import { fetchText, postForm } from './http.mjs';
import { htmlToParagraphs, decodeEntities, stripTags } from '../util.mjs';
import { config, CATEGORIES } from '../config.mjs';

const BASE = 'https://m.biqugen.com';

const CAT_NAME_TO_CODE = Object.fromEntries(CATEGORIES.map((c) => [c.name, c.code]));
const CAT_ALIAS = {
  玄幻小说: 1,
  奇幻小说: 1,
  修真小说: 2,
  仙侠小说: 2,
  都市小说: 3,
  言情小说: 3,
  历史小说: 4,
  军事小说: 4,
  网游小说: 5,
  游戏小说: 5,
  科幻小说: 6,
  悬疑小说: 6,
  其他小说: 9,
};

/** 排行榜 / 分类排序方式 */
export const SORTS = {
  allvisit: '总人气',
  dayvisit: '日人气',
  weekvisit: '周人气',
  monthvisit: '月人气',
  allvote: '总推荐',
  dayvote: '日推荐',
  weekvote: '周推荐',
  monthvote: '月推荐',
  goodnum: '收藏榜',
  size: '字数榜',
  postdate: '最新入库',
  lastupdate: '最近更新',
};

/* ------------------------- 解析工具 ------------------------- */

function parseBookList(html) {
  const books = [];
  const ulMatch = html.match(/<ul class="sort_list">([\s\S]*?)<\/ul>/);
  const scope = ulMatch ? ulMatch[1] : html;
  const items = scope.split(/<li>/).slice(1);
  for (const raw of items) {
    const item = raw.split('</li>')[0];
    const link = item.match(/<a href="\/book_(\d+)\/"[^>]*>([^<]+)<\/a>/);
    if (!link) continue;
    const catMatch = item.match(/<span class="s1">\[([^\]]+)\]<\/span>/);
    const authorMatch = item.match(/<span class="s4">([^<]*)<\/span>/);
    const dateMatch = item.match(/<span class="s5">([^<]*)<\/span>/);
    const latestMatch = item.match(/title="最新章节：([^"]*)"/);
    const catName = catMatch ? catMatch[1].trim() : '';
    books.push({
      source_id: link[1],
      title: decodeEntities(link[2]).trim(),
      category: catName,
      category_code: CAT_NAME_TO_CODE[catName] ?? CAT_ALIAS[catName] ?? 0,
      author: authorMatch ? decodeEntities(authorMatch[1]).trim() : '',
      source_updated: dateMatch ? dateMatch[1].trim() : '',
      latest_chapter: latestMatch ? decodeEntities(latestMatch[1]).trim() : '',
      cover: `/img/${link[1]}.jpg`,
    });
  }
  return books;
}

/**
 * 搜索页结果解析。
 * 注意：搜索页与列表页模板不同——搜索页每条为
 *   <li><span class="s2"><a href="/book_{id}/">书名</a></span><span class="s5">&nbsp;作者</span></li>
 * 即书名在 s2、作者在 s5；而列表页是 s1=分类 / s4=作者 / s5=日期。
 * 因此必须单独解析，否则作者/分类会全部为空。
 */
function parseSearchList(html) {
  const books = [];
  const ulMatch = html.match(/<ul class="sort_list">([\s\S]*?)<\/ul>/);
  const scope = ulMatch ? ulMatch[1] : html;
  for (const raw of scope.split(/<li>/).slice(1)) {
    const item = raw.split('</li>')[0];
    const link = item.match(/<a href="\/book_(\d+)\/"[^>]*>([^<]+)<\/a>/);
    if (!link) continue;
    const author = (item.match(/<span class="s5">([^<]*)<\/span>/) || [])[1] || '';
    const catMatch = item.match(/<span class="s1">\[?([^\]<]+?)\]?<\/span>/);
    const catName = catMatch ? catMatch[1].trim() : '';
    books.push({
      source_id: link[1],
      title: decodeEntities(link[2]).trim(),
      category: catName,
      category_code: CAT_NAME_TO_CODE[catName] ?? CAT_ALIAS[catName] ?? 0,
      author: decodeEntities(author).replace(/\u00a0/g, ' ').trim(),
      cover: `/img/${link[1]}.jpg`,
    });
  }
  return books;
}

function parseChapters(html, sourceId) {
  // 章节列表区块（可能两个：最新章节 + 章节列表），取最后一个
  const blocks = [...html.matchAll(/<ul class="chapter-list">([\s\S]*?)<\/ul>/g)].map((m) => m[1]);
  const scope = blocks.length ? blocks[blocks.length - 1] : html;
  const chapters = [];
  const re = new RegExp(`<a href="/book_${sourceId}/(\\d+)\\.html">([\\s\\S]*?)</a>`, 'g');
  let m;
  while ((m = re.exec(scope))) {
    const title = stripTags(m[2]).trim();
    if (!title) continue;
    chapters.push({ ref: m[1], title });
  }
  return chapters;
}

function cleanText(s = '') {
  return String(s)
    .replace(/mdash+/gi, '—')
    .replace(/ndash+/gi, '–')
    .replace(/ldquo/gi, '“')
    .replace(/rdquo/gi, '”')
    .replace(/hellip/gi, '…')
    .replace(/&nbsp;/gi, ' ')
    .trim();
}

function parseOgMeta(html) {
  const meta = {};
  const re = /<meta property="og:([a-z_:]+)" content="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) meta[m[1]] = cleanText(decodeEntities(m[2]));
  const desc = html.match(/<meta name="description" content="([^"]*)"/);
  if (desc) meta['_description'] = cleanText(decodeEntities(desc[1]));
  return meta;
}

function totalPages(html) {
  const opts = [...html.matchAll(/第\s*\d+\s*-\s*(\d+)\s*章/g)].map((m) => Number(m[1]));
  if (opts.length) return Math.ceil(Math.max(...opts) / 100);
  return 1;
}

function coverFrom(html) {
  const og = html.match(/<meta property="og:image" content="([^"]*)"/);
  if (og && og[1]) return og[1];
  const img = html.match(/<div class="book-img">\s*<img src="([^"]*)"/);
  return img ? img[1] : '';
}

/* ------------------------- 适配器接口 ------------------------- */

export const biqugen = {
  id: 'biqugen',
  name: '笔趣阁',
  base: BASE,

  /** 分类 / 排行榜列表 */
  async listBooks({ category = 0, sort = 'allvisit', page = 1, status = 0, size = 0 } = {}) {
    const url = `${BASE}/list/${sort}_${category}_${size}_${status}_${page}.html`;
    const res = await fetchText(url);
    if (!res.ok) return { ok: false, books: [], error: res.error || `HTTP ${res.status}` };
    return { ok: true, books: parseBookList(res.text), page };
  },

  /** 关键字搜索（用户等待中，单源限时不重试，避免个别源故障拖垮整次搜索） */
  async search(keyword) {
    const res = await postForm(`${BASE}/search.html`, { s: keyword }, { retries: 0, timeoutMs: config.crawl.searchTimeoutMs });
    if (!res.ok) return { ok: false, books: [], error: res.error || `HTTP ${res.status}` };
    return { ok: true, books: parseSearchList(res.text) };
  },

  /** 书籍详情 + 第 1 页章节 */
  async bookDetail(sourceId) {
    const res = await fetchText(`${BASE}/book_${sourceId}/`);
    if (!res.ok) return { ok: false, error: res.error || `HTTP ${res.status}` };
    const html = res.text;
    const og = parseOgMeta(html);
    const chapters = parseChapters(html, sourceId);

    // 完整页数写在章节索引页（index_1 等）的分页选项里，书籍主页往往没有
    let pages = totalPages(html);
    if (pages <= 1) {
      const idx = await fetchText(`${BASE}/book_${sourceId}/index_1.html`);
      if (idx.ok) pages = Math.max(pages, totalPages(idx.text));
    }

    return {
      ok: true,
      book: {
        source_id: String(sourceId),
        title: og['novel:book_name'] || og.title || '',
        author: og['novel:author'] || '',
        category: og['novel:category'] || '',
        category_code: CAT_NAME_TO_CODE[og['novel:category']] ?? CAT_ALIAS[og['novel:category']] ?? 0,
        status: og['novel:status'] || '',
        intro: og.description || og['_description'] || '',
        cover: coverFrom(html),
        latest_chapter: og['novel:latest_chapter_name'] || '',
        source_updated: og['novel:update_time'] || '',
        pages,
      },
      chapters,
    };
  },

  /** 章节列表分页：page=1 用书籍主页，page>=2 用 index_{page-1}.html */
  async chapterListPage(sourceId, page = 1) {
    const url = page <= 1 ? `${BASE}/book_${sourceId}/` : `${BASE}/book_${sourceId}/index_${page - 1}.html`;
    const res = await fetchText(url);
    if (!res.ok) return { ok: false, chapters: [], error: res.error || `HTTP ${res.status}` };
    return { ok: true, chapters: parseChapters(res.text, sourceId) };
  },

  /** 章节正文（含分页合并 + base64 解码） */
  async chapterContent(sourceId, ref) {
    let url = `${BASE}/book_${sourceId}/${ref}.html`;
    const blocks = [];
    let title = '';
    for (let page = 0; page < 12; page++) {
      const res = await fetchText(url);
      if (!res.ok) {
        if (blocks.length) break;
        return { ok: false, error: res.error || `HTTP ${res.status}` };
      }
      const html = res.text;
      const nameMatch = html.match(/<h1 id="chaptername"[^>]*>([\s\S]*?)<\/h1>/);
      if (!title && nameMatch) title = stripTags(nameMatch[1]).replace(/（第\s*\d+\s*页）/, '').trim();

      const b64 = [...html.matchAll(/qsbs\.bb\('([^']+)'\)/g)].map((m) => m[1]);
      for (const b of b64) {
        try {
          blocks.push(Buffer.from(b, 'base64').toString('utf-8'));
        } catch {
          /* ignore */
        }
      }

      // 找“下一章”链接，判断是否仍为本章的下一页
      const next = html.match(/id="pb_next"\s+href="([^"]*)"/);
      if (!next) break;
      const nextPath = next[1];
      const sameChapter = nextPath.match(new RegExp(`/book_${sourceId}/${ref}_(\\d+)\\.html`));
      if (!sameChapter) break;
      url = nextPath.startsWith('http') ? nextPath : BASE + nextPath;
    }

    const paragraphs = htmlToParagraphs(blocks.join('\n'));
    const wordCount = paragraphs.reduce((n, p) => n + p.length, 0);
    return { ok: true, title, paragraphs, wordCount };
  },
};

export default biqugen;
