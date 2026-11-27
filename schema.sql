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

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
