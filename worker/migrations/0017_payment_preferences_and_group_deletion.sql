CREATE TABLE account_payment_profiles (
  user_id TEXT PRIMARY KEY,
  details TEXT NOT NULL
);

-- The remaining references do not cascade in the original ledger schema.
CREATE TRIGGER delete_group_ledger BEFORE DELETE ON groups
BEGIN
  DELETE FROM invites WHERE group_id=OLD.id;
  DELETE FROM group_invites WHERE group_id=OLD.id;
  DELETE FROM member_aliases WHERE member_id IN (SELECT id FROM members WHERE group_id=OLD.id)
    OR canonical_id IN (SELECT id FROM members WHERE group_id=OLD.id);
  DELETE FROM member_contacts WHERE member_id IN (SELECT id FROM members WHERE group_id=OLD.id);
  DELETE FROM deleted_entries WHERE entry_id IN (SELECT id FROM entries WHERE group_id=OLD.id);
  DELETE FROM entries WHERE group_id=OLD.id;
  DELETE FROM members WHERE group_id=OLD.id;
END;
