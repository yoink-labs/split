CREATE TABLE cli_requests (
  device_hash TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  source_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_by TEXT
);
CREATE INDEX cli_requests_expiry ON cli_requests(expires_at);
CREATE INDEX cli_requests_source ON cli_requests(source_hash);

CREATE TABLE cli_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used INTEGER,
  revoked_at INTEGER
);
CREATE INDEX cli_tokens_user ON cli_tokens(user_id, created_at);
