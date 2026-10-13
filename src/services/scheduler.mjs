import { config } from '../config.mjs';
import { all, logCrawl } from '../db.mjs';
import { syncCatalog, refreshBook, purgeBlockedBooks } from './catalog.mjs';

/**
 * 每日自动维护
 * ---------------------------------------------------------------
 * 默认每天凌晨 1 点触发，做两件事：
 *   1) 扩充书库：同步各分类榜单，发现新的免费小说即入库；
 *   2) 更新已有小说：挑出最久未检查的书，检查章节是否有更新，
 *      有新章节则补全目录（新章节正文仍按需在阅读时抓取）。
 *
 * 关闭方式：环境变量 AUTO_UPDATE=0
 * 自定义时间：UPDATE_HOUR / UPDATE_MINUTE（服务器本地时间）
 */

export const schedulerState = {
  enabled: false,
  hour: config.schedule.hour,
  minute: config.schedule.minute,
  nextRun: null,
  lastRun: null,
  lastResult: null,
  running: false,
};

let timer = null;

/** 距离下一个 hour:minute 还有多少毫秒 */
function msUntil(hour, minute) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** 执行一次“每日维护”（也可被手动触发 / 命令行调用） */
export async function runDailyMaintenance({ pagesPerCategory, updateLimit, onlyExpand = false } = {}) {
  const pages = pagesPerCategory ?? config.schedule.syncPages;
  const limit = updateLimit ?? config.schedule.updateLimit;
  const startedAt = new Date().toISOString();
  const summary = {
    ok: true,
    startedAt,
    expand: { ok: false, total: 0 },
    refresh: { total: 0, updated: 0, added: 0, failed: 0 },
    purged: 0,
  };

  // 0) 合规清理：先清掉库内命中的违规作品，避免被推荐/搜索到
  try {
    const p = purgeBlockedBooks();
    summary.purged = p.removed || 0;
  } catch {
    /* 忽略 */
  }

  // 1) 扩充书库：各分类 × 各榜单里发现新书（deep 能覆盖更多长尾作品）
  try {
    const r = await syncCatalog({ pagesPerCategory: pages, deep: config.schedule.deepSync });
    summary.expand = { ok: r.ok, total: r.total, deep: !!config.schedule.deepSync, requests: r.requests };
  } catch (e) {
    summary.expand = { ok: false, total: 0, error: String(e?.message || e) };
    summary.ok = false;
  }

  // 2) 更新已有小说：优先检查最久没检查过的
  if (!onlyExpand) {
    const targets = all(
      `SELECT id FROM books
        WHERE source <> '本地书库'
        ORDER BY CASE WHEN last_checked_at='' THEN 0 ELSE 1 END,
                 last_checked_at ASC,
                 enriched DESC,
                 hot DESC,
                 id ASC
        LIMIT ?`,
      Math.max(0, limit),
    );
    for (const t of targets) {
      summary.refresh.total++;
      try {
        const r = await refreshBook(t.id);
        if (r.ok) {
          if (r.updated) summary.refresh.updated++;
          summary.refresh.added += r.added || 0;
        } else {
          summary.refresh.failed++;
        }
      } catch {
        summary.refresh.failed++;
      }
    }
  }

  summary.finishedAt = new Date().toISOString();
  logCrawl(
    'daily',
    `清理违规 ${summary.purged} 本 / 扩充 +${summary.expand.total} 本 / 更新 ${summary.refresh.updated}/${summary.refresh.total} 本（新增 ${summary.refresh.added} 章）`,
    summary.ok,
    summary.refresh.updated,
  );
  return summary;
}

function scheduleNext() {
  const delay = msUntil(schedulerState.hour, schedulerState.minute);
  schedulerState.nextRun = new Date(Date.now() + delay).toISOString();
  timer = setTimeout(tick, delay);
  if (timer.unref) timer.unref();
}

async function tick() {
  if (schedulerState.running) return scheduleNext();
  schedulerState.running = true;
  try {
    const r = await runDailyMaintenance();
    schedulerState.lastRun = new Date().toISOString();
    schedulerState.lastResult = r;
  } catch (e) {
    schedulerState.lastResult = { ok: false, error: String(e?.message || e) };
  } finally {
    schedulerState.running = false;
    scheduleNext();
  }
}

/** 启动每日调度（返回当前状态） */
export function startScheduler() {
  schedulerState.hour = config.schedule.hour;
  schedulerState.minute = config.schedule.minute;
  schedulerState.enabled = !!config.schedule.enabled;
  if (!schedulerState.enabled) {
    schedulerState.nextRun = null;
    return schedulerState;
  }
  if (timer) clearTimeout(timer);
  scheduleNext();
  return schedulerState;
}

export function stopScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
  schedulerState.enabled = false;
  schedulerState.nextRun = null;
}
