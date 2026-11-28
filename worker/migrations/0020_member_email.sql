ALTER TABLE invites ADD COLUMN recipient_email TEXT COLLATE NOCASE;
CREATE TABLE member_email_attempts (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX member_email_attempts_created_at ON member_email_attempts(created_at);
