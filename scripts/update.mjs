import { runDailyMaintenance } from '../src/services/scheduler.mjs';
import { stats } from '../src/services/books.mjs';

/**
 * 手动执行一次“每日维护”：抓取已有小说更新 + 扩充书库。
 * 适合放进系统 crontab（若不想依赖常驻进程内的定时器）：
 *   0 1 * * *  cd /path/to/novelverse && node --no-warnings scripts/update.mjs >> data/update.log 2>&1
 *
 *   node --no-warnings scripts/update.mjs             # 更新 + 扩充
 *   node --no-warnings scripts/update.mjs expand       # 仅扩充书库
 */

const onlyExpand = process.argv[2] === 'expand';

console.log(`开始每日维护（${onlyExpand ? '仅扩充书库' : '更新已有 + 扩充书库'}）…`);
const t0 = Date.now();
const r = await runDailyMaintenance({ onlyExpand });
console.log(`完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  内容合规：清理违规作品 ${r.purged || 0} 本`);
console.log(`  扩充书库：+${r.expand.total} 本`);
console.log(`  更新已有：${r.refresh.updated}/${r.refresh.total} 本有变化，新增 ${r.refresh.added} 章，失败 ${r.refresh.failed} 本`);
console.log('书库现状：', stats());
process.exit(0);
