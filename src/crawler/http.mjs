import { config } from '../config.mjs';
import { sleep } from '../util.mjs';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
];

let uaIndex = 0;
function nextUA() {
  return USER_AGENTS[uaIndex++ % USER_AGENTS.length];
}

/** 全局并发闸门，避免把源站打挂 */
class Gate {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const gate = new Gate(config.crawl.concurrency);

/**
 * 带重试 / 超时 / 限速的抓取
 * @returns {Promise<{ok:boolean, status:number, text:string, buffer?:Buffer, error?:string, url:string}>}
 */
export async function fetchRaw(url, opts = {}) {
  const { method = 'GET', headers = {}, body, parse = 'text', referer } = opts;
  const retries = opts.retries ?? config.crawl.retries;

  await gate.acquire();
  try {
    let lastErr = '';
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers: {
            'User-Agent': nextUA(),
            Accept: parse === 'buffer' ? 'image/avif,image/webp,image/*,*/*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Cache-Control': 'no-cache',
            ...(referer ? { Referer: referer } : {}),
            ...headers,
          },
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? config.crawl.timeoutMs),
        });

        if (!res.ok) {
          lastErr = `HTTP ${res.status}`;
          // 5xx / 429 可重试，4xx 直接返回
          if (res.status < 500 && res.status !== 429) {
            return { ok: false, status: res.status, text: '', url: res.url, error: lastErr };
          }
          await sleep(config.crawl.delayMs * (attempt + 1));
          continue;
        }

        if (parse === 'buffer') {
          const buffer = Buffer.from(await res.arrayBuffer());
          return { ok: true, status: res.status, text: '', buffer, url: res.url };
        }
        const text = await res.text();
        return { ok: true, status: res.status, text, url: res.url };
      } catch (err) {
        lastErr = err?.name === 'TimeoutError' ? '请求超时' : String(err?.message || err);
        await sleep(config.crawl.delayMs * (attempt + 1));
      }
    }
    return { ok: false, status: 0, text: '', url, error: lastErr };
  } finally {
    gate.release();
  }
}

export async function fetchText(url, opts = {}) {
  return fetchRaw(url, { ...opts, parse: 'text' });
}

export async function fetchBuffer(url, opts = {}) {
  return fetchRaw(url, { ...opts, parse: 'buffer' });
}

/** POST 表单（用于源站搜索接口） */
export async function postForm(url, form, opts = {}) {
  const body = new URLSearchParams(form).toString();
  return fetchRaw(url, {
    ...opts,
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(opts.headers || {}) },
  });
}
