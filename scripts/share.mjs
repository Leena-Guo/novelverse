#!/usr/bin/env node
/**
 * 一键外网访问（服务已在运行时使用）
 * ---------------------------------------------------------------
 * 用法：
 *   1) 另开终端先启动服务：npm start
 *   2) 本终端执行：npm run share
 *   3) 用输出的 https 网址在手机打开，或扫描终端里的二维码
 *
 * 默认使用 Cloudflare 临时隧道（零配置，但每次网址会变）。
 * 想要「重启后网址/二维码不变」，用固定网址的 provider：
 *   - ngrok ：NGROK_AUTHTOKEN=xxx SHARE_DOMAIN=你的域名 npm run share
 *   - 自建  ：SHARE_URL=https://your.domain npm run share
 *   - 详见 README「手机访问与部署」。
 */
import { shareState, startShare, stopShare } from '../src/services/tunnel.mjs';

shareState.enabled = true;

const s = await startShare();
if (s.status === 'online' && s.url) {
  console.log(`\n  ✅ 外网访问地址：${s.url}`);
  if (!s.stable) {
    console.log('  ℹ️  这是临时隧道，重启后会更换网址；要固定网址请看 README（ngrok 固定域名 / SHARE_URL）。');
  }
  console.log('  （保持本终端运行即为在线；按 Ctrl+C 关闭隧道）');
} else {
  console.error(`\n  ✗ 未能建立外网隧道：${s.error || s.status}`);
  console.error('  可改用 Tailscale / 自建隧道，或参考 README「手机访问与部署」。');
  process.exitCode = 1;
}

const keepAlive = setInterval(() => {}, 1 << 30);
function bye() {
  clearInterval(keepAlive);
  stopShare();
  process.exit(0);
}
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
