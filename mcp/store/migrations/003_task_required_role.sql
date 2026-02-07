ALTER TABLE tasks ADD COLUMN required_role TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_team_status_role
  ON tasks(team_id, status, required_role, priority);
