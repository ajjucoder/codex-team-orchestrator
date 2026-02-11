ALTER TABLE messages RENAME TO messages_legacy_008;

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT,
  delivery_mode TEXT NOT NULL,
  route_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  idempotency_scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE,
  FOREIGN KEY (from_agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
  FOREIGN KEY (to_agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
  UNIQUE (team_id, idempotency_scope, idempotency_key)
);

INSERT INTO messages(
  message_id,
  team_id,
  from_agent_id,
  to_agent_id,
  delivery_mode,
  route_key,
  payload_json,
  idempotency_key,
  idempotency_scope,
  created_at
)
SELECT
  message_id,
  team_id,
  from_agent_id,
  to_agent_id,
  delivery_mode,
  CASE
    WHEN delivery_mode = 'direct' THEN 'direct:' || from_agent_id || '->' || COALESCE(to_agent_id, '')
    WHEN delivery_mode = 'broadcast' THEN 'broadcast:' || from_agent_id
    ELSE COALESCE(delivery_mode, 'unknown') || ':' || from_agent_id || '->' || COALESCE(to_agent_id, '')
  END AS route_key,
  payload_json,
  idempotency_key,
  CASE
    WHEN delivery_mode = 'direct' THEN 'direct:' || from_agent_id || '->' || COALESCE(to_agent_id, '')
    WHEN delivery_mode = 'broadcast' THEN 'broadcast:' || from_agent_id
    ELSE COALESCE(delivery_mode, 'unknown') || ':' || from_agent_id || '->' || COALESCE(to_agent_id, '')
  END AS idempotency_scope,
  created_at
FROM messages_legacy_008;

ALTER TABLE inbox RENAME TO inbox_legacy_008;

CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  ack_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  dead_letter_at TEXT,
  FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
  UNIQUE (message_id, agent_id)
);

INSERT INTO inbox(
  id,
  message_id,
  team_id,
  agent_id,
  delivered_at,
  ack_at,
  attempt_count,
  next_attempt_at,
  last_attempt_at,
  last_error,
  dead_letter_at
)
SELECT
  id,
  message_id,
  team_id,
  agent_id,
  delivered_at,
  ack_at,
  0,
  delivered_at,
  NULL,
  NULL,
  NULL
FROM inbox_legacy_008;

DROP TABLE inbox_legacy_008;
DROP TABLE messages_legacy_008;

CREATE INDEX IF NOT EXISTS idx_messages_team_created ON messages(team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_scope_idempotency
  ON messages(team_id, idempotency_scope, idempotency_key, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_route_created
  ON messages(team_id, route_key, created_at);

CREATE INDEX IF NOT EXISTS idx_inbox_agent_ack ON inbox(agent_id, ack_at, delivered_at);
CREATE INDEX IF NOT EXISTS idx_inbox_retry_ready
  ON inbox(team_id, agent_id, ack_at, dead_letter_at, next_attempt_at, delivered_at);
CREATE INDEX IF NOT EXISTS idx_inbox_dead_letter
  ON inbox(team_id, dead_letter_at, delivered_at);
