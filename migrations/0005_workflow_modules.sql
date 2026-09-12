CREATE TABLE IF NOT EXISTS audit_reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  findings_json TEXT NOT NULL DEFAULT '[]',
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(version_id) REFERENCES draft_versions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_reports_project
ON audit_reports(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS detector_reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  human_score REAL NOT NULL,
  suspected_score REAL NOT NULL DEFAULT 0,
  ai_score REAL NOT NULL DEFAULT 0,
  report_object_key TEXT NOT NULL,
  report_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(version_id) REFERENCES draft_versions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_detector_reports_project
ON detector_reports(project_id, created_at DESC);
