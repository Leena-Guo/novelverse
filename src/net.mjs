// 网络小工具：列出本机局域网 IPv4（用于提示手机访问地址）
import os from 'node:os';

export function lanIPv4() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return [...new Set(out)];
}
