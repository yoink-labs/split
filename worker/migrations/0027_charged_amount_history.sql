CREATE TABLE charged_amount_history (
  id INTEGER PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  previous_currency TEXT,
  previous_amount INTEGER,
  charged_currency TEXT,
  charged_amount INTEGER,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX charged_amount_history_entry ON charged_amount_history(entry_id, id);

CREATE TRIGGER record_charged_amount_edit
AFTER UPDATE OF payload ON entries
WHEN json_extract(OLD.payload, '$.exchange.statementAmount')
       IS NOT json_extract(NEW.payload, '$.exchange.statementAmount')
  OR (json_extract(NEW.payload, '$.exchange.statementAmount') IS NOT NULL
      AND json_extract(OLD.payload, '$.exchange.target') IS NOT json_extract(NEW.payload, '$.exchange.target'))
BEGIN
  INSERT INTO charged_amount_history(entry_id, previous_currency, previous_amount, charged_currency, charged_amount)
  VALUES (
    NEW.id,
    CASE WHEN json_extract(OLD.payload, '$.exchange.statementAmount') IS NOT NULL
      THEN json_extract(OLD.payload, '$.exchange.target') END,
    json_extract(OLD.payload, '$.exchange.statementAmount'),
    CASE WHEN json_extract(NEW.payload, '$.exchange.statementAmount') IS NOT NULL
      THEN json_extract(NEW.payload, '$.exchange.target') END,
    json_extract(NEW.payload, '$.exchange.statementAmount')
  );
END;
