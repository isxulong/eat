-- 转盘工具 D1 schema
-- 用法：wrangler d1 execute eat-db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS wheels (
  id          TEXT    PRIMARY KEY,
  title       TEXT    NOT NULL DEFAULT '今天吃什么',
  revision    INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS options (
  id          TEXT    PRIMARY KEY,
  wheel_id    TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  weight      REAL    NOT NULL DEFAULT 1,
  disabled    INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_options_wheel ON options (wheel_id, sort, created_at);

-- 分类标签（多对多：一个选项可属于多个分类）
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

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
