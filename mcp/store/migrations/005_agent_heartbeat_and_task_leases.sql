ALTER TABLE agents ADD COLUMN last_heartbeat_at TEXT;

ALTER TABLE tasks ADD COLUMN lease_owner_agent_id TEXT;
ALTER TABLE tasks ADD COLUMN lease_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_team_heartbeat
  ON agents(team_id, last_heartbeat_at);

CREATE INDEX IF NOT EXISTS idx_tasks_team_lease
  ON tasks(team_id, status, lease_expires_at);
