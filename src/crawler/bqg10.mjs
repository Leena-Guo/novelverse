import { fetchText, postForm } from './http.mjs';
import { config } from '../config.mjs';
import { htmlToParagraphs, stripTags } from '../util.mjs';
import { catCode, parseOgMeta, cleanText, CAT_NAMES, isWatermark } from './parse.mjs';

/**
 * 通用「新版笔趣阁模板」适配器工厂。
 *
 * 模板特征（已在 www.bqg10.cc 验证）：
 *   - 书籍页   /book/{id}/                     含简介头像 + 第 1 页章节（1~100 章）
 *   - 目录分页 /book/{id}/mulu{n}.html          第 n+1 页章节（每页 100 章）
 *   - 章节正文 /book/{id}/{chapid}.html         正文位于 <div id="booktxt"><p>…</p></div>
 *   - 搜索     POST /search.html  s=关键词
 *   - 分类     /fenlei/{cat}/{page}.html
 *   - 目录总页数写在 mulu 页的 <select> 选项里
 */
export function makeBiqugeSite({ id, name, base }) {
  const B = base.replace(/\/+$/, '');
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** 提取 <a href="/book/{id}/{ref}.html">…</a>，按 DOM 顺序、按 ref 去重 */
  function pickChapters(html, sid) {
    const out = [];
    const seen = new Set();
    const re = new RegExp(`<a[^>]*href="${reEsc(`/book/${sid}/`)}(\\d+)\\.html"[^>]*>([\\s\\S]*?)<\\/a>`, 'g');
    let m;
    while ((m = re.exec(html))) {
      const ref = m[1];
      const title = cleanText(stripTags(m[2])).replace(/^开始阅读$/, '').trim();
      if (!title || seen.has(ref)) continue;
      seen.add(ref);
      out.push({ ref, title });
    }
    return out;
  }

  /**
   * 书籍页第 1 页章节。
   * 书籍页 #list 结构为：<dt>最新章节</dt> + 最新 12 章，随后是
   * <a href="/book/{id}/mulu1.html"><dt>…全部章节目录</dt></a>，之后才是第 1~100 章。
   * 必须跳过“最新章节”小部件，否则顺序会错乱。
   */
  function firstPageChapters(html, sid) {
    const list = (html.match(/id="list"[^>]*>([\s\S]*?)<\/dl>/) || [])[1] || html;
    const i = list.indexOf('mulu1.html');
    const seg = i >= 0 ? list.slice(i) : list;
    return pickChapters(seg, sid);
  }

  /** 目录总页数：mulu 页 <select> 的选项数 */
  function totalPages(html) {
    const vals = [...html.matchAll(/<option[^>]*value="([^"]*)"[^>]*>/g)].map((m) => m[1]);
    const idxs = [];
    for (const v of vals) {
      if (/^\/book\/\d+\/?$/.test(v)) idxs.push(0);
      else {
        const m = v.match(/mulu(\d+)\.html$/);
        if (m) idxs.push(Number(m[1]));
      }
    }
    return idxs.length ? Math.max(...idxs) + 1 : 1;
  }

  function parseSearchItems(html) {
    const books = [];
    const seen = new Set();
    for (const chunk of String(html).split('<div class="item">').slice(1)) {
      const m = chunk.match(/<dt><a href="\/book\/(\d+)\/"[^>]*>([\s\S]*?)<\/a>/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      let author = '';
      let cat2 = '';
      let updated = '';
      const btm = chunk.match(/<div class="btm">([\s\S]*?)<\/div>/);
      if (btm) {
        author = cleanText(stripTags(btm[1].split('<em')[0]));
        const ems = [...btm[1].matchAll(/<em[^>]*>([\s\S]*?)<\/em>/g)].map((x) => cleanText(stripTags(x[1])));
        cat2 = ems.find((e) => CAT_NAMES.has(e)) || '';
        updated = ems[ems.length - 1] || '';
      }
      const intro = (chunk.match(/<dd>([\s\S]*?)<\/dd>/) || [])[1] || '';
      books.push({
        source_id: m[1],
        title: cleanText(stripTags(m[2])),
        author,
        category: cat2,
        category_code: catCode(cat2),
        intro: cleanText(stripTags(intro)).replace(/\.{3,}$/, ''),
        source_updated: updated,
        cover: `${B}/img/${m[1]}.jpg`,
      });
    }
    return books;
  }

  return {
    id,
    name,
    base: B,

    /** 分类列表 /fenlei/{cat}/{page}.html */
    async listBooks({ category = 0, page = 1 } = {}) {
      const cat = Number(category) || 1;
      const res = await fetchText(`${B}/fenlei/${cat}/${page}.html`);
      if (!res.ok) return { ok: false, books: [], error: res.error || `HTTP ${res.status}` };
      return { ok: true, books: parseSearchItems(res.text), page };
    },

    /** 关键字搜索 POST /search.html s=（用户等待中，单源限时、不重试） */
    async search(keyword) {
      const res = await postForm(`${B}/search.html`, { s: keyword }, { retries: 0, timeoutMs: config.crawl.searchTimeoutMs });
      if (!res.ok) return { ok: false, books: [], error: res.error || `HTTP ${res.status}` };
      return { ok: true, books: parseSearchItems(res.text) };
    },

    /** 书籍详情 + 第 1 页章节 + 总页数 */
    async bookDetail(sourceId) {
      const res = await fetchText(`${B}/book/${sourceId}/`);
      if (!res.ok) return { ok: false, error: res.error || `HTTP ${res.status}` };
      const html = res.text;
      const og = parseOgMeta(html);
      const chapters = firstPageChapters(html, sourceId);

      // 目录总页数需要读 mulu 页的分页下拉
      let pages = 1;
      const idx = await fetchText(`${B}/book/${sourceId}/mulu1.html`);
      if (idx.ok) pages = totalPages(idx.text);

      return {
        ok: true,
        book: {
          source_id: String(sourceId),
          title: og['novel:book_name'] || og.title || '',
          author: og['novel:author'] || '',
          category: og['novel:category'] || '',
          category_code: catCode(og['novel:category']),
          status: og['novel:status'] || '',
          intro: og.description || og._description || '',
          cover: og.image ? (og.image.startsWith('http') ? og.image : B + og.image) : '',
          latest_chapter: og['novel:latest_chapter_name'] || '',
          source_updated: og['novel:update_time'] || '',
          pages,
        },
        chapters,
      };
    },

    /** 章节列表分页：page=1 用书籍页，page>=2 用 mulu{page-1}.html */
    async chapterListPage(sourceId, page = 1) {
      if (page <= 1) {
        const res = await fetchText(`${B}/book/${sourceId}/`);
        if (!res.ok) return { ok: false, chapters: [], error: res.error || `HTTP ${res.status}` };
        return { ok: true, chapters: firstPageChapters(res.text, sourceId) };
      }
      const res = await fetchText(`${B}/book/${sourceId}/mulu${page - 1}.html`);
      if (!res.ok) return { ok: false, chapters: [], error: res.error || `HTTP ${res.status}` };
      const scope = (res.text.match(/<div id="content_1">([\s\S]*?)<\/div>\s*<dt/) || res.text.match(/<div id="content_1">([\s\S]*?)<\/dt>/) || res.text.match(/<div id="content_1">([\s\S]*?)<\/div>/))?.[1] || res.text;
      return { ok: true, chapters: pickChapters(scope, sourceId) };
    },

    /** 章节正文（含本章多页合并） */
    async chapterContent(sourceId, ref) {
      const paragraphs = [];
      let title = '';
      for (let page = 0; page < 20; page++) {
        const suffix = page === 0 ? '' : `_${page}`;
        const res = await fetchText(`${B}/book/${sourceId}/${ref}${suffix}.html`);
        if (!res.ok) {
          if (paragraphs.length) break;
          return { ok: false, error: res.error || `HTTP ${res.status}` };
        }
        const html = res.text;
        if (!title) {
          const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
          if (h1) title = cleanText(stripTags(h1[1])).replace(/[（(]\s*第?\s*\d+\s*页\s*[）)]/g, '').trim();
        }
        const inner = (html.match(/<div[^>]*id="booktxt"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
        let ps = [...inner.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
        if (!ps.length && inner) ps = htmlToParagraphs(inner);
        for (const p of ps) {
          const t = cleanText(stripTags(p));
          if (t && !isWatermark(t)) paragraphs.push(t);
        }
        // 本章是否还有下一页：/book/{id}/{ref}_{n}.html
        if (!new RegExp(`/book/${sourceId}/${ref}_\\d+\\.html`).test(html)) break;
      }
      const wordCount = paragraphs.reduce((n, p) => n + p.length, 0);
      return { ok: true, title, paragraphs, wordCount };
    },
  };
}

export default makeBiqugeSite;
