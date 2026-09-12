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
