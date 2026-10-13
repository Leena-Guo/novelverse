// Service Worker：应用外壳缓存（离线可打开）+ 已下载书籍的离线回退。
// 说明：Service Worker 仅在 https 或 localhost 下生效；局域网 http 访问时自动跳过。
const CACHE = 'shusheng-v21';
const DL_CACHE = 'nv-downloads-v1';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/store.js',
  '/js/tts.js',
  '/js/offline.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== DL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 这些接口可使用“已下载”缓存做离线回退（按路径匹配，忽略查询串）
function isCacheableApi(pathname) {
  return (
    /^\/api\/books\/\d+$/.test(pathname) ||
    /^\/api\/books\/\d+\/chapters$/.test(pathname) ||
    /^\/api\/books\/\d+\/chapter\/\d+$/.test(pathname) ||
    /^\/api\/cover\/\d+$/.test(pathname)
  );
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 动态接口：命中“已下载”缓存时做离线回退，其余不拦截
  if (url.pathname.startsWith('/api/')) {
    if (!isCacheableApi(url.pathname)) return;
    e.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          const cache = await caches.open(DL_CACHE);
          const hit = await cache.match(url.pathname); // 仅路径，忽略查询串
          if (hit) return hit;
          throw new Error('offline');
        }
      })(),
    );
    return;
  }

  // 静态资源 / 应用外壳：网络优先，失败回退缓存
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
        }
        return res;
      })
      .catch(() => caches.match(req).then((m) => m || caches.match('/index.html'))),
  );
});
