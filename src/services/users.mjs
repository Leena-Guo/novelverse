import { get, all, run } from '../db.mjs';
import { mapBook } from './books.mjs';

export function ensureUser(id, name = '书友') {
  if (!id) return null;
  const cur = get('SELECT * FROM users WHERE id=?', id);
  if (cur) return cur;
  run('INSERT INTO users(id, name) VALUES(?,?)', id, name);
  return get('SELECT * FROM users WHERE id=?', id);
}

export function addToShelf(userId, bookId) {
  ensureUser(userId);
  run('INSERT INTO bookshelf(user_id, book_id) VALUES(?,?) ON CONFLICT(user_id, book_id) DO NOTHING', userId, Number(bookId));
}

export function removeFromShelf(userId, bookId) {
  run('DELETE FROM bookshelf WHERE user_id=? AND book_id=?', userId, Number(bookId));
}

export function isOnShelf(userId, bookId) {
  return !!get('SELECT 1 AS x FROM bookshelf WHERE user_id=? AND book_id=?', userId, Number(bookId));
}

export function getShelf(userId) {
  const rows = all(
    `SELECT b.*, s.created_at AS shelf_at, h.chapter_idx AS progress_idx
     FROM bookshelf s
     JOIN books b ON b.id = s.book_id
     LEFT JOIN history h ON h.user_id = s.user_id AND h.book_id = s.book_id
     WHERE s.user_id=?
     ORDER BY s.created_at DESC`,
    userId,
  );
  return rows.map((r) =>
    mapBook(r, {
      shelfAt: r.shelf_at,
      progress: r.progress_idx || 1,
    }),
  );
}

export function recordHistory(userId, bookId, chapterIdx = 1) {
  ensureUser(userId);
  run(
    `INSERT INTO history(user_id, book_id, chapter_idx, updated_at) VALUES(?,?,?,datetime('now'))
     ON CONFLICT(user_id, book_id) DO UPDATE SET chapter_idx=excluded.chapter_idx, updated_at=datetime('now')`,
    userId,
    Number(bookId),
    Number(chapterIdx) || 1,
  );
}

export function getHistory(userId, limit = 60) {
  const rows = all(
    `SELECT b.*, h.chapter_idx AS progress_idx, h.updated_at AS read_at,
            (SELECT title FROM chapters WHERE book_id=b.id AND idx=h.chapter_idx) AS chapter_title
     FROM history h
     JOIN books b ON b.id = h.book_id
     WHERE h.user_id=?
     ORDER BY h.updated_at DESC
     LIMIT ?`,
    userId,
    limit,
  );
  return rows.map((r) =>
    mapBook(r, {
      progress: r.progress_idx || 1,
      chapterTitle: r.chapter_title || '',
      readAt: r.read_at,
    }),
  );
}

export function clearHistory(userId) {
  run('DELETE FROM history WHERE user_id=?', userId);
}

export function removeHistory(userId, bookId) {
  run('DELETE FROM history WHERE user_id=? AND book_id=?', userId, Number(bookId));
}

/** 把访客（本地客户端 id）的书架/阅读记录迁移到账号名下 */
export function migrateGuestData(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return { shelf: 0, history: 0 };
  ensureUser(toId);
  let shelf = 0;
  let history = 0;
  for (const r of all('SELECT book_id, created_at FROM bookshelf WHERE user_id=?', fromId)) {
    run(
      'INSERT INTO bookshelf(user_id, book_id, created_at) VALUES(?,?,?) ON CONFLICT(user_id, book_id) DO NOTHING',
      toId,
      r.book_id,
      r.created_at,
    );
    shelf++;
  }
  for (const r of all('SELECT book_id, chapter_idx, updated_at FROM history WHERE user_id=?', fromId)) {
    run(
      `INSERT INTO history(user_id, book_id, chapter_idx, updated_at) VALUES(?,?,?,?)
       ON CONFLICT(user_id, book_id) DO UPDATE SET chapter_idx=excluded.chapter_idx, updated_at=excluded.updated_at`,
      toId,
      r.book_id,
      r.chapter_idx,
      r.updated_at,
    );
    history++;
  }
  run('DELETE FROM bookshelf WHERE user_id=?', fromId);
  run('DELETE FROM history WHERE user_id=?', fromId);
  return { shelf, history };
}

export function getUserById(id) {
  return id ? get('SELECT * FROM users WHERE id=?', id) : null;
}

export function countUserData(userId) {
  const shelf = get('SELECT COUNT(*) AS n FROM bookshelf WHERE user_id=?', userId)?.n || 0;
  const history = get('SELECT COUNT(*) AS n FROM history WHERE user_id=?', userId)?.n || 0;
  return { shelf, history };
}
