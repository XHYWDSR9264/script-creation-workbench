CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  route TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

INSERT OR IGNORE INTO projects(id,name,route,note,created_at,updated_at) VALUES
('p-退婚药','退婚当天，我押十箱救命药闯雪关','定制卡点扩写','第1—10集 · 待人工确认','2026-09-12T10:00:00Z','2026-09-12T10:00:00Z'),
('p-绑手车祸','绑手砸车造车祸，转头我包下整条货运线','定制卡点扩写','一卡规划 · 已保存','2026-09-12T09:00:00Z','2026-09-12T09:00:00Z'),
('p-倒计时','倒计时爱人','海外原创','第1—10集 · 待朱雀','2026-09-12T08:00:00Z','2026-09-12T08:00:00Z');

CREATE TABLE IF NOT EXISTS project_profiles (
  project_id TEXT PRIMARY KEY,
  region TEXT NOT NULL DEFAULT '国内', medium TEXT NOT NULL DEFAULT 'AI漫剧',
  genre TEXT NOT NULL DEFAULT '待设定', total_episodes INTEGER NOT NULL DEFAULT 60,
  submission_start INTEGER NOT NULL DEFAULT 1, submission_end INTEGER NOT NULL DEFAULT 10,
  opening_template TEXT NOT NULL DEFAULT '老王模板', current_stage TEXT NOT NULL DEFAULT 'G0 立项与参数',
  progress INTEGER NOT NULL DEFAULT 10, status TEXT NOT NULL DEFAULT '待立项', updated_at TEXT NOT NULL,
  duration_min_seconds INTEGER NOT NULL DEFAULT 120, duration_max_seconds INTEGER NOT NULL DEFAULT 180,
  calibration_threshold INTEGER NOT NULL DEFAULT 85, quality_threshold INTEGER NOT NULL DEFAULT 90,
  zhuque_threshold REAL NOT NULL DEFAULT 85, one_scene_each INTEGER NOT NULL DEFAULT 1,
  zhuque_required INTEGER NOT NULL DEFAULT 1,
  origin_research_id TEXT, origin_candidate_id TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS story_assets (
  project_id TEXT NOT NULL, asset_type TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, asset_type), FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS draft_versions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, label TEXT NOT NULL,
  range_start INTEGER NOT NULL, range_end INTEGER NOT NULL, content TEXT NOT NULL,
  sha256 TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS gates (
  project_id TEXT NOT NULL, gate_code TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, gate_code), FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS source_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  object_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  extracted_text TEXT NOT NULL DEFAULT '',
  extraction_status TEXT NOT NULL DEFAULT 'stored',
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_source_documents_project
ON source_documents(project_id, created_at DESC);

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
  audit_type TEXT NOT NULL DEFAULT 'structural',
  dimensions_json TEXT NOT NULL DEFAULT '{}',
  reverse_checks_json TEXT NOT NULL DEFAULT '{}',
  hard_errors_json TEXT NOT NULL DEFAULT '[]',
  core_floor_pass INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(version_id) REFERENCES draft_versions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_audit_reports_project ON audit_reports(project_id, created_at DESC);

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
CREATE INDEX IF NOT EXISTS idx_detector_reports_project ON detector_reports(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_type TEXT NOT NULL,
  instruction TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0, output_preview TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '', version_id TEXT, retry_of TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(version_id) REFERENCES draft_versions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_task_runs_project ON task_runs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS continuity_entries (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, category TEXT NOT NULL,
  subject TEXT NOT NULL, state TEXT NOT NULL DEFAULT '', first_episode INTEGER,
  last_episode INTEGER, source_version_id TEXT, status TEXT NOT NULL DEFAULT 'active',
  notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(source_version_id) REFERENCES draft_versions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_continuity_entries_project ON continuity_entries(project_id, category, subject);

CREATE TABLE IF NOT EXISTS approval_records (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, gate_code TEXT NOT NULL,
  decision TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', version_id TEXT,
  sha256 TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL DEFAULT 'operator', created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(version_id) REFERENCES draft_versions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_records_project ON approval_records(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS quality_reviews (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version_id TEXT NOT NULL,
  score REAL NOT NULL, note TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL DEFAULT 'operator',
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(version_id) REFERENCES draft_versions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_quality_reviews_project ON quality_reviews(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS research_sessions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '',
  reference_titles TEXT NOT NULL DEFAULT '', market_notes TEXT NOT NULL DEFAULT '',
  requested_count INTEGER NOT NULL DEFAULT 5, analysis_summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft', error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_sessions_updated ON research_sessions(updated_at DESC);
CREATE TABLE IF NOT EXISTS research_candidates (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL,
  genre TEXT NOT NULL DEFAULT '', hook TEXT NOT NULL DEFAULT '',
  core_conflict TEXT NOT NULL DEFAULT '', innovation TEXT NOT NULL DEFAULT '',
  episode_recommendation INTEGER NOT NULL DEFAULT 50, score REAL NOT NULL DEFAULT 0,
  risks TEXT NOT NULL DEFAULT '', raw_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES research_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_research_candidates_session ON research_candidates(session_id, score DESC, created_at);

INSERT OR IGNORE INTO project_profiles(project_id,genre,current_stage,progress,status,updated_at)
SELECT id,'待设定','G0 立项与参数',10,'待立项',updated_at FROM projects;
INSERT OR IGNORE INTO gates(project_id,gate_code,title,status,note,updated_at)
SELECT id,'G0','立项与参数','current','等待参数确认',updated_at FROM projects;
INSERT OR IGNORE INTO gates(project_id,gate_code,title,status,note,updated_at)
SELECT id,'G1','方案与卡点','pending','未开始',updated_at FROM projects;
INSERT OR IGNORE INTO gates(project_id,gate_code,title,status,note,updated_at)
SELECT id,'G2','第1—3集校准','pending','未开始',updated_at FROM projects;
INSERT OR IGNORE INTO gates(project_id,gate_code,title,status,note,updated_at)
SELECT id,'G3','批次创作','pending','未开始',updated_at FROM projects;
INSERT OR IGNORE INTO gates(project_id,gate_code,title,status,note,updated_at)
SELECT id,'G4','内容终审','pending','未开始',updated_at FROM projects;
INSERT OR IGNORE INTO gates(project_id,gate_code,title,status,note,updated_at)
SELECT id,'G5','朱雀同版检测','pending','未开始',updated_at FROM projects;
INSERT OR IGNORE INTO gates(project_id,gate_code,title,status,note,updated_at)
SELECT id,'G6','交付与归档','pending','未开始',updated_at FROM projects;
INSERT OR IGNORE INTO story_assets(project_id,asset_type,content,version,updated_at)
SELECT id,'synopsis','',1,updated_at FROM projects;
INSERT OR IGNORE INTO story_assets(project_id,asset_type,content,version,updated_at)
SELECT id,'characters','',1,updated_at FROM projects;
INSERT OR IGNORE INTO story_assets(project_id,asset_type,content,version,updated_at)
SELECT id,'world','',1,updated_at FROM projects;
INSERT OR IGNORE INTO story_assets(project_id,asset_type,content,version,updated_at)
SELECT id,'beat_matrix','',1,updated_at FROM projects;
