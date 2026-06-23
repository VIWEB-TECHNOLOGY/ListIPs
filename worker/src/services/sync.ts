import type { Env, ExternalSyncQueueMessage, ListRow, User } from '../types';
import { compileListContent, ContentValidationError } from '../validation/content';
import { isAllowedExternalSource } from '../validation/source';
import { logEvent } from './observability';
import { putCompiledList } from './compiled-list-store';
import { RequestError } from './response';

interface SyncRow extends ListRow {
  username: string;
  item_quota_per_list: number;
}

export async function syncConfiguredExternalLists(env: Env): Promise<void> {
  if (!env.SYNC_QUEUE) {
    console.error('Scheduled external sync skipped: SYNC_QUEUE binding is not configured.');
    return;
  }

  const result = await env.DB.prepare(
    `SELECT
      lists.*,
      users.username,
      users.item_quota_per_list
     FROM lists
     JOIN users ON users.id = lists.user_id
     WHERE lists.external_sync_enabled = 1
       AND users.status = 'active'
       AND COALESCE(lists.last_sync_status, '') != 'queued'
       AND (lists.next_sync_at IS NULL OR lists.next_sync_at <= datetime('now'))
     ORDER BY
       CASE WHEN lists.last_synced_at IS NULL THEN 0 ELSE 1 END,
       lists.next_sync_at ASC,
       lists.last_synced_at ASC,
       lists.created_at ASC,
       lists.id ASC
     LIMIT 100`
  ).all<SyncRow>();

  for (const row of result.results ?? []) {
    await enqueueExternalSyncForRow(env, row, 'scheduled');
  }
}

export async function syncOwnedList(env: Env, user: User, listId: string, trigger: 'scheduled' | 'manual' | 'queued' = 'manual'): Promise<SyncResult> {
  const row = await env.DB.prepare(
    `SELECT
      lists.*,
      users.username,
      users.item_quota_per_list
     FROM lists
     JOIN users ON users.id = lists.user_id
     WHERE lists.id = ?
       AND lists.user_id = ?
       AND users.status = 'active'`
  ).bind(listId, user.id).first<SyncRow>();

  if (!row) throw new RequestError(404, 'list_not_found', 'List not found.');
  try {
    return await syncOneList(env, row, trigger);
  } catch (error) {
    await recordSyncFailure(env, row, error, trigger);
    throw error;
  }
}

export async function enqueueExternalSyncForList(env: Env, user: User, row: ListRow): Promise<boolean> {
  return enqueueExternalSyncForRow(env, row, 'save', user.id);
}

async function enqueueExternalSyncForRow(
  env: Env,
  row: ListRow,
  reason: ExternalSyncQueueMessage['reason'],
  userId = row.user_id
): Promise<boolean> {
  if (!env.SYNC_QUEUE || row.external_sync_enabled !== 1 || !hasEnabledSources(row.external_sources_json)) {
    return false;
  }

  const queued = await markSyncQueued(env, row.id, userId);
  if (!queued) return false;

  try {
    await env.SYNC_QUEUE.send({
      listId: row.id,
      userId,
      reason,
      queuedAt: new Date().toISOString()
    });
    return true;
  } catch (error) {
    await recordQueueFailure(env, row.id, error);
    console.error('Failed to queue external sync', error);
    return false;
  }
}

export async function processExternalSyncQueueMessage(env: Env, message: ExternalSyncQueueMessage): Promise<void> {
  const user = await env.DB.prepare(
    `SELECT *
     FROM users
     WHERE id = ?
       AND status = 'active'`
  ).bind(message.userId).first<User>();

  if (!user) return;
  await syncOwnedList(env, user, message.listId, message.reason === 'scheduled' ? 'scheduled' : 'queued');
}

interface SyncResult {
  ok: boolean;
  itemCount: number;
  sourceCount: number;
  compiledHash: string;
  syncedAt: string;
}

async function syncOneList(env: Env, row: SyncRow, trigger: 'scheduled' | 'manual' | 'queued'): Promise<SyncResult> {
  const startedAt = Date.now();
  const sources = parseSources(row.external_sources_json).filter((source) => source.enabled);
  logSyncEvent(env, 'sync_started', row, {
    trigger,
    sourceCount: sources.length,
    force: trigger === 'manual'
  });

  if (sources.length === 0) {
    throw new RequestError(400, 'no_sources_enabled', 'No enabled external sources are configured.');
  }

  const chunks = [row.content];
  for (const source of sources) {
    if (!isAllowedExternalSource(source.url, env.EXTERNAL_SOURCE_ALLOWED_HOSTS)) {
      throw new Error(`Source is not allowed: ${source.url}`);
    }

    chunks.push(await fetchSource(source.url));
  }

  const compiled = await compileFetchedContent(chunks.join('\n'), row.item_quota_per_list);
  const syncedAt = new Date().toISOString();

  await env.DB.prepare(
    `UPDATE lists
     SET compiled_hash = ?,
         item_count = ?,
         last_sync_status = 'ok',
         last_sync_error = NULL,
         last_synced_at = datetime('now'),
         next_sync_at = datetime('now', '+24 hours'),
         sync_failure_count = 0,
         updated_at = datetime('now')
     WHERE id = ?`
  ).bind(compiled.hash, compiled.entryCount, row.id).run();

  await putCompiledList(env, row.kv_key, compiled.content, {
    hash: compiled.hash,
    itemCount: compiled.entryCount,
    visibility: row.visibility,
    privateTokenPolicy: row.private_token_policy,
    rawTokenHash: row.raw_token_hash,
    updatedAt: syncedAt
  });

  const result = {
    ok: true,
    itemCount: compiled.entryCount,
    sourceCount: sources.length,
    compiledHash: compiled.hash,
    syncedAt
  };

  logSyncEvent(env, 'sync_success', row, {
    trigger,
    sourceCount: sources.length,
    itemCount: compiled.entryCount,
    durationMs: Date.now() - startedAt,
    force: trigger === 'manual'
  });

  return result;
}

async function recordSyncFailure(env: Env, row: SyncRow, error: unknown, trigger: 'scheduled' | 'manual' | 'queued'): Promise<void> {
  const message = error instanceof Error ? error.message : 'Unknown sync error.';
  const failureCount = row.sync_failure_count + 1;
  await env.DB.prepare(
    `UPDATE lists
     SET last_sync_status = 'failed',
         last_sync_error = ?,
         last_synced_at = datetime('now'),
         next_sync_at = datetime('now', ?),
         sync_failure_count = ?
     WHERE id = ?`
  ).bind(message.slice(0, 500), syncFailureBackoff(failureCount), failureCount, row.id).run();

  logSyncEvent(env, 'sync_failed', row, {
    trigger,
    sourceCount: parseSources(row.external_sources_json).filter((source) => source.enabled).length,
    errorCode: error instanceof RequestError ? error.code : 'sync_error',
    errorMessage: safeLogMessage(message),
    force: true
  });
}

async function fetchSource(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { Accept: 'text/plain,*/*;q=0.1' }
    });

    if (!response.ok) throw new Error(`Fetch failed with status ${response.status}`);

    const contentType = response.headers.get('Content-Type') ?? '';
    if (contentType && !contentType.includes('text/plain') && !contentType.includes('application/octet-stream')) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 262144) {
      throw new Error('Source response exceeds 256 KB.');
    }

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function compileFetchedContent(content: string, itemLimit: number) {
  try {
    return await compileListContent(content, itemLimit);
  } catch (error) {
    if (error instanceof ContentValidationError) {
      const detail = error.issues.map((issue) => `line ${issue.line}: ${issue.message}`).join(' ');
      throw new RequestError(400, 'invalid_synced_content', detail);
    }

    throw error;
  }
}

function parseSources(value: string): Array<{ url: string; enabled: boolean }> {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object' && typeof item.url === 'string')
      .map((item) => ({ url: item.url, enabled: item.enabled !== false }));
  } catch {
    return [];
  }
}

function hasEnabledSources(value: string): boolean {
  return parseSources(value).some((source) => source.enabled);
}

async function markSyncQueued(env: Env, listId: string, userId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE lists
     SET last_sync_status = 'queued',
         last_sync_error = NULL,
         next_sync_at = NULL,
         updated_at = datetime('now')
     WHERE id = ?
       AND user_id = ?
       AND external_sync_enabled = 1
       AND COALESCE(last_sync_status, '') != 'queued'`
  ).bind(listId, userId).run();

  return rowsWritten(result) > 0;
}

async function recordQueueFailure(env: Env, listId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : 'Unknown queue error.';
  await env.DB.prepare(
    `UPDATE lists
     SET last_sync_status = 'failed',
         last_sync_error = ?,
         next_sync_at = datetime('now', '+1 hour'),
         sync_failure_count = sync_failure_count + 1
     WHERE id = ?`
  ).bind(`Failed to queue external sync: ${message}`.slice(0, 500), listId).run();
}

function syncFailureBackoff(failureCount: number): string {
  if (failureCount >= 3) return '+24 hours';
  if (failureCount === 2) return '+6 hours';
  return '+1 hour';
}

function rowsWritten(result: D1Result): number {
  return Number(result.meta?.rows_written ?? result.meta?.changes ?? 0);
}

function logSyncEvent(
  env: Env,
  event: 'sync_started' | 'sync_success' | 'sync_failed',
  row: SyncRow,
  fields: {
    trigger: 'scheduled' | 'manual' | 'queued';
    sourceCount: number;
    itemCount?: number;
    durationMs?: number;
    errorCode?: string;
    errorMessage?: string;
    force?: boolean;
  }
): void {
  logEvent(env, event, {
    trigger: fields.trigger,
    listId: row.id,
    username: row.username,
    slug: row.slug,
    visibility: row.visibility,
    sourceCount: fields.sourceCount,
    itemCount: fields.itemCount,
    durationMs: fields.durationMs,
    errorCode: fields.errorCode,
    errorMessage: fields.errorMessage
  }, { force: fields.force });
}

function safeLogMessage(message: string): string {
  return message.slice(0, 500).replace(/https?:\/\/\S+/g, '[url]');
}
