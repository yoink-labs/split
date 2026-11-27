CREATE TABLE settlement_requests (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  payer_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','cancelled'))
);
CREATE INDEX settlement_requests_author ON settlement_requests(author, status);
CREATE INDEX settlement_requests_recipient ON settlement_requests(recipient_id, status);
CREATE INDEX settlement_requests_group ON settlement_requests(group_id, status);
