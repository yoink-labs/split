ALTER TABLE groups ADD COLUMN simplify INTEGER NOT NULL DEFAULT 1;
ALTER TABLE groups ADD COLUMN archived_at TEXT;
CREATE TABLE entry_comments (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  author TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX entry_comments_entry ON entry_comments(entry_id,created_at);
CREATE TABLE entry_reactions (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(entry_id,user_id)
);
