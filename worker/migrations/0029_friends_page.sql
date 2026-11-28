-- Sender-side receipts also exist for undeliverable email requests, so the
-- outgoing list cannot be used to look up Split accounts by email.
CREATE TABLE friend_request_receipts (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  target_key TEXT NOT NULL,
  label TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (sender, target_key)
);

ALTER TABLE account_payment_profiles ADD COLUMN share_with_friends INTEGER NOT NULL DEFAULT 0
  CHECK (share_with_friends IN (0, 1));
