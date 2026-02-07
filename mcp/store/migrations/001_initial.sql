CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  team_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  profile TEXT NOT NULL,
  objective TEXT,
  max_threads INTEGER NOT NULL,
  session_model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_active_at TEXT,
  metadata_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  metadata_json TEXT DEFAULT '{}',
  FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT,
  delivery_mode TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE,
  FOREIGN KEY (from_agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
  FOREIGN KEY (to_agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
  UNIQUE (team_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  ack_at TEXT,
  FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
  UNIQUE (message_id, agent_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL,
  claimed_by TEXT,
  lock_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE,
  FOREIGN KEY (claimed_by) REFERENCES agents(agent_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_by TEXT,
  metadata_json TEXT DEFAULT '{}',
  PRIMARY KEY (artifact_id, version),
  FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE,
  FOREIGN KEY (published_by) REFERENCES agents(agent_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT,
  agent_id TEXT,
  task_id TEXT,
  message_id TEXT,
  artifact_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_team_created ON messages(team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inbox_agent_ack ON inbox(agent_id, ack_at, delivered_at);
CREATE INDEX IF NOT EXISTS idx_tasks_team_status ON tasks(team_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_artifacts_team_artifact ON artifacts(team_id, artifact_id, version);
CREATE INDEX IF NOT EXISTS idx_events_team_created ON run_events(team_id, created_at);
