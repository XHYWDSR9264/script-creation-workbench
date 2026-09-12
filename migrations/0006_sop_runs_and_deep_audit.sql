ALTER TABLE project_profiles ADD COLUMN duration_min_seconds INTEGER NOT NULL DEFAULT 120;
ALTER TABLE project_profiles ADD COLUMN duration_max_seconds INTEGER NOT NULL DEFAULT 180;
ALTER TABLE project_profiles ADD COLUMN calibration_threshold INTEGER NOT NULL DEFAULT 85;
ALTER TABLE project_profiles ADD COLUMN quality_threshold INTEGER NOT NULL DEFAULT 90;
ALTER TABLE project_profiles ADD COLUMN zhuque_threshold REAL NOT NULL DEFAULT 85;
ALTER TABLE project_profiles ADD COLUMN one_scene_each INTEGER NOT NULL DEFAULT 1;
ALTER TABLE project_profiles ADD COLUMN zhuque_required INTEGER NOT NULL DEFAULT 1;

ALTER TABLE audit_reports ADD COLUMN audit_type TEXT NOT NULL DEFAULT 'structural';
ALTER TABLE audit_reports ADD COLUMN dimensions_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE audit_reports ADD COLUMN reverse_checks_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE audit_reports ADD COLUMN hard_errors_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE audit_reports ADD COLUMN core_floor_pass INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  output_preview TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(version_id) REFERENCES draft_versions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_task_runs_project
ON task_runs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS approval_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  gate_code TEXT NOT NULL,
  decision TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  version_id TEXT,
  sha256 TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'operator',
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(version_id) REFERENCES draft_versions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_records_project
ON approval_records(project_id, created_at DESC);
