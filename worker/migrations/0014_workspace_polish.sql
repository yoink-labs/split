ALTER TABLE groups ADD COLUMN description TEXT;
ALTER TABLE groups ADD COLUMN start_date TEXT;
ALTER TABLE groups ADD COLUMN end_date TEXT;
ALTER TABLE members ADD COLUMN removed_at TEXT;
CREATE TABLE user_avatars (
  user_id TEXT PRIMARY KEY,
  avatar_url TEXT,
  updated_at TEXT NOT NULL
);
