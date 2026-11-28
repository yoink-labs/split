ALTER TABLE cli_requests ADD COLUMN scope TEXT NOT NULL DEFAULT 'cli' CHECK (scope IN ('cli', 'finance'));
ALTER TABLE cli_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'cli' CHECK (scope IN ('cli', 'finance'));
