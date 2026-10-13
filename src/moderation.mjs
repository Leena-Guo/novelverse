import { config } from './config.mjs';

/**
 * 内容合规过滤
 * ---------------------------------------------------------------
 * 目标：拦截“违法涉黄 / 低俗色情”类网络小说，避免被抓取、上架与展示。
 *
 * 判定依据：书名、作者、简介中命中明确的成人/低俗词汇，或命中常见成人分区标记
 *          （如「（高H）」「1V1 甜H」「NPH」等）。
 *
 * 说明：自动词表力求“宁可放过正常作品，不漏过明显涉黄”，因此只收录语义明确的
 *      词，不收录「妻 / 婚 / 娇 / 老公 / 出轨 / 少妇」等正常言情也会出现的词。
 *      仍可能有擦边作品漏网，页面提供「手动删除/下架」入口兜底。
 *      可通过环境变量 BLOCK_TERMS（英文逗号分隔）追加自定义词。
 */

// 语义明确、正常作品几乎不会出现的涉黄 / 低俗 / 违法词
const ADULT_TERMS = [
  // 直接色情
  '淫', '乱伦', '色情', '情色', '做爱', '性爱', '性交', '口交', '肛交', '射精', '精液',
  '淫液', '爱液', '淫水', '蜜液', '骚水', '潮吹', '喷潮', '龟头', '鸡巴', '阳具',
  '肉棒', '肉刃', '肉柱', '巨根', '巨屌', '巨吊', '大屌', '阴茎', '阴道', '子宫', '阴部',
  '下体', '乳头', '巨乳', '爆乳', '产乳', '产奶', '奶水', '肉文', '肉番', '肉欲',
  // 性器官 / 私处
  '蜜穴', '骚穴', '肉穴', '淫穴', '嫩穴', '菊穴', '后穴', '小穴', '穴口', '私处', '性器',
  // 卖淫 / 性交易 / 性侵
  '嫖娼', '卖淫', '妓女', '妓院', '娼妇', '援交', '自慰', '手淫', '口爆',
  '强奸', '迷奸', '轮奸', '诱奸', '迷药', '春药', '催情', '約炮', '约炮', '一夜情', '卖春',
  // 多人与调教
  '换妻', '群交', '调教', '发情', '求欢', '交欢', '承欢', '荡妇', '骚货', '贱货', '浪货',
  '玩奴', '女绿', '纯欲', '母狗', '性奴', '肉奴', '肉便器', '雌畜', '绿帽', '抖M', '抖S',
  // 露骨描写
  '骚逼', '淫妇', '淫娃', '淫荡', '呻吟', '肏', '舔弄', '舔舐', '口活', '肛塞', '跳蛋', '脱衣',
  '情趣玩具', '情趣用品', '成人用品', '春宫',
  // 偷拍 / 裸露
  '艳照', '裸照', '裸聊', '裸群',
  // 未删减 / 禁书等标记
  '未删减', '无删减', '禁书',
  // 分区字母标记
  'H文', 'H版', '高H', '甜H', '纯H', '肉H', 'HNP', 'NPH',
  // 直白行为描述
  '上床', '搞上',
  // 违法（儿童色情）
  '恋童', '幼女', '儿童色情',
];

// 括号内带 H / NP 等成人分区标记，例如：（1v1甜H）、[高H]、【NP】
const ADULT_TAG_RE = /[（(【[][^）)】\]]{0,16}[Hh][^）)】\]]{0,16}[）)】\]]/;
const ADULT_NP_RE = /[（(【[][^）)】\]]{0,16}(NP|NPH|多[Pp]|群[Pp])[^）)】\]]{0,16}[）)】\]]/;

function buildMatcher() {
  const extra = (config.contentFilter.extraTerms || [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const terms = [...ADULT_TERMS, ...extra];
  const escaped = terms
    .filter(Boolean)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return escaped ? new RegExp(escaped, 'i') : null;
}

const MATCHER = buildMatcher();

/** 文本是否命中违规过滤 */
export function isAdultText(text) {
  if (!config.contentFilter.enabled) return false;
  const s = String(text || '');
  if (!s) return false;
  if (MATCHER && MATCHER.test(s)) return true;
  if (ADULT_TAG_RE.test(s)) return true;
  if (ADULT_NP_RE.test(s)) return true;
  return false;
}

/** 一本书（书名/作者/简介）是否命中违规过滤 */
export function isBlockedBook(b) {
  if (!b) return false;
  if (!config.contentFilter.enabled) return false;
  return isAdultText(b.title) || isAdultText(b.intro) || isAdultText(b.author);
}

/** 命中的词（用于日志/说明，便于排查） */
export function matchedTerms(b) {
  const hits = new Set();
  const fields = [b?.title, b?.author, b?.intro].filter(Boolean).map(String);
  for (const f of fields) {
    if (!MATCHER) break;
    const m = f.match(MATCHER);
    if (m) for (const t of m) hits.add(t);
    if (ADULT_TAG_RE.test(f)) hits.add('(H标记)');
    if (ADULT_NP_RE.test(f)) hits.add('(NP标记)');
  }
  return [...hits];
}
