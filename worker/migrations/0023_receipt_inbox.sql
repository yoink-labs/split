-- Receipts uploaded before their expense exists wait in a group inbox until a member pairs them.
-- Pairing copies the image into receipts and removes the inbox row; moving updates receipts.entry_id.
CREATE TABLE inbox_receipts (
  group_id TEXT NOT NULL,
  id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  user_id TEXT NOT NULL,
  note TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  image BLOB NOT NULL CHECK(length(image) BETWEEN 4 AND 245760),
  PRIMARY KEY(group_id,id)
);
CREATE TRIGGER inbox_receipt_capacity BEFORE INSERT ON inbox_receipts
WHEN (SELECT count(*) FROM inbox_receipts WHERE group_id=NEW.group_id AND id<>NEW.id)>=50
BEGIN SELECT RAISE(ABORT,'Receipt inbox is full'); END;
CREATE TRIGGER inbox_receipt_added AFTER INSERT ON inbox_receipts BEGIN
  UPDATE receipt_usage SET bytes=bytes+length(NEW.image) WHERE id=1;
END;
CREATE TRIGGER inbox_receipt_removed AFTER DELETE ON inbox_receipts BEGIN
  UPDATE receipt_usage SET bytes=bytes-length(OLD.image) WHERE id=1;
END;
CREATE TRIGGER delete_group_inbox_receipts BEFORE DELETE ON groups BEGIN
  DELETE FROM inbox_receipts WHERE group_id=OLD.id;
END;
-- Moving a receipt onto an expense honours the same four-photo limit as attaching one.
CREATE TRIGGER receipt_move_capacity BEFORE UPDATE OF entry_id ON receipts
WHEN NEW.entry_id<>OLD.entry_id AND (SELECT count(*) FROM receipts WHERE entry_id=NEW.entry_id)>=4
BEGIN SELECT RAISE(ABORT,'Receipt limit reached'); END;
