import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* 访问口令：ACCESS_PASSWORD 非空时启用。
   - token 是「URL 令牌」：手机把它拼在网址后（?k=…）即可免去每次输密码，
     并会在首次访问时写入 Cookie，之后即使不带 ?k= 也能进（用于「添加到主屏幕」）。 */
const accessUser = process.env.ACCESS_USER || 'shusheng';
const accessPassword = process.env.ACCESS_PASSWORD || '';
const accessToken = accessPassword
  ? createHash('sha256').update(`novelverse:${accessUser}:${accessPassword}`).digest('hex').slice(0, 32)
  : '';

export const ROOT = path.resolve(__dirname, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = path.join(ROOT, 'data');
export const COVER_DIR = path.join(DATA_DIR, 'covers');
export const DB_PATH = path.join(DATA_DIR, 'novelverse.db');

export const config = {
  siteName: process.env.SITE_NAME || '书声',
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '0.0.0.0',

  // 访问口令（可选）：设置 ACCESS_PASSWORD 后，全站需 Basic 认证才能访问。
  // 局域网可留空；若要经公网隧道暴露，强烈建议设置。
  access: {
    user: accessUser,
    password: accessPassword,
    token: accessToken,
  },

  // 抓取参数：并发、超时、重试、请求间隔（做一个有礼貌的爬虫）
  crawl: {
    timeoutMs: Number(process.env.CRAWL_TIMEOUT || 15000),
    // 用户搜索时单源限时（秒级返回，个别源故障不拖垮整次搜索）
    searchTimeoutMs: Number(process.env.CRAWL_SEARCH_TIMEOUT || 8000),
    retries: Number(process.env.CRAWL_RETRIES || 3),
    concurrency: Number(process.env.CRAWL_CONCURRENCY || 12),
    delayMs: Number(process.env.CRAWL_DELAY || 250),
  },

  // 听书引擎：
  //   baidu（默认）= 服务端在线合成 mp3，无需密钥，任何浏览器都能听（含微信/夸克内置浏览器）
  //   azure        = 服务端神经语音，需 AZURE_TTS_KEY，音质更自然
  //   browser      = 只用浏览器 Web Speech（旧行为，部分手机浏览器不支持）
  tts: {
    provider: (process.env.TTS_PROVIDER || 'baidu').toLowerCase(),
    azureKey: process.env.AZURE_TTS_KEY || '',
    azureRegion: process.env.AZURE_TTS_REGION || 'eastasia',
  },

  // 阅读预加载：看某章时后台预取后续章节（写入章节缓存），让「下一章」秒开
  //   0 = 关闭。服务端只负责把内容抓进缓存，抓取仍受 crawl.concurrency 限速。
  reader: {
    prefetch: Math.max(0, Number(process.env.PREFETCH_CHAPTERS ?? 3)),
  },

  // 手机 / 外网访问：默认启动时自动建立隧道，让手机在任意网络都能打开
  //   关闭：SHARE=0
  //   provider：auto（默认，自动选择）/ quick（Cloudflare 临时隧道）/ ngrok / tailscale / custom
  //   固定网址（重启后不变）：设置 SHARE_URL（自建/命名隧道）或 ngrok 的 SHARE_DOMAIN + NGROK_AUTHTOKEN
  share: {
    enabled: process.env.SHARE !== '0',
    provider: (process.env.SHARE_PROVIDER || 'auto').toLowerCase(),
    url: (process.env.SHARE_URL || '').replace(/\/+$/, ''),
    domain: (process.env.SHARE_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    ngrokToken: process.env.NGROK_AUTHTOKEN || '',
  },

  // 搜索时自动抓取：本地书库没有的相关小说，自动从网络书源抓取并入库
  autoFetchOnSearch: process.env.AUTO_FETCH_SEARCH !== '0',
  autoFetchLimit: Number(process.env.AUTO_FETCH_LIMIT || 15),

  // 内容合规过滤：拦截违法涉黄 / 低俗色情作品（书名、作者、简介）
  contentFilter: {
    enabled: process.env.CONTENT_FILTER !== '0',
    extraTerms: (process.env.BLOCK_TERMS || '').split(',').map((s) => s.trim()).filter(Boolean),
  },

  // 每日自动维护：默认每天凌晨 1 点抓取“已存在小说的更新”并扩充书库
  schedule: {
    enabled: process.env.AUTO_UPDATE !== '0',
    hour: Number(process.env.UPDATE_HOUR ?? 1),
    minute: Number(process.env.UPDATE_MINUTE ?? 0),
    syncPages: Number(process.env.UPDATE_SYNC_PAGES || 3), // 每日扩充：每分类/榜单抓几页
    deepSync: process.env.UPDATE_DEEP !== '0', // 每日扩充是否遍历“全部分类 × 全部榜单”
    updateLimit: Number(process.env.UPDATE_LIMIT || 30), // 每日最多检查多少本已有书
  },
};

export const CATEGORIES = [
  { code: 1, name: '玄幻小说', slug: 'xuanhuan' },
  { code: 2, name: '修真小说', slug: 'xiuzhen' },
  { code: 3, name: '都市小说', slug: 'dushi' },
  { code: 4, name: '历史小说', slug: 'lishi' },
  { code: 5, name: '网游小说', slug: 'wangyou' },
  { code: 6, name: '科幻小说', slug: 'kehuan' },
  { code: 9, name: '其他小说', slug: 'qita' },
];
