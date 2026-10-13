/**
 * 服务端语音合成（默认走百度翻译的在线 TTS，无需密钥）。
 *
 * 为什么需要它：微信 / QQ / 夸克 等 App 内置浏览器没有 Web Speech API，
 * 手机上「听书」会提示「当前浏览器不支持」。改为服务端合成 mp3，
 * 前端只用 <audio> 播放，任何浏览器都能听。
 *
 * - 按标点切分长段落，逐段请求后拼接（MP3 帧可安全拼接）。
 * - 内存 + 磁盘两级缓存（data/tts-cache），避免重复合成。
 * - 串行队列 + 超时，做一个有礼貌、稳定的客户端。
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DATA_DIR } from '../config.mjs';

const CACHE_DIR = path.join(DATA_DIR, 'tts-cache');
const BAIDU_URL = 'https://fanyi.baidu.com/gettts';
const MAX_CHUNK = 240; // 单次请求的最大字符数
const MAX_TEXT = 4000; // 单段文本上限，超出直接截断

const memCache = new Map();
const MAX_MEM = 80;

// 保证同一时刻只有一个外部请求，避免被风控
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

function keyOf(text, rate) {
  return createHash('sha1').update(`baidu|${Number(rate) || 1}|${text}`).digest('hex');
}

/**
 * 可选音色。除「原声」外，其余由「百度标准女声 + ffmpeg rubberband 变声」得到：
 * 不依赖任何密钥、不额外消耗上游配额，只在第一次合成时变声并落盘缓存。
 * 变声使用 rubberband（同时调整基频与共振峰），比单纯变调更自然、不太"机器人"。
 */
export const VOICE_PRESETS = [
  { id: 'baidu', name: '标准女声', note: '原声，自然清晰' },
  { id: 'soft', name: '温柔女声', note: '更柔更轻，适合言情 / 日常', needsFfmpeg: true },
  { id: 'bright', name: '清亮女声', note: '音调偏高，明亮活泼', needsFfmpeg: true },
  { id: 'deep', name: '低沉男声', note: '音色偏低，适合历史 / 武侠', needsFfmpeg: true },
  { id: 'magnetic', name: '磁性男声', note: '更厚更低，旁白感，适合悬疑', needsFfmpeg: true },
  { id: 'child', name: '童声', note: '音调更高，像讲故事的小朋友', needsFfmpeg: true },
];

/** 音色 -> ffmpeg 滤镜；空串表示原声 */
const VOICE_FILTER = {
  baidu: '',
  soft: 'rubberband=pitch=1.06:formant=1.05',
  bright: 'rubberband=pitch=1.15:formant=1.12',
  deep: 'rubberband=pitch=0.84:formant=0.90',
  magnetic: 'rubberband=pitch=0.76:formant=0.84',
  child: 'rubberband=pitch=1.28:formant=1.22',
};

/** 未知音色一律回退到原声，避免任意参数进入 ffmpeg 命令行 */
export function normalizeVoice(voice) {
  const v = String(voice || 'baidu');
  return VOICE_FILTER[v] !== undefined ? v : 'baidu';
}

let ffmpegOk = null;
/** 是否装了 ffmpeg（变声依赖它）；未安装时只提供原声 */
export function ffmpegAvailable() {
  if (ffmpegOk !== null) return ffmpegOk;
  try {
    const r = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
    ffmpegOk = r.status === 0;
  } catch {
    ffmpegOk = false;
  }
  return ffmpegOk;
}

/** 用 ffmpeg 对 mp3 做变声；失败由调用方回退到原声 */
function runFfmpeg(buf, filter) {
  return new Promise((resolve, reject) => {
    const bin = process.env.FFMPEG || 'ffmpeg';
    const p = spawn(bin, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-af',
      filter,
      '-b:a',
      '48k',
      '-f',
      'mp3',
      'pipe:1',
    ]);
    const out = [];
    const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code} ${Buffer.concat(err).toString().slice(0, 120)}`)),
    );
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
  });
}

/** 把速度倍率（0.5~2.0）映射到百度 spd（1~7），1 最慢、7 最快 */
export function mapRate(rate) {
  const r = Number(rate) || 1;
  return Math.min(7, Math.max(1, Math.round(r * 4)));
}

/** 按句子边界切分长文本，保证每块不超过 limit 个字符 */
export function chunkText(text, limit = MAX_CHUNK) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return [];
  if (s.length <= limit) return [s];
  const parts = [];
  let cur = '';
  // 在中文/英文句末标点后切分，保留标点
  const sentences = s.split(/(?<=[。！？!?；;…\n])/);
  for (const sen of sentences) {
    if (!sen) continue;
    if (sen.length > limit) {
      if (cur) {
        parts.push(cur);
        cur = '';
      }
      for (let i = 0; i < sen.length; i += limit) parts.push(sen.slice(i, i + limit));
    } else if ((cur + sen).length > limit) {
      if (cur) parts.push(cur);
      cur = sen;
    } else {
      cur += sen;
    }
  }
  if (cur) parts.push(cur);
  return parts.filter((p) => p.trim());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 请求一小段文字。百度 TTS 偶发 `503`，旧实现直接抛错，
 * 会让前端整场听书中断；这里对可重试的失败（网络 / 5xx / 非音频）
 * 做指数退避重试，显著降低中断率。
 */
async function fetchOne(text, rate) {
  const spd = mapRate(rate);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(`${BAIDU_URL}?lan=zh&spd=${spd}&source=web`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Referer: 'https://fanyi.baidu.com/',
          Accept: 'audio/mpeg,*/*',
        },
        body: new URLSearchParams({ text }).toString(),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`tts ${r.status}`);
      const ct = r.headers.get('content-type') || '';
      const buf = Buffer.from(await r.arrayBuffer());
      if (!ct.includes('audio') || buf.length < 200) throw new Error('tts 返回了非音频内容');
      return buf;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(200 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function putMem(key, buf) {
  memCache.set(key, buf);
  if (memCache.size > MAX_MEM) {
    const first = memCache.keys().next().value;
    memCache.delete(first);
  }
}

/**
 * 合成一段文本，返回 mp3 Buffer。
 * @param {string} text
 * @param {{rate?: number, voice?: string}} opts
 */
export async function synthesize(text, { rate = 1, voice = 'baidu' } = {}) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
  if (!clean) throw new Error('空文本');

  const v = normalizeVoice(voice);
  const filter = ffmpegAvailable() ? VOICE_FILTER[v] : '';
  const baseKey = keyOf(clean, rate);
  const finalKey = filter ? `${baseKey}-${v}` : baseKey;

  if (memCache.has(finalKey)) return memCache.get(finalKey);

  const file = path.join(CACHE_DIR, `${finalKey}.mp3`);
  try {
    const buf = await fsp.readFile(file);
    if (buf.length > 200) {
      putMem(finalKey, buf);
      return buf;
    }
  } catch {
    /* 缓存未命中 */
  }

  const base = await baseSynthesize(clean, rate, baseKey);
  let out = base;
  if (filter) {
    try {
      out = await runFfmpeg(base, filter);
    } catch {
      out = base; // 变声失败就用原声，别让听书断掉
    }
  }
  putMem(finalKey, out);

  // 异步写盘缓存，不阻塞返回
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fsp.writeFile(file, out).catch(() => {});
  } catch {
    /* ignore */
  }
  return out;
}

/** 原声（百度）合成，结果按 text+rate 缓存；变声只管在它之上加工 */
async function baseSynthesize(clean, rate, key) {
  if (memCache.has(key)) return memCache.get(key);

  const file = path.join(CACHE_DIR, `${key}.mp3`);
  try {
    const buf = await fsp.readFile(file);
    if (buf.length > 200) {
      putMem(key, buf);
      return buf;
    }
  } catch {
    /* 缓存未命中 */
  }

  const chunks = chunkText(clean);
  const buffers = [];
  for (const c of chunks) buffers.push(await enqueue(() => fetchOne(c, rate)));
  const out = Buffer.concat(buffers);
  putMem(key, out);

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fsp.writeFile(file, out).catch(() => {});
  } catch {
    /* ignore */
  }
  return out;
}
