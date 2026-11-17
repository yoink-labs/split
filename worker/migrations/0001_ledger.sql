CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, currency TEXT NOT NULL, creator TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE members (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), user_id TEXT, name TEXT NOT NULL, UNIQUE(group_id,user_id));
CREATE INDEX members_user ON members(user_id,group_id);
CREATE TABLE entries (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), author TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX entries_group ON entries(group_id,created_at);
CREATE TABLE invites (token_hash TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), member_id TEXT NOT NULL REFERENCES members(id), expires_at INTEGER NOT NULL);
CREATE INDEX invites_member ON invites(member_id);
