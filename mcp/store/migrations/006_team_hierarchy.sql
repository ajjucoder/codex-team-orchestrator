ALTER TABLE teams ADD COLUMN parent_team_id TEXT;
ALTER TABLE teams ADD COLUMN root_team_id TEXT;
ALTER TABLE teams ADD COLUMN hierarchy_depth INTEGER NOT NULL DEFAULT 0;

UPDATE teams
SET root_team_id = team_id
WHERE root_team_id IS NULL OR root_team_id = '';

CREATE TABLE IF NOT EXISTS team_hierarchy (
  ancestor_team_id TEXT NOT NULL,
  descendant_team_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ancestor_team_id, descendant_team_id),
  FOREIGN KEY (ancestor_team_id) REFERENCES teams(team_id) ON DELETE CASCADE,
  FOREIGN KEY (descendant_team_id) REFERENCES teams(team_id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO team_hierarchy(ancestor_team_id, descendant_team_id, depth, created_at)
SELECT team_id, team_id, 0, updated_at FROM teams;

CREATE INDEX IF NOT EXISTS idx_teams_parent ON teams(parent_team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_teams_root_depth ON teams(root_team_id, hierarchy_depth, created_at);
CREATE INDEX IF NOT EXISTS idx_team_hierarchy_ancestor_depth ON team_hierarchy(ancestor_team_id, depth, descendant_team_id);
CREATE INDEX IF NOT EXISTS idx_team_hierarchy_descendant ON team_hierarchy(descendant_team_id, depth, ancestor_team_id);
