CREATE TABLE expense_disputes (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE UNIQUE INDEX expense_disputes_open ON expense_disputes(entry_id) WHERE closed_at IS NULL;

CREATE TABLE expense_dispute_events (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES expense_disputes(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK(action IN ('opened','edited','dismissed','withdrawn')),
  actor TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  comment TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX expense_dispute_events_dispute ON expense_dispute_events(dispute_id, created_at);

CREATE TRIGGER expense_dispute_event_recorded AFTER INSERT ON expense_dispute_events
BEGIN
  INSERT INTO entry_comments(id,entry_id,group_id,author,author_name,body,created_at)
    SELECT NEW.id,e.id,e.group_id,NEW.actor,NEW.actor_name,
      CASE NEW.action WHEN 'opened' THEN 'Disputed' || COALESCE(' (for ' || (
        SELECT group_concat(m.name, ', ') FROM members m WHERE m.group_id=e.group_id AND m.removed_at IS NULL
        AND (m.user_id=e.author OR m.id IN (
          SELECT COALESCE(a.canonical_id,json_extract(p.value,'$.memberID'))
          FROM json_each(COALESCE(json_extract(e.payload,'$.payers'),
            json_array(json_object('memberID',json_extract(e.payload,'$.paidBy'))))) p
          LEFT JOIN member_aliases a ON a.member_id=json_extract(p.value,'$.memberID')
        ))
      ) || ')', '') WHEN 'edited' THEN 'Resolved by editing'
        WHEN 'dismissed' THEN 'Dismissed dispute' ELSE 'Withdrew dispute' END ||
        CASE WHEN NEW.comment='' THEN '' ELSE ': ' || NEW.comment END,NEW.created_at
    FROM expense_disputes d JOIN entries e ON e.id=d.entry_id WHERE d.id=NEW.dispute_id;
  UPDATE entries SET payload=json_set(payload,'$.pending',json('true'))
    WHERE id=(SELECT entry_id FROM expense_disputes WHERE id=NEW.dispute_id) AND NEW.action='opened';
  UPDATE entries SET payload=json_remove(payload,'$.pending','$.pendingNote')
    WHERE id=(SELECT entry_id FROM expense_disputes WHERE id=NEW.dispute_id)
      AND NEW.action<>'opened' AND json_type(payload,'$.pending') IS NOT NULL;
  UPDATE expense_disputes SET closed_at=NEW.created_at WHERE id=NEW.dispute_id AND NEW.action<>'opened';
END;
