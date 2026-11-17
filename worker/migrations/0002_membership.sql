-- Separate tables keep build 2's positional inserts compatible during rollout.
CREATE TABLE split_profiles (
  user_id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT COLLATE NOCASE,
  email TEXT COLLATE NOCASE, refreshed_at INTEGER NOT NULL
);
CREATE INDEX profile_email ON split_profiles(email);
CREATE INDEX profile_username ON split_profiles(username);
CREATE TABLE member_contacts (
  member_id TEXT PRIMARY KEY REFERENCES members(id), email TEXT COLLATE NOCASE, phone TEXT
);
CREATE INDEX contact_email ON member_contacts(email);
CREATE TABLE member_aliases (
  member_id TEXT PRIMARY KEY REFERENCES members(id), canonical_id TEXT NOT NULL REFERENCES members(id)
);
CREATE TABLE group_invites (
  token_hash TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), expires_at INTEGER NOT NULL
);
CREATE INDEX group_invite_expiry ON group_invites(expires_at);
CREATE TABLE lookup_limits (user_id TEXT PRIMARY KEY, hour INTEGER NOT NULL, attempts INTEGER NOT NULL);
CREATE TABLE deleted_entries (entry_id TEXT PRIMARY KEY REFERENCES entries(id));
CREATE TRIGGER member_capacity BEFORE INSERT ON members
WHEN (SELECT count(*) FROM members m WHERE m.group_id=NEW.group_id AND NOT EXISTS
  (SELECT 1 FROM member_aliases a WHERE a.member_id=m.id)) >= 50
BEGIN SELECT RAISE(ABORT, 'Group is full'); END;
CREATE TRIGGER account_capacity BEFORE INSERT ON members
WHEN NEW.user_id IS NOT NULL AND (SELECT count(*) FROM members WHERE user_id=NEW.user_id) >= 100
BEGIN SELECT RAISE(ABORT, 'Account group limit reached'); END;
CREATE TRIGGER claim_capacity BEFORE UPDATE OF user_id ON members
WHEN OLD.user_id IS NULL AND NEW.user_id IS NOT NULL AND (SELECT count(*) FROM members WHERE user_id=NEW.user_id) >= 100
BEGIN SELECT RAISE(ABORT, 'Account group limit reached'); END;
