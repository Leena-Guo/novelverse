// 二维码生成（零运行时依赖）：封装内置的 qrcode-generator（MIT，见 src/vendor/qrcode.cjs）。
import { createRequire } from 'node:module';
import { encodePng } from './png.mjs';

const require = createRequire(import.meta.url);
const qrcode = require('./vendor/qrcode.cjs');

function makeQr(text, ec = 'M') {
  const qr = qrcode(0, ec); // typeNumber=0 → 自动选择版本
  qr.addData(String(text), 'Byte');
  qr.make();
  return qr;
}

/** 返回二维码点阵访问器：size 与 isDark(x,y) */
export function qrMatrix(text, ec = 'M') {
  const qr = makeQr(text, ec);
  const size = qr.getModuleCount();
  return { size, isDark: (x, y) => qr.isDark(y, x) };
}

/** 生成 SVG 字符串 */
export function qrSvg(text, { scale = 8, margin = 4, ec = 'M', dark = '#12141c', light = '#ffffff' } = {}) {
  const qr = makeQr(text, ec);
  const size = qr.getModuleCount();
  const dim = (size + margin * 2) * scale;
  let rects = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!qr.isDark(y, x)) continue;
      rects += `<rect x="${(x + margin) * scale}" y="${(y + margin) * scale}" width="${scale}" height="${scale}"/>`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<g fill="${dark}">${rects}</g>` +
    `</svg>`
  );
}

/** 生成 PNG Buffer */
export function qrPng(text, { scale = 8, margin = 4, ec = 'M', dark = [18, 20, 28], light = [255, 255, 255] } = {}) {
  const qr = makeQr(text, ec);
  const size = qr.getModuleCount();
  const dim = (size + margin * 2) * scale;
  return encodePng(dim, dim, (x, y) => {
    const mx = Math.floor(x / scale) - margin;
    const my = Math.floor(y / scale) - margin;
    const on = mx >= 0 && my >= 0 && mx < size && my < size && qr.isDark(my, mx);
    const [r, g, b] = on ? dark : light;
    return [r, g, b, 255];
  });
}

/** 终端可扫描二维码：ANSI 反白（黑块白底）+ 静默区，仅在支持 ANSI 的终端正常显示 */
export function qrTerminal(text, { ec = 'M', margin = 2 } = {}) {
  const qr = makeQr(text, ec);
  const size = qr.getModuleCount();
  const dark = '\x1b[40m  \x1b[0m';
  const light = '\x1b[47m  \x1b[0m';
  const w = size + margin * 2;
  const blank = light.repeat(w);
  const rows = [];
  for (let i = 0; i < margin; i++) rows.push(blank);
  for (let y = 0; y < size; y++) {
    let line = light.repeat(margin);
    for (let x = 0; x < size; x++) line += qr.isDark(y, x) ? dark : light;
    line += light.repeat(margin);
    rows.push(line);
  }
  for (let i = 0; i < margin; i++) rows.push(blank);
  return rows.join('\n');
}
