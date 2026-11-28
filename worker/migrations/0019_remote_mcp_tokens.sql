ALTER TABLE cli_tokens ADD COLUMN is_remote INTEGER NOT NULL DEFAULT 0 CHECK (is_remote IN (0, 1));
