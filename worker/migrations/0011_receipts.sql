CREATE TABLE receipt_usage (id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL CHECK(bytes BETWEEN 0 AND 104857600));
INSERT INTO receipt_usage VALUES (1,0);
CREATE TABLE receipts (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  image BLOB NOT NULL CHECK(length(image) BETWEEN 4 AND 245760),
  PRIMARY KEY(entry_id,id)
);
CREATE TRIGGER receipt_capacity BEFORE INSERT ON receipts
WHEN (SELECT count(*) FROM receipts WHERE entry_id=NEW.entry_id AND id<>NEW.id)>=4
BEGIN SELECT RAISE(ABORT,'Receipt limit reached'); END;
CREATE TRIGGER receipt_added AFTER INSERT ON receipts BEGIN
  UPDATE receipt_usage SET bytes=bytes+length(NEW.image) WHERE id=1;
END;
CREATE TRIGGER receipt_removed AFTER DELETE ON receipts BEGIN
  UPDATE receipt_usage SET bytes=bytes-length(OLD.image) WHERE id=1;
END;
CREATE TRIGGER receipt_cleanup AFTER INSERT ON deleted_entries BEGIN
  DELETE FROM receipts WHERE entry_id=NEW.entry_id;
END;
