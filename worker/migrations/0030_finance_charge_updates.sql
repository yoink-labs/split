-- Finance may also send the amount a card actually charged for an expense the
-- viewer paid, when the person approves that capability. Existing Finance
-- connections stay read-only.
ALTER TABLE cli_requests ADD COLUMN capabilities TEXT NOT NULL DEFAULT '';
ALTER TABLE cli_tokens ADD COLUMN capabilities TEXT NOT NULL DEFAULT '';

-- One row per Finance charge update: the idempotency record and its audit
-- trail. charged_amount_history (0027) also records the change itself.
CREATE TABLE finance_charge_updates (
  idempotency_key TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  previous_currency TEXT,
  previous_amount INTEGER,
  charged_currency TEXT NOT NULL,
  charged_amount INTEGER NOT NULL,
  rate_e8 INTEGER NOT NULL,
  response TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX finance_charge_updates_entry ON finance_charge_updates(entry_id, created_at);
