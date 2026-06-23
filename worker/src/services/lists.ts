import type { Env, ListRow, User } from '../types';
import { compileListContent, ContentValidationError } from '../validation/content';
import { isAllowedExternalSource } from '../validation/source';
import { deleteCompiledList, getCompiledList, putCompiledList } from './compiled-list-store';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from './crypto';
import { RequestError } from './response';

export interface ListInput {
  name?: unknown;
  slug?: unknown;
  description?: unknown;
  visibility?: unknown;
  mode?: unknown;
  privateTokenPolicy?: unknown;
  content?: unknown;
  externalSources?: unknown;
}

export async function createList(env: Env, user: User, input: ListInput): Promise<{ row: ListRow; rawToken?: string }> {
  const normalized = normalizeListInput(input);
  await assertSlugAvailable(env, user.id, normalized.slug);

  const listCount = await countUserLists(env, user.id);
  if (listCount >= user.list_quota) {
    throw new RequestError(403, 'list_quota_exceeded', `List quota exceeded. Maximum: ${user.list_quota}.`);
  }

  const compiled = await compileInputContent(normalized.content, user.item_quota_per_list);
  const listId = `lst_${crypto.randomUUID()}`;
  const kvKey = `lists/${user.username}/${normalized.slug}`;
  const rawToken = normalized.visibility === 'private' ? randomToken('sec_', 24) : undefined;
  const rawTokenHash = rawToken ? await sha256Hex(rawToken) : null;
  const rawTokenPrefix = rawToken ? rawToken.slice(0, 12) : null;
  const rawTokenCiphertext = rawToken && normalized.privateTokenPolicy === 'always'
    ? await encryptSecret(rawToken, env.SESSION_SECRET)
    : null;
  const externalSourcesJson = JSON.stringify(normalized.externalSources);

  await env.DB.prepare(
    `INSERT INTO lists (
      id, user_id, name, slug, description, visibility, mode, private_token_policy,
      content, compiled_hash, kv_key, raw_token_hash, raw_token_prefix, raw_token_ciphertext,
      item_count, external_sync_enabled, external_sources_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).bind(
    listId,
    user.id,
    normalized.name,
    normalized.slug,
    normalized.description,
    normalized.visibility,
    normalized.mode,
    normalized.privateTokenPolicy,
    compiled.content,
    compiled.hash,
    kvKey,
    rawTokenHash,
    rawTokenPrefix,
    rawTokenCiphertext,
    compiled.entryCount,
    normalized.externalSources.length > 0 ? 1 : 0,
    externalSourcesJson
  ).run();

  const row = await getOwnedList(env, user.id, listId);
  if (!row) throw new Error('Failed to create list.');
  await publishList(env, user.username, row, rawTokenHash);
  return { row, rawToken };
}

export async function updateList(env: Env, user: User, listId: string, input: ListInput): Promise<{ row: ListRow; rawToken?: string }> {
  const existing = await getOwnedList(env, user.id, listId);
  if (!existing) throw new RequestError(404, 'list_not_found', 'List not found.');

  const normalized = normalizeListInput(input, existing);
  await assertSlugAvailable(env, user.id, normalized.slug, listId);

  const compiled = await compileInputContent(normalized.content, user.item_quota_per_list);
  const oldKvKey = existing.kv_key;
  const kvKey = `lists/${user.username}/${normalized.slug}`;
  const externalSourcesJson = JSON.stringify(normalized.externalSources);
  const preserveSyncedArtifact = shouldPreserveSyncedArtifact(existing, compiled.content, externalSourcesJson);
  const compiledHash = preserveSyncedArtifact ? existing.compiled_hash : compiled.hash;
  const itemCount = preserveSyncedArtifact ? existing.item_count : compiled.entryCount;
  const shouldGenerateToken = normalized.visibility === 'private'
    && (!existing.raw_token_hash || (normalized.privateTokenPolicy === 'always' && !existing.raw_token_ciphertext));
  const rawToken = shouldGenerateToken ? randomToken('sec_', 24) : undefined;
  const rawTokenHash = normalized.visibility === 'public'
    ? null
    : rawToken ? await sha256Hex(rawToken) : existing.raw_token_hash;
  const rawTokenPrefix = normalized.visibility === 'public'
    ? null
    : rawToken ? rawToken.slice(0, 12) : existing.raw_token_prefix;
  const rawTokenCiphertext = normalized.visibility === 'public' || normalized.privateTokenPolicy === 'one_time'
    ? null
    : rawToken ? await encryptSecret(rawToken, env.SESSION_SECRET) : existing.raw_token_ciphertext;

  await env.DB.prepare(
    `UPDATE lists
     SET name = ?,
         slug = ?,
         description = ?,
         visibility = ?,
         mode = ?,
         private_token_policy = ?,
         content = ?,
         compiled_hash = ?,
         kv_key = ?,
         raw_token_hash = ?,
         raw_token_prefix = ?,
         raw_token_ciphertext = ?,
         item_count = ?,
         external_sync_enabled = ?,
         external_sources_json = ?,
         updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`
  ).bind(
    normalized.name,
    normalized.slug,
    normalized.description,
    normalized.visibility,
    normalized.mode,
    normalized.privateTokenPolicy,
    compiled.content,
    compiledHash,
    kvKey,
    rawTokenHash,
    rawTokenPrefix,
    rawTokenCiphertext,
    itemCount,
    normalized.externalSources.length > 0 ? 1 : 0,
    externalSourcesJson,
    listId,
    user.id
  ).run();

  const row = await getOwnedList(env, user.id, listId);
  if (!row) throw new Error('Failed to update list.');
  const existingArtifact = preserveSyncedArtifact ? await getCompiledList(env, oldKvKey) : null;
  await publishList(env, user.username, row, row.raw_token_hash, existingArtifact?.content);

  if (oldKvKey !== kvKey) {
    await deleteCompiledList(env, oldKvKey);
  }

  return { row, rawToken };
}

export async function rotatePrivateToken(env: Env, user: User, listId: string): Promise<{ row: ListRow; rawToken: string }> {
  const existing = await getOwnedList(env, user.id, listId);
  if (!existing) throw new RequestError(404, 'list_not_found', 'List not found.');
  if (existing.visibility !== 'private') {
    throw new RequestError(400, 'not_private', 'Only private lists have raw URL tokens.');
  }

  const rawToken = randomToken('sec_', 24);
  const rawTokenHash = await sha256Hex(rawToken);
  const rawTokenPrefix = rawToken.slice(0, 12);
  const rawTokenCiphertext = existing.private_token_policy === 'always'
    ? await encryptSecret(rawToken, env.SESSION_SECRET)
    : null;

  await env.DB.prepare(
    `UPDATE lists
     SET raw_token_hash = ?, raw_token_prefix = ?, raw_token_ciphertext = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`
  ).bind(rawTokenHash, rawTokenPrefix, rawTokenCiphertext, listId, user.id).run();

  const row = await getOwnedList(env, user.id, listId);
  if (!row) throw new Error('Failed to rotate token.');
  const existingArtifact = shouldPreserveSyncedArtifact(row, row.content, row.external_sources_json)
    ? await getCompiledList(env, row.kv_key)
    : null;
  await publishList(env, user.username, row, rawTokenHash, existingArtifact?.content);
  return { row, rawToken };
}

export async function deleteList(env: Env, user: User, listId: string): Promise<void> {
  const existing = await getOwnedList(env, user.id, listId);
  if (!existing) throw new RequestError(404, 'list_not_found', 'List not found.');

  await env.DB.prepare(`DELETE FROM lists WHERE id = ? AND user_id = ?`).bind(listId, user.id).run();
  await deleteCompiledList(env, existing.kv_key);
}

export async function listUserLists(env: Env, user: User): Promise<ListRow[]> {
  const result = await env.DB.prepare(
    `SELECT *
     FROM lists
     WHERE user_id = ?
     ORDER BY updated_at DESC`
  ).bind(user.id).all<ListRow>();

  return result.results ?? [];
}

export async function getOwnedList(env: Env, userId: string, listId: string): Promise<ListRow | null> {
  return env.DB.prepare(
    `SELECT * FROM lists WHERE id = ? AND user_id = ?`
  ).bind(listId, userId).first<ListRow>();
}

export async function listResponse(row: ListRow, username: string, appOrigin: string, sessionSecret: string, rawToken?: string): Promise<Record<string, unknown>> {
  const rawUrlBase = `${appOrigin}/u/${username}/${row.slug}`;
  const visiblePrivateToken = rawToken ?? await storedVisiblePrivateToken(row, sessionSecret);
  const rawUrl = row.visibility === 'public'
    ? rawUrlBase
    : visiblePrivateToken ? `${rawUrlBase}?token=${visiblePrivateToken}` : null;

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    visibility: row.visibility,
    mode: row.mode,
    privateTokenPolicy: row.private_token_policy,
    content: row.content,
    itemCount: row.item_count,
    externalSyncEnabled: row.external_sync_enabled === 1,
    externalSources: safeJsonArray(row.external_sources_json),
    rawUrl,
    rawUrlBase,
    rawUrlRequiresToken: row.visibility === 'private',
    rawUrlTokenVisible: Boolean(visiblePrivateToken),
    rawTokenPrefix: row.raw_token_prefix,
    cacheSeconds: 60,
    lastSyncedAt: row.last_synced_at,
    lastSyncStatus: row.last_sync_status,
    lastSyncError: row.last_sync_error,
    updatedAt: row.updated_at,
    createdAt: row.created_at
  };
}

async function publishList(env: Env, _username: string, row: ListRow, rawTokenHash: string | null, content = row.content): Promise<void> {
  await putCompiledList(env, row.kv_key, content, {
    hash: row.compiled_hash ?? undefined,
    itemCount: row.item_count,
    visibility: row.visibility,
    privateTokenPolicy: row.private_token_policy,
    rawTokenHash,
    updatedAt: row.updated_at
  });
}

function shouldPreserveSyncedArtifact(existing: ListRow, compiledContent: string, externalSourcesJson: string): boolean {
  return existing.external_sync_enabled === 1
    && existing.last_sync_status === 'ok'
    && existing.content === compiledContent
    && existing.external_sources_json === externalSourcesJson;
}

async function countUserLists(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM lists WHERE user_id = ?`
  ).bind(userId).first<{ count: number }>();

  return row?.count ?? 0;
}

async function compileInputContent(content: string, itemLimit: number) {
  try {
    return await compileListContent(content, itemLimit);
  } catch (error) {
    if (error instanceof ContentValidationError) {
      const detail = error.issues.map((issue) => `line ${issue.line}: ${issue.message}`).join(' ');
      throw new RequestError(400, 'invalid_list_content', detail);
    }

    throw error;
  }
}

async function assertSlugAvailable(env: Env, userId: string, slug: string, currentListId?: string): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT id FROM lists WHERE user_id = ? AND slug = ?`
  ).bind(userId, slug).first<{ id: string }>();

  if (existing && existing.id !== currentListId) {
    throw new RequestError(409, 'slug_already_exists', 'A list with this slug already exists.');
  }
}

function normalizeListInput(input: ListInput, existing?: ListRow) {
  const name = stringField(input.name, existing?.name, 'name').trim();
  if (name.length < 1 || name.length > 80) {
    throw new RequestError(400, 'invalid_name', 'Name must be between 1 and 80 characters.');
  }

  const slug = stringField(input.slug, existing?.slug ?? slugify(name), 'slug').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new RequestError(400, 'invalid_slug', 'Slug must use lowercase letters, numbers, and hyphens.');
  }

  const visibility = enumField(input.visibility, existing?.visibility ?? 'private', ['public', 'private'], 'visibility');
  const mode = enumField(input.mode, existing?.mode ?? 'allowlist', ['allowlist', 'blocklist'], 'mode');
  const privateTokenPolicy = enumField(
    input.privateTokenPolicy,
    existing?.private_token_policy ?? 'always',
    ['always', 'one_time'],
    'private_token_policy'
  );
  const description = optionalString(input.description, existing?.description);
  const content = stringField(input.content, existing?.content, 'content');
  const externalSources = sourceArray(input.externalSources, existing?.external_sources_json);

  return { name, slug, visibility, mode, privateTokenPolicy, description, content, externalSources };
}

async function storedVisiblePrivateToken(row: ListRow, sessionSecret: string): Promise<string | undefined> {
  if (row.visibility !== 'private' || row.private_token_policy !== 'always' || !row.raw_token_ciphertext) {
    return undefined;
  }

  return await decryptSecret(row.raw_token_ciphertext, sessionSecret) ?? undefined;
}

function stringField(value: unknown, fallback: string | undefined, field: string): string {
  if (typeof value === 'string') return value;
  if (fallback !== undefined) return fallback;
  throw new RequestError(400, `invalid_${field}`, `${field} is required.`);
}

function optionalString(value: unknown, fallback: string | null | undefined): string | null {
  if (value === undefined) return fallback ?? null;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new RequestError(400, 'invalid_description', 'Description must be a string.');
  return value.slice(0, 240);
}

function enumField<T extends string>(value: unknown, fallback: T, allowed: T[], field: string): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new RequestError(400, `invalid_${field}`, `${field} is invalid.`);
  }

  return value as T;
}

function sourceArray(value: unknown, fallbackJson?: string): Array<{ url: string; enabled: boolean }> {
  const raw = value === undefined ? safeJsonArray(fallbackJson ?? '[]') : value;
  if (!Array.isArray(raw)) throw new RequestError(400, 'invalid_sources', 'External sources must be an array.');

  if (raw.length > 5) {
    throw new RequestError(400, 'too_many_sources', 'A list may have at most 5 external sources.');
  }

  return raw.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new RequestError(400, 'invalid_source', 'External source must be an object.');
    }

    const source = item as { url?: unknown; enabled?: unknown };
    if (typeof source.url !== 'string') {
      throw new RequestError(400, 'invalid_source_url', 'External source URL is required.');
    }

    return { url: source.url, enabled: source.enabled !== false };
  });
}

function safeJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function validateSourceAllowlist(sources: Array<{ url: string; enabled: boolean }>, allowedHosts: string): void {
  for (const source of sources) {
    if (source.enabled && !isAllowedExternalSource(source.url, allowedHosts)) {
      throw new RequestError(400, 'source_not_allowed', `External source is not on the domain allowlist: ${source.url}`);
    }
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || `list-${Date.now()}`;
}
