CREATE TABLE IF NOT EXISTS worker_runtime_sessions (
  agent_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  transport_backend TEXT,
  session_ref TEXT,
  pane_ref TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT,
  FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_worker_runtime_sessions_team
  ON worker_runtime_sessions(team_id, lifecycle_state, updated_at);

CREATE INDEX IF NOT EXISTS idx_worker_runtime_sessions_worker
  ON worker_runtime_sessions(worker_id, provider);
