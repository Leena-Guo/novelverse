import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, DATA_DIR, COVER_DIR } from './config.mjs';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(COVER_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS books (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  title         TEXT NOT NULL,
  author        TEXT DEFAULT '',
  category      TEXT DEFAULT '',
  category_code INTEGER DEFAULT 0,
  cover         TEXT DEFAULT '',
  intro         TEXT DEFAULT '',
  status        TEXT DEFAULT '',
  word_count    INTEGER DEFAULT 0,
  latest_chapter TEXT DEFAULT '',
  chapter_count INTEGER DEFAULT 0,
  enriched      INTEGER DEFAULT 0,
  hot           INTEGER DEFAULT 0,
  source_updated TEXT DEFAULT '',
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_books_category ON books(category_code);
CREATE INDEX IF NOT EXISTS idx_books_hot ON books(hot);

CREATE TABLE IF NOT EXISTS chapters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL,
  idx         INTEGER NOT NULL,
  title       TEXT NOT NULL,
  source_ref  TEXT NOT NULL,
  cached      INTEGER DEFAULT 0,
  word_count  INTEGER DEFAULT 0,
  UNIQUE(book_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id, idx);

CREATE TABLE IF NOT EXISTS chapter_contents (
  chapter_id INTEGER PRIMARY KEY,
  content    TEXT NOT NULL,
  fetched_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT DEFAULT '访客',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS bookshelf (
  user_id    TEXT NOT NULL,
  book_id    INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE IF NOT EXISTS history (
  user_id     TEXT NOT NULL,
  book_id     INTEGER NOT NULL,
  chapter_idx INTEGER DEFAULT 1,
  updated_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id, updated_at);

CREATE TABLE IF NOT EXISTS crawl_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  detail     TEXT DEFAULT '',
  ok         INTEGER DEFAULT 1,
  count      INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

/* ---------- 轻量迁移：为老库补齐新列 ---------- */
function ensureColumn(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
// 记录每本书最近一次“联网检查更新”的时间，供每日自动更新调度使用
ensureColumn('books', 'last_checked_at', "TEXT DEFAULT ''");
// 题材标签（|标签1|标签2| 形式），支持按题材浏览
ensureColumn('books', 'tags', "TEXT DEFAULT ''");
// 已抓取的目录页数：lite 同步只抓第 1 页，剩余页由后台补齐（enriched=1 表示已全部同步）
ensureColumn('books', 'catalog_pages', 'INTEGER DEFAULT 0');

// 账号体系：在原有 users 表上补齐账号字段（老库为访客记录）
ensureColumn('users', 'username', 'TEXT');
ensureColumn('users', 'password_hash', 'TEXT');
ensureColumn('users', 'salt', 'TEXT');
ensureColumn('users', 'is_account', 'INTEGER DEFAULT 0');
ensureColumn('users', 'updated_at', "TEXT DEFAULT ''");
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL;');

/* ---------- 便捷查询封装 ---------- */

export function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

export function exists(table) {
  return !!get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table);
}

export function getMeta(key, fallback = null) {
  const row = get('SELECT value FROM meta WHERE key=?', key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  run('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
}

export function logCrawl(kind, detail, ok, count = 0) {
  run('INSERT INTO crawl_logs(kind, detail, ok, count) VALUES(?,?,?,?)', kind, detail, ok ? 1 : 0, count);
}
