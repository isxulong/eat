-- 迁移：分类标签
-- 用法：wrangler d1 execute eat-db --remote --file=./migrations/001-tags.sql
-- 幂等：可重复执行。

CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,
  wheel_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '',
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS option_tags (
  option_id TEXT NOT NULL,
  tag_id    TEXT NOT NULL,
  PRIMARY KEY (option_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_option_tags_tag ON option_tags (tag_id);
CREATE INDEX IF NOT EXISTS idx_option_tags_opt ON option_tags (option_id);
