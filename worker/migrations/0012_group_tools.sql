CREATE TABLE group_splits (group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE, weights TEXT NOT NULL);
CREATE TABLE payment_profiles (member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE, details TEXT NOT NULL);
CREATE TABLE recurring (entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, cadence TEXT NOT NULL, due TEXT NOT NULL, anchor INTEGER NOT NULL);
CREATE INDEX recurring_due ON recurring(due);
CREATE TRIGGER stop_deleted_series AFTER INSERT ON deleted_entries BEGIN DELETE FROM recurring WHERE entry_id=NEW.entry_id; END;
