export interface Env {
  DB: D1Database;
  LISTS_KV: KVNamespace;
  LISTS_R2: R2Bucket;
  SYNC_QUEUE?: Queue<ExternalSyncQueueMessage>;
  RATE_LIMIT_COUNTER?: DurableObjectNamespace;
  APP_ORIGIN: string;
  SESSION_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_OAUTH_REDIRECT_URI: string;
  TURNSTILE_SECRET_KEY?: string;
  RAW_LIST_CACHE_SECONDS: string;
  OBSERVABILITY_SAMPLE_RATE?: string;
  MAX_LISTS_PER_USER: string;
  MAX_LIST_ITEMS: string;
  MAX_LIST_BODY_BYTES: string;
  EXTERNAL_SOURCE_ALLOWED_HOSTS: string;
}

export interface User {
  id: string;
  username: string;
  email: string;
  auth_provider: string;
  auth_subject: string;
  avatar_url: string | null;
  role: string;
  status: string;
  list_quota: number;
  item_quota_per_list: number;
}

export interface ListRow {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: 'public' | 'private';
  mode: 'allowlist' | 'blocklist';
  private_token_policy: 'always' | 'one_time';
  content: string;
  compiled_hash: string | null;
  kv_key: string;
  raw_token_hash: string | null;
  raw_token_prefix: string | null;
  raw_token_ciphertext: string | null;
  item_count: number;
  external_sync_enabled: number;
  external_sources_json: string;
  last_synced_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  next_sync_at: string | null;
  sync_failure_count: number;
  created_at: string;
  updated_at: string;
}

export interface AuthContext {
  user: User;
  sessionId: string;
}

export interface ExternalSyncQueueMessage {
  listId: string;
  userId: string;
  reason: 'save' | 'scheduled';
  queuedAt: string;
}
