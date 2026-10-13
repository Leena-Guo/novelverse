const CLIENT_KEY = 'nv-client-id';

export function clientId() {
  let id = localStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = 'u-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    localStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

async function req(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Client-Id': clientId(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // 离线或网络中断：不抛异常，调用方按 ok:false 处理
    return { ok: false, offline: true, error: '网络不可用（可能处于离线状态）' };
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { ok: false, error: '响应解析失败', raw: text.slice(0, 200) };
  }
  if (!res.ok && data.ok === undefined) data.ok = false;
  return data;
}

const qs = (o) => {
  const s = new URLSearchParams();
  Object.entries(o || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') s.set(k, v);
  });
  return s.toString();
};

/* ---------- 章节内存缓存 + 预加载（翻章免等待）---------- */
const CHAPTER_CACHE_MAX = 32;
const chapterCache = new Map(); // `${bookId}:${idx}` -> 章节响应（章节正文不可变，可安全缓存）

function rememberChapter(key, data) {
  if (!data || !data.ok || !Array.isArray(data.paragraphs)) return;
  chapterCache.delete(key); // 重插到末尾，维持 LRU 顺序
  chapterCache.set(key, data);
  while (chapterCache.size > CHAPTER_CACHE_MAX) {
    chapterCache.delete(chapterCache.keys().next().value);
  }
}

function loadChapter(id, idx, force) {
  const key = `${id}:${idx}`;
  if (!force) {
    const hit = chapterCache.get(key);
    if (hit) return Promise.resolve(hit);
  }
  return req(`/api/books/${id}/chapter/${idx}${force ? '?force=1' : ''}`).then((data) => {
    rememberChapter(key, data);
    return data;
  });
}

let prefetchSeq = 0;
const prefetching = new Set();

/**
 * 顺序预取某章之后的若干章到内存缓存；去重，且切换书籍 / 章节时自动作废旧任务。
 * 失败静默忽略（预加载失败不影响正常阅读）。
 */
export function prefetchChapters(id, fromIdx, count) {
  const seq = ++prefetchSeq;
  const n = Math.max(0, Number(count) || 0);
  if (!n) return;
  (async () => {
    for (let i = 1; i <= n; i++) {
      if (seq !== prefetchSeq) return; // 已切换书籍 / 章节，停止后续预取
      const idx = fromIdx + i;
      const key = `${id}:${idx}`;
      if (chapterCache.has(key) || prefetching.has(key)) continue;
      prefetching.add(key);
      try {
        rememberChapter(key, await req(`/api/books/${id}/chapter/${idx}`));
      } catch {
        /* ignore */
      } finally {
        prefetching.delete(key);
      }
    }
  })();
}

export const api = {
  home: () => req('/api/home'),
  categories: () => req('/api/categories'),
  tags: () => req('/api/tags'),
  books: (params) => req('/api/books?' + qs(params)),
  book: (id) => req(`/api/books/${id}`),
  chapters: (id, params) => req(`/api/books/${id}/chapters?` + qs(params)),
  chapter: (id, idx, force) => loadChapter(id, idx, force),
  prefetchChapters,
  enrich: (id) => req(`/api/books/${id}/enrich`, { method: 'POST' }),
  search: (q, remote = true) => req('/api/search?' + qs({ q, remote: remote ? 1 : 0 })),
  importBook: (sourceId, source) => req('/api/import', { method: 'POST', body: { sourceId, source } }),

  shelf: () => req('/api/shelf'),
  addShelf: (bookId) => req('/api/shelf', { method: 'POST', body: { bookId } }),
  removeShelf: (bookId) => req(`/api/shelf/${bookId}`, { method: 'DELETE' }),

  history: () => req('/api/history'),
  recordHistory: (bookId, chapterIdx) => req('/api/history', { method: 'POST', body: { bookId, chapterIdx } }),
  clearHistory: () => req('/api/history', { method: 'DELETE' }),
  removeHistory: (bookId) => req(`/api/history/${bookId}`, { method: 'DELETE' }),

  syncStatus: () => req('/api/crawl/status'),
  sync: (body) => req('/api/crawl/sync', { method: 'POST', body }),
  syncCancel: () => req('/api/crawl/sync/cancel', { method: 'POST' }),
  daily: () => req('/api/crawl/daily', { method: 'POST' }),
  purge: (dryRun) => req('/api/crawl/purge', { method: 'POST', body: { dryRun: !!dryRun } }),
  rebuildTags: () => req('/api/tags/rebuild', { method: 'POST' }),
  removeBook: (id) => req(`/api/books/${id}`, { method: 'DELETE' }),
  ttsVoices: () => req('/api/tts/voices'),
  share: () => req('/api/share'),
  shareRestart: () => req('/api/share/restart', { method: 'POST' }),

  me: () => req('/api/auth/me'),
  register: (username, password, name) => req('/api/auth/register', { method: 'POST', body: { username, password, name } }),
  login: (username, password) => req('/api/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => req('/api/auth/logout', { method: 'POST' }),
};
