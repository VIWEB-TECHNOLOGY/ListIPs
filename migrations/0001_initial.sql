PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  auth_provider TEXT NOT NULL DEFAULT 'github',
  auth_subject TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  turnstile_required INTEGER NOT NULL DEFAULT 1,
  list_quota INTEGER NOT NULL DEFAULT 100,
  item_quota_per_list INTEGER NOT NULL DEFAULT 500,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE UNIQUE INDEX idx_users_provider_subject ON users(auth_provider, auth_subject);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  redirect_path TEXT NOT NULL DEFAULT '/dashboard',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_oauth_states_expires_at ON oauth_states(expires_at);

CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  mode TEXT NOT NULL DEFAULT 'allowlist',
  content TEXT NOT NULL DEFAULT '',
  compiled_hash TEXT,
  kv_key TEXT NOT NULL,
  raw_token_hash TEXT,
  raw_token_prefix TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  external_sync_enabled INTEGER NOT NULL DEFAULT 0,
  external_sources_json TEXT NOT NULL DEFAULT '[]',
  last_synced_at TEXT,
  last_sync_status TEXT,
  last_sync_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, slug)
);

CREATE INDEX idx_lists_user_id ON lists(user_id);
CREATE INDEX idx_lists_kv_key ON lists(kv_key);
CREATE INDEX idx_lists_visibility ON lists(visibility);
CREATE INDEX idx_lists_external_sync_enabled ON lists(external_sync_enabled);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_api_tokens_user_id ON api_tokens(user_id);
