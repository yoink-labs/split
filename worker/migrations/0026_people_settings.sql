CREATE TABLE friendships (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0,1)),
  expires_at INTEGER NOT NULL,
  CHECK (sender <> recipient)
);
CREATE UNIQUE INDEX friendship_pair ON friendships(min(sender,recipient),max(sender,recipient));
CREATE INDEX friendship_sender ON friendships(sender,accepted);
CREATE INDEX friendship_recipient ON friendships(recipient,accepted,expires_at);

CREATE TABLE member_links (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  actor TEXT NOT NULL,
  recipient TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX member_links_group ON member_links(group_id,created_at);
CREATE INDEX member_links_recipient ON member_links(recipient,read_at);
