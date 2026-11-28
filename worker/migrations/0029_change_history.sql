-- The Worker sets request context inside the transaction that changes the source.
CREATE TABLE history_context (
  id INTEGER PRIMARY KEY CHECK (id=1),
  actor TEXT,
  action TEXT NOT NULL,
  reason TEXT
);
-- IDs survive deletion of their source rows.
CREATE TABLE change_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  actor TEXT,
  member TEXT,
  actor_name TEXT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  type TEXT NOT NULL,
  entity TEXT NOT NULL,
  expense TEXT,
  action TEXT NOT NULL,
  title TEXT,
  reason TEXT,
  previous TEXT,
  current TEXT
);
CREATE INDEX change_history_group ON change_history(group_id,id);
CREATE INDEX change_history_expense ON change_history(group_id,expense,id);
CREATE INDEX change_history_member ON change_history(group_id,member,id);
CREATE INDEX change_history_type ON change_history(group_id,type,id);

CREATE TRIGGER change_history_no_update BEFORE UPDATE ON change_history
BEGIN SELECT RAISE(ABORT,'Change history is append-only'); END;
CREATE TRIGGER change_history_no_delete BEFORE DELETE ON change_history
BEGIN SELECT RAISE(ABORT,'Change history is append-only'); END;

CREATE VIEW history_event AS
  SELECT group_id,type,entity,expense,action,title,previous,current FROM change_history WHERE 0;
CREATE TRIGGER record_history_event INSTEAD OF INSERT ON history_event
BEGIN
  INSERT INTO change_history(group_id,actor,member,actor_name,type,entity,expense,action,title,reason,previous,current)
  SELECT NEW.group_id,c.actor,m.id,COALESCE(m.name,p.name),NEW.type,NEW.entity,NEW.expense,NEW.action,NEW.title,
    c.reason,NEW.previous,NEW.current
  FROM history_context c
  LEFT JOIN members m ON m.group_id=NEW.group_id AND m.user_id=c.actor
  LEFT JOIN split_profiles p ON p.user_id=c.actor;
END;

-- The earlier charged-amount history contains no verified actor or reason.
INSERT INTO change_history(group_id,timestamp,type,entity,expense,action,title,previous,current)
SELECT e.group_id,h.changed_at,'expense',e.id,e.id,'edit',json_extract(e.payload,'$.title'),
  json_object('chargedAmount',h.previous_amount,'chargedCurrency',h.previous_currency),
  json_object('chargedAmount',h.charged_amount,'chargedCurrency',h.charged_currency)
FROM charged_amount_history h JOIN entries e ON e.id=h.entry_id ORDER BY h.changed_at,h.id;

CREATE TRIGGER history_entries_insert AFTER INSERT ON entries
WHEN EXISTS (SELECT 1 FROM history_context)
  AND NOT EXISTS (SELECT 1 FROM settlement_requests s WHERE s.id=NEW.id)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT NEW.group_id, CASE WHEN json_extract(NEW.payload,'$.kind')='refund' AND json_extract(NEW.payload,'$.refundOf') IS NULL THEN 'credit' ELSE json_extract(NEW.payload,'$.kind') END, NEW.id, COALESCE(json_extract(NEW.payload,'$.refundOf'),NEW.id), CASE (SELECT action FROM history_context) WHEN 'combine' THEN 'combine' WHEN 'recurring' THEN 'recurring' ELSE 'add' END, json_extract(NEW.payload,'$.title'),
    NULL,
    NEW.payload;
END;

CREATE TRIGGER history_entries_update AFTER UPDATE ON entries
WHEN EXISTS (SELECT 1 FROM history_context)
  AND OLD.payload IS NOT NEW.payload
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT NEW.group_id, CASE WHEN json_extract(NEW.payload,'$.kind')='refund' AND json_extract(NEW.payload,'$.refundOf') IS NULL THEN 'credit' ELSE json_extract(NEW.payload,'$.kind') END, NEW.id, COALESCE(json_extract(NEW.payload,'$.refundOf'),NEW.id), CASE (SELECT action FROM history_context) WHEN 'claim' THEN 'claim' WHEN 'close' THEN 'close' WHEN 'resolve' THEN 'resolve' ELSE 'edit' END, json_extract(NEW.payload,'$.title'),
    OLD.payload,
    NEW.payload;
END;

CREATE TRIGGER history_tombstone_insert AFTER INSERT ON deleted_entries
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT e.group_id, CASE WHEN json_extract(e.payload,'$.kind')='refund' AND json_extract(e.payload,'$.refundOf') IS NULL THEN 'credit' ELSE json_extract(e.payload,'$.kind') END, e.id, COALESCE(json_extract(e.payload,'$.refundOf'),e.id), CASE (SELECT action FROM history_context) WHEN 'combine' THEN 'combine' WHEN 'uncombine' THEN 'undo-combine' ELSE 'delete' END, json_extract(e.payload,'$.title'),
    e.payload,
    NULL
  FROM entries e WHERE e.id=NEW.entry_id;
END;

CREATE TRIGGER history_tombstone_delete AFTER DELETE ON deleted_entries
WHEN EXISTS (SELECT 1 FROM history_context)
  AND (SELECT action FROM history_context) IN ('restore','uncombine')
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT e.group_id, CASE WHEN json_extract(e.payload,'$.kind')='refund' AND json_extract(e.payload,'$.refundOf') IS NULL THEN 'credit' ELSE json_extract(e.payload,'$.kind') END, e.id, COALESCE(json_extract(e.payload,'$.refundOf'),e.id), CASE (SELECT action FROM history_context) WHEN 'combine' THEN 'combine' WHEN 'uncombine' THEN 'undo-combine' ELSE 'restore' END, json_extract(e.payload,'$.title'),
    NULL,
    e.payload
  FROM entries e WHERE e.id=OLD.entry_id;
END;

CREATE TRIGGER history_settlement_requests_insert AFTER INSERT ON settlement_requests
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT NEW.group_id, 'settlement', NEW.id, NEW.id, 'record', json_extract(NEW.payload,'$.title'),
    NULL,
    json_set(NEW.payload,'$.status',NEW.status);
END;

CREATE TRIGGER history_settlement_requests_update AFTER UPDATE ON settlement_requests
WHEN EXISTS (SELECT 1 FROM history_context)
  AND json_set(OLD.payload,'$.status',OLD.status) IS NOT json_set(NEW.payload,'$.status',NEW.status)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT NEW.group_id, 'settlement', NEW.id, NEW.id, (SELECT action FROM history_context), json_extract(NEW.payload,'$.title'),
    json_set(OLD.payload,'$.status',OLD.status),
    json_set(NEW.payload,'$.status',NEW.status);
END;

CREATE TRIGGER history_groups_insert AFTER INSERT ON groups
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT NEW.id, 'group', NEW.id, NULL, 'add', NEW.name,
    NULL,
    json_object('name',NEW.name,'currency',NEW.currency,'kind',NEW.kind,'description',NEW.description,'startDate',NEW.start_date,'endDate',NEW.end_date,'simplify',NEW.simplify,'archivedAt',NEW.archived_at);
END;

CREATE TRIGGER history_groups_update AFTER UPDATE ON groups
WHEN EXISTS (SELECT 1 FROM history_context)
  AND json_object('name',OLD.name,'currency',OLD.currency,'kind',OLD.kind,'description',OLD.description,'startDate',OLD.start_date,'endDate',OLD.end_date,'simplify',OLD.simplify,'archivedAt',OLD.archived_at) IS NOT json_object('name',NEW.name,'currency',NEW.currency,'kind',NEW.kind,'description',NEW.description,'startDate',NEW.start_date,'endDate',NEW.end_date,'simplify',NEW.simplify,'archivedAt',NEW.archived_at)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT NEW.id, 'group', NEW.id, NULL, 'edit', NEW.name,
    json_object('name',OLD.name,'currency',OLD.currency,'kind',OLD.kind,'description',OLD.description,'startDate',OLD.start_date,'endDate',OLD.end_date,'simplify',OLD.simplify,'archivedAt',OLD.archived_at),
    json_object('name',NEW.name,'currency',NEW.currency,'kind',NEW.kind,'description',NEW.description,'startDate',NEW.start_date,'endDate',NEW.end_date,'simplify',NEW.simplify,'archivedAt',NEW.archived_at);
END;

CREATE TRIGGER history_groups_delete BEFORE DELETE ON groups
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT OLD.id, 'group', OLD.id, NULL, 'delete', OLD.name,
    json_object('name',OLD.name,'currency',OLD.currency,'kind',OLD.kind,'description',OLD.description,'startDate',OLD.start_date,'endDate',OLD.end_date,'simplify',OLD.simplify,'archivedAt',OLD.archived_at),
    NULL;
END;

CREATE TRIGGER history_members_insert AFTER INSERT ON members
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT NEW.group_id, 'member', NEW.id, NULL, 'add', NEW.name,
    NULL,
    json_object('name',NEW.name,'linked',NEW.user_id IS NOT NULL,'removedAt',NEW.removed_at);
END;

CREATE TRIGGER history_members_update AFTER UPDATE ON members
WHEN EXISTS (SELECT 1 FROM history_context)
  AND json_object('name',OLD.name,'linked',OLD.user_id IS NOT NULL,'removedAt',OLD.removed_at) IS NOT json_object('name',NEW.name,'linked',NEW.user_id IS NOT NULL,'removedAt',NEW.removed_at)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT NEW.group_id, 'member', NEW.id, NULL, CASE WHEN OLD.user_id IS NOT NEW.user_id THEN 'link' WHEN NEW.removed_at IS NOT NULL THEN 'remove' WHEN OLD.removed_at IS NOT NULL THEN 'restore' ELSE 'rename' END, NEW.name,
    json_object('name',OLD.name,'linked',OLD.user_id IS NOT NULL,'removedAt',OLD.removed_at),
    json_object('name',NEW.name,'linked',NEW.user_id IS NOT NULL,'removedAt',NEW.removed_at);
END;

CREATE TRIGGER history_members_delete BEFORE DELETE ON members
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT OLD.group_id, 'member', OLD.id, NULL, 'remove', OLD.name,
    json_object('name',OLD.name,'linked',OLD.user_id IS NOT NULL,'removedAt',OLD.removed_at),
    NULL;
END;

CREATE TRIGGER history_member_aliases_insert AFTER INSERT ON member_aliases
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT m.group_id, 'member', NEW.member_id, NULL, 'link', m.name,
    NULL,
    json_object('canonicalMember',NEW.canonical_id)
  FROM members m WHERE m.id=NEW.member_id;
END;

CREATE TRIGGER history_member_aliases_update AFTER UPDATE ON member_aliases
WHEN EXISTS (SELECT 1 FROM history_context)
  AND json_object('canonicalMember',OLD.canonical_id) IS NOT json_object('canonicalMember',NEW.canonical_id)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT m.group_id, 'member', NEW.member_id, NULL, 'edit', m.name,
    json_object('canonicalMember',OLD.canonical_id),
    json_object('canonicalMember',NEW.canonical_id)
  FROM members m WHERE m.id=NEW.member_id;
END;

CREATE TRIGGER history_member_aliases_delete AFTER DELETE ON member_aliases
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT m.group_id, 'member', OLD.member_id, NULL, 'unlink', m.name,
    json_object('canonicalMember',OLD.canonical_id),
    NULL
  FROM members m WHERE m.id=OLD.member_id;
END;

CREATE TRIGGER history_group_splits_insert AFTER INSERT ON group_splits
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT NEW.group_id, 'group', NEW.group_id, NULL, 'edit', NULL,
    NULL,
    json_object('defaultWeights',json(NEW.weights));
END;

CREATE TRIGGER history_group_splits_update AFTER UPDATE ON group_splits
WHEN EXISTS (SELECT 1 FROM history_context)
  AND json_object('defaultWeights',json(OLD.weights)) IS NOT json_object('defaultWeights',json(NEW.weights))
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT NEW.group_id, 'group', NEW.group_id, NULL, 'edit', NULL,
    json_object('defaultWeights',json(OLD.weights)),
    json_object('defaultWeights',json(NEW.weights));
END;

CREATE TRIGGER history_group_splits_delete AFTER DELETE ON group_splits
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT OLD.group_id, 'group', OLD.group_id, NULL, 'edit', NULL,
    json_object('defaultWeights',json(OLD.weights)),
    NULL;
END;

CREATE TRIGGER history_trip_exchange_rates_insert AFTER INSERT ON trip_exchange_rates
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT NEW.group_id, 'group', NEW.group_id, NULL, 'edit', NULL,
    NULL,
    json_object('rateE8',NEW.rate_e8,'currency',NEW.currency);
END;

CREATE TRIGGER history_trip_exchange_rates_update AFTER UPDATE ON trip_exchange_rates
WHEN EXISTS (SELECT 1 FROM history_context)
  AND json_object('rateE8',OLD.rate_e8,'currency',OLD.currency) IS NOT json_object('rateE8',NEW.rate_e8,'currency',NEW.currency)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT NEW.group_id, 'group', NEW.group_id, NULL, 'edit', NULL,
    json_object('rateE8',OLD.rate_e8,'currency',OLD.currency),
    json_object('rateE8',NEW.rate_e8,'currency',NEW.currency);
END;

CREATE TRIGGER history_trip_exchange_rates_delete AFTER DELETE ON trip_exchange_rates
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT OLD.group_id, 'group', OLD.group_id, NULL, 'edit', NULL,
    json_object('rateE8',OLD.rate_e8,'currency',OLD.currency),
    NULL;
END;

CREATE TRIGGER history_recurring_insert AFTER INSERT ON recurring
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT e.group_id, 'expense', NEW.entry_id, NEW.entry_id, 'schedule', json_extract(e.payload,'$.title'),
    NULL,
    json_object('recurrence',NEW.cadence)
  FROM entries e WHERE e.id=NEW.entry_id;
END;

CREATE TRIGGER history_recurring_update AFTER UPDATE ON recurring
WHEN EXISTS (SELECT 1 FROM history_context)
  AND json_object('recurrence',OLD.cadence) IS NOT json_object('recurrence',NEW.cadence)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT e.group_id, 'expense', NEW.entry_id, NEW.entry_id, 'schedule', json_extract(e.payload,'$.title'),
    json_object('recurrence',OLD.cadence),
    json_object('recurrence',NEW.cadence)
  FROM entries e WHERE e.id=NEW.entry_id;
END;

CREATE TRIGGER history_recurring_delete AFTER DELETE ON recurring
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT e.group_id, 'expense', OLD.entry_id, OLD.entry_id, 'schedule', json_extract(e.payload,'$.title'),
    json_object('recurrence',OLD.cadence),
    NULL
  FROM entries e WHERE e.id=OLD.entry_id;
END;

CREATE TRIGGER history_receipts_insert AFTER INSERT ON receipts
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT e.group_id, 'receipt', NEW.id, NEW.entry_id, CASE WHEN (SELECT action FROM history_context)='pair' THEN 'pair' ELSE 'add' END, json_extract(e.payload,'$.title'),
    NULL,
    json_object('expense',NEW.entry_id)
  FROM entries e WHERE e.id=NEW.entry_id;
END;

CREATE TRIGGER history_receipts_update AFTER UPDATE ON receipts
WHEN EXISTS (SELECT 1 FROM history_context)
  AND json_object('expense',OLD.entry_id) IS NOT json_object('expense',NEW.entry_id)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT e.group_id, 'receipt', NEW.id, NEW.entry_id, 'move', json_extract(e.payload,'$.title'),
    json_object('expense',OLD.entry_id),
    json_object('expense',NEW.entry_id)
  FROM entries e WHERE e.id=NEW.entry_id;
END;

CREATE TRIGGER history_receipts_delete AFTER DELETE ON receipts
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT e.group_id, 'receipt', OLD.id, OLD.entry_id, 'detach', json_extract(e.payload,'$.title'),
    json_object('expense',OLD.entry_id),
    NULL
  FROM entries e WHERE e.id=OLD.entry_id;
END;

CREATE TRIGGER history_receipts_move_source AFTER UPDATE ON receipts
WHEN EXISTS (SELECT 1 FROM history_context)
  AND OLD.entry_id IS NOT NEW.entry_id
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT e.group_id, 'receipt', OLD.id, OLD.entry_id, 'move', json_extract(e.payload,'$.title'),
    json_object('expense',OLD.entry_id),
    json_object('expense',NEW.entry_id)
  FROM entries e WHERE e.id=OLD.entry_id;
END;

CREATE TRIGGER history_inbox_receipts_insert AFTER INSERT ON inbox_receipts
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT NEW.group_id, 'receipt', NEW.id, NULL, 'add', NEW.note,
    NULL,
    json_object('note',NEW.note,'uploadedBy',NEW.uploaded_by);
END;

CREATE TRIGGER history_inbox_receipts_delete AFTER DELETE ON inbox_receipts
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT OLD.group_id, 'receipt', OLD.id, NULL, 'delete', OLD.note,
    json_object('note',OLD.note,'uploadedBy',OLD.uploaded_by),
    NULL;
END;

-- Reusing a deleted group's ID could expose its history to a new group.
CREATE TRIGGER history_group_id_reserved BEFORE INSERT ON groups
WHEN EXISTS (SELECT 1 FROM change_history WHERE group_id=NEW.id AND type='group' AND action='delete')
  AND NOT EXISTS (SELECT 1 FROM groups WHERE id=NEW.id)
  AND EXISTS (SELECT 1 FROM history_context)
BEGIN SELECT RAISE(ABORT,'Group ID already used'); END;

CREATE TRIGGER history_combination_insert AFTER INSERT ON expense_combinations
WHEN EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT e.group_id,'expense',e.id,e.id,'combine',json_extract(e.payload,'$.title'),
    NULL,json_object('sources',json(NEW.sources))
  FROM entries e WHERE e.id=NEW.entry_id;
END;

CREATE TRIGGER history_combination_undo AFTER UPDATE OF undone_at ON expense_combinations
WHEN OLD.undone_at IS NULL AND NEW.undone_at IS NOT NULL AND EXISTS (SELECT 1 FROM history_context)
BEGIN
  INSERT INTO history_event(group_id,type,entity,expense,action,title,previous,current)
  SELECT e.group_id,'expense',e.id,e.id,'undo-combine',json_extract(e.payload,'$.title'),
    json_object('sources',json(OLD.sources)),NULL
  FROM entries e WHERE e.id=NEW.entry_id;
END;
