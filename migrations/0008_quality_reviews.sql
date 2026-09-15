CREATE TABLE IF NOT EXISTS quality_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  score REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'operator',
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(version_id) REFERENCES draft_versions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quality_reviews_project
ON quality_reviews(project_id, created_at DESC);
