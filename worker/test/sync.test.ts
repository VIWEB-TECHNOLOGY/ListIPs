import { afterEach, describe, expect, it, vi } from 'vitest';
import { processExternalSyncQueueMessage, syncConfiguredExternalLists, syncOwnedList } from '../src/services/sync';
import type { ListRow } from '../src/types';
import { createTestEnv, testUser } from './helpers';

function syncedList(id: string, lastSyncedAt: string | null, createdAt: string): ListRow {
  return {
    id,
    user_id: testUser.id,
    name: id,
    slug: id,
    description: null,
    visibility: 'public',
    mode: 'allowlist',
    private_token_policy: 'always',
    content: '192.0.2.10\n',
    compiled_hash: 'sha256:old',
    kv_key: `lists/alice/${id}`,
    raw_token_hash: null,
    raw_token_prefix: null,
    raw_token_ciphertext: null,
    item_count: 1,
    external_sync_enabled: 1,
    external_sources_json: JSON.stringify([{ url: 'https://www.cloudflare.com/ips-v4', enabled: true }]),
    last_synced_at: lastSyncedAt,
    last_sync_status: null,
    last_sync_error: null,
    next_sync_at: null,
    sync_failure_count: 0,
    created_at: createdAt,
    updated_at: createdAt
  };
}

describe('configured external sync', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('queues never-synced and oldest-synced due lists first', async () => {
    const env = createTestEnv();

    env.__db.lists.push(syncedList('recent', '2026-05-06T09:00:00Z', '2026-05-01T00:00:00Z'));
    for (let index = 0; index < 99; index += 1) {
      env.__db.lists.push(syncedList(
        `never-${String(index).padStart(2, '0')}`,
        null,
        `2026-05-${String(index + 1).padStart(2, '0')}T00:00:00Z`
      ));
    }
    env.__db.lists.push(syncedList('oldest', '2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z'));
    env.__db.lists.push(syncedList('middle', '2026-04-15T00:00:00Z', '2026-05-01T00:00:00Z'));

    await syncConfiguredExternalLists(env);

    const queuedIds = env.__queue.messages.map((message) => (message as { listId: string }).listId);
    expect(queuedIds).toHaveLength(100);
    expect(queuedIds.slice(0, 3)).toEqual(['never-00', 'never-01', 'never-02']);
    expect(queuedIds).toContain('oldest');
    expect(queuedIds).not.toContain('middle');
    expect(queuedIds).not.toContain('recent');
    expect(env.__db.syncedListIds).toHaveLength(0);
    expect(env.__db.lists.find((row) => row.id === 'oldest')?.last_sync_status).toBe('queued');
  });

  it('stores a clear failure and backoff when queued output exceeds the list limit', async () => {
    const env = createTestEnv();
    const sourceContent = Array.from({ length: 500 }, (_, index) => {
      const third = Math.floor(index / 256);
      const fourth = index % 256;
      return `10.0.${third}.${fourth}`;
    }).join('\n');
    vi.stubGlobal('fetch', async () => new Response(`${sourceContent}\n`, {
      headers: { 'Content-Type': 'text/plain' }
    }));

    env.__db.lists.push(syncedList('large-source', null, '2026-05-01T00:00:00Z'));

    await expect(processExternalSyncQueueMessage(env, {
      listId: 'large-source',
      userId: testUser.id,
      reason: 'scheduled',
      queuedAt: '2026-05-08T00:00:00Z'
    })).rejects.toThrow('Compiled list has 501 output lines');

    const row = env.__db.lists.find((item) => item.id === 'large-source');
    expect(row?.last_sync_status).toBe('failed');
    expect(row?.last_sync_error).toContain('Compiled list has 501 output lines; the current limit is 500.');
    expect(row?.next_sync_at).not.toBeNull();
    expect(row?.sync_failure_count).toBe(1);
    expect(env.__r2.store.has('lists/alice/large-source')).toBe(false);
  });

  it('emits structured sync success logs without source content', async () => {
    const env = createTestEnv();
    env.OBSERVABILITY_SAMPLE_RATE = '1';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', async () => new Response('198.51.100.0/24\n', {
      headers: { 'Content-Type': 'text/plain' }
    }));
    env.__db.lists.push(syncedList('logged-success', null, '2026-05-01T00:00:00Z'));

    await processExternalSyncQueueMessage(env, {
      listId: 'logged-success',
      userId: testUser.id,
      reason: 'scheduled',
      queuedAt: '2026-05-08T00:00:00Z'
    });

    const payloads = logSpy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(payloads.map((payload) => payload.event)).toEqual(['sync_started', 'sync_success']);
    expect(payloads[1]).toMatchObject({
      trigger: 'scheduled',
      listId: 'logged-success',
      slug: 'logged-success',
      sourceCount: 1,
      itemCount: 2
    });
    expect(JSON.stringify(payloads)).not.toContain('198.51.100.0/24');
    expect(JSON.stringify(payloads)).not.toContain('cloudflare.com/ips-v4');
  });

  it('persists manual sync failures and logs a safe failure event', async () => {
    const env = createTestEnv();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const row = syncedList('manual-failure', null, '2026-05-01T00:00:00Z');
    row.external_sources_json = JSON.stringify([{ url: 'https://blocked.example.com/list.txt', enabled: true }]);
    env.__db.lists.push(row);

    await expect(syncOwnedList(env, testUser, 'manual-failure')).rejects.toThrow('Source is not allowed');

    const updated = env.__db.lists.find((item) => item.id === 'manual-failure');
    expect(updated?.last_sync_status).toBe('failed');
    expect(updated?.last_sync_error).toContain('https://blocked.example.com/list.txt');

    const failure = logSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .find((payload) => payload.event === 'sync_failed');
    expect(failure).toMatchObject({
      trigger: 'manual',
      listId: 'manual-failure',
      sourceCount: 1,
      errorCode: 'sync_error'
    });
    expect(JSON.stringify(failure)).not.toContain('blocked.example.com');
    expect(failure?.errorMessage).toBe('Source is not allowed: [url]');
  });

  it('processes a queued sync for only the requested list', async () => {
    const env = createTestEnv();
    vi.stubGlobal('fetch', async () => new Response('198.51.100.0/24\n', {
      headers: { 'Content-Type': 'text/plain' }
    }));
    env.__db.lists.push(syncedList('queued-list', null, '2026-05-01T00:00:00Z'));
    env.__db.lists.push(syncedList('other-list', null, '2026-05-01T00:00:00Z'));

    await processExternalSyncQueueMessage(env, {
      listId: 'queued-list',
      userId: testUser.id,
      reason: 'save',
      queuedAt: '2026-05-08T00:00:00Z'
    });

    expect(env.__db.syncedListIds).toEqual(['queued-list']);
    expect(env.__r2.store.has('lists/alice/queued-list')).toBe(true);
    expect(env.__r2.store.has('lists/alice/other-list')).toBe(false);
  });
});
