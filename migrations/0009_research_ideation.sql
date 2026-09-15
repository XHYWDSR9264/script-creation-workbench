CREATE TABLE IF NOT EXISTS research_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  reference_titles TEXT NOT NULL DEFAULT '',
  market_notes TEXT NOT NULL DEFAULT '',
  requested_count INTEGER NOT NULL DEFAULT 5,
  analysis_summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_research_sessions_updated
  ON research_sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS research_candidates (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  genre TEXT NOT NULL DEFAULT '',
  hook TEXT NOT NULL DEFAULT '',
  core_conflict TEXT NOT NULL DEFAULT '',
  innovation TEXT NOT NULL DEFAULT '',
  episode_recommendation INTEGER NOT NULL DEFAULT 50,
  score REAL NOT NULL DEFAULT 0,
  risks TEXT NOT NULL DEFAULT '',
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES research_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_research_candidates_session
  ON research_candidates(session_id, score DESC, created_at);

ALTER TABLE project_profiles ADD COLUMN origin_research_id TEXT;
ALTER TABLE project_profiles ADD COLUMN origin_candidate_id TEXT;
