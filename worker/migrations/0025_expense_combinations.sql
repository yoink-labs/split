CREATE TABLE expense_combinations (
  entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  sources TEXT NOT NULL,
  combined_by TEXT NOT NULL,
  combined_at TEXT NOT NULL,
  undone_by TEXT,
  undone_at TEXT
);

CREATE TABLE active_expense_combination_sources (
  source_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  combined_id TEXT NOT NULL REFERENCES expense_combinations(entry_id) ON DELETE CASCADE
);
CREATE INDEX active_expense_combination_sources_combined ON active_expense_combination_sources(combined_id);

-- Keep the original images at their original keys. The combined ledger entry
-- exposes them through a separate namespace, even if source photo IDs collide.
DROP TRIGGER receipt_cleanup;
CREATE TRIGGER receipt_cleanup AFTER INSERT ON deleted_entries
WHEN NOT EXISTS (
  SELECT 1 FROM active_expense_combination_sources WHERE source_id=NEW.entry_id
)
BEGIN
  DELETE FROM receipts WHERE entry_id=NEW.entry_id;
END;

CREATE TRIGGER expense_combination_hide_sources AFTER INSERT ON expense_combinations
BEGIN
  INSERT INTO active_expense_combination_sources(source_id,combined_id) SELECT value,NEW.entry_id FROM json_each(NEW.sources);
  INSERT INTO deleted_entries(entry_id) SELECT value FROM json_each(NEW.sources);
END;

CREATE TRIGGER expense_combination_restore_sources AFTER UPDATE OF undone_at ON expense_combinations
WHEN OLD.undone_at IS NULL AND NEW.undone_at IS NOT NULL
BEGIN
  DELETE FROM deleted_entries WHERE entry_id IN (SELECT value FROM json_each(NEW.sources));
  DELETE FROM active_expense_combination_sources WHERE combined_id=NEW.entry_id;
  INSERT INTO deleted_entries(entry_id) VALUES (NEW.entry_id);
END;

CREATE VIEW expense_receipts AS
  SELECT entry_id,id,image FROM receipts
  UNION ALL
  SELECT s.combined_id, hex(r.entry_id)||'-'||hex(r.id), r.image
  FROM active_expense_combination_sources s JOIN receipts r ON r.entry_id=s.source_id;
