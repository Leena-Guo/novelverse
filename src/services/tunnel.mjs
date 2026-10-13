// 外网隧道服务：让手机在任意网络（含 4G/5G）都能访问本机服务。
//
// 支持的 provider：
//   custom    —— 你自己已在跑的隧道，只需设 SHARE_URL（网址稳定）
//   quick     —— Cloudflare 临时隧道（零配置，但每次启动网址会变）
//   ngrok     —— 需 NGROK_AUTHTOKEN；设 SHARE_DOMAIN 用固定域名（网址稳定）
//   tailscale —— Tailscale Funnel，网址为 https://<节点名>.<tailnet>.ts.net（网址稳定）
//
// 默认在服务启动后自动拉起（SHARE=0 可关闭）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { config, ROOT } from '../config.mjs';
import { getMeta, setMeta } from '../db.mjs';
import { lanIPv4 } from '../net.mjs';
import { qrTerminal } from '../qr.mjs';

const TOOL_DIR = path.join(ROOT, '.tools');

export const shareState = {
  enabled: config.share.enabled,
  requested: config.share.provider,
  provider: '',
  url: config.share.url || '',
  status: config.share.enabled ? 'idle' : 'disabled',
  error: '',
  stable: Boolean(config.share.url),
  startedAt: null,
  announced: '',
  runId: 0,
};

let child = null;
let lastUrl = '';
try {
  lastUrl = getMeta('share_last_url') || '';
} catch {
  lastUrl = '';
}

export function getShare() {
  return {
    enabled: shareState.enabled,
    provider: shareState.provider,
    requested: shareState.requested,
    url: shareState.url,
    status: shareState.status,
    error: shareState.error,
    stable: shareState.stable,
    startedAt: shareState.startedAt,
    lastUrl,
    local: `http://localhost:${config.port}`,
    lan: lanIPv4(),
    port: config.port,
  };
}

function setUrl(url) {
  if (!url || url === shareState.url) return;
  shareState.url = url;
  shareState.status = 'online';
  shareState.startedAt = Date.now();
  if (url !== lastUrl) {
    lastUrl = url;
    try {
      setMeta('share_last_url', url);
    } catch {
      /* ignore */
    }
  }
  announce();
}

function announce() {
  if (shareState.announced === shareState.url) return;
  shareState.announced = shareState.url;
  console.log(`\n  📱 外网访问地址：${shareState.url}`);
  if (!config.access.password) {
    console.log('  ⚠️  当前未设置访问口令：任何拿到该网址的人都能访问书库。建议用 ACCESS_PASSWORD=你的密码 再启动。');
  }
  console.log(`  🔳 二维码 / 局域网地址：用本机浏览器打开  http://localhost:${config.port}/#/share`);
  if (process.stdout.isTTY) {
    try {
      console.log('\n' + qrTerminal(shareState.url, { margin: 2 }) + '\n');
    } catch {
      /* 终端不支持 ANSI 时忽略 */
    }
  }
}

function hasCmd(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 && String(r.stdout).trim().length > 0;
}

function resolveProvider() {
  const want = config.share.provider;
  if (config.share.url) return 'custom';
  if (want && want !== 'auto') return want;
  if (config.share.ngrokToken && config.share.domain) return 'ngrok';
  return 'quick';
}

async function ensureCloudflared() {
  const binName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const dest = path.join(TOOL_DIR, binName);
  if (fs.existsSync(dest)) return dest;
  if (hasCmd('cloudflared')) return 'cloudflared';

  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const asset = process.platform === 'win32'
    ? 'cloudflared-windows-amd64.exe'
    : `cloudflared-linux-${arch}`;
  fs.mkdirSync(TOOL_DIR, { recursive: true });
  console.log(`  ⇣ 首次运行：正在下载 cloudflared …（${asset}）`);
  const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`, {
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`下载 cloudflared 失败：HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  fs.chmodSync(dest, 0o755);
  return dest;
}

function wireChild(proc, { onLine, runId }) {
  const handle = (buf) => {
    if (shareState.runId !== runId) return; // 已被新一轮隧道取代
    onLine(buf.toString());
  };
  proc.stdout?.on('data', handle);
  proc.stderr?.on('data', handle);
  proc.on('exit', (code) => {
    if (shareState.runId !== runId) return;
    shareState.status = code === 0 ? 'stopped' : 'error';
    if (code !== 0) shareState.error = `隧道进程退出（code=${code}）`;
  });
  proc.on('error', (err) => {
    if (shareState.runId !== runId) return;
    shareState.status = 'error';
    shareState.error = String(err?.message || err);
  });
}

function runQuick(runId) {
  return ensureCloudflared().then((bin) => {
    child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${config.port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    wireChild(child, {
      runId,
      onLine: (text) => {
        const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) setUrl(m[0]);
      },
    });
  });
}

function runNgrok(runId) {
  if (!hasCmd('ngrok')) {
    throw new Error('未找到 ngrok 命令；请先安装 ngrok 并设置 NGROK_AUTHTOKEN（见 README）');
  }
  const args = ['http', String(config.port), '--log', 'stdout'];
  if (config.share.domain) args.push('--url', `https://${config.share.domain}`);
  child = spawn('ngrok', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NGROK_AUTHTOKEN: config.share.ngrokToken || process.env.NGROK_AUTHTOKEN || '' },
  });
  wireChild(child, {
    runId,
    onLine: (text) => {
      const m =
        text.match(/https:\/\/[a-z0-9-]+\.(?:ngrok-free\.app|ngrok-free\.dev|ngrok\.app|ngrok\.io)/) ||
        text.match(/"url"\s*:\s*"(https:\/\/[^"]+)"/);
      if (m) {
        shareState.stable = Boolean(config.share.domain);
        setUrl(m[1] || m[0]);
      }
    },
  });
}

function runTailscale() {
  if (!hasCmd('tailscale')) throw new Error('未安装 tailscale（见 README 方案 C）');
  const st = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
  if (st.status !== 0) throw new Error('tailscale 未登录，请先执行 tailscale up');
  let dns = '';
  try {
    const info = JSON.parse(st.stdout || '{}');
    dns = String(info?.Self?.DNSName || '').replace(/\.$/, '');
  } catch {
    /* ignore */
  }
  if (!dns) throw new Error('未能获取 tailscale 节点域名');

  // 若 Funnel 已开启（通常由 start-remote.sh 以 root 预先开启且常驻），
  // 非 root 进程既无需也无法再次开启，直接复用即可。
  if (funnelProxyMatchesPort()) {
    shareState.stable = true;
    setUrl(`https://${dns}`);
    return;
  }

  const r = spawnSync('tailscale', ['funnel', '--bg', String(config.port)], { encoding: 'utf8' });
  if (r.status !== 0) {
    const msg = String(r.stderr || r.stdout || '').trim();
    throw new Error(
      `tailscale funnel 开启失败：${msg}\n` +
        `  （非 root 运行时无法自行开启，请以 root 执行  tailscale funnel --bg ${config.port}，或直接运行 start-remote.sh）`,
    );
  }
  shareState.stable = true;
  setUrl(`https://${dns}`);
}

/** Funnel 是否已把本机端口对外代理（读取 tailscale funnel status，非 root 亦可） */
function funnelProxyMatchesPort() {
  const r = spawnSync('tailscale', ['funnel', 'status'], { encoding: 'utf8' });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  return new RegExp(`:${config.port}(\\s|$)`).test(out);
}

export async function startShare() {
  if (!shareState.enabled) {
    shareState.status = 'disabled';
    return getShare();
  }
  if (shareState.status === 'online' || shareState.status === 'starting') return getShare();
  const provider = resolveProvider();
  shareState.provider = provider;

  if (provider === 'custom') {
    shareState.stable = true;
    setUrl(config.share.url);
    return getShare();
  }

  shareState.error = '';
  shareState.status = 'starting';
  const runId = ++shareState.runId; // 新一轮隧道：作废旧进程的事件回调
  try {
    if (provider === 'quick') await runQuick(runId);
    else if (provider === 'ngrok') runNgrok(runId);
    else if (provider === 'tailscale') runTailscale();
    else throw new Error(`未知 SHARE_PROVIDER：${provider}`);

    // 等待拿到网址（最多 45 秒），否则报错但服务继续运行
    const deadline = Date.now() + 45000;
    while (shareState.runId === runId && shareState.status === 'starting' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
    }
    if (shareState.runId === runId && shareState.status !== 'online') {
      shareState.status = 'error';
      shareState.error = shareState.error || '启动超时，未获取到外网地址';
      console.error(`  ✗ 外网隧道未就绪：${shareState.error}`);
    }
  } catch (err) {
    if (shareState.runId === runId) {
      shareState.status = 'error';
      shareState.error = String(err?.message || err);
    }
    console.error(`  ✗ 外网隧道启动失败：${shareState.error}`);
  }
  return getShare();
}

export function stopShare() {
  shareState.runId += 1; // 让旧进程的 onLine/exit 回调失效
  if (child && !child.killed) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  child = null;
  if (shareState.status === 'online' || shareState.status === 'starting') shareState.status = 'stopped';
}
