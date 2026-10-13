import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, PUBLIC_DIR } from './src/config.mjs';
import { lanIPv4 } from './src/net.mjs';
import { startShare, stopShare } from './src/services/tunnel.mjs';
import { handleApi } from './src/api.mjs';
import { stats } from './src/services/books.mjs';
import { ensureSeed } from './src/seed.mjs';
import { startScheduler } from './src/services/scheduler.mjs';
import { purgeBlockedBooks, ensureTags } from './src/services/catalog.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};

/* ---------------- 访问口令（可选，HTTP Basic Auth） ---------------- */

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * 未设置 ACCESS_PASSWORD 时永远放行。
 * 设置后，公网与局域网请求都需要鉴权，可通过三种方式：
 *   1) URL 令牌  ?k=<token>   —— 手机「添加到主屏幕」用，首次访问自动写 Cookie
 *   2) Cookie    nv_auth=<token>
 *   3) HTTP Basic 认证（兼容旧方式）
 *
 * 安全模型（重要）：只有「来自 loopback 且未经任何转发」的请求才免密，
 * 即真正的本机进程。任何远端（含经隧道转发）都必须携带口令/令牌。
 * 旧实现是「没有 X-Forwarded-* 头就免密」，任何人都能直连端口绕过鉴权，已修复；
 * 同时服务默认只监听 127.0.0.1，使远端无法直连，只能经隧道（带转发头）。
 */
function isLoopback(req) {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function authOk(req, url) {
  const password = config.access.password;
  if (!password) return true;
  const forwarded =
    req.headers['x-forwarded-for'] ||
    req.headers['x-forwarded-host'] ||
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'];
  if (!forwarded && isLoopback(req)) return true;
  // 1) URL 令牌
  const k = url?.searchParams?.get('k');
  if (k && config.access.token && safeEqual(k, config.access.token)) return true;
  // 2) Cookie 令牌
  const cookie = parseCookies(req.headers.cookie).nv_auth;
  if (cookie && config.access.token && safeEqual(cookie, config.access.token)) return true;
  // 3) Basic 认证
  const header = req.headers.authorization || '';
  const [scheme, b64] = header.split(' ');
  if (scheme !== 'Basic' || !b64) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return false;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), config.access.user) && safeEqual(decoded.slice(i + 1), password);
}

/* ---------------- 登录失败限流（防止公网暴力破解口令） ---------------- */

const AUTH_MAX_FAILS = 20; // 同一来源窗口内的最大失败次数
const AUTH_WINDOW_MS = 10 * 60 * 1000; // 窗口 10 分钟
const authFails = new Map(); // key -> { count, ts }

/** 优先用真实客户端 IP（隧道会带 X-Forwarded-For），否则用 socket 地址 */
function clientKey(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket?.remoteAddress || 'unknown';
}

function authThrottled(key) {
  const rec = authFails.get(key);
  if (!rec) return false;
  if (Date.now() - rec.ts > AUTH_WINDOW_MS) {
    authFails.delete(key);
    return false;
  }
  return rec.count >= AUTH_MAX_FAILS;
}

function noteAuthFail(key) {
  const rec = authFails.get(key);
  if (!rec || Date.now() - rec.ts > AUTH_WINDOW_MS) authFails.set(key, { count: 1, ts: Date.now() });
  else {
    rec.count += 1;
    rec.ts = Date.now();
  }
}

/** 安全响应头：防 MIME 嗅探、防点击劫持、防 referrer 泄露令牌、限制能力 */
function setSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; " +
      "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  if (req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
}

/* ---------------- 静态资源 ---------------- */

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA 回退
      const fallback = path.join(PUBLIC_DIR, 'index.html');
      return fs.readFile(fallback, (e, buf) => {
        if (e) {
          res.writeHead(404);
          return res.end('Not Found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(buf);
      });
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  setSecurityHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Client-Id',
    });
    return res.end();
  }

  const tokenViaUrl =
    config.access.password &&
    config.access.token &&
    url.searchParams.get('k') &&
    safeEqual(url.searchParams.get('k'), config.access.token);

  // 登录失败限流：超过阈值直接 429，拖慢暴力破解
  const key = clientKey(req);
  if (config.access.password && authThrottled(key) && !tokenViaUrl) {
    res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '600' });
    return res.end('尝试过于频繁，请 10 分钟后再试');
  }

  if (!authOk(req, url)) {
    noteAuthFail(key);
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Shusheng", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return res.end('需要访问口令');
  }
  authFails.delete(key);

  // 用 ?k= 令牌进来的：发一个长期 Cookie，之后（含「添加到主屏幕」）免密
  if (tokenViaUrl) {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `nv_auth=${config.access.token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  }
});

server.listen(config.port, config.host, () => {
  const seed = ensureSeed();
  const purged = purgeBlockedBooks();
  // 题材标签：仅当题材词表版本变化时重算（见 src/tags.mjs 的 GENRE_VERSION）
  const tagged = ensureTags();
  const s = stats();
  console.log(`\n  📚 ${config.siteName} · 小说阅读与听书平台`);
  if (seed.seeded) console.log(`  ▸ 已载入离线兜底书库（${seed.books} 本，抓取可用时可自动扩充）`);
  if (config.contentFilter.enabled) {
    console.log(`  ▸ 内容合规:  已开启（启动清理违规作品 ${purged.removed} 本）`);
  } else {
    console.log(`  ▸ 内容合规:  已关闭（CONTENT_FILTER=0）`);
  }
  console.log(`  ▸ 本地访问:  http://localhost:${config.port}`);
  if (config.host === '0.0.0.0' || config.host === '::') {
    const ips = lanIPv4();
    for (const ip of ips) console.log(`  ▸ 手机访问:  http://${ip}:${config.port}   （手机连同一 Wi-Fi 后，用浏览器打开）`);
    if (ips.length) console.log('                · 想在外网/流量下也能用？见 README「手机访问与部署」的隧道方案');
  } else {
    console.log(`  ▸ 提示:      当前仅监听 ${config.host}，手机无法直连；设 HOST=0.0.0.0 可开放局域网访问`);
  }
  if (config.access.password) {
    console.log(`  ▸ 访问口令:  已开启（用户名 ${config.access.user}，密码见 ACCESS_PASSWORD）`);
  } else if (config.host === '0.0.0.0' || config.host === '::') {
    console.log('  ▸ 安全提示:  未设置访问口令；若将服务暴露到公网，建议设置 ACCESS_PASSWORD 后再开放');
  }
  if (tagged) console.log(`  ▸ 题材标签:  已为 ${tagged.books} 本书抽取题材（共 ${Object.keys(tagged.tags).length} 类）`);
  console.log(`  ▸ 书库:      ${s.books} 本书 / ${s.chapters} 章（已缓存正文 ${s.cached} 章）`);
  const ttsLabel =
    config.tts.provider === 'azure'
      ? config.tts.azureKey
        ? 'Azure 神经语音（服务端）'
        : 'Azure（未配置密钥，改用百度）'
      : config.tts.provider === 'browser'
        ? '浏览器 Web Speech（部分手机浏览器不支持）'
        : '服务端在线语音（百度，任何浏览器都能听）';
  console.log(`  ▸ 听书引擎:  ${ttsLabel}`);
  const sched = startScheduler();
  if (sched.enabled) {
    const pad = (n) => String(n).padStart(2, '0');
    console.log(`  ▸ 每日更新:  每天 ${pad(sched.hour)}:${pad(sched.minute)} 自动抓取更新 / 扩充书库（下次 ${new Date(sched.nextRun).toLocaleString()}）`);
  } else {
    console.log('  ▸ 每日更新:  已关闭（AUTO_UPDATE=0 可关闭，UPDATE_HOUR 可改时间）');
  }
  if (config.share.enabled) {
    console.log(`  ▸ 外网访问:  正在建立隧道…（二维码与地址：http://localhost:${config.port}/#/share）`);
    startShare().catch(() => {});
  } else {
    console.log('  ▸ 外网访问:  已关闭（需要时执行 npm run share）');
  }
  console.log('');
});

function shutdown(signal) {
  console.log(`\n  收到 ${signal}，正在关闭…`);
  stopShare();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
