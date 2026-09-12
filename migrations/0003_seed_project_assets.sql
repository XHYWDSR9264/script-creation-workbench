INSERT OR IGNORE INTO story_assets(project_id,asset_type,content,version,updated_at)
SELECT id,'synopsis','',1,updated_at FROM projects;
INSERT OR IGNORE INTO story_assets(project_id,asset_type,content,version,updated_at)
SELECT id,'characters','',1,updated_at FROM projects;
INSERT OR IGNORE INTO story_assets(project_id,asset_type,content,version,updated_at)
SELECT id,'world','',1,updated_at FROM projects;
INSERT OR IGNORE INTO story_assets(project_id,asset_type,content,version,updated_at)
SELECT id,'beat_matrix','',1,updated_at FROM projects;
