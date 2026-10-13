import { CATEGORIES } from '../config.mjs';
import { decodeEntities, stripTags } from '../util.mjs';

/** 分类名 → 本站分类码 */
export const CAT_NAME_TO_CODE = Object.fromEntries(CATEGORIES.map((c) => [c.name, c.code]));

/** 各镜像站对分类的别名 → 本站分类码 */
export const CAT_ALIAS = {
  玄幻小说: 1,
  奇幻小说: 1,
  玄幻魔法: 1,
  修真小说: 2,
  仙侠小说: 2,
  武侠小说: 2,
  都市小说: 3,
  言情小说: 3,
  历史小说: 4,
  军事小说: 4,
  网游小说: 5,
  游戏小说: 5,
  科幻小说: 6,
  悬疑小说: 6,
  恐怖小说: 6,
  其他小说: 9,
};

/** 已知分类名集合（用于从列表项中识别“分类”字段） */
export const CAT_NAMES = new Set([...Object.keys(CAT_ALIAS), ...CATEGORIES.map((c) => c.name)]);

export function catCode(name) {
  const n = String(name || '').trim();
  return CAT_NAME_TO_CODE[n] ?? CAT_ALIAS[n] ?? 0;
}

/** 修正镜像站常见的 HTML 实体式转义 */
export function cleanText(s = '') {
  return String(s)
    .replace(/mdash+/gi, '—')
    .replace(/ndash+/gi, '–')
    .replace(/ldquo/gi, '“')
    .replace(/rdquo/gi, '”')
    .replace(/hellip/gi, '…')
    .replace(/&nbsp;/gi, ' ')
    .trim();
}

/** 解析 <meta property="og:*"> 与 description */
export function parseOgMeta(html) {
  const meta = {};
  const re = /<meta[^>]*property="og:([a-z_:]+)"[^>]*content="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) meta[m[1]] = cleanText(decodeEntities(m[2]));
  const desc = html.match(/<meta name="description" content="([^"]*)"/);
  if (desc) meta._description = cleanText(decodeEntities(desc[1]));
  return meta;
}

/** 判断是否为盗版站夹带的广告/水印段落（只对短句生效，避免误伤正文） */
export function isWatermark(p) {
  const t = String(p || '').trim();
  if (!t) return true;
  if (t.length <= 40 && /(一秒记住|记住本站|精彩小说|无弹窗|本章未完|点击下一页|继续阅读|请收藏本站|笔趣阁|最新网址|手机版阅读|免费阅读|app2\(\)|read2\(\)|更多精彩|首发|域名|书友群|QQ群|微信公众号|求月票|推荐票)/.test(t)) {
    return true;
  }
  return false;
}

/** 过滤正文水印行 + 空行 */
export function dropWatermark(paragraphs = []) {
  return paragraphs
    .map((p) => cleanText(stripTags(p)).trim())
    .filter((p) => p && !isWatermark(p));
}

export { decodeEntities, stripTags };
