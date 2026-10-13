import fs from 'node:fs';
import path from 'node:path';
import { config, COVER_DIR, CATEGORIES } from './config.mjs';
import { getSource, sources, sourceList } from './crawler/index.mjs';
import { fetchBuffer } from './crawler/http.mjs';
import { clamp, escapeHtml } from './util.mjs';
import {
  homeData,
  listBooks,
  getBookDetail,
  getChapters,
  getCategories,
  getTags,
  searchAll,
  stats,
} from './services/books.mjs';
import { deleteBook, enrichBook, getChapter, importBook, importBookList, isJunkBook, purgeBlockedBooks, rebuildTags, refreshBook, runSyncJob, syncList, syncState, warmCatalog, warmChapters } from './services/catalog.mjs';
import { isBlockedBook } from './moderation.mjs';
import { runDailyMaintenance, schedulerState } from './services/scheduler.mjs';
import { getShare, startShare, stopShare } from './services/tunnel.mjs';
import { qrPng, qrSvg } from './qr.mjs';
import { synthesize, VOICE_PRESETS, ffmpegAvailable } from './services/tts.mjs';
import {
  addToShelf,
  getHistory,
  getShelf,
  isOnShelf,
  recordHistory,
  removeFromShelf,
  clearHistory,
  removeHistory,
  migrateGuestData,
  countUserData,
} from './services/users.mjs';
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  getSessionUser,
  loginUser,
  parseCookies,
  publicUser,
  registerUser,
  sessionCookie,
} from './auth.mjs';

/* ---------------- helpers ---------------- */

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    return {};
  }
}

function guestId(req, url) {
  return req.headers['x-client-id'] || url.searchParams.get('uid') || 'guest';
}

function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  return getSessionUser(token);
}

/** 数据归属：登录用户用账号 id，未登录用本地客户端 id */
function ownerId(req, url, user) {
  return user ? user.id : guestId(req, url);
}

/* ---------------- cover proxy ---------------- */

function placeholderSvg(title) {
  const t = escapeHtml((title || '书').slice(0, 4));
  const hue = [...(title || '书')].reduce((n, c) => n + c.charCodeAt(0), 0) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="213" viewBox="0 0 160 213">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},46%,34%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},52%,20%)"/></linearGradient></defs>
<rect width="160" height="213" rx="10" fill="url(#g)"/>
<rect x="1.5" y="1.5" width="157" height="210" rx="9" fill="none" stroke="rgba(255,255,255,.25)"/>
<text x="80" y="98" font-size="42" font-family="serif" fill="rgba(255,255,255,.92)" text-anchor="middle">${t}</text>
<text x="80" y="132" font-size="13" font-family="sans-serif" fill="rgba(255,255,255,.55)" text-anchor="middle">暂无封面</text>
</svg>`;
}

function contentTypeOf(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF') return 'image/webp';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return 'image/jpeg';
}

async function serveCover(res, bookId) {
  const { get } = await import('./db.mjs');
  const book = get('SELECT id, title, cover, source FROM books WHERE id=?', bookId);
  const cacheFile = path.join(COVER_DIR, `${bookId}.img`);
  const metaFile = path.join(COVER_DIR, `${bookId}.type`);

  if (fs.existsSync(cacheFile)) {
    const buf = fs.readFileSync(cacheFile);
    const type = fs.existsSync(metaFile) ? fs.readFileSync(metaFile, 'utf-8') : contentTypeOf(buf);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800' });
    return res.end(buf);
  }

  if (book && book.cover) {
    const src = getSource(book.source);
    const url = book.cover.startsWith('http') ? book.cover : src.base + (book.cover.startsWith('/') ? book.cover : '/' + book.cover);
    const r = await fetchBuffer(url, { referer: src.base + '/' });
    if (r.ok && r.buffer && r.buffer.length > 512) {
      try {
        fs.writeFileSync(cacheFile, r.buffer);
        fs.writeFileSync(metaFile, contentTypeOf(r.buffer));
      } catch {
        /* ignore */
      }
      res.writeHead(200, { 'Content-Type': contentTypeOf(r.buffer), 'Cache-Control': 'public, max-age=604800' });
      return res.end(r.buffer);
    }
  }

  const svg = placeholderSvg(book?.title);
  res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
  res.end(svg);
}

/* ---------------- 服务端 TTS ---------------- */

/** 服务端语音是否可用（baidu 无需密钥；azure 需要密钥） */
function serverTtsEnabled() {
  const p = config.tts.provider;
  if (p === 'baidu') return true;
  if (p === 'azure') return !!config.tts.azureKey;
  return false;
}

const BAIDU_VOICES = VOICE_PRESETS.filter((v) => !v.needsFfmpeg || ffmpegAvailable()).map((v) => ({
  id: v.id,
  name: v.name,
  note: v.note + (v.needsFfmpeg ? '（服务器变声）' : ''),
}));

function escapeXml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function azureSpeak(res, { text, voice = 'zh-CN-XiaoxiaoNeural', rate = 0, pitch = 0 }) {
  const { azureKey, azureRegion } = config.tts;
  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${escapeXml(voice)}'><prosody rate='${rate >= 0 ? '+' : ''}${clamp(rate, -50, 100)}%' pitch='${pitch >= 0 ? '+' : ''}${clamp(pitch, -50, 50)}Hz'>${escapeXml(text)}</prosody></voice></speak>`;
  try {
    const r = await fetch(`https://${azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': azureKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'novelverse',
      },
      body: ssml,
    });
    if (!r.ok) return send(res, 502, { ok: false, error: `TTS ${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (e) {
    send(res, 502, { ok: false, error: String(e?.message || e) });
  }
}

/** 百度在线 TTS：合成 mp3 直接返回给 <audio> 播放（可按音色变声） */
async function baiduSpeak(res, { text, rate = 1, voice = 'baidu' }) {
  try {
    const buf = await synthesize(text, { rate, voice });
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=604800',
    });
    res.end(buf);
  } catch (e) {
    send(res, 502, { ok: false, error: `语音合成失败：${String(e?.message || e)}`, fallback: 'browser' });
  }
}

/* ---------------- 路由 ---------------- */

export async function handleApi(req, res, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/api';
  const q = url.searchParams;
  const user = currentUser(req);
  const uid = ownerId(req, url, user);

  // ---- 账号 ----
  // GET /api/auth/me
  if (p === '/api/auth/me') {
    const data = { ok: true, user: publicUser(user) };
    if (user) data.stats = countUserData(user.id);
    return send(res, 200, data);
  }
  // POST /api/auth/register { username, password, name? }
  if (p === '/api/auth/register' && req.method === 'POST') {
    const body = await readJson(req);
    const r = registerUser(body);
    if (!r.ok) return send(res, 400, r);
    const guest = guestId(req, url);
    if (guest && guest !== 'guest') migrateGuestData(guest, r.user.id);
    const token = createSession(r.user.id);
    return send(res, 200, { ok: true, user: publicUser(r.user) }, { 'Set-Cookie': sessionCookie(token) });
  }
  // POST /api/auth/login { username, password }
  if (p === '/api/auth/login' && req.method === 'POST') {
    const body = await readJson(req);
    const r = loginUser(body);
    if (!r.ok) return send(res, 400, r);
    const guest = guestId(req, url);
    if (guest && guest !== 'guest') migrateGuestData(guest, r.user.id);
    const token = createSession(r.user.id);
    return send(res, 200, { ok: true, user: publicUser(r.user) }, { 'Set-Cookie': sessionCookie(token) });
  }
  // POST /api/auth/logout
  if (p === '/api/auth/logout' && req.method === 'POST') {
    destroySession(parseCookies(req)[SESSION_COOKIE]);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', { clear: true }) });
  }

  // GET /api/health
  if (p === '/api/health')
    return send(res, 200, { ok: true, service: config.siteName, tts: config.tts.provider, ttsServer: serverTtsEnabled(), stats: stats() });

  // GET /api/share —— 手机访问信息（局域网 + 外网地址 + 状态）
  if (p === '/api/share') {
    const info = getShare();
    // 设了口令时，给手机一个「带令牌」的一键地址（扫码即进，无需输密码；并写 Cookie 供「添加到主屏幕」用）
    const access =
      config.access.password && info.url
        ? { user: config.access.user, url: `${info.url}/?k=${config.access.token}` }
        : null;
    return send(res, 200, { ok: true, ...info, access });
  }

  // POST /api/share/restart —— 重新建立外网隧道
  if (p === '/api/share/restart' && req.method === 'POST') {
    stopShare();
    const s = await startShare();
    return send(res, 200, { ok: true, ...s });
  }

  // GET /api/qr.svg?text=…&scale=&margin= —— 二维码（矢量）
  if (p === '/api/qr.svg') {
    const text = String(q.get('text') || '').slice(0, 600);
    if (!text) return send(res, 400, { ok: false, error: '缺少 text' });
    const svg = qrSvg(text, { scale: clamp(Number(q.get('scale') || 8), 2, 20), margin: clamp(q.get('margin') ?? 4, 0, 10) });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    return res.end(svg);
  }

  // GET /api/qr.png —— 二维码位图
  if (p === '/api/qr.png') {
    const text = String(q.get('text') || '').slice(0, 1000);
    if (!text) return send(res, 400, { ok: false, error: '缺少文本' });
    const buf = qrPng(text, { scale: clamp(Number(q.get('scale') || 8), 2, 20), margin: 4 });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return res.end(buf);
  }

  // GET /api/home
  if (p === '/api/home')
    return send(res, 200, { ok: true, categories: getCategories(), tags: getTags(), ...homeData(), stats: stats() });

  // GET /api/categories
  if (p === '/api/categories') return send(res, 200, { ok: true, categories: getCategories() });

  // GET /api/tags —— 题材标签及数量
  if (p === '/api/tags') return send(res, 200, { ok: true, tags: getTags() });

  // GET /api/books
  if (p === '/api/books') {
    return send(res, 200, {
      ok: true,
      ...listBooks({
        category: q.get('category') || 0,
        sort: q.get('sort') || 'hot',
        q: q.get('q') || '',
        tag: q.get('tag') || '',
        page: q.get('page') || 1,
        size: q.get('size') || 24,
      }),
    });
  }

  // GET /api/search?q=&remote=1&source=<id>
  if (p === '/api/search') {
    const keyword = (q.get('q') || '').trim();
    if (!keyword) return send(res, 200, { ok: true, local: [], remote: [], sources: sourceList() });
    let local = searchAll(keyword);
    let remote = [];
    let imported = 0;
    const srcIds = q.get('source') ? [q.get('source')] : sourceList().map((s) => s.id);
    if (q.get('remote') !== '0') {
      // 跨所有书源并发搜索；单个源失败不影响其它源
      const settled = await Promise.allSettled(
        srcIds.map(async (sid) => ({ sid, r: await getSource(sid).search(keyword) })),
      );
      const seen = new Set();
      for (const s of settled) {
        if (s.status !== 'fulfilled') continue;
        const { sid, r } = s.value;
        if (!r || !r.ok) continue;
        const srcName = sources[sid]?.name || sid;
        for (const b of r.books) {
          if (isJunkBook(b) || isBlockedBook(b)) continue;
          const key = `${sid}:${b.source_id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          remote.push({ ...b, source: sid, sourceName: srcName, source_id: String(b.source_id) });
        }
      }
      remote = remote.slice(0, 40);

      // 自动补充：本地书库没有的相关小说，自动从网络抓取入库（按源分组）
      if (config.autoFetchOnSearch && q.get('autofetch') !== '0' && remote.length) {
        const localKeys = new Set(local.map((l) => `${l.source}:${l.sourceId}`));
        const bySrc = new Map();
        for (const b of remote.slice(0, config.autoFetchLimit)) {
          if (localKeys.has(`${b.source}:${b.source_id}`)) continue;
          if (!bySrc.has(b.source)) bySrc.set(b.source, []);
          bySrc.get(b.source).push(b);
        }
        for (const [sid, list] of bySrc) {
          const imp = importBookList(list, sid);
          imported += imp.added || 0;
        }
        if (imported) local = searchAll(keyword);
      }
    }
    return send(res, 200, { ok: true, keyword, local, remote, imported, sources: sourceList() });
  }

  // POST /api/import
  if (p === '/api/import' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.sourceId) return send(res, 400, { ok: false, error: '缺少 sourceId' });
    const source = sources[body.source] ? body.source : config.activeSource;
    const r = await importBook(String(body.sourceId), source);
    if (!r.ok) return send(res, 502, r);
    return send(res, 200, { ok: true, ...r, book: getBookDetail(r.bookId)?.book });
  }

  // GET /api/cover/:id
  let m = p.match(/^\/api\/cover\/(\d+)$/);
  if (m) return serveCover(res, Number(m[1]));

  // GET /api/books/:id
  m = p.match(/^\/api\/books\/(\d+)$/);
  if (m && req.method === 'GET') {
    const detail = getBookDetail(Number(m[1]));
    if (!detail) return send(res, 404, { ok: false, error: '书籍不存在' });
    return send(res, 200, { ok: true, ...detail, onShelf: isOnShelf(uid, Number(m[1])) });
  }

  // DELETE /api/books/:id —— 手动下架删除（用于清理漏网的违规作品）
  if (m && req.method === 'DELETE') {
    const r = deleteBook(Number(m[1]));
    return send(res, 200, { ...r, stats: stats() });
  }

  // GET /api/books/:id/chapters
  m = p.match(/^\/api\/books\/(\d+)\/chapters$/);
  if (m) {
    return send(res, 200, {
      ok: true,
      ...getChapters(Number(m[1]), { offset: q.get('offset') || 0, limit: q.get('limit') || 200, sort: q.get('sort') || 'asc' }),
    });
  }

  // POST /api/books/:id/enrich
  // 默认（lite）：只抓第 1 页目录，让用户 1~2 秒内就能打开详情/开始读第 1 章；
  // 随后在后台把整本目录补齐（warmCatalog）。?full=1 或 mode=full 可强制整本同步。
  m = p.match(/^\/api\/books\/(\d+)\/enrich$/);
  if (m && req.method === 'POST') {
    const bookId = Number(m[1]);
    const full = q.get('full') === '1' || String(q.get('mode') || '').toLowerCase() === 'full';
    if (full) {
      const r = await enrichBook(bookId);
      return send(res, r.ok ? 200 : 502, r);
    }
    const r = await enrichBook(bookId, { lite: true });
    if (r.ok && !r.complete) warmCatalog(bookId); // 后台补齐剩余目录页
    return send(res, r.ok ? 200 : 502, r);
  }

  // GET /api/books/:id/chapter/:idx
  m = p.match(/^\/api\/books\/(\d+)\/chapter\/(\d+)$/);
  if (m) {
    const bookId = Number(m[1]);
    const idx = Number(m[2]);
    const r = await getChapter(bookId, idx, { force: q.get('force') === '1' });
    if (!r.ok) return send(res, 502, r);
    const detail = getBookDetail(bookId);
    const total = detail?.book.chapterCount || 0;
    // 后台预取后续章节，让用户翻到「下一章」时秒开（不影响本次响应）
    if (config.reader.prefetch > 0) {
      const remain = total ? total - idx : config.reader.prefetch;
      const n = Math.max(0, Math.min(config.reader.prefetch, remain));
      if (n > 0) warmChapters(Number(m[1]), idx, n);
    }
    return send(res, 200, {
      ok: true,
      bookId,
      idx,
      title: r.chapter.title,
      paragraphs: r.paragraphs,
      cached: r.cached,
      total,
      prev: idx > 1 ? idx - 1 : null,
      next: total && idx < total ? idx + 1 : null,
      book: detail?.book,
    });
  }

  // GET /api/shelf
  if (p === '/api/shelf' && req.method === 'GET') {
    return send(res, 200, { ok: true, user: uid, books: getShelf(uid) });
  }
  // POST /api/shelf { bookId }
  if (p === '/api/shelf' && req.method === 'POST') {
    const body = await readJson(req);
    addToShelf(uid, body.bookId);
    return send(res, 200, { ok: true, onShelf: true });
  }
  // DELETE /api/shelf/:id
  m = p.match(/^\/api\/shelf\/(\d+)$/);
  if (m && (req.method === 'DELETE' || req.method === 'POST')) {
    removeFromShelf(uid, Number(m[1]));
    return send(res, 200, { ok: true, onShelf: false });
  }

  // GET /api/history
  if (p === '/api/history' && req.method === 'GET') {
    return send(res, 200, { ok: true, items: getHistory(uid) });
  }
  // POST /api/history { bookId, chapterIdx }
  if (p === '/api/history' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.bookId) return send(res, 400, { ok: false, error: '缺少 bookId' });
    recordHistory(uid, body.bookId, body.chapterIdx || 1);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/history' && req.method === 'DELETE') {
    clearHistory(uid);
    return send(res, 200, { ok: true });
  }
  m = p.match(/^\/api\/history\/(\d+)$/);
  if (m && req.method === 'DELETE') {
    removeHistory(uid, Number(m[1]));
    return send(res, 200, { ok: true });
  }

  // POST /api/crawl/sync { category, sort, pages, full, deep, ultra }
  //   full=true   同步各分类「总人气」榜（较慢，同步等待）
  //   deep=true   全量：全部分类 × 全部榜单 × 每榜 pages 页（后台执行，进度见 /api/crawl/status）
  //   ultra=true  深度全量：在 deep 基础上再遍历 字数段 × 连载状态，深挖长尾（耗时更久）
  if (p === '/api/crawl/sync' && req.method === 'POST') {
    const body = await readJson(req);
    if (body.deep || body.ultra) {
      if (syncState.running) return send(res, 409, { ok: false, error: '已有抓取任务正在运行', sync: { ...syncState } });
      const defPages = body.ultra ? 1 : 10; // 深度全量默认“广度优先”：每个组合只抓第 1 页，最大化新书产出
      const pages = clamp(body.pages || defPages, 1, 10);
      runSyncJob({ deep: true, ultra: !!body.ultra, pagesPerCategory: pages }); // 后台执行，不阻塞请求
      return send(res, 202, { ok: true, started: true, deep: true, ultra: !!body.ultra, pages, sync: { ...syncState } });
    }
    if (body.full) {
      if (syncState.running) return send(res, 409, { ok: false, error: '已有抓取任务正在运行', sync: { ...syncState } });
      const r = await runSyncJob({ deep: false, pagesPerCategory: clamp(body.pages || 2, 1, 5) });
      return send(res, 200, { ok: r.ok, ...r, stats: stats() });
    }
    const r = await syncList({
      category: body.category || 0,
      sort: body.sort || 'allvisit',
      pages: clamp(body.pages || 1, 1, 10),
    });
    return send(res, 200, { ok: r.ok, ...r, stats: stats() });
  }

  // POST /api/crawl/sync/cancel —— 停止正在进行的全量/深度抓取
  if (p === '/api/crawl/sync/cancel' && req.method === 'POST') {
    if (!syncState.running) return send(res, 200, { ok: true, stopped: false, sync: { ...syncState } });
    syncState.cancel = true;
    return send(res, 200, { ok: true, stopped: true, sync: { ...syncState } });
  }
  // POST /api/crawl/daily —— 立即执行一次“每日维护”（清理违规 + 抓更新 + 扩充书库）
  if (p === '/api/crawl/daily' && req.method === 'POST') {
    if (schedulerState.running) return send(res, 409, { ok: false, error: '每日维护正在执行中，请稍候' });
    schedulerState.running = true;
    try {
      const r = await runDailyMaintenance();
      schedulerState.lastRun = new Date().toISOString();
      schedulerState.lastResult = r;
      return send(res, 200, { ok: r.ok, ...r, stats: stats() });
    } finally {
      schedulerState.running = false;
    }
  }

  // POST /api/crawl/purge —— 扫描并清理命中违规过滤的作品（dryRun=1 仅预览）
  if (p === '/api/crawl/purge' && req.method === 'POST') {
    const body = await readJson(req);
    const r = purgeBlockedBooks({ dryRun: !!body.dryRun });
    return send(res, 200, { ok: true, ...r, stats: stats() });
  }

  // POST /api/tags/rebuild —— 重新抽取全库题材标签
  if (p === '/api/tags/rebuild' && req.method === 'POST') {
    const r = rebuildTags();
    return send(res, 200, { ok: true, ...r });
  }

  // GET /api/crawl/status
  if (p === '/api/crawl/status') {
    const { all } = await import('./db.mjs');
    const logs = all('SELECT * FROM crawl_logs ORDER BY id DESC LIMIT 20');
    const pendingUpdate = all("SELECT COUNT(*) AS n FROM books WHERE source<>'本地书库' AND (last_checked_at='' OR last_checked_at < datetime('now','-1 day'))")[0]?.n || 0;
    return send(res, 200, {
      ok: true,
      stats: stats(),
      sources: sourceList(),
      schedule: {
        enabled: schedulerState.enabled,
        hour: schedulerState.hour,
        minute: schedulerState.minute,
        nextRun: schedulerState.nextRun,
        lastRun: schedulerState.lastRun,
        running: schedulerState.running,
        lastResult: schedulerState.lastResult,
        updateLimit: config.schedule.updateLimit,
        syncPages: config.schedule.syncPages,
      },
      autoFetchOnSearch: config.autoFetchOnSearch,
      contentFilter: { enabled: config.contentFilter.enabled },
      sync: { ...syncState },
      pendingUpdate,
      logs,
    });
  }

  // GET /api/tts/voices —— 可用音色 + 服务端语音是否可用（前端据此选择朗读方式）
  if (p === '/api/tts/voices') {
    const enabled = serverTtsEnabled();
    const provider = config.tts.provider;
    const voices =
      provider === 'azure' && enabled
        ? RECOMMENDED_VOICES
        : provider === 'baidu' && enabled
          ? BAIDU_VOICES
          : RECOMMENDED_VOICES;
    return send(res, 200, { ok: true, provider, server: enabled, voices });
  }

  // POST/GET /api/tts/speak —— 服务端合成语音（baidu 免费 / azure 需密钥）
  if (p === '/api/tts/speak') {
    if (!serverTtsEnabled()) {
      return send(res, 501, { ok: false, error: '服务端语音未启用，请使用浏览器朗读', fallback: 'browser' });
    }
    let text;
    let rate;
    let voice = 'baidu';
    if (req.method === 'POST') {
      const body = await readJson(req);
      text = body.text;
      rate = body.rate;
      voice = body.voice;
    } else {
      text = q.get('text');
      rate = q.get('rate');
      voice = q.get('voice');
    }
    text = String(text || '').slice(0, 4000);
    if (!text.trim()) return send(res, 400, { ok: false, error: '缺少文本' });
    const r = Number(rate);
    const speed = Number.isFinite(r) && r > 0 ? r : 1;
    if (config.tts.provider === 'azure' && config.tts.azureKey) {
      return azureSpeak(res, { text, voice: undefined, rate: Math.round((speed - 1) * 50), pitch: 0 });
    }
    return baiduSpeak(res, { text, rate: speed, voice });
  }

  return send(res, 404, { ok: false, error: 'Not Found', path: p });
}

export const RECOMMENDED_VOICES = [
  { id: 'zh-CN-YunxiNeural', name: '云希 · 阳光男声', tag: '男声', note: '轻快、有少年感，适合玄幻/都市' },
  { id: 'zh-CN-YunyangNeural', name: '云扬 · 新闻男声', tag: '男声', note: '沉稳有力，适合历史/军事' },
  { id: 'zh-CN-YunjianNeural', name: '云健 · 旁白男声', tag: '男声', note: '低沉有磁性，适合修仙/悬疑' },
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 · 温柔女声', tag: '女声', note: '自然甜美，适合言情/日常' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊 · 活泼女声', tag: '女声', note: '灵动，适合轻松题材' },
  { id: 'zh-CN-XiaohanNeural', name: '晓涵 · 知性女声', tag: '女声', note: '温柔端庄，适合叙述' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北 · 东北女声', tag: '方言', note: '带喜感，适合搞笑文' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮 · 陕西女声', tag: '方言', note: '别具一格' },
];
