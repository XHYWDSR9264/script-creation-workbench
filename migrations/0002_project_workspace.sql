CREATE TABLE IF NOT EXISTS project_profiles (
  project_id TEXT PRIMARY KEY,
  region TEXT NOT NULL DEFAULT '国内',
  medium TEXT NOT NULL DEFAULT 'AI漫剧',
  genre TEXT NOT NULL DEFAULT '待设定',
  total_episodes INTEGER NOT NULL DEFAULT 60,
  submission_start INTEGER NOT NULL DEFAULT 1,
  submission_end INTEGER NOT NULL DEFAULT 10,
  opening_template TEXT NOT NULL DEFAULT '老王模板',
  current_stage TEXT NOT NULL DEFAULT 'G0 立项与参数',
  progress INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT '待立项',
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS story_assets (
  project_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, asset_type),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS draft_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  label TEXT NOT NULL,
  range_start INTEGER NOT NULL,
  range_end INTEGER NOT NULL,
  content TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS gates (
  project_id TEXT NOT NULL,
  gate_code TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, gate_code),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

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
