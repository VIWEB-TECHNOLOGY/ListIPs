import { describe, expect, it } from 'vitest';
import type { Env, ListRow, User } from '../src/types';
import { createList, deleteList, updateList } from '../src/services/lists';
import { sha256Hex } from '../src/services/crypto';

class MemoryKV {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
}

class MemoryR2 {
  store = new Map<string, { value: string; customMetadata: Record<string, string>; httpMetadata?: R2HTTPMetadata }>();
  deleted: string[] = [];

  async get(key: string): Promise<(R2ObjectBody & { text(): Promise<string> }) | null> {
    const item = this.store.get(key);
    if (!item) return null;

    return {
      key,
      customMetadata: item.customMetadata,
      httpMetadata: item.httpMetadata ?? {},
      text: async () => item.value
    } as unknown as R2ObjectBody & { text(): Promise<string> };
  }

  async put(key: string, value: string, options?: { customMetadata?: Record<string, string>; httpMetadata?: R2HTTPMetadata }): Promise<void> {
    this.store.set(key, {
      value,
      customMetadata: options?.customMetadata ?? {},
      httpMetadata: options?.httpMetadata
    });
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.store.delete(key);
  }
}

class MemoryD1 {
  lists: ListRow[] = [];

  prepare(sql: string) {
    return new MemoryStatement(this, sql);
  }
}

class MemoryStatement {
  private values: unknown[] = [];

  constructor(private readonly db: MemoryD1, private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes('SELECT COUNT(*) AS count FROM lists')) {
      const [userId] = this.values;
      return { count: this.db.lists.filter((row) => row.user_id === userId).length } as T;
    }

    if (this.sql.includes('SELECT id FROM lists WHERE user_id = ? AND slug = ?')) {
      const [userId, slug] = this.values;
      const row = this.db.lists.find((item) => item.user_id === userId && item.slug === slug);
      return (row ? { id: row.id } : null) as T | null;
    }

    if (this.sql.includes('SELECT * FROM lists WHERE id = ? AND user_id = ?')) {
      const [id, userId] = this.values;
      return (this.db.lists.find((row) => row.id === id && row.user_id === userId) ?? null) as T | null;
    }

    throw new Error(`Unhandled first SQL: ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('SELECT *') && this.sql.includes('FROM lists') && this.sql.includes('WHERE user_id = ?')) {
      const [userId] = this.values;
      return { results: this.db.lists.filter((row) => row.user_id === userId) as T[] };
    }

    throw new Error(`Unhandled all SQL: ${this.sql}`);
  }

  async run(): Promise<void> {
    if (this.sql.includes('INSERT INTO lists')) {
      const [
        id,
        userId,
        name,
        slug,
        description,
        visibility,
        mode,
        privateTokenPolicy,
        content,
        compiledHash,
        kvKey,
        rawTokenHash,
        rawTokenPrefix,
        rawTokenCiphertext,
        itemCount,
        externalSyncEnabled,
        externalSourcesJson
      ] = this.values;
      const now = new Date().toISOString();
      this.db.lists.push({
        id,
        user_id: userId,
        name,
        slug,
        description,
        visibility,
        mode,
        private_token_policy: privateTokenPolicy,
        content,
        compiled_hash: compiledHash,
        kv_key: kvKey,
        raw_token_hash: rawTokenHash,
        raw_token_prefix: rawTokenPrefix,
        raw_token_ciphertext: rawTokenCiphertext,
        item_count: itemCount,
        external_sync_enabled: externalSyncEnabled,
        external_sources_json: externalSourcesJson,
        last_synced_at: null,
        last_sync_status: null,
        last_sync_error: null,
        next_sync_at: null,
        sync_failure_count: 0,
        created_at: now,
        updated_at: now
      } as ListRow);
      return;
    }

    if (this.sql.includes('UPDATE lists') && this.sql.includes('raw_token_hash = ?') && this.sql.includes('external_sources_json = ?')) {
      const [
        name,
        slug,
        description,
        visibility,
        mode,
        privateTokenPolicy,
        content,
        compiledHash,
        kvKey,
        rawTokenHash,
        rawTokenPrefix,
        rawTokenCiphertext,
        itemCount,
        externalSyncEnabled,
        externalSourcesJson,
        id,
        userId
      ] = this.values;
      const row = this.db.lists.find((item) => item.id === id && item.user_id === userId);
      if (row) {
        Object.assign(row, {
          name,
          slug,
          description,
          visibility,
          mode,
          private_token_policy: privateTokenPolicy,
          content,
          compiled_hash: compiledHash,
          kv_key: kvKey,
          raw_token_hash: rawTokenHash,
          raw_token_prefix: rawTokenPrefix,
          raw_token_ciphertext: rawTokenCiphertext,
          item_count: itemCount,
          external_sync_enabled: externalSyncEnabled,
          external_sources_json: externalSourcesJson,
          updated_at: new Date().toISOString()
        });
      }
      return;
    }

    if (this.sql.includes('UPDATE lists') && this.sql.includes('SET raw_token_hash = ?')) {
      const [rawTokenHash, rawTokenPrefix, rawTokenCiphertext, id, userId] = this.values;
      const row = this.db.lists.find((item) => item.id === id && item.user_id === userId);
      if (row) {
        row.raw_token_hash = rawTokenHash as string;
        row.raw_token_prefix = rawTokenPrefix as string;
        row.raw_token_ciphertext = rawTokenCiphertext as string | null;
        row.updated_at = new Date().toISOString();
      }
      return;
    }

    if (this.sql.includes('DELETE FROM lists')) {
      const [id, userId] = this.values;
      this.db.lists = this.db.lists.filter((row) => row.id !== id || row.user_id !== userId);
      return;
    }

    throw new Error(`Unhandled run SQL: ${this.sql}`);
  }
}

const user: User = {
  id: 'usr_1',
  username: 'alice',
  email: 'alice@example.com',
  auth_provider: 'github',
  auth_subject: '1',
  avatar_url: null,
  role: 'user',
  status: 'active',
  list_quota: 100,
  item_quota_per_list: 500
};

function env() {
  const db = new MemoryD1();
  const kv = new MemoryKV();
  const r2 = new MemoryR2();
  return {
    DB: db as unknown as D1Database,
    LISTS_KV: kv as unknown as KVNamespace,
    LISTS_R2: r2 as unknown as R2Bucket,
    APP_ORIGIN: 'https://listips.test',
    SESSION_SECRET: 'test',
    GITHUB_CLIENT_ID: 'test',
    GITHUB_CLIENT_SECRET: 'test',
    GITHUB_OAUTH_REDIRECT_URI: 'https://listips.test/api/auth/github/callback',
    RAW_LIST_CACHE_SECONDS: '300',
    MAX_LISTS_PER_USER: '100',
    MAX_LIST_ITEMS: '500',
    MAX_LIST_BODY_BYTES: '524288',
    EXTERNAL_SOURCE_ALLOWED_HOSTS: '*.cloudflare.com,*.githubusercontent.com,*.amazonaws.com',
    __db: db,
    __kv: kv,
    __r2: r2
  } as Env & { __db: MemoryD1; __kv: MemoryKV; __r2: MemoryR2 };
}

describe('list service', () => {
  it('publishes created lists to R2 with output-line metadata', async () => {
    const testEnv = env();
    const result = await createList(testEnv, user, {
      name: 'Office',
      visibility: 'public',
      mode: 'allowlist',
      content: '# comment\n192.0.2.10\n'
    });

    expect(result.rawToken).toBeUndefined();
    expect(result.row.item_count).toBe(2);
    expect(testEnv.__r2.store.get('lists/alice/office')?.value).toBe('# comment\n192.0.2.10\n');
    expect(testEnv.__r2.store.get('lists/alice/office')?.customMetadata).toMatchObject({
      itemCount: '2',
      visibility: 'public',
    });
  });

  it('generates a token when an existing public list becomes private', async () => {
    const testEnv = env();
    const created = await createList(testEnv, user, {
      name: 'Office',
      visibility: 'public',
      mode: 'allowlist',
      content: '192.0.2.10\n'
    });

    const updated = await updateList(testEnv, user, created.row.id, {
      visibility: 'private'
    });

    expect(updated.rawToken).toMatch(/^sec_/);
    expect(updated.row.raw_token_hash).toBe(await sha256Hex(updated.rawToken ?? ''));
    expect(updated.row.private_token_policy).toBe('always');
    expect(updated.row.raw_token_ciphertext).toMatch(/^v1:/);
    expect(testEnv.__r2.store.get('lists/alice/office')?.customMetadata).toMatchObject({
      visibility: 'private',
      privateTokenPolicy: 'always',
      rawTokenHash: updated.row.raw_token_hash
    });
  });

  it('preserves synced R2 content when metadata-only updates change visibility', async () => {
    const testEnv = env();
    const created = await createList(testEnv, user, {
      name: 'Office',
      visibility: 'public',
      mode: 'allowlist',
      content: '# manual\n192.0.2.10\n',
      externalSources: [{ url: 'https://www.cloudflare.com/ips-v4', enabled: true }]
    });
    const row = testEnv.__db.lists.find((item) => item.id === created.row.id);
    if (!row) throw new Error('Missing test list.');
    row.last_sync_status = 'ok';
    row.last_synced_at = '2026-05-06T00:00:00Z';
    row.item_count = 3;
    row.compiled_hash = 'sha256:synced';
    await testEnv.__r2.put(row.kv_key, '# manual\n192.0.2.10\n198.51.100.0/24\n', {
      customMetadata: {
        hash: 'sha256:synced',
        itemCount: '3',
        visibility: 'public'
      }
    });

    const updated = await updateList(testEnv, user, created.row.id, {
      visibility: 'private'
    });

    expect(updated.row.item_count).toBe(3);
    expect(updated.row.compiled_hash).toBe('sha256:synced');
    expect(testEnv.__r2.store.get('lists/alice/office')?.value).toBe('# manual\n192.0.2.10\n198.51.100.0/24\n');
    expect(testEnv.__r2.store.get('lists/alice/office')?.customMetadata).toMatchObject({
      hash: 'sha256:synced',
      itemCount: '3',
      visibility: 'private',
      rawTokenHash: updated.row.raw_token_hash
    });
  });

  it('does not store recoverable tokens for one-time private lists', async () => {
    const testEnv = env();
    const created = await createList(testEnv, user, {
      name: 'Office',
      visibility: 'private',
      privateTokenPolicy: 'one_time',
      mode: 'allowlist',
      content: '192.0.2.10\n'
    });

    expect(created.rawToken).toMatch(/^sec_/);
    expect(created.row.private_token_policy).toBe('one_time');
    expect(created.row.raw_token_hash).toBe(await sha256Hex(created.rawToken ?? ''));
    expect(created.row.raw_token_ciphertext).toBeNull();
  });

  it('clears private token state when a list becomes public', async () => {
    const testEnv = env();
    const created = await createList(testEnv, user, {
      name: 'Office',
      visibility: 'private',
      mode: 'allowlist',
      content: '192.0.2.10\n'
    });

    expect(created.rawToken).toMatch(/^sec_/);
    const updated = await updateList(testEnv, user, created.row.id, {
      visibility: 'public'
    });

    expect(updated.rawToken).toBeUndefined();
    expect(updated.row.raw_token_hash).toBeNull();
    expect(updated.row.raw_token_prefix).toBeNull();
    expect(updated.row.raw_token_ciphertext).toBeNull();
    expect(testEnv.__r2.store.get('lists/alice/office')?.customMetadata).toMatchObject({
      visibility: 'public',
    });
  });

  it('removes old R2 artifacts on slug rename and delete', async () => {
    const testEnv = env();
    const created = await createList(testEnv, user, {
      name: 'Office',
      visibility: 'public',
      mode: 'allowlist',
      content: '192.0.2.10\n'
    });

    const updated = await updateList(testEnv, user, created.row.id, {
      name: 'Branch Office',
      slug: 'branch-office'
    });

    expect(updated.row.kv_key).toBe('lists/alice/branch-office');
    expect(testEnv.__r2.deleted).toContain('lists/alice/office');
    expect(testEnv.__r2.store.has('lists/alice/branch-office')).toBe(true);

    await deleteList(testEnv, user, created.row.id);
    expect(testEnv.__r2.deleted).toContain('lists/alice/branch-office');
    expect(testEnv.__db.lists).toHaveLength(0);
  });
});
