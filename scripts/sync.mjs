import { syncCatalog, syncState } from '../src/services/catalog.mjs';
import { stats } from '../src/services/books.mjs';

/**
 * 命令行抓取：把源站的小说目录整合进本地书库
 *   node --no-warnings scripts/sync.mjs                # 浅抓：各分类人气榜（每分类 2 页）
 *   node --no-warnings scripts/sync.mjs 3              # 浅抓：每分类 3 页
 *   node --no-warnings scripts/sync.mjs full           # 浅抓（各分类人气榜，每分类 2 页）
 *   node --no-warnings scripts/sync.mjs deep           # 全量：全部分类 × 全部榜单 × 每榜 10 页（约 8000+ 本）
 *   node --no-warnings scripts/sync.mjs deep 5         # 全量但每榜 5 页
 *   node --no-warnings scripts/sync.mjs ultra          # 深度全量：再叠加 字数段 × 连载状态，深挖长尾（数万本，耗时长）
 */

const arg1 = (process.argv[2] || '2').trim();
const deep = arg1 === 'deep';
const ultra = arg1 === 'ultra';
const full = arg1 === 'full' || deep || ultra;
const pages = deep ? Number(process.argv[3] || 10) : ultra ? Number(process.argv[3] || 1) : Number(arg1 || 2);

const estimate = ultra ? 7 * 12 * 6 * 3 + 3 : deep ? 7 * 12 + 3 : 7 + 3;
console.log(
  ultra
    ? `开始【深度全量·广度优先】同步：全部分类 × 全部榜单 × 字数段(6) × 状态(3) × 每榜 ${pages} 页（约 ${estimate * pages} 次请求）…`
    : deep
      ? `开始【全量】同步：全部分类 × 全部榜单 × 每榜 ${pages} 页（约 ${estimate * pages} 次请求）…`
      : `开始同步目录（每分类 ${pages} 页）…`,
);

const t0 = Date.now();
let lastPct = -1;
const r = await syncCatalog({
  pagesPerCategory: pages,
  deep,
  ultra,
  onProgress: (d, t) => {
    const pct = Math.round((d / t) * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      process.stdout.write(`\r  进度 ${d}/${t}（${pct}%）   `);
    }
  },
});
process.stdout.write('\n');
console.log(
  `完成：处理 ${r.total} 条记录、共 ${r.requests} 个榜单任务，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
console.log('书库现状：', stats(), '任务状态：', { running: syncState.running, mode: syncState.mode });
process.exit(0);
