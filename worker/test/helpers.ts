import type { Env, ListRow, User } from '../src/types';
import { sha256Hex } from '../src/services/crypto';

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  last_seen_at: string | null;
}

export class MemoryKV {
  store = new Map<string, { value: string; metadata?: unknown }>();
  deleted: string[] = [];

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }

  async getWithMetadata<T = unknown>(key: string): Promise<{ value: string | null; metadata: T | null }> {
    const item = this.store.get(key);
    return {
      value: item?.value ?? null,
      metadata: (item?.metadata as T | undefined) ?? null
    };
  }

  async put(key: string, value: string, options?: { metadata?: unknown }): Promise<void> {
    this.store.set(key, { value, metadata: options?.metadata });
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.store.delete(key);
  }
}

export class MemoryR2 {
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

export class MemoryQueue<T = unknown> {
  messages: T[] = [];

  async send(message: T): Promise<void> {
    this.messages.push(message);
  }
}

export class MemoryD1 {
  users: User[] = [];
  sessions: SessionRow[] = [];
  lists: ListRow[] = [];
  sessionLastSeenUpdates = 0;
  syncedListIds: string[] = [];

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
    if (this.sql.includes('SELECT *') && this.sql.includes('FROM users') && this.sql.includes('WHERE id = ?')) {
      const [id] = this.values;
      return (this.db.users.find((row) => row.id === id && row.status === 'active') ?? null) as T | null;
    }

    if (this.sql.includes('FROM sessions') && this.sql.includes('JOIN users')) {
      const [tokenHash] = this.values;
      const session = this.db.sessions.find((row) => row.token_hash === tokenHash);
      if (!session) return null;
      const user = this.db.users.find((row) => row.id === session.user_id);
      if (!user) return null;
      return { session_id: session.id, last_seen_at: session.last_seen_at, ...user } as T;
    }

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

    if (this.sql.includes('FROM lists') && this.sql.includes('JOIN users') && this.sql.includes('lists.id = ?')) {
      const [listId, userId] = this.values;
      const user = this.db.users.find((row) => row.id === userId && row.status === 'active');
      if (!user) return null;
      const list = this.db.lists.find((row) => row.id === listId && row.user_id === userId);
      if (!list) return null;
      return {
        ...list,
        username: user.username,
        item_quota_per_list: user.item_quota_per_list
      } as T;
    }

    if (this.sql.includes('FROM lists') && this.sql.includes('JOIN users') && this.sql.includes('users.username = ?')) {
      const [username, slug] = this.values;
      const user = this.db.users.find((row) => row.username === username && row.status === 'active');
      if (!user) return null;
      const list = this.db.lists.find((row) => row.user_id === user.id && row.slug === slug);
      if (!list) return null;
      return {
        content: list.content,
        compiled_hash: list.compiled_hash,
        item_count: list.item_count,
        visibility: list.visibility,
        private_token_policy: list.private_token_policy,
        raw_token_hash: list.raw_token_hash,
        updated_at: list.updated_at
      } as T;
    }

    if (this.sql.includes('COUNT(*) AS list_count')) {
      const [userId] = this.values;
      const lists = this.db.lists.filter((row) => row.user_id === userId);
      return {
        list_count: lists.length,
        total_items: lists.reduce((sum, row) => sum + row.item_count, 0),
        max_items: Math.max(0, ...lists.map((row) => row.item_count)),
        public_lists: lists.filter((row) => row.visibility === 'public').length,
        private_lists: lists.filter((row) => row.visibility === 'private').length,
        synced_lists: lists.filter((row) => row.external_sync_enabled === 1).length
      } as T;
    }

    throw new Error(`Unhandled first SQL: ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('JOIN users') && this.sql.includes('external_sync_enabled = 1')) {
      const now = new Date().toISOString();
      const rows = this.db.lists
        .filter((list) => {
          const user = this.db.users.find((item) => item.id === list.user_id);
          return list.external_sync_enabled === 1
            && user?.status === 'active'
            && list.last_sync_status !== 'queued'
            && (!this.sql.includes('next_sync_at') || list.next_sync_at === null || list.next_sync_at <= now);
        })
        .sort(compareSyncPriority)
        .slice(0, this.sql.includes('LIMIT 100') ? 100 : 50)
        .map((list) => {
          const user = this.db.users.find((item) => item.id === list.user_id);
          return {
            ...list,
            username: user?.username,
            item_quota_per_list: user?.item_quota_per_list
          };
        });
      return { results: rows as T[] };
    }

    if (this.sql.includes('SELECT *') && this.sql.includes('FROM lists') && this.sql.includes('WHERE user_id = ?')) {
      const [userId] = this.values;
      return { results: this.db.lists.filter((row) => row.user_id === userId) as T[] };
    }

    throw new Error(`Unhandled all SQL: ${this.sql}`);
  }

  async run(): Promise<D1Result> {
    if (this.sql.includes('UPDATE sessions SET last_seen_at')) {
      const [sessionId] = this.values;
      const session = this.db.sessions.find((row) => row.id === sessionId);
      if (session) session.last_seen_at = new Date().toISOString();
      this.db.sessionLastSeenUpdates += 1;
      return d1Result(1);
    }

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
      return d1Result(1);
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
      return d1Result(row ? 1 : 0);
    }

    if (this.sql.includes("last_sync_status = 'queued'")) {
      const [id, userId] = this.values;
      const row = this.db.lists.find((item) => (
        item.id === id
        && item.user_id === userId
        && item.external_sync_enabled === 1
        && item.last_sync_status !== 'queued'
      ));
      if (row) {
        row.last_sync_status = 'queued';
        row.last_sync_error = null;
        row.next_sync_at = null;
        row.updated_at = new Date().toISOString();
      }
      return d1Result(row ? 1 : 0);
    }

    if (this.sql.includes('UPDATE lists') && this.sql.includes("last_sync_status = 'failed'")) {
      const [lastSyncError, nextSyncOrId, failureCount, maybeId] = this.values;
      const id = maybeId ?? nextSyncOrId;
      const row = this.db.lists.find((item) => item.id === id);
      if (row) {
        row.last_sync_status = 'failed';
        row.last_sync_error = lastSyncError as string;
        row.last_synced_at = new Date().toISOString();
        if (maybeId !== undefined) {
          row.next_sync_at = addHours(String(nextSyncOrId));
          row.sync_failure_count = failureCount as number;
        } else if (this.sql.includes('sync_failure_count = sync_failure_count + 1')) {
          row.next_sync_at = addHours('+1 hour');
          row.sync_failure_count += 1;
        }
      }
      return d1Result(row ? 1 : 0);
    }

    if (this.sql.includes('UPDATE lists') && this.sql.includes("last_sync_status = 'ok'")) {
      const [compiledHash, itemCount, id] = this.values;
      const row = this.db.lists.find((item) => item.id === id);
      if (row) {
        this.db.syncedListIds.push(String(id));
        row.compiled_hash = compiledHash as string;
        row.item_count = itemCount as number;
        row.last_sync_status = 'ok';
        row.last_sync_error = null;
        row.last_synced_at = new Date().toISOString();
        row.next_sync_at = addHours('+24 hours');
        row.sync_failure_count = 0;
        row.updated_at = new Date().toISOString();
      }
      return d1Result(row ? 1 : 0);
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
      return d1Result(row ? 1 : 0);
    }

    if (this.sql.includes('DELETE FROM lists')) {
      const [id, userId] = this.values;
      this.db.lists = this.db.lists.filter((row) => row.id !== id || row.user_id !== userId);
      return d1Result(1);
    }

    throw new Error(`Unhandled run SQL: ${this.sql}`);
  }
}

function d1Result(rowsWritten: number): D1Result {
  return {
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: rowsWritten
    },
    results: []
  } as unknown as D1Result;
}

function addHours(modifier: string): string {
  const match = /^\+(\d+) hours?$/.exec(modifier);
  const hours = match ? Number(match[1]) : 0;
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function compareSyncPriority(a: ListRow, b: ListRow): number {
  if (a.last_synced_at === null && b.last_synced_at !== null) return -1;
  if (a.last_synced_at !== null && b.last_synced_at === null) return 1;

  const lastSynced = compareNullableDate(a.last_synced_at, b.last_synced_at);
  if (lastSynced !== 0) return lastSynced;

  const created = compareNullableDate(a.created_at, b.created_at);
  if (created !== 0) return created;

  return a.id.localeCompare(b.id);
}

function compareNullableDate(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a.localeCompare(b);
}

export const testUser: User = {
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

export function createTestEnv(user: User = testUser) {
  const db = new MemoryD1();
  const kv = new MemoryKV();
  const r2 = new MemoryR2();
  const queue = new MemoryQueue();
  db.users.push(user);
  return {
    DB: db as unknown as D1Database,
    LISTS_KV: kv as unknown as KVNamespace,
    LISTS_R2: r2 as unknown as R2Bucket,
    SYNC_QUEUE: queue as unknown as Queue,
    APP_ORIGIN: 'https://listips.test',
    SESSION_SECRET: 'test-secret',
    GITHUB_CLIENT_ID: 'test',
    GITHUB_CLIENT_SECRET: 'test',
    GITHUB_OAUTH_REDIRECT_URI: 'https://listips.test/api/auth/github/callback',
    RAW_LIST_CACHE_SECONDS: '60',
    OBSERVABILITY_SAMPLE_RATE: '0',
    MAX_LISTS_PER_USER: '100',
    MAX_LIST_ITEMS: '500',
    MAX_LIST_BODY_BYTES: '524288',
    EXTERNAL_SOURCE_ALLOWED_HOSTS: '*.cloudflare.com,*.githubusercontent.com,*.amazonaws.com',
    __db: db,
    __kv: kv,
    __r2: r2,
    __queue: queue
  } as Env & { __db: MemoryD1; __kv: MemoryKV; __r2: MemoryR2; __queue: MemoryQueue };
}

export async function createSession(env: Env & { __db: MemoryD1 }, userId = testUser.id, token = 'test-session', lastSeenAt: string | null = null) {
  env.__db.sessions.push({
    id: 'sess_1',
    user_id: userId,
    token_hash: await sha256Hex(`${env.SESSION_SECRET}:${token}`),
    expires_at: '2099-01-01T00:00:00Z',
    last_seen_at: lastSeenAt
  });
  return token;
}
