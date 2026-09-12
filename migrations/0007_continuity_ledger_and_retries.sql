ALTER TABLE task_runs ADD COLUMN retry_of TEXT;

CREATE TABLE IF NOT EXISTS continuity_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '',
  first_episode INTEGER,
  last_episode INTEGER,
  source_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(source_version_id) REFERENCES draft_versions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_continuity_entries_project
ON continuity_entries(project_id, category, subject);
