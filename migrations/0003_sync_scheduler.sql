ALTER TABLE lists ADD COLUMN next_sync_at TEXT;
ALTER TABLE lists ADD COLUMN sync_failure_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_lists_next_sync_at ON lists(next_sync_at);
