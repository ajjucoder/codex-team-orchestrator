CREATE TABLE IF NOT EXISTS team_wave_state (
  team_id TEXT PRIMARY KEY,
  wave_id INTEGER NOT NULL DEFAULT 0,
  tick_count INTEGER NOT NULL DEFAULT 0,
  dispatched_count INTEGER NOT NULL DEFAULT 0,
  recovered_tasks INTEGER NOT NULL DEFAULT 0,
  cleaned_assignments INTEGER NOT NULL DEFAULT 0,
  dispatched_total INTEGER NOT NULL DEFAULT 0,
  recovered_total INTEGER NOT NULL DEFAULT 0,
  cleaned_total INTEGER NOT NULL DEFAULT 0,
  ready_tasks INTEGER NOT NULL DEFAULT 0,
  in_progress_tasks INTEGER NOT NULL DEFAULT 0,
  blocked_tasks INTEGER NOT NULL DEFAULT 0,
  done_tasks INTEGER NOT NULL DEFAULT 0,
  cancelled_tasks INTEGER NOT NULL DEFAULT 0,
  total_tasks INTEGER NOT NULL DEFAULT 0,
  completion_pct INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_team_wave_state_updated
  ON team_wave_state(updated_at DESC, team_id);
