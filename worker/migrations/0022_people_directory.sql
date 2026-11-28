-- People search and the invite inbox. Additive only.

-- A missing row means the default: discoverable.
CREATE TABLE people_settings (
  user_id TEXT PRIMARY KEY,
  discoverable INTEGER NOT NULL DEFAULT 1 CHECK (discoverable IN (0, 1)),
  updated_at INTEGER NOT NULL
);

-- Invitations sent to a specific Split account from people search. A row with
-- member_id also lets the recipient claim that placeholder when they accept.
CREATE TABLE direct_invites (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  inviter TEXT NOT NULL,
  member_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (group_id, recipient)
);
CREATE INDEX direct_invites_recipient ON direct_invites(recipient, expires_at);
CREATE INDEX direct_invites_inviter ON direct_invites(inviter, created_at);
CREATE INDEX invites_recipient_email ON invites(recipient_email);
CREATE INDEX profile_name ON split_profiles(name COLLATE NOCASE);

CREATE TRIGGER delete_group_direct_invites BEFORE DELETE ON groups
BEGIN
  DELETE FROM direct_invites WHERE group_id=OLD.id;
END;
