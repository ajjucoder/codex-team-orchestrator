CREATE TABLE IF NOT EXISTS agent_decision_reports (
  report_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  decision TEXT NOT NULL,
  summary TEXT NOT NULL,
  confidence REAL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
  UNIQUE(team_id, agent_id, task_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_agent_decision_reports_team_task_revision
  ON agent_decision_reports(team_id, task_id, revision DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_decision_reports_team_created
  ON agent_decision_reports(team_id, created_at DESC, report_id DESC);
