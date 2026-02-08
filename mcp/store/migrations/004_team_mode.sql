ALTER TABLE teams ADD COLUMN mode TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_teams_status_mode ON teams(status, mode, updated_at);
