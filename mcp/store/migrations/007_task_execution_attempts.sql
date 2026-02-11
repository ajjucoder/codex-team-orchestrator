CREATE TABLE IF NOT EXISTS task_execution_attempts (
  execution_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  lease_owner_agent_id TEXT,
  lease_expires_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
  FOREIGN KEY (lease_owner_agent_id) REFERENCES agents(agent_id) ON DELETE SET NULL,
  UNIQUE (team_id, task_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_task_execution_attempts_team_task
  ON task_execution_attempts(team_id, task_id, attempt_no);

CREATE INDEX IF NOT EXISTS idx_task_execution_attempts_status_lease
  ON task_execution_attempts(team_id, status, lease_expires_at);
