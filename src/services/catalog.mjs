import { get, all, run, logCrawl, getMeta, setMeta } from '../db.mjs';
import { getSource } from '../crawler/index.mjs';
import { CATEGORIES, config } from '../config.mjs';
import { SORTS } from '../crawler/biqugen.mjs';
import { isBlockedBook, matchedTerms } from '../moderation.mjs';
import { extractTags, tagsToField, GENRE_VERSION } from '../tags.mjs';
import { mapLimit } from '../util.mjs';

const ALL_SORTS = Object.keys(SORTS);

const pick = (a, b) => (a !== undefined && a !== null && String(a).trim() !== '' ? a : b || '');

/** 过滤镜像站的垃圾/SEO 书名 */
const JUNK_TITLE = /(无弹窗|无错版|内容概括|笔趣阁|全文阅读|最新章节|txt下载|免费阅读|在线阅读|手机版|目录列表|章节列表|防盗|盘点|解说)/;
export function isJunkBook(b) {
  const t = String(b?.title || '').trim();
  if (t.length < 2 || t.length > 40) return true;
  if (JUNK_TITLE.test(t)) return true;
  if (/^[\d\s\-—.、]+$/.test(t)) return true;
  return false;
}

/**
 * 过滤目录中夹带的作者公告 / 求票 / 推广 / 节日问候等非正文条目。
 * 镜像站目录里常混入"更新通知""求月票""推荐新书""拜年"等，它们并非章节正文。
 * 关键：真实章节标题通常带"第N章"等标记；只有当标题**不含**章节标记、
 * 且命中公告类关键词时才判定为垃圾，避免误伤"第420章 …求月票"这类正常章节。
 */
const CHAPTER_MARK = /第[\d零一二三四五六七八九十百千万两]+[章节回卷集部篇]|番外|外篇|外传|序章|序言|楔子|尾声|后记|终章|最终章|大结局|收官|完本/;
const JUNK_CHAPTER = /(公告|通知|更新|求票|求月票|月票|推荐|求订阅|求收藏|订阅群|书友群|读者群|QQ群|加更|请假|断更|停更|感言|打赏|签售|新书|说两件事情|说一二三|微博|关注|月底之事|节日快乐|拜年|除夕|春节|新年|元旦|中秋|元宵|端午|七夕|正月十五|恭喜发财|祝大家|祝各位|祝道友)/;
export function isJunkChapter(title) {
  const t = String(title || '').trim();
  if (!t) return true;
  if (CHAPTER_MARK.test(t)) return false;
  if (JUNK_CHAPTER.test(t)) return true;
  return false;
}

/* ------------------------- 书籍写入 ------------------------- */

export function upsertBook(source, b, opts = {}) {
  const cur = get('SELECT * FROM books WHERE source=? AND source_id=?', source, String(b.source_id));
  const hot = Math.max(Number(opts.hot || 0), cur?.hot || 0);

  // 题材标签：从「书名 + 简介」抽取，并与已有标签合并（避免列表页更新时丢掉详情页抽到的标签）
  const mergedTags = extractTags(pick(b.title, cur?.title), pick(b.intro, cur?.intro));
  const existing = String(cur?.tags || '')
    .split('|')
    .filter(Boolean);
  const tagField = tagsToField([...new Set([...existing, ...mergedTags])]);

  if (cur) {
    run(
      `UPDATE books SET title=?, author=?, category=?, category_code=?, cover=?, intro=?,
        status=?, latest_chapter=?, source_updated=?, hot=?, tags=? WHERE id=?`,
      pick(b.title, cur.title),
      pick(b.author, cur.author),
      pick(b.category, cur.category),
      Number(b.category_code) || cur.category_code || 0,
      pick(b.cover, cur.cover),
      pick(b.intro, cur.intro),
      pick(b.status, cur.status),
      pick(b.latest_chapter, cur.latest_chapter),
      pick(b.source_updated, cur.source_updated),
      hot,
      tagField,
      cur.id,
    );
    return cur.id;
  }

  const info = run(
    `INSERT INTO books(source, source_id, title, author, category, category_code, cover, intro, status, latest_chapter, source_updated, hot, tags)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    source,
    String(b.source_id),
    pick(b.title, '未命名'),
    b.author || '',
    b.category || '',
    Number(b.category_code) || 0,
    b.cover || '',
    b.intro || '',
    b.status || '',
    b.latest_chapter || '',
    b.source_updated || '',
    hot,
    tagField,
  );
  return Number(info.lastInsertRowid);
}

function upsertChapter(bookId, idx, title, ref) {
  const cur = get('SELECT id, title, source_ref FROM chapters WHERE book_id=? AND idx=?', bookId, idx);
  if (cur) {
    if (cur.source_ref !== ref) {
      run('UPDATE chapters SET title=?, source_ref=?, cached=0, word_count=0 WHERE id=?', title, ref, cur.id);
      run('DELETE FROM chapter_contents WHERE chapter_id=?', cur.id);
    } else if (cur.title !== title) {
      run('UPDATE chapters SET title=? WHERE id=?', title, cur.id);
    }
    return cur.id;
  }
  const info = run('INSERT INTO chapters(book_id, idx, title, source_ref) VALUES(?,?,?,?)', bookId, idx, title, ref);
  return Number(info.lastInsertRowid);
}

/* ------------------------- 目录同步 ------------------------- */

export async function syncList({ source = 'biqugen', category = 0, sort = 'allvisit', pages = 1, size = 0, status = 0 } = {}) {
  const src = getSource(source);
  let count = 0;
  let ok = true;
  let error = '';
  for (let p = 1; p <= pages; p++) {
    const r = await src.listBooks({ category, sort, page: p, size, status });
    if (!r.ok) {
      ok = false;
      error = r.error;
      break;
    }
    const kept = r.books.filter((b) => !isJunkBook(b) && !isBlockedBook(b));
    kept.forEach((b, i) => upsertBook(source, b, { hot: (pages - p + 1) * 1000 + (100 - i) }));
    count += kept.length;
    if (!r.books.length) break;
  }
  logCrawl('sync-list', `${source} cat=${category} sort=${sort} size=${size} status=${status} pages=${pages}`, ok, count);
  return { ok, count, error };
}

/**
 * 同步书库。
 * - 默认（浅）：各分类「总人气」榜 + 最近更新/最新入库/收藏榜（每日维护用，轻量）。
 * - deep=true：遍历「全部分类 × 全部榜单 × 每榜 pages 页」（biqugen 实测约 8200+ 本）。
 * - ultra=true：在 deep 基础上再遍历「字数段(6) × 连载状态(3)」，可深挖到源站目录的长尾
 *   （源站每个「分类×字数×状态」列表各暴露约 10 页；实测可达数万本）。耗时较久，建议后台执行。
 *
 * onProgress(done, total) 用于回报进度；任务会以并发池加速（受全局抓取闸门限制）。
 */
export async function syncCatalog({ pagesPerCategory = 2, deep = false, ultra = false, onProgress, jobConcurrency } = {}) {
  const sorts = deep || ultra ? ALL_SORTS : ['allvisit'];
  const sizes = ultra ? [0, 1, 2, 3, 4, 5] : [0];
  const statuses = ultra ? [0, 1, 2] : [0];

  const jobs = [];
  for (const cat of CATEGORIES) {
    for (const sort of sorts) {
      for (const size of sizes) {
        for (const status of statuses) jobs.push({ category: cat.code, sort, size, status });
      }
    }
  }
  // 最新入库 + 最近更新 + 收藏榜，丰富推荐池
  jobs.push({ category: 0, sort: 'lastupdate', size: 0, status: 0 });
  jobs.push({ category: 0, sort: 'postdate', size: 0, status: 0 });
  jobs.push({ category: 0, sort: 'goodnum', size: 0, status: 0 });

  const total = jobs.length;
  let done = 0;
  const results = [];
  const concurrency = Math.max(1, Math.min(Number(jobConcurrency) || 4, 8));
  let cursor = 0;

  // 并发池：多个榜单同时抓取，加速全量收录（底层全局闸门仍限制对源站的总并发）
  async function worker() {
    while (cursor < jobs.length && !syncState.cancel) {
      const j = jobs[cursor++];
      const r = await syncList({
        category: j.category,
        sort: j.sort,
        size: j.size,
        status: j.status,
        pages: pagesPerCategory,
      });
      results.push(r);
      done++;
      if (typeof onProgress === 'function') onProgress(done, total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));

  const count = results.reduce((n, r) => n + r.count, 0);
  const okCount = results.filter((r) => r.ok).length;
  const label = ultra ? 'ultra' : deep ? 'deep' : '';
  logCrawl(
    'sync-catalog',
    `${label ? label + ' ' : ''}ok=${okCount}/${results.length} 处理条目 ${count}`,
    okCount > 0,
    count,
  );
  return { ok: okCount > 0, total: count, requests: results.length, detail: results };
}

/** 抓取任务状态（供接口轮询展示进度） */
export const syncState = {
  running: false,
  cancel: false,
  mode: '',
  startedAt: null,
  finishedAt: null,
  done: 0,
  total: 0,
  count: 0,
  error: '',
};

/** 启动一次抓取任务并返回其状态（deep/ultra 任务耗时较久，建议不 await） */
export async function runSyncJob({ deep = false, ultra = false, pagesPerCategory = 10 } = {}) {
  if (syncState.running) return { ok: false, error: '已有抓取任务正在运行', ...syncState };
  syncState.running = true;
  syncState.cancel = false;
  syncState.mode = ultra ? 'ultra' : deep ? 'deep' : 'normal';
  syncState.startedAt = new Date().toISOString();
  syncState.finishedAt = null;
  syncState.done = 0;
  syncState.total = 0;
  syncState.count = 0;
  syncState.error = '';
  try {
    const r = await syncCatalog({
      deep,
      ultra,
      pagesPerCategory,
      onProgress: (d, t) => {
        syncState.done = d;
        syncState.total = t;
      },
    });
    syncState.count = r.total;
    return { ...r, sync: { ...syncState } };
  } catch (e) {
    syncState.error = String(e?.message || e);
    return { ok: false, error: syncState.error, sync: { ...syncState } };
  } finally {
    syncState.running = false;
    syncState.finishedAt = new Date().toISOString();
  }
}

/* ------------------------- 书籍详情 / 目录补全 ------------------------- */

const enrichInflight = new Map(); // `${bookId}:${lite?'lite':'full'}` -> Promise

export function enrichBook(bookId, opts = {}) {
  const key = `${bookId}:${opts.lite ? 'lite' : 'full'}`;
  const running = enrichInflight.get(key);
  if (running) return running;
  const p = runEnrich(bookId, opts).finally(() => enrichInflight.delete(key));
  enrichInflight.set(key, p);
  return p;
}

/**
 * 抓取书籍目录（章节列表）。
 *   - 默认 full：并行抓取全部页，最后一次性定稿（enriched=1）。
 *   - lite：只抓第 1 页（书籍主页），先让用户「立刻能看/能读第 1 章」，
 *     enriched 保持 0，剩余页由 warmCatalog() 在后台补齐。
 * 抓取受全局并发闸门限速（config.crawl.concurrency），并行不会打爆源站。
 */
async function runEnrich(bookId, { maxPages = 30, lite = false } = {}) {
  const book = get('SELECT * FROM books WHERE id=?', bookId);
  if (!book) return { ok: false, error: '书籍不存在' };
  const src = getSource(book.source);
  const detail = await src.bookDetail(book.source_id);
  if (!detail.ok) {
    logCrawl('enrich', `${book.source}:${book.source_id} ${detail.error}`, false, 0);
    return { ok: false, error: detail.error || '抓取失败' };
  }
  upsertBook(book.source, { ...detail.book, source_id: book.source_id });

  const pages = Math.max(1, Math.min(Number(detail.book.pages) || 1, maxPages));
  const fetchPages = lite ? 1 : pages;

  // 第 1 页来自书籍主页；第 2..N 页并行抓取，但按页序合并，保证章节顺序正确
  const pageChapters = new Map([[1, detail.chapters]]);
  if (fetchPages > 1) {
    const pageNums = [];
    for (let p = 2; p <= fetchPages; p++) pageNums.push(p);
    const concurrency = Math.max(1, Number(config.crawl.concurrency) || 1);
    const results = await mapLimit(pageNums, concurrency, async (p) => {
      const r = await src.chapterListPage(book.source_id, p);
      return { page: p, chapters: r.ok ? r.chapters : [] };
    });
    for (const { page, chapters } of results) pageChapters.set(page, chapters);
  }

  const all = [];
  for (let p = 1; p <= fetchPages; p++) all.push(...(pageChapters.get(p) || []));

  const seen = new Set();
  const final = [];
  for (const c of all) {
    if (!c.ref || seen.has(c.ref)) continue;
    if (isJunkChapter(c.title)) continue;
    seen.add(c.ref);
    final.push(c);
  }

  final.forEach((c, i) => upsertChapter(bookId, i + 1, c.title, c.ref));

  if (lite) {
    // 只发布第 1 页：先让用户能进详情 / 读第 1 章。
    // 若整本只有 1 页（pages<=1），说明已完整，直接标记 enriched。
    const done = pages <= 1;
    run('UPDATE books SET chapter_count=?, catalog_pages=?, enriched=? WHERE id=?', final.length, 1, done ? 1 : 0, bookId);
    logCrawl('enrich', `${book.source}:${book.source_id} (lite${done ? ', complete' : ''})`, true, final.length);
    return { ok: true, count: final.length, pages, pagesFetched: 1, lite: true, complete: done };
  }

  // 清理因过滤/目录收缩而残留的旧章节行
  run('DELETE FROM chapter_contents WHERE chapter_id IN (SELECT id FROM chapters WHERE book_id=? AND idx>?)', bookId, final.length);
  run('DELETE FROM chapters WHERE book_id=? AND idx>?', bookId, final.length);
  run('UPDATE books SET chapter_count=?, enriched=1, catalog_pages=? WHERE id=?', final.length, pages, bookId);
  logCrawl('enrich', `${book.source}:${book.source_id}`, true, final.length);
  return { ok: true, count: final.length, pages, lite: false, complete: true };
}

// 后台「补齐整本目录」：仅在尚未完整同步时触发，去重，失败静默
const warmingCatalog = new Set();
export function warmCatalog(bookId) {
  const key = String(bookId);
  if (warmingCatalog.has(key)) return;
  const book = get('SELECT id, enriched FROM books WHERE id=?', bookId);
  if (!book || book.enriched) return;
  warmingCatalog.add(key);
  enrichBook(bookId)
    .catch(() => {})
    .finally(() => warmingCatalog.delete(key));
}

export async function ensureChapters(bookId, { force = false } = {}) {
  const book = get('SELECT * FROM books WHERE id=?', bookId);
  if (!book) return { ok: false, error: '书籍不存在' };
  if (!force && book.enriched && book.chapter_count > 0) return { ok: true, count: book.chapter_count };
  return enrichBook(bookId);
}

/** 按源站 id 导入整本书 */
export async function importBook(sourceId, source = 'biqugen') {
  let row = get('SELECT * FROM books WHERE source=? AND source_id=?', source, String(sourceId));
  if (!row) {
    const id = upsertBook(source, { source_id: String(sourceId), title: '加载中…' });
    row = { id };
  }
  const r = await enrichBook(row.id);
  // 入库后复查合规：命中违规直接下架删除
  const saved = get('SELECT * FROM books WHERE id=?', row.id);
  if (saved && isBlockedBook(saved)) {
    const terms = matchedTerms(saved).join('、');
    deleteBook(row.id);
    logCrawl('blocked', `${source}:${sourceId} ${saved.title}（命中：${terms}）`, true, 1);
    return { ok: false, blocked: true, error: `该作品命中违规内容过滤，已拒绝入库（${terms}）` };
  }
  return { ...r, bookId: row.id };
}

/**
 * 把一批“列表页解析出的书目”加入书库（已存在的只更新元数据，hot 保持不变）。
 * 用于搜索时自动补充、以及每日扩充书库。会自动跳过 SEO 垃圾与违规涉黄作品。
 */
export function importBookList(list, source = 'biqugen') {
  const ids = [];
  let blocked = 0;
  for (const b of list || []) {
    if (!b?.source_id || isJunkBook(b)) continue;
    if (isBlockedBook(b)) {
      blocked++;
      continue;
    }
    const existed = get('SELECT id FROM books WHERE source=? AND source_id=?', source, String(b.source_id));
    const id = upsertBook(source, b, { hot: existed ? 0 : 1 });
    if (!existed) ids.push(id);
  }
  return { added: ids.length, ids, blocked };
}

/**
 * 搜索时自动联网补充：本地书库没有的相关小说，自动从网络书源抓取并入库。
 * 返回新增数量与新增书籍 id；已入库的书不会重复添加。
 */
export async function autoImportFromSearch(keyword, { source = 'biqugen', limit = 15 } = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return { ok: false, added: 0, checked: 0, ids: [] };
  const src = getSource(source);
  const res = await src.search(kw);
  if (!res.ok) return { ok: false, added: 0, checked: 0, ids: [], error: res.error };
  const clean = res.books.filter((b) => !isJunkBook(b) && !isBlockedBook(b));
  const candidates = clean.slice(0, Math.max(1, Number(limit) || 15));
  const { added, ids } = importBookList(candidates, source);
  if (added) logCrawl('auto-import', `search:${kw} +${added}`, true, added);
  return { ok: true, added, checked: candidates.length, ids };
}

/** 重算全库题材标签（新增/调整词表后调用）；返回各标签数量 */
export function rebuildTags() {
  const rows = all('SELECT id, title, intro, tags FROM books');
  const counts = {};
  for (const r of rows) {
    const existing = String(r.tags || '')
      .split('|')
      .filter(Boolean);
    const tags = [...new Set([...existing, ...extractTags(r.title, r.intro)])];
    run('UPDATE books SET tags=? WHERE id=?', tagsToField(tags), r.id);
    for (const t of tags) counts[t] = (counts[t] || 0) + 1;
  }
  setMeta('tags_version', GENRE_VERSION);
  return { ok: true, books: rows.length, tags: counts };
}

/**
 * 启动时按需重算题材标签：仅当题材词表版本变化时执行（词表未变则跳过，保证启动轻快）。
 */
export function ensureTags() {
  if (Number(getMeta('tags_version', 0)) === GENRE_VERSION) return null;
  return rebuildTags();
}

/** 删除一本书及其章节、正文缓存、书架与阅读记录引用 */
export function deleteBook(bookId) {
  run('DELETE FROM chapter_contents WHERE chapter_id IN (SELECT id FROM chapters WHERE book_id=?)', bookId);
  run('DELETE FROM chapters WHERE book_id=?', bookId);
  run('DELETE FROM bookshelf WHERE book_id=?', bookId);
  run('DELETE FROM history WHERE book_id=?', bookId);
  run('DELETE FROM books WHERE id=?', bookId);
  return { ok: true, bookId };
}

/**
 * 扫描并清理书库中命中违规过滤的作品（含章节/正文/书架/记录）。
 * 可在启动时、每日维护时或通过接口手动触发。
 */
export function purgeBlockedBooks({ dryRun = false } = {}) {
  const rows = all('SELECT id, title, author, intro FROM books');
  const hits = [];
  for (const b of rows) {
    if (isBlockedBook(b)) hits.push({ id: b.id, title: b.title, terms: matchedTerms(b) });
  }
  if (!dryRun) {
    for (const h of hits) deleteBook(h.id);
    if (hits.length) logCrawl('purge', `清理违规作品 ${hits.length} 本`, true, hits.length);
  }
  return { ok: true, removed: dryRun ? 0 : hits.length, matched: hits.length, dryRun, items: hits };
}
/**
 * 检查单本已入库小说是否有更新（章节/最新章变化）。
 * 轻量：只抓书籍详情页（含第 1 页目录与总页数）；确有变化才做完整目录补全。
 */
export async function refreshBook(bookId, { force = false, maxPages = 60 } = {}) {
  const book = get('SELECT * FROM books WHERE id=?', bookId);
  if (!book) return { ok: false, error: '书籍不存在' };
  // 本地原创书库不需要联网检查
  if (book.source === '本地书库') return { ok: true, updated: false, skipped: true, count: book.chapter_count || 0 };

  const src = getSource(book.source);
  const detail = await src.bookDetail(book.source_id);
  if (!detail.ok) {
    run("UPDATE books SET last_checked_at=datetime('now') WHERE id=?", bookId);
    logCrawl('refresh', `${book.source}:${book.source_id} ${detail.error || ''}`, false, 0);
    return { ok: false, error: detail.error || '抓取失败' };
  }

  const latestChanged = String(detail.book.latest_chapter || '') !== String(book.latest_chapter || '');
  const needEnrich = force || !book.enriched || !book.chapter_count || latestChanged;

  // 复查合规：书名/简介变更后若命中违规，直接下架删除
  if (isBlockedBook({ ...detail.book, title: detail.book.title || book.title })) {
    const terms = matchedTerms({ ...detail.book, title: detail.book.title || book.title }).join('、');
    deleteBook(bookId);
    logCrawl('blocked', `${book.source}:${book.source_id} ${detail.book.title || book.title}（命中：${terms}）`, true, 1);
    return { ok: true, updated: false, removed: true, blocked: true, count: 0, added: 0 };
  }

  upsertBook(book.source, { ...detail.book, source_id: book.source_id });

  let count = book.chapter_count || 0;
  let updated = false;
  if (needEnrich) {
    const r = await enrichBook(bookId, { maxPages });
    if (r.ok) {
      updated = r.count !== (book.chapter_count || 0) || !book.enriched;
      count = r.count;
    }
  }
  run("UPDATE books SET last_checked_at=datetime('now') WHERE id=?", bookId);
  return { ok: true, updated, latestChanged, count, added: Math.max(0, count - (book.chapter_count || 0)) };
}

/* ------------------------- 章节正文 ------------------------- */

// 同一章的并发请求去重：预加载与用户翻章若同时命中，不会重复抓取源站
const chapterInflight = new Map();

export function getChapter(bookId, idx, opts = {}) {
  const key = `${bookId}:${idx}:${opts.force ? 1 : 0}`;
  const running = chapterInflight.get(key);
  if (running) return running;
  const p = loadChapter(bookId, idx, opts).finally(() => chapterInflight.delete(key));
  chapterInflight.set(key, p);
  return p;
}

async function loadChapter(bookId, idx, { force = false } = {}) {
  const book = get('SELECT * FROM books WHERE id=?', bookId);
  if (!book) return { ok: false, error: '书籍不存在' };

  let ch = get('SELECT * FROM chapters WHERE book_id=? AND idx=?', bookId, idx);
  if (!ch) {
    // 目录还没开始抓：先只抓第 1 页（快，1~2 个请求），早章可直接命中，
    // 避免「直接打开阅读链接」被整本目录抓取拖慢；剩余页服务端后台补齐。
    if (!book.enriched && !book.catalog_pages) {
      const lite = await enrichBook(bookId, { lite: true });
      if (lite.ok && !lite.complete) warmCatalog(bookId);
      ch = get('SELECT * FROM chapters WHERE book_id=? AND idx=?', bookId, idx);
    }
    // 仍缺（章节在更靠后的目录页）：整本同步一次
    if (!ch) {
      await ensureChapters(bookId);
      ch = get('SELECT * FROM chapters WHERE book_id=? AND idx=?', bookId, idx);
    }
  }
  if (!ch) return { ok: false, error: '章节不存在' };

  if (!force) {
    const cached = get('SELECT content FROM chapter_contents WHERE chapter_id=?', ch.id);
    if (cached) {
      return { ok: true, book, chapter: ch, paragraphs: JSON.parse(cached.content), cached: true };
    }
  }

  const src = getSource(book.source);
  const r = await src.chapterContent(book.source_id, ch.source_ref);
  if (!r.ok) {
    logCrawl('chapter', `${book.source}:${book.source_id}#${idx} ${r.error}`, false, 0);
    return { ok: false, error: r.error || '章节抓取失败' };
  }
  run(
    "INSERT INTO chapter_contents(chapter_id,content) VALUES(?,?) ON CONFLICT(chapter_id) DO UPDATE SET content=excluded.content, fetched_at=datetime('now')",
    ch.id,
    JSON.stringify(r.paragraphs),
  );
  run('UPDATE chapters SET cached=1, word_count=? WHERE id=?', r.wordCount, ch.id);
  logCrawl('chapter', `${book.source}:${book.source_id}#${idx}`, true, r.wordCount);
  return { ok: true, book, chapter: { ...ch, cached: 1 }, paragraphs: r.paragraphs, cached: false };
}

// 已在后台预热的章节，避免重复排队
const warming = new Set();

/**
 * 后台预取 fromIdx 之后的 count 章（写入章节缓存），让「下一章」秒开。
 * 幂等且去重；抓取仍受全局并发闸门限制，不会打爆源站。返回预取任务数。
 */
export function warmChapters(bookId, fromIdx, count) {
  let started = 0;
  for (let i = 1; i <= count; i++) {
    const idx = fromIdx + i;
    const key = `${bookId}:${idx}`;
    if (warming.has(key)) continue;
    warming.add(key);
    started++;
    getChapter(bookId, idx)
      .catch(() => {})
      .finally(() => warming.delete(key));
  }
  return started;
}
