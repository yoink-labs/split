-- Per-user email switches. A missing row means the kind is on.
CREATE TABLE email_preferences (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);
-- Activity waiting for the next digest. sent_at stays set so a retried
-- request cannot queue the same update twice.
CREATE TABLE email_activity (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  UNIQUE (user_id, kind, ref_id)
);
CREATE INDEX email_activity_pending ON email_activity(sent_at, user_id, group_id);
CREATE INDEX email_activity_created_at ON email_activity(created_at);
-- At most one activity email per user per group per digest window.
CREATE TABLE email_digest_sends (
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_id)
);
