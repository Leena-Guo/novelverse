import { get, all } from '../db.mjs';
import { CATEGORIES } from '../config.mjs';
import { truncate } from '../util.mjs';

export function mapBook(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    author: row.author || '佚名',
    category: row.category || '其他小说',
    categoryCode: row.category_code || 0,
    cover: `/api/cover/${row.id}`,
    intro: row.intro || '',
    summary: truncate(row.intro || '', 90),
    status: row.status || '',
    latestChapter: row.latest_chapter || '',
    chapterCount: row.chapter_count || 0,
    wordCount: row.word_count || 0,
    hot: row.hot || 0,
    enriched: !!row.enriched,
    source: row.source,
    sourceId: row.source_id,
    updatedAt: row.source_updated || '',
    tags: String(row.tags || '')
      .split('|')
      .filter(Boolean),
    ...extra,
  };
}

const SORT_SQL = {
  hot: 'hot DESC, id ASC',
  newest: 'id DESC',
  update: "CASE WHEN source_updated='' THEN 1 ELSE 0 END, source_updated DESC, id DESC",
  title: 'title ASC',
};

export function listBooks({ category = 0, sort = 'hot', q = '', tag = '', page = 1, size = 24 } = {}) {
  page = Math.max(1, Number(page) || 1);
  size = Math.min(60, Math.max(1, Number(size) || 24));
  const where = [];
  const params = [];
  if (category) {
    where.push('category_code = ?');
    params.push(Number(category));
  }
  if (tag) {
    where.push('tags LIKE ?');
    params.push(`%|${String(tag).trim()}|%`);
  }
  if (q) {
    where.push('(title LIKE ? OR author LIKE ? OR intro LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const orderSql = SORT_SQL[sort] || SORT_SQL.hot;
  const total = get(`SELECT COUNT(*) AS n FROM books ${whereSql}`, ...params).n;
  const rows = all(
    `SELECT * FROM books ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
    ...params,
    size,
    (page - 1) * size,
  );
  return { total, page, size, pages: Math.ceil(total / size) || 1, books: rows.map((r) => mapBook(r)) };
}

/** 各题材的书籍数量（只返回有书的题材，按数量降序） */
/** 各题材的书籍数量（只返回有书的题材，按数量降序） */
export function getTags() {
  const rows = all("SELECT tags FROM books WHERE tags<>''");
  const counts = new Map();
  for (const r of rows) {
    for (const t of String(r.tags).split('|')) {
      if (t) counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  const out = [...counts.entries()].map(([tag, count]) => ({ tag, count }));
  out.sort((a, b) => b.count - a.count);
  return out;
}

export function getBookDetail(id) {
  const row = get('SELECT * FROM books WHERE id=?', id);
  if (!row) return null;
  const chapters = all(
    'SELECT idx, title, cached, word_count FROM chapters WHERE book_id=? ORDER BY idx ASC LIMIT 12',
    id,
  );
  const latest = all(
    'SELECT idx, title, cached, word_count FROM chapters WHERE book_id=? ORDER BY idx DESC LIMIT 6',
    id,
  );
  return {
    book: mapBook(row),
    chapters: chapters.map((c) => ({ idx: c.idx, title: c.title, cached: !!c.cached })),
    latest: latest.map((c) => ({ idx: c.idx, title: c.title, cached: !!c.cached })),
  };
}

export function getChapters(bookId, { offset = 0, limit = 200, sort = 'asc' } = {}) {
  const total = get('SELECT COUNT(*) AS n FROM chapters WHERE book_id=?', bookId).n;
  const want = Number(limit);
  // limit=0 或非正数以外的 0 → 一次性返回全部（上限 20000，避免异常调用拖垮内存）
  const lim = want === 0 ? 20000 : Math.min(500, want || 200);
  const order = String(sort).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const rows = all(
    `SELECT idx, title, cached, word_count FROM chapters WHERE book_id=? ORDER BY idx ${order} LIMIT ? OFFSET ?`,
    bookId,
    lim,
    Math.max(0, Number(offset) || 0),
  );
  return { total, offset, limit: lim, sort: order.toLowerCase(), chapters: rows.map((c) => ({ idx: c.idx, title: c.title, cached: !!c.cached, words: c.word_count })) };
}

export function getCategories() {
  return CATEGORIES.map((c) => {
    const n = get('SELECT COUNT(*) AS n FROM books WHERE category_code=?', c.code).n;
    return { ...c, count: n };
  });
}

export function homeData() {
  const hot = all('SELECT * FROM books ORDER BY hot DESC, id ASC LIMIT 12').map((r) => mapBook(r));
  const newest = all('SELECT * FROM books ORDER BY id DESC LIMIT 12').map((r) => mapBook(r));
  const updating = all(
    "SELECT * FROM books WHERE source_updated<>'' ORDER BY source_updated DESC, id DESC LIMIT 12",
  ).map((r) => mapBook(r));
  const random = all('SELECT * FROM books ORDER BY RANDOM() LIMIT 12').map((r) => mapBook(r));

  const byCategory = CATEGORIES.slice(0, 6).map((c) => ({
    ...c,
    books: all('SELECT * FROM books WHERE category_code=? ORDER BY hot DESC, id ASC LIMIT 6', c.code).map((r) => mapBook(r)),
  }));

  const banners = all("SELECT * FROM books WHERE intro<>'' ORDER BY hot DESC LIMIT 5").map((r) => mapBook(r));

  return { banners, hot, newest, updating, random, byCategory };
}

export function searchAll(q, { limit = 40 } = {}) {
  const like = `%${q}%`;
  const rows = all(
    'SELECT * FROM books WHERE title LIKE ? OR author LIKE ? ORDER BY hot DESC LIMIT ?',
    like,
    like,
    limit,
  );
  return rows.map((r) => mapBook(r));
}

export function stats() {
  const books = get('SELECT COUNT(*) AS n FROM books').n;
  const chapters = get('SELECT COUNT(*) AS n FROM chapters').n;
  const cached = get('SELECT COUNT(*) AS n FROM chapters WHERE cached=1').n;
  return { books, chapters, cached };
}
