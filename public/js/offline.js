// 离线下载：用 Cache Storage 缓存整本书（元信息 + 目录 + 全部正文 + 封面）。
// 断网时由 Service Worker 自动回退到本缓存，实现离线阅读 / 听书。
// 注意：Cache Storage 需要安全上下文（https 或 localhost）；用外网隧道地址即可。

const DL_CACHE = 'nv-downloads-v1';
const MANIFEST_PREFIX = '/__nvdl__/book/';

export function downloadSupported() {
  return typeof caches !== 'undefined' && (window.isSecureContext || location.hostname === 'localhost');
}

function bookPaths(bookId) {
  const id = Number(bookId);
  return {
    detail: `/api/books/${id}`,
    list: `/api/books/${id}/chapters`,
    cover: `/api/cover/${id}`,
    manifest: `${MANIFEST_PREFIX}${id}`,
  };
}

async function openCache() {
  return caches.open(DL_CACHE);
}

/** 只缓存“整本”下载时用到的路径（不含具体章节） */
async function cacheBookShell(cache, bookId) {
  const p = bookPaths(bookId);
  const [detailRes, listRes] = await Promise.all([
    fetch(p.detail, { credentials: 'same-origin' }),
    fetch(`${p.list}?offset=1&limit=100000`, { credentials: 'same-origin' }),
  ]);
  if (!detailRes.ok) throw new Error('书籍信息获取失败');
  const detail = await detailRes.clone().json();
  const listClone = listRes.clone();
  await cache.put(p.detail, detailRes);
  await cache.put(p.list, listRes);
  const list = await listClone.json().catch(() => ({}));
  try {
    const cover = await fetch(p.cover, { credentials: 'same-origin' });
    if (cover.ok) await cache.put(p.cover, cover);
  } catch {
    /* 封面失败不影响 */
  }
  const total = detail?.book?.chapterCount || list?.total || 0;
  return { detail, list, total };
}

async function fetchAndStoreChapters(cache, bookId, indexes, { onProgress, signal, concurrency = 12 } = {}) {
  const queue = [...indexes];
  const totalN = queue.length;
  let done = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      const idx = queue.shift();
      try {
        const r = await fetch(`/api/books/${bookId}/chapter/${idx}`, { credentials: 'same-origin' });
        if (r.ok) await cache.put(`/api/books/${bookId}/chapter/${idx}`, r);
      } catch {
        /* 单章失败跳过 */
      }
      done++;
      onProgress?.(done, totalN);
    }
  });
  await Promise.all(workers);
  return done;
}

/* 计算已缓存大小（字节） */
async function cacheSize(cache, bookId) {
  const p = bookPaths(bookId);
  let bytes = 0;
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    const hit =
      path === p.detail ||
      path === p.list ||
      path === p.cover ||
      path.startsWith(`/api/books/${Number(bookId)}/chapter/`);
    if (!hit) continue;
    const res = await cache.match(req);
    if (!res) continue;
    try {
      bytes += (await res.clone().arrayBuffer()).byteLength;
    } catch {
      /* ignore */
    }
  }
  return bytes;
}

export async function downloadBook(bookId, opts = {}) {
  if (!downloadSupported()) throw new Error('当前环境不支持离线下载（请用 https 或外网隧道地址访问）');
  const cache = await openCache();
  const { detail, total } = await cacheBookShell(cache, bookId);
  const indexes = [];
  for (let i = 1; i <= total; i++) indexes.push(i);
  await fetchAndStoreChapters(cache, bookId, indexes, opts);
  const meta = {
    bookId: Number(bookId),
    title: detail?.book?.title || `#${bookId}`,
    author: detail?.book?.author || '',
    cover: detail?.book?.cover || '',
    category: detail?.book?.category || '',
    total,
    bytes: await cacheSize(cache, bookId),
    partial: false,
    ts: Date.now(),
  };
  await cache.put(bookPaths(bookId).manifest, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  return meta;
}

/** 只缓存指定章节（如“缓存本章”）；会同时缓存书籍信息与目录，保证离线可开读 */
export async function downloadChapters(bookId, indexes, opts = {}) {
  if (!downloadSupported()) throw new Error('当前环境不支持离线下载（请用 https 或外网隧道地址访问）');
  const cache = await openCache();
  const { detail, total } = await cacheBookShell(cache, bookId);
  const list = [...new Set(indexes.map(Number).filter((n) => n >= 1 && (!total || n <= total)))];
  await fetchAndStoreChapters(cache, bookId, list, opts);

  const prev = await getMetaRaw(cache, bookId);
  const meta = {
    bookId: Number(bookId),
    title: detail?.book?.title || prev?.title || `#${bookId}`,
    author: detail?.book?.author || prev?.author || '',
    cover: detail?.book?.cover || prev?.cover || '',
    category: detail?.book?.category || prev?.category || '',
    total,
    bytes: await cacheSize(cache, bookId),
    partial: true,
    chapters: await cachedChapterIndexes(cache, bookId),
    ts: Date.now(),
  };
  await cache.put(bookPaths(bookId).manifest, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  return meta;
}

async function getMetaRaw(cache, bookId) {
  const res = await cache.match(bookPaths(bookId).manifest);
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function cachedChapterIndexes(cache, bookId) {
  const out = [];
  for (const req of await cache.keys()) {
    const m = new URL(req.url).pathname.match(new RegExp(`^/api/books/${Number(bookId)}/chapter/(\\d+)$`));
    if (m) out.push(Number(m[1]));
  }
  out.sort((a, b) => a - b);
  return out;
}

export async function listDownloads() {
  if (!downloadSupported()) return [];
  const cache = await openCache();
  const out = [];
  for (const req of await cache.keys()) {
    if (!new URL(req.url).pathname.startsWith(MANIFEST_PREFIX)) continue;
    const res = await cache.match(req);
    if (!res) continue;
    try {
      out.push(await res.json());
    } catch {
      /* ignore */
    }
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}

export async function getDownload(bookId) {
  const cache = await openCache();
  const res = await cache.match(bookPaths(bookId).manifest);
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function removeDownload(bookId) {
  if (!downloadSupported()) return;
  const cache = await openCache();
  const p = bookPaths(bookId);
  const id = Number(bookId);
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (
      path === p.detail ||
      path === p.list ||
      path === p.cover ||
      path === p.manifest ||
      path.startsWith(`/api/books/${id}/chapter/`)
    ) {
      await cache.delete(req);
    }
  }
}

export async function downloadTotalSize() {
  if (!downloadSupported()) return 0;
  const cache = await openCache();
  const list = await listDownloads();
  return list.reduce((n, m) => n + (m.bytes || 0), 0);
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
