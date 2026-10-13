import { api } from './api.js';
import { settings, saveSettings, THEMES } from './store.js';
import { speaker } from './tts.js';

// PWA：仅在安全上下文（https / localhost）注册 Service Worker；局域网 http 下自动跳过
if (
  'serviceWorker' in navigator &&
  (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')
) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
import {
  downloadSupported,
  downloadBook,
  downloadChapters,
  listDownloads,
  getDownload,
  removeDownload,
  formatBytes,
} from './offline.js';

const main = document.getElementById('main');
const toastEl = document.getElementById('toast');

/* ============================ 小工具 ============================ */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  return { parts, query, raw: pathPart };
}

function spinner(label = '加载中') {
  return `<div class="empty"><div class="spin"></div><div style="margin-top:12px">${esc(label)}…</div></div>`;
}

function coverImg(b, cls = '') {
  return `<img class="${cls}" loading="lazy" src="${esc(b.cover || '/api/cover/0')}" alt="${esc(b.title)}" />`;
}

function bookCard(b) {
  return `
  <a class="book-card" href="#/book/${b.id}">
    <div class="cover">
      ${coverImg(b)}
      <span class="badge">${esc(b.category || '小说')}</span>
    </div>
    <div class="title">${esc(b.title)}</div>
    <div class="meta"><span class="author">${esc(b.author || '佚名')}</span>${b.source ? `<em class="src">${esc(sourceLabel(b.source))}</em>` : ''}</div>
  </a>`;
}

/* 书源 id → 展示名称；随任意含 sources 的接口响应自动补全 */
const SOURCE_NAMES = {
  biqugen: '笔趣阁',
  bqg10: '笔趣书阁',
  本地书库: '离线书库',
};
function rememberSources(list) {
  for (const s of list || []) if (s?.id && s?.name) SOURCE_NAMES[s.id] = s.name;
}
function sourceLabel(id, fallback = '网络书源') {
  if (!id) return fallback;
  return SOURCE_NAMES[id] || id;
}

function setNav(key) {
  // 手机底部标签栏的别名映射：把二级页归到对应的一级 Tab
  const TAB_ALIAS = {
    tags: 'category',
    tag: 'category',
    history: 'account',
    downloads: 'account',
    login: 'account',
    account: 'account',
    share: 'account',
    admin: 'account',
  };
  const tabKey = TAB_ALIAS[key] || key;
  $$('#mainnav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
  $$('#tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.nav === tabKey));
}

/* ============================ 账号状态 ============================ */

let me = null; // { id, username, name } | null

function updateUserButton() {
  const el = document.getElementById('userName');
  const btn = document.getElementById('userBtn');
  if (!el || !btn) return;
  el.textContent = me ? me.name || me.username || '我的' : '登录';
  btn.href = me ? '#/account' : '#/login';
  btn.title = me ? `${me.name || me.username} · 我的账号` : '登录 / 注册';
}

async function loadMe() {
  try {
    const r = await api.me();
    me = r && r.ok ? r.user : null;
  } catch {
    me = null;
  }
  updateUserButton();
  return me;
}

/* ============================ 首页 ============================ */

let heroTimer;
let homeCache = null;

async function viewHome() {
  clearInterval(heroTimer);
  setNav('home');
  if (homeCache) {
    // 已经看过：先秒开旧内容，再后台静默刷新，返回首页不再等待
    paintHome(homeCache);
    api.home().then((d) => { if (d && d.ok) homeCache = d; }).catch(() => {});
    return;
  }
  main.innerHTML = spinner('正在加载首页');
  const data = await api.home();
  if (!data.ok) return (main.innerHTML = `<div class="empty">加载失败：${esc(data.error)}</div>`);
  homeCache = data;
  paintHome(data);
}

function paintHome(data) {
  const banners = data.banners.length ? data.banners : data.hot;
  const bannerHtml = banners.length
    ? `<section class="hero" id="hero">${heroSlides(banners, 0)}<div class="hero-dots">${banners
        .map((_, i) => `<i data-i="${i}" class="${i === 0 ? 'active' : ''}"></i>`)
        .join('')}</div></section>`
    : '';

  const byCatHtml = data.byCategory
    .filter((c) => c.books.length)
    .map(
      (c) => `
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">${esc(c.name)}</h2>
          <span class="section-sub">人气精选</span>
          <span class="spacer"></span>
          <a class="more-link" href="#/category/${c.code}">更多 ›</a>
        </div>
        <div class="grid compact">${c.books.map(bookCard).join('')}</div>
      </section>`,
    )
    .join('');

  main.innerHTML = `
    ${bannerHtml}
    <section class="section">
      <div class="section-head">
        <h2 class="section-title">为你推荐</h2>
        <span class="section-sub">按兴趣随手翻翻</span>
      </div>
      <div class="grid">${data.random.map(bookCard).join('')}</div>
    </section>
    <section class="section">
      <div class="section-head">
        <h2 class="section-title">人气排行</h2>
        <span class="section-sub">读的人最多</span>
        <span class="spacer"></span>
        <a class="more-link" href="#/rank">完整榜单 ›</a>
      </div>
      <div class="rank-list">${data.hot.map(rankItem).join('')}</div>
    </section>
    ${
      data.tags && data.tags.length
        ? `<section class="section">
      <div class="section-head">
        <h2 class="section-title">热门题材</h2>
        <span class="section-sub">重生 / 穿越 / 系统 / 无限流…</span>
      </div>
      <div class="chips">${data.tags
        .slice(0, 36)
        .map((t) => `<a class="chip" href="#/tag/${encodeURIComponent(t.tag)}">${esc(t.tag)} <small style="opacity:.6">${t.count}</small></a>`)
        .join('')}</div>
    </section>`
        : ''
    }
    ${byCatHtml}
    <section class="section">
      <div class="section-head"><h2 class="section-title">最近更新</h2></div>
      <div class="rank-list">${data.updating.map(rankItem).join('')}</div>
    </section>`;

  bindHero(banners);
}

function heroSlides(banners, i) {
  const b = banners[i];
  return `
    <div class="hero-cover">${coverImg(b)}</div>
    <div class="hero-body">
      <div class="hero-cat">${esc(b.category || '')} · ${esc(b.status || '')}</div>
      <h1 class="hero-title">${esc(b.title)}</h1>
      <p class="hero-desc">${esc(b.intro || `${b.author || '佚名'} 的作品`)}</p>
      <div class="hero-actions">
        <a class="btn primary" href="#/read/${b.id}/1">开始阅读</a>
        <a class="btn" href="#/read/${b.id}/1?listen=1">🎧 直接听书</a>
        <a class="btn ghost" href="#/book/${b.id}">查看详情</a>
      </div>
    </div>`;
}

function bindHero(banners) {
  const hero = $('#hero');
  if (!hero) return;
  let i = 0;
  const dots = $$('.hero-dots i', hero);
  const go = (n) => {
    i = (n + banners.length) % banners.length;
    hero.querySelector('.hero-cover')?.remove();
    hero.querySelector('.hero-body')?.remove();
    hero.insertAdjacentHTML('afterbegin', heroSlides(banners, i));
    dots.forEach((d, k) => d.classList.toggle('active', k === i));
  };
  dots.forEach((d) => d.addEventListener('click', () => go(Number(d.dataset.i))));
  heroTimer = setInterval(() => go(i + 1), 6500);
}

function rankItem(b, i) {
  return `
    <a class="rank-item" href="#/book/${b.id}">
      <span class="rank-no">${i + 1}</span>
      <span class="rank-main">
        <span class="rank-title">${esc(b.title)}</span>
        <span class="rank-meta">${esc(b.author)} · ${esc(b.category)}</span>
      </span>
      <span class="rank-hot">${b.latestChapter ? esc(b.latestChapter.slice(0, 10)) : ''}</span>
    </a>`;
}

/* ============================ 分类 ============================ */

let catState = { category: 0, sort: 'hot', page: 1 };
async function viewCategory(parts, query) {
  clearInterval(heroTimer);
  setNav('category');
  catState.category = Number(parts[1] || query.cat || 0);
  catState.sort = query.sort || 'hot';
  catState.page = Number(query.page || 1);

  if (main.dataset.catReady !== '1') {
    main.innerHTML = spinner('加载分类');
    main.dataset.catReady = '1';
  }
  const [cats, res] = await Promise.all([api.categories(), api.books(catState)]);
  const catChips = [{ code: 0, name: '全部分类', count: '' }, ...(cats.categories || [])]
    .map(
      (c) =>
        `<button class="chip ${Number(catState.category) === c.code ? 'active' : ''}" data-cat="${c.code}">${esc(
          c.name,
        )}${c.count !== '' ? ` <small style="opacity:.6">${c.count}</small>` : ''}</button>`,
    )
    .join('');
  const sorts = [
    ['hot', '最热'],
    ['update', '最近更新'],
    ['newest', '最新入库'],
    ['title', '按书名'],
  ];

  main.innerHTML = `
    <section class="section" style="margin-top:6px">
      <div class="section-head"><h2 class="section-title">分类浏览</h2><span class="section-sub">共 ${res.total} 本</span></div>
      <div class="chips" id="catChips">${catChips}</div>
      <div class="chips" id="sortChips" style="margin-top:10px">${sorts
        .map(([k, n]) => `<button class="chip ${catState.sort === k ? 'active' : ''}" data-sort="${k}">${n}</button>`)
        .join('')}</div>
    </section>
    <section class="section">
      ${res.books.length ? `<div class="grid">${res.books.map(bookCard).join('')}</div>` : emptyBox('这个分类下暂时没有书')}
      ${pager(res.page, res.pages, 'cat')}
    </section>`;

  $$('#catChips .chip').forEach((el) =>
    el.addEventListener('click', () => navigate(`#/category/${el.dataset.cat}?sort=${catState.sort}`)),
  );
  $$('#sortChips .chip').forEach((el) =>
    el.addEventListener('click', () => navigate(`#/category/${catState.category}?sort=${el.dataset.sort}`)),
  );
  bindPager((p) => navigate(`#/category/${catState.category}?sort=${catState.sort}&page=${p}`));
}

/* ============================ 题材标签 ============================ */

async function viewTags() {
  clearInterval(heroTimer);
  setNav('tags');
  main.innerHTML = spinner('加载题材');
  const { tags } = await api.tags();
  main.innerHTML = `
    <section class="section" style="margin-top:6px">
      <div class="section-head"><h2 class="section-title">全部题材</h2><span class="section-sub">按题材找书 · 共 ${(tags || []).length} 类</span></div>
      <div class="chips">${(tags || [])
        .map(
          (t) =>
            `<a class="chip" href="#/tag/${encodeURIComponent(t.tag)}">${esc(t.tag)} <small style="opacity:.6">${t.count}</small></a>`,
        )
        .join('')}</div>
    </section>`;
}

let tagState = { tag: '', sort: 'hot', page: 1 };
async function viewTag(parts, query) {
  clearInterval(heroTimer);
  setNav('category');
  tagState.tag = decodeURIComponent(parts[1] || '');
  tagState.sort = query.sort || 'hot';
  tagState.page = Number(query.page || 1);
  main.innerHTML = spinner('加载题材');

  const [tagList, res] = await Promise.all([api.tags(), api.books(tagState)]);
  const sorts = [
    ['hot', '最热'],
    ['update', '最近更新'],
    ['newest', '最新入库'],
    ['title', '按书名'],
  ];
  const chips = (tagList.tags || [])
    .map(
      (t) =>
        `<a class="chip ${t.tag === tagState.tag ? 'active' : ''}" href="#/tag/${encodeURIComponent(t.tag)}">${esc(t.tag)} <small style="opacity:.6">${t.count}</small></a>`,
    )
    .join('');

  main.innerHTML = `
    <section class="section" style="margin-top:6px">
      <div class="section-head"><h2 class="section-title">题材 · ${esc(tagState.tag)}</h2><span class="section-sub">共 ${res.total} 本</span></div>
      <div class="chips">${chips}</div>
      <div class="chips" id="tagSort" style="margin-top:10px">${sorts
        .map(([k, n]) => `<button class="chip ${tagState.sort === k ? 'active' : ''}" data-sort="${k}">${n}</button>`)
        .join('')}</div>
    </section>
    <section class="section">
      ${
        res.books.length
          ? `<div class="grid">${res.books.map(bookCard).join('')}</div>`
          : emptyBox(`「${tagState.tag}」题材下暂时没有书`)
      }
      ${pager(res.page, res.pages, 'tag')}
    </section>`;

  $$('#tagSort .chip').forEach((el) =>
    el.addEventListener('click', () =>
      navigate(`#/tag/${encodeURIComponent(tagState.tag)}?sort=${el.dataset.sort}`),
    ),
  );
  bindPager((p) => navigate(`#/tag/${encodeURIComponent(tagState.tag)}?sort=${tagState.sort}&page=${p}`));
}

/* ============================ 排行榜 ============================ */

async function viewRank() {
  clearInterval(heroTimer);
  setNav('rank');
  main.innerHTML = spinner('加载榜单');
  const res = await api.books({ sort: 'hot', size: 60 });
  const res2 = await api.books({ sort: 'update', size: 30 });
  main.innerHTML = `
    <section class="section" style="margin-top:6px">
      <div class="section-head"><h2 class="section-title">🔥 人气榜</h2><span class="section-sub">按阅读热度排序</span></div>
      <div class="rank-list">${res.books.map(rankItem).join('')}</div>
    </section>
    <section class="section">
      <div class="section-head"><h2 class="section-title">🆕 最近更新</h2></div>
      <div class="rank-list">${res2.books.map(rankItem).join('')}</div>
    </section>`;
}

/* ============================ 搜索 ============================ */

async function viewSearch(query) {
  clearInterval(heroTimer);
  setNav('');
  const q = query.q || $('#searchbar input').value.trim();
  if (!q) return (main.innerHTML = emptyBox('输入书名或作者开始搜索'));

  main.innerHTML = spinner(`搜索「${q}」`);
  const res = await api.search(q);
  if (Array.isArray(res.sources)) res.sources.forEach((s) => { if (s?.id) SOURCE_NAMES[s.id] = s.name || s.id; });
  const remoteNotImported = (res.remote || []).filter(
    (r) => !(res.local || []).some((l) => l.source === r.source && String(l.sourceId) === String(r.source_id)),
  );

  main.innerHTML = `
    <section class="section" style="margin-top:6px">
      <div class="section-head"><h2 class="section-title">书库结果</h2><span class="section-sub">${(res.local || []).length} 本</span></div>
      ${
        res.imported
          ? `<div class="notice">🔎 已在网络书源找到相关内容，自动抓取并补充了 <b>${res.imported}</b> 本到书库。</div>`
          : ''
      }
      ${
        (res.local || []).length
          ? `<div class="grid">${res.local.map(bookCard).join('')}</div>`
          : emptyBox('本地书库没有匹配，试试从网络书源导入 ↓')
      }
    </section>
    ${
      remoteNotImported.length
        ? `<section class="section">
            <div class="section-head"><h2 class="section-title">网络书源</h2><span class="section-sub">点击「导入」即可加入书库</span></div>
            <div class="list">${remoteNotImported
              .map(
                (b) => `
              <div class="list-row">
                <div class="list-body">
                  <div class="list-title">${esc(b.title)}</div>
                  <div class="list-meta">${esc(b.author || '佚名')} · ${esc(b.category || '')} ${b.latest_chapter ? '· ' + esc(b.latest_chapter) : ''}</div>
                  <div class="list-meta"><span class="tag">来自：${esc(sourceLabel(b.source, b.sourceName))}</span></div>
                </div>
                <div class="list-actions">
                  <button class="btn primary" data-import-id="${esc(b.source_id)}" data-import-source="${esc(b.source)}">导入</button>
                </div>
              </div>`,
              )
              .join('')}</div>
          </section>`
        : ''
    }`;

  $$('[data-import-id]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const old = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span> 抓取中';
      const r = await api.importBook(btn.dataset.importId, btn.dataset.importSource);
      if (r.ok) {
        toast('导入成功');
        navigate(`#/book/${r.bookId}`);
      } else {
        btn.textContent = old;
        btn.disabled = false;
        toast('导入失败：' + (r.error || '未知错误'));
      }
    }),
  );
}

/* ============================ 书籍详情 ============================ */

async function viewBook(id) {
  clearInterval(heroTimer);
  clearInterval(catalogPollTimer);
  setNav('');
  main.innerHTML = spinner('加载书籍');
  let data = await api.book(id);
  if (!data.ok) return (main.innerHTML = emptyBox('书籍不存在'));

  const b = data.book;
  const chapters = data.chapters || [];
  main.innerHTML = `
    <section class="section" style="margin-top:6px">
      <div class="detail">
        <div class="detail-cover">${coverImg(b)}</div>
        <div class="detail-body">
          <h1 class="detail-title">${esc(b.title)}</h1>
          <div class="detail-meta">
            <span><i>作者</i>${esc(b.author)}</span>
            <span><i>分类</i>${esc(b.category)}</span>
            ${b.status ? `<span><i>状态</i>${esc(b.status)}</span>` : ''}
            <span id="detailCount">共 ${b.chapterCount || '—'} 章</span>
            ${b.updatedAt ? `<span><i>更新</i>${esc(b.updatedAt)}</span>` : ''}
          </div>
          <div class="detail-tags">
            <span class="tag accent">${esc(b.status || '连载中')}</span>
            <span class="tag">来自：${esc(sourceLabel(b.source))}</span>
            <span class="tag" id="syncTag">${b.enriched ? '目录已同步' : '目录待同步'}</span>
          </div>
          <p class="detail-intro" id="detailIntro">${esc(b.intro || '暂无简介。')}</p>
          <button type="button" class="intro-toggle" id="introToggle" aria-expanded="false">展开简介 ▾</button>
          <div class="detail-actions">
            <a class="btn primary detail-read" href="#/read/${b.id}/1">开始阅读</a>
            <a class="btn detail-tts" href="#/read/${b.id}/1?listen=1">🎧 听书</a>
            <button class="btn detail-dl" id="dlBtn" title="缓存整本，断网可读可听">⬇ 离线下载</button>
            <button class="btn detail-shelf" id="shelfBtn" data-on="${data.onShelf ? 1 : 0}">
              ${data.onShelf ? '★ 已在书架' : '☆ 加入书架'}
            </button>
            ${b.source === '本地书库' ? '' : '<button class="btn danger detail-remove" id="removeBook" title="从书库中删除本书（用于清理违规内容）">删除本书</button>'}
          </div>
        </div>
      </div>
    </section>

    <section class="chapter-panel">
      <div class="chapter-panel-head">
        <b>章节目录</b>
        <span class="section-sub" id="chapCount">${b.chapterCount || chapters.length} 章</span>
        <span class="spacer"></span>
        <button class="btn" id="chapSort" title="切换正序 / 倒序">${chapSortLabel()}</button>
        <input id="chapFilter" class="chap-filter" placeholder="筛选章节…" />
      </div>
      <div class="chapter-grid" id="chapGrid">
        ${chapters.length ? chapters.map((c) => chapLink(b.id, c)).join('') : `<div style="padding:16px;color:var(--text-faint)">${b.enriched ? '暂无章节' : '<span class="spin"></span> 目录同步中…'}</div>`}
      </div>
    </section>`;

  // 目录不分页：一次性拉全，支持正序 / 倒序
  bindChapSort(b.id);
  renderChapterList(b.id);

  // 章节筛选
  $('#chapFilter')?.addEventListener('input', applyChapFilter);

  // 简介过长时提供「展开 / 收起」；没有溢出就不显示这个按钮
  const introEl = $('#detailIntro');
  const introBtn = $('#introToggle');
  if (introEl && introBtn) {
    if (introEl.scrollHeight > introEl.clientHeight + 2) {
      introBtn.addEventListener('click', () => {
        const open = introEl.classList.toggle('open');
        introBtn.setAttribute('aria-expanded', String(open));
        introBtn.textContent = open ? '收起简介 ▴' : '展开简介 ▾';
      });
    } else {
      introBtn.style.display = 'none';
    }
  }

  // 书架
  $('#shelfBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const on = btn.dataset.on === '1';
    if (on) {
      await api.removeShelf(b.id);
      shelfCache = null;
      btn.dataset.on = '0';
      btn.textContent = '☆ 加入书架';
      toast('已移出书架');
    } else {
      await api.addShelf(b.id);
      shelfCache = null;
      btn.dataset.on = '1';
      btn.textContent = '★ 已在书架';
      toast('已加入书架');
    }
  });

  // 离线下载整本
  const dlBtn = $('#dlBtn');
  if (dlBtn) {
    if (!downloadSupported()) {
      dlBtn.title = '离线下载需 HTTPS 或外网隧道地址';
    } else {
      getDownload(b.id).then((d) => {
        if (d) dlBtn.textContent = '✓ 已离线';
      });
      dlBtn.addEventListener('click', () => startBookDownload(b.id, dlBtn));
    }
  }

  // 手动删除（清理违规内容）
  $('#removeBook')?.addEventListener('click', async (e) => {
    if (!confirm(`确定从书库删除《${b.title}》吗？此操作不可撤销。`)) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    const r = await api.removeBook(b.id);
    if (r.ok) {
      toast('已删除');
      navigate('#/');
    } else {
      btn.disabled = false;
      toast('删除失败，请稍后重试');
    }
  });

  // 目录尚未同步：先抓第 1 页（很快，页面已渲染出来），剩余页服务端后台补齐
  if (!b.enriched || !b.chapterCount) {
    const r = await api.enrich(id);
    if (r.ok) {
      await refreshChapterPanel(id);
      if (!r.complete) pollCatalog(id); // 轮询后台补齐进度，完成后刷新目录
    } else {
      toast('目录抓取失败，可稍后重试');
    }
  }
}

let catalogPollTimer = null;

/** 重新拉取书籍详情，只刷新目录区/章节数/同步状态，不动其它已绑定的事件 */
async function refreshChapterPanel(bookId) {
  const data = await api.book(bookId);
  if (!data?.ok) return;
  const b = data.book;
  const c1 = $('#chapCount');
  if (c1) c1.textContent = `${b.chapterCount || 0} 章`;
  const c2 = $('#detailCount');
  if (c2) c2.textContent = `共 ${b.chapterCount || '—'} 章`;
  const tag = $('#syncTag');
  if (tag) tag.textContent = b.enriched ? '目录已同步' : '目录同步中…';
  await renderChapterList(bookId);
}

/** 后台补齐目录期间，定时刷新目录区（最多约 30 秒，页面切走自动停止） */
function pollCatalog(bookId) {
  clearInterval(catalogPollTimer);
  let tries = 0;
  const stop = () => clearInterval(catalogPollTimer);
  catalogPollTimer = setInterval(async () => {
    if (!location.hash.startsWith(`#/book/${bookId}`)) return stop();
    tries += 1;
    const data = await api.book(bookId);
    if (!data?.ok) return stop();
    await refreshChapterPanel(bookId);
    if (data.book.enriched || tries >= 20) stop();
  }, 1500);
}

/* ---------- 目录：一次性拉全，不分页，支持正序 / 倒序 ---------- */

const CHAP_SORT_KEY = 'nv-chap-sort';
let chapSortOrder = (() => {
  try {
    return localStorage.getItem(CHAP_SORT_KEY) === 'desc' ? 'desc' : 'asc';
  } catch {
    return 'asc';
  }
})();

function chapSortLabel() {
  return chapSortOrder === 'asc' ? '↑ 正序' : '↓ 倒序';
}

/** 单个章节链接（active = 当前正在读的章） */
function chapLink(bookId, c, active = false) {
  const cls = [c.cached ? '' : 'read', active ? 'active' : ''].filter(Boolean).join(' ');
  return `<a href="#/read/${bookId}/${c.idx}" data-t="${esc(c.title)}" data-idx="${c.idx}" class="${cls}">${esc(c.title)}</a>`;
}

/** 按筛选框关键字过滤已渲染的章节 */
function applyChapFilter() {
  const kw = ($('#chapFilter')?.value || '').trim();
  $$('#chapGrid a').forEach((a) => {
    a.style.display = !kw || (a.dataset.t || '').includes(kw) ? '' : 'none';
  });
}

/** 绑定目录区「正序 / 倒序」切换按钮 */
function bindChapSort(bookId) {
  const btn = $('#chapSort');
  if (!btn) return;
  btn.textContent = chapSortLabel();
  btn.addEventListener('click', async () => {
    chapSortOrder = chapSortOrder === 'asc' ? 'desc' : 'asc';
    try {
      localStorage.setItem(CHAP_SORT_KEY, chapSortOrder);
    } catch {}
    btn.textContent = chapSortLabel();
    $('#catSort') && ($('#catSort').textContent = chapSortLabel()); // 若抽屉也开着，同步其按钮
    await renderChapterList(bookId);
  });
}

/** 拉取整本书目录并渲染（limit=0 表示不分页全量返回） */
async function renderChapterList(bookId, { activeIdx = null } = {}) {
  const grid = $('#chapGrid');
  if (!grid) return;
  const res = await api.chapters(bookId, { limit: 0, sort: chapSortOrder });
  const list = res.chapters || [];
  grid.innerHTML = list.length
    ? list.map((c) => chapLink(bookId, c, c.idx === activeIdx)).join('')
    : `<div style="padding:16px;color:var(--text-faint)">暂无章节</div>`;
  grid.classList.toggle('long', list.length > 400);
  const c1 = $('#chapCount');
  if (c1) c1.textContent = `${res.total ?? list.length} 章`;
  applyChapFilter();
  if (activeIdx != null) grid.querySelector(`a[data-idx="${activeIdx}"]`)?.scrollIntoView({ block: 'center' });
}

/* ============================ 阅读器 ============================ */

let readerCtx = null; // { bookId, idx }
let lastChapterNavAt = 0; // 防止双击 / 连点一次跳多章

/**
 * 当前（或最近一次）正在听的书章节。即使离开阅读页也保留，
 * 用于后台连播下一章 & 迷你播放条显示。
 * { bookId, bookTitle, idx, total, prev, next, chapterTitle }
 */
let nowPlaying = null;
let listenAutoHideTimer = null;

/* ---------- 阅读页工具条（顶栏 + 底部操作面板）---------- */

function chromeOn() {
  return document.body.classList.contains('chrome-on');
}

function applyChrome(on) {
  document.body.classList.toggle('chrome-on', !!on);
  const sb = $('#setImmersiveBtn');
  if (sb) sb.textContent = on ? '🙈 隐藏工具条（沉浸）' : '📖 显示工具条';
  syncReaderBarHeight();
  // 翻页模式：工具条显隐改变了可用高度，重新分页
  if (readerCtx && isPaged() && readerCtx._contentHTML != null) layoutPagedReader({ keepPage: true });
}

function toggleChrome() {
  applyChrome(!chromeOn());
}

function syncReaderBarHeight() {
  const barEl = $('.reader-bar');
  if (barEl && barEl.offsetHeight) {
    document.documentElement.style.setProperty('--reader-bar-h', barEl.offsetHeight + 'px');
  }
}

/** 从指定段落开始朗读（长按段落触发） */
function readFromParagraph(i) {
  if (!$('#listenPanel')) buildListenPanel();
  openListenPanel(true); // 开始后自动收起面板
  speaker.setIndex(Number(i), true);
  listenAutoHide();
}

/** 把当前的朗读位置同步到阅读页高亮（回到正在听的章节时用） */
function syncReaderHighlight() {
  const idx = speaker.index;
  $$('#readerBody p').forEach((p) => p.classList.toggle('speaking', Number(p.dataset.i) === idx));
  const active = $('#readerBody')?.querySelector(`p[data-i="${idx}"]`);
  // 翻页模式由 onState 整页跟随，不做 scrollIntoView（否则会带动窗口滚动）
  if (active && (speaker.playing || speaker.paused) && !isPaged()) {
    try {
      active.scrollIntoView({ block: 'center' });
    } catch {
      /* ignore */
    }
  }
}

/* ---------- 翻页阅读（滚动 / 左右翻页 / 上下翻页）---------- */

/** 本章上次看到的「页」，仅本会话记忆，翻回本章时恢复 */
const readerPageMemo = new Map();

/** 当前是否处于翻页模式 */
function isPaged() {
  return settings.pageMode === 'hpage' || settings.pageMode === 'vpage';
}

/**
 * 把带高度的元素按页高贪心分页（纯函数，便于单测）。
 * @param {{node:any,h:number}[]} items
 * @param {number} pageH
 * @returns {any[][]} 每页一个数组
 */
function groupIntoPages(items, pageH) {
  const pages = [];
  let cur = [];
  let h = 0;
  for (const it of items) {
    const hh = Math.max(0, Number(it.h) || 0);
    if (cur.length && h + hh > pageH) {
      pages.push(cur);
      cur = [];
      h = 0;
    }
    cur.push(it.node);
    h += hh;
  }
  if (cur.length) pages.push(cur);
  return pages;
}

/** 用隐藏的量具把内容块逐个测高（含块间距），并算出页内可用高度 */
function measureItems(html, pageW, pageH) {
  const holder = document.createElement('div');
  holder.className = 'reader-page reader-measure';
  holder.style.width = pageW + 'px';
  document.body.appendChild(holder);
  // 页面自身有上下留白，实际可放内容的高度要扣掉
  const cs = getComputedStyle(holder);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  for (const n of [...tmp.childNodes]) holder.appendChild(n);
  const items = [];
  let prev = null;
  let prevTop = 0;
  for (const el of [...holder.children]) {
    const top = el.offsetTop;
    if (prev) items.push({ node: prev, h: Math.max(prev.offsetHeight, top - prevTop) });
    prev = el;
    prevTop = top;
  }
  if (prev) items.push({ node: prev, h: prev.offsetHeight });
  holder.remove();
  // 减一点点余量，抵消 offsetHeight 取整误差，避免最后一行被裁
  return { items, contentH: Math.max(1, pageH - padY - 2) };
}

/** 跳到第 k 页 */
function gotoPage(k, opts = {}) {
  if (!readerCtx || !readerCtx._pages) return;
  const count = readerCtx._pageCount || 0;
  if (!count) return;
  const target = Math.min(Math.max(0, k), count - 1);
  readerCtx._pageIndex = target;
  readerPageMemo.set(`${readerCtx.bookId}:${readerCtx.idx}`, target);
  const track = $('#readerTrack');
  const stage = $('#readerStage');
  if (track && stage) {
    track.style.transition = opts.instant ? 'none' : 'transform 0.28s cubic-bezier(.2,.7,.2,1)';
    const d = settings.pageMode === 'vpage' ? stage.clientHeight : stage.clientWidth;
    track.style.transform = settings.pageMode === 'vpage' ? `translateY(${-target * d}px)` : `translateX(${-target * d}px)`;
  }
  updatePagedProgress();
}

/** 翻页：到本章边界时自动切上一章 / 下一章 */
function turnPage(dir) {
  if (!readerCtx || !readerCtx._pages) return false;
  const count = readerCtx._pageCount || 0;
  const cur = readerCtx._pageIndex || 0;
  const next = cur + dir;
  if (next < 0 || next >= count) {
    if (readerCtx._gotoChapter) readerCtx._gotoChapter(dir);
    return true;
  }
  gotoPage(next);
  return true;
}

/** paged 模式的进度：结合章节序号与本章页序号 */
function updatePagedProgress() {
  const rp = $('#rp');
  if (!rp || !readerCtx) return;
  const count = readerCtx._pageCount || 0;
  const within = count ? ((readerCtx._pageIndex || 0) + 1) / count : 1;
  const total = nowPlaying?.total || 0;
  const pct = total > 1 ? ((readerCtx.idx - 1 + within) / total) * 100 : within * 100;
  rp.style.width = Math.min(100, Math.max(0, pct)) + '%';
}

/** 当前视口（或当前页）顶部的段落索引——用于「从当前处开始听」 */
function currentParagraphIndex() {
  const ps = $$('#readerBody p[data-i]');
  if (!ps.length) return 0;
  if (isPaged() && readerCtx?._pages?.length) {
    const start = readerCtx._pageIndex || 0;
    // 当前页可能只有标题 / 章头（无段落），往后找最近的段落
    for (let k = start; k < readerCtx._pages.length; k++) {
      const first = readerCtx._pages[k]?.querySelector('p[data-i]');
      if (first) return Number(first.dataset.i);
    }
    // 实在没有则从当前页往前找最后一个段落
    for (let k = start - 1; k >= 0; k--) {
      const list = readerCtx._pages[k]?.querySelectorAll('p[data-i]');
      if (list && list.length) return Number(list[list.length - 1].dataset.i);
    }
    return 0;
  }
  for (const p of ps) {
    if (p.getBoundingClientRect().bottom > 0) return Number(p.dataset.i);
  }
  return Number(ps[ps.length - 1].dataset.i);
}

/** 待处理的「看原文」跳转：跨章时先记录，等章节渲染完再滚动定位 */
let pendingSpeakScroll = null;

/** 把指定段落滚到视野中间（滚动模式平滑滚动；翻页模式翻到所在页）并高亮 */
function scrollToParagraph(i) {
  const body = $('#readerBody');
  if (!body) return false;
  const p = body.querySelector(`p[data-i="${i}"]`);
  if (!p) return false;
  $$('#readerBody p').forEach((x) => x.classList.toggle('speaking', Number(x.dataset.i) === i));
  if (isPaged() && readerCtx?._pages?.length) {
    const page = p.closest('.reader-page');
    const k = page ? readerCtx._pages.indexOf(page) : -1;
    if (k >= 0) gotoPage(k);
    else p.scrollIntoView({ block: 'center' });
  } else {
    p.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  return true;
}

/** 「看原文」：收起听书面板，跳到当前正在朗读的那一段（必要时先切章） */
function jumpToSpokenParagraph() {
  const np = nowPlaying;
  const i = speaker.index || 0;
  if (typeof closeListenPanel === 'function') closeListenPanel();
  if (!np) {
    toast('还没有开始朗读');
    return;
  }
  const sameChapter = readerCtx && readerCtx.bookId === np.bookId && readerCtx.idx === np.idx;
  if (sameChapter) {
    scrollToParagraph(i);
    return;
  }
  // 不在同一章：先跳章，渲染完再定位（viewReader 里消费 pendingSpeakScroll）
  pendingSpeakScroll = { bookId: np.bookId, idx: np.idx, i };
  navigate(`#/read/${np.bookId}/${np.idx}`);
}

/** 翻页模式的点按分区（纯函数）：hpage 分左右，vpage 分上下 */
function pageTapZone(clientX, clientY, width, height, mode) {
  if (mode === 'vpage') {
    const h = height > 0 ? height : 1;
    const r = clientY / h;
    if (r < 0.3) return 'prev';
    if (r > 0.7) return 'next';
    return 'center';
  }
  const ratio = width > 0 ? clientX / width : 0.5;
  if (ratio < 0.28) return 'prev';
  if (ratio > 0.72) return 'next';
  return 'center';
}

/** 把阅读内容按当前翻页方式重新排版（滚动模式则恢复原样） */
function layoutPagedReader(opts = {}) {
  const bodyEl = $('#readerBody');
  if (!bodyEl || !readerCtx) return;
  const mode = settings.pageMode || 'scroll';

  if (mode === 'scroll') {
    if (bodyEl.dataset.paged === '1') {
      bodyEl.classList.remove('paged');
      delete bodyEl.dataset.paged;
      bodyEl.innerHTML = readerCtx._contentHTML || '';
      readerCtx._pages = [];
      readerCtx._pageCount = 0;
      readerCtx._pageIndex = 0;
      const rp = $('#rp');
      if (rp) rp.style.width = '0%';
      syncReaderHighlight();
      readerCtx._onScroll?.();
    }
    return;
  }

  if (readerCtx._contentHTML == null) return;

  if (bodyEl.dataset.paged !== '1') {
    bodyEl.classList.add('paged');
    bodyEl.dataset.paged = '1';
    bodyEl.innerHTML = '<div class="reader-stage" id="readerStage"><div class="reader-track" id="readerTrack"></div></div>';
  }
  const stage = $('#readerStage');
  const track = $('#readerTrack');
  if (!stage || !track) return;
  const stageW = Math.round(stage.clientWidth);
  const stageH = Math.round(stage.clientHeight);
  if (stageW < 40 || stageH < 40) {
    // 还没拿到布局（极少见）：下一帧再排一次
    if (!opts._retried && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => layoutPagedReader({ keepPage: true, _retried: true }));
    }
    return;
  }

  // 翻页模式：章末「上一章 / 下一章」导航不参与分页（翻章统一走工具栏 / 点按 / 滑动），
  // 避免最后一页底部突兀地出现一排按钮。滚动模式仍保留章末导航。
  let srcHTML = readerCtx._contentHTML;
  if (mode !== 'scroll') {
    const tmp = document.createElement('div');
    tmp.innerHTML = srcHTML;
    tmp.querySelectorAll('.reader-nav').forEach((n) => n.remove());
    srcHTML = tmp.innerHTML;
  }
  const { items, contentH } = measureItems(srcHTML, stageW, stageH);
  const pages = groupIntoPages(items, contentH);
  const frag = document.createDocumentFragment();
  for (const pageNodes of pages) {
    const page = document.createElement('section');
    page.className = 'reader-page';
    page.style.width = stageW + 'px';
    page.style.height = stageH + 'px';
    for (const n of pageNodes) page.appendChild(n);
    frag.appendChild(page);
  }
  track.innerHTML = '';
  track.appendChild(frag);
  readerCtx._pages = [...track.children];
  readerCtx._pageCount = readerCtx._pages.length;
  const memo = readerPageMemo.get(`${readerCtx.bookId}:${readerCtx.idx}`) || 0;
  let start = opts.keepPage ? readerCtx._pageIndex || 0 : memo;
  // 正在听书：重排后仍停在当前朗读段落所在页
  if (speaker.playing) {
    const cur = track.querySelector(`p[data-i="${speaker.index}"]`);
    const pg = cur ? cur.closest('.reader-page') : null;
    const k = pg ? readerCtx._pages.indexOf(pg) : -1;
    if (k >= 0) start = k;
  }
  gotoPage(Math.min(start, Math.max(0, readerCtx._pageCount - 1)), { instant: true });
  syncReaderHighlight();
}

function enterFullscreen() {
  const el = document.documentElement;
  try {
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch {
    /* 部分手机浏览器（如 iPhone Safari）不支持，忽略 */
  }
}

function exitFullscreen() {
  try {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
  } catch {
    /* ignore */
  }
}

/* ---------- 主题（夜间 / 日间）---------- */

let readerDayTheme = 'ink';

function syncThemeBtn() {
  const night = settings.theme === 'night';
  const ic = $('#rThemeIcon');
  if (ic) ic.textContent = night ? '☀️' : '🌙';
  const lb = $('#rThemeLabel');
  if (lb) lb.textContent = night ? '日间' : '夜间';
}

/** 触屏点按分区：左侧 28% 上一章，右侧 28% 下一章，中间弹出面板 */
function tapZone(clientX, width) {
  const ratio = width > 0 ? clientX / width : 0.5;
  if (ratio < 0.28) return 'prev';
  if (ratio > 0.72) return 'next';
  return 'center';
}

async function viewReader(bookId, idx, query) {
  setNav('');
  document.body.classList.add('reading');
  clearInterval(heroTimer);
  // 章内换章时保留工具条状态；从其它页面进来时用设置里的默认值
  const keepChrome = readerCtx ? document.body.classList.contains('chrome-on') : null;
  detachReader(); // 换章时移除上一章的监听，避免重复触发

  readerCtx = { bookId: Number(bookId), idx: Number(idx) || 1 };
  main.innerHTML = `<div class="reader">${spinner('正在取出章节')}</div>`;

  const data = await api.chapter(readerCtx.bookId, readerCtx.idx);
  if (!data.ok) {
    main.innerHTML = `<div class="empty">章节加载失败：${esc(data.error)}<br/><br/><a class="btn" href="#/book/${bookId}">返回目录</a></div>`;
    return;
  }

  readerCtx.total = data.total;
  const b = data.book || {};

  // 回到正在听的同一本书同一章：不打断播放，只同步高亮
  const wasListening = speaker.playing || speaker.paused;
  const sameBook = !!(nowPlaying && nowPlaying.bookId === readerCtx.bookId);
  const sameChapter = !!(sameBook && nowPlaying.idx === readerCtx.idx);
  const keepAudio = sameChapter && wasListening;

  nowPlaying = {
    bookId: readerCtx.bookId,
    bookTitle: b.title || '',
    idx: readerCtx.idx,
    total: data.total || 0,
    prev: data.prev,
    next: data.next,
    chapterTitle: data.title || '',
  };

  // 已开始阅读本书：自动往后续缓冲几章，翻到「下一章」时秒开（服务端也会同时预热）
  const prefetchN = Math.max(0, Math.min(10, Number(settings.prefetchChapters) || 0));
  if (prefetchN > 0 && data.next) api.prefetchChapters(readerCtx.bookId, readerCtx.idx, prefetchN);

  main.innerHTML = `
  <div class="reader">
    <div class="reader-bar">
      <button class="icon-btn" id="rBack" title="返回">←</button>
      <button class="icon-btn" id="rPrevChap" ${data.prev ? '' : 'disabled'} title="上一章">‹</button>
      <div class="rtitle"><b>${esc(b.title || '')}</b><span>${esc(data.title)}</span></div>
      <button class="icon-btn" id="rNextChap" ${data.next ? '' : 'disabled'} title="下一章">›</button>
    </div>
    <div class="reader-progress"><i id="rp"></i></div>
    <article class="reader-body" id="readerBody">
      <h1>${esc(data.title)}</h1>
      <div class="chap-meta"><span>第 ${data.idx} / ${data.total || '?'} 章</span><span>${esc(b.author || '')}</span><span>点两侧翻章 · 点中间弹出菜单 · 长按段落朗读</span></div>
      ${data.paragraphs.map((p, i) => `<p data-i="${i}">${esc(p)}</p>`).join('')}
      <div class="reader-nav">
        <button class="btn" id="rPrev" ${data.prev ? '' : 'disabled'}>‹ 上一章</button>
        <button class="btn" id="rCacheChap" title="仅缓存本章，断网可读">⬇ 缓存本章</button>
        <button class="btn" id="rNext" ${data.next ? '' : 'disabled'}>下一章 ›</button>
      </div>
    </article>
    <div class="reader-actions" id="readerActions">
      <button class="ra-btn" id="rCatalog"><span>☰</span><em>目录</em></button>
      <button class="ra-btn" id="rListen"><span>🎧</span><em>听书</em></button>
      <button class="ra-btn" id="rTheme"><span id="rThemeIcon">🌙</span><em id="rThemeLabel">夜间</em></button>
      <button class="ra-btn" id="rShelf" data-on="0" title="加入书架"><span id="rShelfIcon">☆</span><em id="rShelfLabel">书架</em></button>
      <button class="ra-btn" id="rSettings"><span>⚙</span><em>设置</em></button>
    </div>
  </div>`;

  // 保存原始正文：翻页模式（左右 / 上下）会把它重新分页渲染
  readerCtx._contentHTML = $('#readerBody').innerHTML;

  // 书架状态
  const detail = await api.book(readerCtx.bookId);
  const shelfBtn = $('#rShelf');
  const setShelfBtn = (on) => {
    shelfBtn.dataset.on = on ? '1' : '0';
    const ic = $('#rShelfIcon');
    const lb = $('#rShelfLabel');
    if (ic) ic.textContent = on ? '★' : '☆';
    if (lb) lb.textContent = on ? '已收藏' : '书架';
    shelfBtn.title = on ? '已在书架，点击移出' : '加入书架';
  };
  setShelfBtn(detail.onShelf);
  shelfBtn.addEventListener('click', async () => {
    const on = shelfBtn.dataset.on === '1';
    if (on) {
      await api.removeShelf(readerCtx.bookId);
      shelfCache = null;
      setShelfBtn(false);
      toast('已移出书架');
    } else {
      await api.addShelf(readerCtx.bookId);
      shelfCache = null;
      setShelfBtn(true);
      toast('已加入书架');
    }
  });

  // 记录阅读历史
  api.recordHistory(readerCtx.bookId, readerCtx.idx);

  // 朗读内容
  if (keepAudio) {
    // 同一章：保留正在进行的朗读，仅恢复高亮
    syncReaderHighlight();
  } else {
    speaker.setContent(data.paragraphs, 0);
    speaker.setConfig({
      rate: settings.listenRate,
      pitch: settings.listenPitch,
      volume: settings.listenVolume,
      voiceURI: settings.voiceURI,
      autoNext: settings.autoNext,
    });
    // 正在听书时手动翻章：自动继续朗读新章节，不打断听书
    if (wasListening && sameBook) {
      speaker.play();
      listenAutoHide();
    }
  }

  bindReaderEvents(data);
  buildListenPanel();
  if (settings.theme === 'night') readerDayTheme = 'paper';
  applyChrome(keepChrome === null ? !settings.readerImmersive : keepChrome);
  syncThemeBtn();
  layoutPagedReader({ memo: true });
  updateMiniPlayer();

  // 「看原文」跨章跳转：等本章渲染/排版完，再滚动到正在朗读的那一段
  if (pendingSpeakScroll && pendingSpeakScroll.bookId === readerCtx.bookId && pendingSpeakScroll.idx === readerCtx.idx) {
    const target = pendingSpeakScroll.i;
    pendingSpeakScroll = null;
    setTimeout(() => scrollToParagraph(target), 180);
  }

  if (query.listen === '1') {
    setTimeout(() => {
      openListenPanel(true); // 开始播放后自动收起面板，让出正文
      const startIdx = currentParagraphIndex();
      if (startIdx > 0) speaker.setIndex(startIdx, true);
      else speaker.play();
      // 部分手机（尤其 iOS）需用户再点一下才能出声
      setTimeout(() => {
        if (!speaker.playing && !speaker.paused) toast('请点播放键「▶」开始朗读');
      }, 1600);
    }, 300);
  }
}

function bindReaderEvents(data) {
  const body = $('#readerBody');
  const rp = $('#rp');

  $('#rBack').addEventListener('click', () => navigate(`#/book/${readerCtx.bookId}`));
  // 工具栏里的上一章 / 下一章（翻页模式章末不再内联按钮，统一到这里）
  $('#rPrevChap')?.addEventListener('click', () => { if (data.prev) gotoChapter(-1); });
  $('#rNextChap')?.addEventListener('click', () => { if (data.next) gotoChapter(1); });
  $('#rCatalog').addEventListener('click', () => {
    if (!$('#catalog')) buildCatalogDrawer(readerCtx);
  });
  $('#rSettings').addEventListener('click', () => {
    if (!$('#settings')) buildSettingsDrawer();
  });
  $('#rListen').addEventListener('click', () => {
    const wasActive = speaker.playing || speaker.paused;
    // 已在听：打开面板是为了调设置，不自动收起；否则开始播放后自动收起
    openListenPanel(!wasActive);
    // 新开始听：从当前看得见的位置（或当前页）起读，而不是整章开头
    const start = () => {
      if (wasActive) {
        if (!speaker.playing) speaker.play();
      } else {
        speaker.setIndex(currentParagraphIndex(), true);
        listenAutoHide();
      }
    };
    if (!speaker.supported) {
      // 服务端语音仍在检测中，稍等一下
      setTimeout(() => {
        if (speaker.supported) start();
        else toast('暂未检测到可用音色，请点面板里的「重新检测音色」');
      }, 600);
      return;
    }
    if (readerCtx) start();
  });

  // 夜间 / 日间切换
  $('#rTheme').addEventListener('click', () => {
    if (settings.theme === 'night') {
      saveSettings({ theme: readerDayTheme });
      toast('日间模式');
    } else {
      readerDayTheme = settings.theme;
      saveSettings({ theme: 'night' });
      toast('夜间模式');
    }
    syncThemeBtn();
  });

  // 全屏按钮（若存在）
  $('#rFullscreen')?.addEventListener('click', () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) exitFullscreen();
    else enterFullscreen();
  });

  // 轻点正文：左右两侧翻章，中间显示 / 隐藏工具条
  // 触屏设备点正文任意处生效；鼠标设备点正文留给选词 / 双击朗读，仅点空白处切换
  const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const gotoChapter = (dir) => {
    const target = dir < 0 ? data.prev : data.next;
    if (!target) {
      toast(dir < 0 ? '已经是第一章了' : '已经是最后一章了');
      return;
    }
    const now = Date.now();
    if (now - lastChapterNavAt < 500) return; // 连点 / 双击只算一次
    lastChapterNavAt = now;
    navigate(`#/read/${readerCtx.bookId}/${target}`);
  };
  readerCtx._gotoChapter = gotoChapter;
  const onBodyTap = (e) => {
    if (readerCtx._suppressTapUntil && Date.now() < readerCtx._suppressTapUntil) return;
    if (e.target.closest('button, a, input, select, .reader-nav, .reader-actions')) return;

    // 翻页模式：点按翻页（左右 / 上下），中间切换工具条
    if (isPaged() && readerCtx._pages && readerCtx._pageCount) {
      if (chromeOn()) {
        toggleChrome();
        return;
      }
      const w = window.innerWidth || document.documentElement.clientWidth || 1;
      const h = window.innerHeight || document.documentElement.clientHeight || 1;
      const zone = pageTapZone(e.clientX, e.clientY, w, h, settings.pageMode);
      if (zone === 'prev') return void turnPage(-1);
      if (zone === 'next') return void turnPage(1);
      toggleChrome();
      return;
    }

    if (!coarse) {
      // 桌面：点段落从该处朗读，点空白处显示 / 隐藏工具条
      const p = e.target.closest('p[data-i]');
      if (p) {
        readFromParagraph(Number(p.dataset.i));
        return;
      }
      toggleChrome();
      return;
    }
    // 工具条已展开时，点正文任意处先收起，避免误翻章
    if (chromeOn()) {
      toggleChrome();
      return;
    }
    const w = window.innerWidth || document.documentElement.clientWidth || 1;
    const zone = tapZone(e.clientX, w);
    if (zone === 'prev') {
      gotoChapter(-1);
      return;
    }
    if (zone === 'next') {
      gotoChapter(1);
      return;
    }
    toggleChrome();
  };
  body.addEventListener('click', onBodyTap);
  readerCtx._onBodyTap = onBodyTap;

  // 翻页模式：左右 / 上下滑动翻页（滚动模式不拦截，交给原生滚动）
  let tsx = 0;
  let tsy = 0;
  const onTouchStart = (e) => {
    const t = e.changedTouches[0];
    tsx = t.clientX;
    tsy = t.clientY;
  };
  const onTouchEnd = (e) => {
    if (!isPaged() || !readerCtx._pages || !readerCtx._pages.length) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - tsx;
    const dy = t.clientY - tsy;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (Math.max(adx, ady) < 40) return; // 视为点按
    if (settings.pageMode === 'hpage') {
      if (adx < ady) return;
      turnPage(dx < 0 ? 1 : -1);
    } else {
      if (ady < adx) return;
      turnPage(dy < 0 ? 1 : -1);
    }
    readerCtx._suppressTapUntil = Date.now() + 350;
  };
  body.addEventListener('touchstart', onTouchStart, { passive: true });
  body.addEventListener('touchend', onTouchEnd, { passive: true });
  readerCtx._onTouchStart = onTouchStart;
  readerCtx._onTouchEnd = onTouchEnd;

  // 尺寸 / 纸张变化后重新分页
  const relayout = () => {
    if (!isPaged() || !readerCtx) return;
    clearTimeout(readerCtx._relayoutTimer);
    readerCtx._relayoutTimer = setTimeout(() => layoutPagedReader({ keepPage: true }), 160);
  };
  window.addEventListener('resize', relayout);
  window.addEventListener('orientationchange', relayout);
  readerCtx._onRelayout = relayout;

  const onSettingsChanged = () => {
    if (!readerCtx) return;
    const sig = `${settings.pageMode}|${settings.fontSize}|${settings.lineHeight}|${settings.fontFamily}|${settings.readerWidth}`;
    if (sig === readerCtx._pageSig) return;
    readerCtx._pageSig = sig;
    layoutPagedReader({ keepPage: true });
  };
  readerCtx._pageSig = `${settings.pageMode}|${settings.fontSize}|${settings.lineHeight}|${settings.fontFamily}|${settings.readerWidth}`;
  document.addEventListener('settings-changed', onSettingsChanged);
  readerCtx._onSettings = onSettingsChanged;

  // 离线下载：整本 / 本章
  const rDownload = $('#rDownload');
  if (rDownload) {
    if (!downloadSupported()) {
      rDownload.title = '离线下载需 HTTPS 或外网隧道地址';
    } else {
      getDownload(readerCtx.bookId).then((d) => {
        if (d) rDownload.textContent = '✓ 已离线';
      });
      rDownload.addEventListener('click', () => startBookDownload(readerCtx.bookId, rDownload));
    }
  }
  // 章末按钮用事件委托：滚动 / 翻页切换会重建 DOM，委托后依然可用
  const onNavClick = (e) => {
    const btn = e.target.closest && e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'rPrev' && data.prev) navigate(`#/read/${readerCtx.bookId}/${data.prev}`);
    else if (btn.id === 'rNext' && data.next) navigate(`#/read/${readerCtx.bookId}/${data.next}`);
    else if (btn.id === 'rCacheChap') startBookDownload(readerCtx.bookId, btn, [readerCtx.idx]);
  };
  body.addEventListener('click', onNavClick);
  readerCtx._onNavClick = onNavClick;

  // 段落：长按从此处朗读；桌面双击亦可（事件委托，翻页重排后依然有效）
  let pressTimer = null;
  let pressX = 0;
  let pressY = 0;
  let pressIdx = -1;
  const clearPressTimer = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };
  const onBodyPointerDown = (e) => {
    if (e.pointerType === 'mouse') return; // 桌面用双击
    const p = e.target.closest && e.target.closest('p[data-i]');
    if (!p) return;
    pressX = e.clientX;
    pressY = e.clientY;
    pressIdx = Number(p.dataset.i);
    clearPressTimer();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      const idx = pressIdx;
      pressIdx = -1;
      if (idx < 0) return;
      readerCtx._suppressTapUntil = Date.now() + 700;
      if (navigator.vibrate) {
        try {
          navigator.vibrate(15);
        } catch {
          /* ignore */
        }
      }
      readFromParagraph(idx);
    }, 460);
  };
  const onBodyPointerMove = (e) => {
    if (pressTimer && (Math.abs(e.clientX - pressX) > 8 || Math.abs(e.clientY - pressY) > 8)) clearPressTimer();
  };
  const onBodyDblClick = (e) => {
    const p = e.target.closest && e.target.closest('p[data-i]');
    if (p) readFromParagraph(Number(p.dataset.i));
  };
  body.addEventListener('pointerdown', onBodyPointerDown);
  body.addEventListener('pointermove', onBodyPointerMove);
  body.addEventListener('pointerup', clearPressTimer);
  body.addEventListener('pointercancel', clearPressTimer);
  body.addEventListener('dblclick', onBodyDblClick);
  readerCtx._onPointerDown = onBodyPointerDown;
  readerCtx._onPointerMove = onBodyPointerMove;
  readerCtx._onPointerUp = clearPressTimer;
  readerCtx._onBodyDblClick = onBodyDblClick;

  // 高亮 + 跟随（滚动模式滚动跟随；翻页模式整页跟随）
  const onState = (e) => {
    const { index, playing } = e.detail;
    $$('#readerBody p').forEach((p) => p.classList.toggle('speaking', Number(p.dataset.i) === index));
    const active = body.querySelector(`p[data-i="${index}"]`);
    if (active && playing) {
      if (isPaged() && readerCtx._pages && readerCtx._pages.length) {
        const page = active.closest('.reader-page');
        const k = page ? readerCtx._pages.indexOf(page) : -1;
        if (k >= 0 && k !== readerCtx._pageIndex) gotoPage(k);
      } else if (!isPaged()) {
        active.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    updateListenUI(e.detail);
  };
  speaker.addEventListener('state', onState);
  readerCtx._onState = onState;

  // 跨章连播由全局 onChapterEnd 统一处理（停留阅读页或后台播放都能续播）

  // 服务端语音出错提示
  const onTtsError = (e) => toast(`语音播放失败：${e?.detail?.error || '未知错误'}`);
  speaker.addEventListener('error', onTtsError);
  readerCtx._onTtsError = onTtsError;

  // 浏览器拦截自动播放时提示用户手动开始
  const onBlocked = () => toast('请点播放键「▶」开始朗读');
  speaker.addEventListener('blocked', onBlocked);
  readerCtx._onBlocked = onBlocked;

  // 阅读进度条
  const onScroll = () => {
    if (isPaged()) return; // 翻页模式由 updatePagedProgress 负责
    const h = document.documentElement.scrollHeight - window.innerHeight;
    rp.style.width = Math.min(100, Math.max(0, (window.scrollY / (h || 1)) * 100)) + '%';
  };
  readerCtx._onScroll = onScroll;
  window.addEventListener('scroll', onScroll);
  onScroll();

  // 键盘
  document.onkeydown = (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'ArrowRight') {
      if (isPaged()) turnPage(1);
      else data.next && navigate(`#/read/${readerCtx.bookId}/${data.next}`);
    } else if (e.key === 'ArrowLeft') {
      if (isPaged()) turnPage(-1);
      else data.prev && navigate(`#/read/${readerCtx.bookId}/${data.prev}`);
    } else if (e.key === 'ArrowDown' && isPaged() && settings.pageMode === 'vpage') turnPage(1);
    else if (e.key === 'ArrowUp' && isPaged() && settings.pageMode === 'vpage') turnPage(-1);
    else if (e.code === 'Space') {
      e.preventDefault();
      openListenPanel();
      speaker.toggle();
    } else if (e.key === 'j') speaker.next();
    else if (e.key === 'k') speaker.prev();
    else if (e.key === 'f') toggleChrome();
  };
}

function detachReader() {
  if (!readerCtx) return;
  if (readerCtx._onState) speaker.removeEventListener('state', readerCtx._onState);
  if (readerCtx._onTtsError) speaker.removeEventListener('error', readerCtx._onTtsError);
  if (readerCtx._onBlocked) speaker.removeEventListener('blocked', readerCtx._onBlocked);
  if (readerCtx._onScroll) window.removeEventListener('scroll', readerCtx._onScroll);
  const bodyEl = $('#readerBody');
  if (readerCtx._onBodyTap) bodyEl?.removeEventListener('click', readerCtx._onBodyTap);
  if (readerCtx._onTouchStart) bodyEl?.removeEventListener('touchstart', readerCtx._onTouchStart);
  if (readerCtx._onTouchEnd) bodyEl?.removeEventListener('touchend', readerCtx._onTouchEnd);
  if (readerCtx._onPointerDown) bodyEl?.removeEventListener('pointerdown', readerCtx._onPointerDown);
  if (readerCtx._onPointerMove) bodyEl?.removeEventListener('pointermove', readerCtx._onPointerMove);
  if (readerCtx._onPointerUp) {
    bodyEl?.removeEventListener('pointerup', readerCtx._onPointerUp);
    bodyEl?.removeEventListener('pointercancel', readerCtx._onPointerUp);
  }
  if (readerCtx._onBodyDblClick) bodyEl?.removeEventListener('dblclick', readerCtx._onBodyDblClick);
  if (readerCtx._onNavClick) bodyEl?.removeEventListener('click', readerCtx._onNavClick);
  if (readerCtx._onRelayout) {
    window.removeEventListener('resize', readerCtx._onRelayout);
    window.removeEventListener('orientationchange', readerCtx._onRelayout);
    clearTimeout(readerCtx._relayoutTimer);
  }
  if (readerCtx._onSettings) document.removeEventListener('settings-changed', readerCtx._onSettings);
  document.onkeydown = null;
}

function cleanupReader() {
  detachReader();
  document.body.classList.remove('reading', 'immersive', 'chrome-on');
  exitFullscreen();
  // 后台听书：离开阅读页不打断朗读，由迷你播放条「✕」单独停止
  if (!speaker.playing && !speaker.paused) speaker.stop();
  closeLookups();
  readerCtx = null;
  updateMiniPlayer();
}

/* ---------- 目录抽屉 ---------- */

let drawers = [];
function mountDrawer(id, side, title, innerHtml) {
  const mask = document.createElement('div');
  mask.className = 'drawer-mask';
  const drawer = document.createElement('aside');
  drawer.className = `drawer ${side}`;
  drawer.id = id;
  drawer.innerHTML = `<div class="drawer-head"><b>${esc(title)}</b><button class="icon-btn" data-close>✕</button></div><div class="drawer-body">${innerHtml}</div>`;
  document.body.append(mask, drawer);
  requestAnimationFrame(() => {
    mask.classList.add('show');
    drawer.classList.add('open');
  });
  mask.addEventListener('click', () => closeDrawer(id));
  drawer.querySelector('[data-close]').addEventListener('click', () => closeDrawer(id));
  drawers.push({ id, mask, drawer });
  return drawer;
}
function closeDrawer(id) {
  const i = drawers.findIndex((d) => d.id === id);
  if (i < 0) return;
  const { mask, drawer } = drawers[i];
  mask.classList.remove('show');
  drawer.classList.remove('open');
  setTimeout(() => {
    mask.remove();
    drawer.remove();
  }, 250);
  drawers.splice(i, 1);
}

async function buildCatalogDrawer(ctx) {
  const drawer = mountDrawer(
    'catalog',
    'right',
    '章节目录',
    `<div class="drawer-actions" style="margin-bottom:10px">
      <button class="btn" id="catSort" title="切换正序 / 倒序">${chapSortLabel()}</button>
      <input id="catFilter" placeholder="筛选章节…" style="flex:1;padding:7px 12px;border-radius:9px;border:1px solid var(--line-strong);background:var(--bg-elev);color:var(--text);font-size:13px" />
    </div>
    <div id="catList">${spinner('读取目录')}</div>`,
  );
  const list = drawer.querySelector('#catList');

  const filterItems = () => {
    const kw = (drawer.querySelector('#catFilter')?.value || '').trim();
    list.querySelectorAll('a').forEach((a) => {
      a.style.display = !kw || (a.dataset.t || '').includes(kw) ? '' : 'none';
    });
  };

  const render = async (scrollToCurrent) => {
    const res = await api.chapters(ctx.bookId, { limit: 0, sort: chapSortOrder });
    const items = res.chapters || [];
    list.innerHTML = items.length
      ? `<div class="chapter-grid long" style="max-height:none;padding:0">${items.map((c) => chapLink(ctx.bookId, c, c.idx === ctx.idx)).join('')}</div>`
      : `<div class="empty">暂无章节</div>`;
    filterItems();
    if (scrollToCurrent) list.querySelector(`a[data-idx="${ctx.idx}"]`)?.scrollIntoView({ block: 'center' });
  };

  drawer.querySelector('#catSort').addEventListener('click', async (e) => {
    chapSortOrder = chapSortOrder === 'asc' ? 'desc' : 'asc';
    try {
      localStorage.setItem(CHAP_SORT_KEY, chapSortOrder);
    } catch {}
    e.currentTarget.textContent = chapSortLabel();
    $('#chapSort') && ($('#chapSort').textContent = chapSortLabel()); // 若详情页也开着，同步
    await render(true);
  });
  drawer.querySelector('#catFilter').addEventListener('input', filterItems);

  await render(true);
}

function buildSettingsDrawer() {
  if ($('#settings')) return;
  const fonts = [
    ['serif', '宋体 / 衬线'],
    ['sans', '黑体 / 无衬线'],
  ];
  mountDrawer(
    'settings',
    'right',
    '阅读设置',
    `
    <div class="drawer-actions">
      <button class="btn" id="setImmersiveBtn">${settings.readerImmersive ? '📖 显示工具条' : '🙈 隐藏工具条（沉浸）'}</button>
      <button class="btn" id="setFullscreenBtn">⛶ 全屏</button>
      <button class="btn" id="setDownloadBtn" title="缓存整本，断网可读可听">⬇ 离线整本</button>
      <button class="btn" id="setCacheChapBtn" title="仅缓存本章">⬇ 缓存本章</button>
    </div>
    <div class="listen-grid" style="grid-template-columns:1fr">
      <label>主题
        <select id="setTheme">${THEMES.map((t) => `<option value="${t.id}" ${settings.theme === t.id ? 'selected' : ''}>${t.name}</option>`).join('')}</select>
      </label>
      <label>字号 <input type="range" id="setSize" min="14" max="30" value="${settings.fontSize}" /> <b id="sizeVal">${settings.fontSize}px</b></label>
      <label>行距 <input type="range" id="setLine" min="150" max="260" value="${Math.round(settings.lineHeight * 100)}" /></label>
      <label>版心 <input type="range" id="setWidth" min="560" max="1000" step="20" value="${settings.readerWidth}" /></label>
      <label>字体 <select id="setFont">${fonts.map(([v, n]) => `<option value="${v}" ${settings.fontFamily === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>翻页 <select id="setPage">
        ${[['scroll', '滚动（下拉）'], ['hpage', '左右翻页'], ['vpage', '上下翻页']]
          .map(([v, n]) => `<option value="${v}" ${(settings.pageMode || 'scroll') === v ? 'selected' : ''}>${n}</option>`)
          .join('')}
      </select></label>
      <label>预加载 <select id="setPrefetch">${[0, 3, 5, 10].map((n) => `<option value="${n}" ${(Number(settings.prefetchChapters) || 0) === n ? 'selected' : ''}>${n === 0 ? '关闭' : n + ' 章'}</option>`).join('')}</select></label>
      <label class="listen-full"><input type="checkbox" id="setImmersive" ${settings.readerImmersive ? 'checked' : ''} /> 打开章节时默认隐藏工具条</label>
      <label class="listen-full"><input type="checkbox" id="setFullscreen" ${settings.readerFullscreen ? 'checked' : ''} /> 阅读时请求全屏</label>
    </div>
    <div class="listen-note">提示：轻点正文显示 / 隐藏工具条；长按段落可「从此处开始听」；顶栏 ‹ › 切上一章 / 下一章；「左右翻页」点两侧 / 左右滑动翻页，「上下翻页」点上下 / 上下滑动翻页，到本章末自动切下一章。空格播放/暂停，J / K 切换朗读段落。</div>`,
  );
  $('#setImmersiveBtn').addEventListener('click', () => {
    toggleChrome();
    closeDrawer('settings');
  });
  $('#setFullscreenBtn').addEventListener('click', () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) exitFullscreen();
    else enterFullscreen();
  });
  $('#setDownloadBtn').addEventListener('click', (e) => {
    if (!readerCtx) return toast('请先打开一本书再离线');
    startBookDownload(readerCtx.bookId, e.currentTarget);
  });
  $('#setCacheChapBtn').addEventListener('click', (e) => {
    if (!readerCtx) return toast('请先打开一本书再缓存');
    startBookDownload(readerCtx.bookId, e.currentTarget, [readerCtx.idx]);
  });
  $('#setTheme').addEventListener('change', (e) => {
    saveSettings({ theme: e.target.value });
    syncThemeBtn();
  });
  $('#setSize').addEventListener('input', (e) => {
    $('#sizeVal').textContent = e.target.value + 'px';
    saveSettings({ fontSize: Number(e.target.value) });
  });
  $('#setLine').addEventListener('input', (e) => saveSettings({ lineHeight: Number(e.target.value) / 100 }));
  $('#setWidth').addEventListener('input', (e) => saveSettings({ readerWidth: Number(e.target.value) }));
  $('#setFont').addEventListener('change', (e) => saveSettings({ fontFamily: e.target.value }));
  $('#setPage').addEventListener('change', (e) => {
    saveSettings({ pageMode: e.target.value });
    const names = { scroll: '滚动（下拉）', hpage: '左右翻页', vpage: '上下翻页' };
    toast('翻页方式：' + (names[e.target.value] || ''));
  });
  $('#setPrefetch').addEventListener('change', (e) => {
    const n = Number(e.target.value) || 0;
    saveSettings({ prefetchChapters: n });
    toast(n ? `已开启预加载（${n} 章）` : '已关闭预加载');
  });
  $('#setImmersive').addEventListener('change', (e) => {
    saveSettings({ readerImmersive: e.target.checked });
    applyChrome(!e.target.checked);
    if (e.target.checked) {
      if (settings.readerFullscreen) enterFullscreen();
      closeDrawer('settings');
    }
  });
  $('#setFullscreen').addEventListener('change', (e) => {
    saveSettings({ readerFullscreen: e.target.checked });
    if (e.target.checked) enterFullscreen();
  });
}

/* ---------- 听书面板 ---------- */

let listenPanel = null;
let sleepTimer = null;

/** 倍速显示：1 → “1×”，1.5 → “1.5×” */
function fmtRate(v) {
  const n = Number(v) || 1;
  return (Number.isInteger(n) ? n : n.toFixed(1)) + '×';
}

function buildListenPanel() {
  if ($('#listenPanel')) return listenPanel;
  const el = document.createElement('div');
  el.className = 'listen-panel';
  el.id = 'listenPanel';
  el.innerHTML = `
    <div class="listen-head">
      <div class="lp-head">
        <span class="lp-title" id="lpTitle">🎧 正在听书</span>
        <span class="lp-sub" id="lpSub">—</span>
      </div>
      <button class="icon-btn" id="lpClose" aria-label="关闭">✕</button>
    </div>
    <div class="listen-main">
      <div class="listen-chapters">
        <button type="button" id="lpPrevChap">⏮ 上一章</button>
        <button type="button" id="lpNextChap">下一章 ⏭</button>
      </div>
      <div class="listen-transport">
        <div class="tp"><button id="lpPrev" title="上一段">⏮</button><span>上一段</span></div>
        <div class="tp"><button class="play" id="lpPlay" title="播放/暂停">▶</button><span>播放 / 暂停</span></div>
        <div class="tp"><button id="lpNext" title="下一段">⏭</button><span>下一段</span></div>
      </div>
      <button type="button" class="listen-full listen-original" id="lpOriginal">📖 看原文（跳到当前朗读处）</button>
      <div class="listen-grid">
        <label class="listen-full">音色
          <select id="lpVoice"></select>
        </label>
        <label class="listen-full">朗读方式
          <select id="lpMode">
            <option value="auto">自动（推荐）</option>
            <option value="browser">浏览器语音</option>
            <option value="server">服务端语音</option>
          </select>
        </label>
        <label>语速 <input type="range" id="lpRate" min="100" max="400" step="25" value="${Math.round(settings.listenRate * 100)}" /> <b id="lpRateVal">${fmtRate(settings.listenRate)}</b></label>
        <div class="rate-chips" id="lpRateChips">
          ${[1, 1.5, 2, 3, 4].map((n) => `<button type="button" data-r="${n}" class="${Math.abs(Number(settings.listenRate) - n) < 0.01 ? 'on' : ''}">${n}×</button>`).join('')}
        </div>
        <label>音调 <input type="range" id="lpPitch" min="60" max="160" value="${Math.round(settings.listenPitch * 100)}" /></label>
        <label>音量 <input type="range" id="lpVol" min="0" max="100" value="${Math.round(settings.listenVolume * 100)}" /></label>
        <label>定时关闭
          <select id="lpSleep">
            <option value="0">不开启</option>
            <option value="15">15 分钟</option>
            <option value="30">30 分钟</option>
            <option value="60">60 分钟</option>
          </select>
        </label>
        <label class="listen-full"><input type="checkbox" id="lpAuto" ${settings.autoNext ? 'checked' : ''} /> 读完自动进入下一章</label>
      </div>
      <div class="voice-tips" id="voiceTips"></div>
      <div class="listen-note" id="voiceNote">正在检测可用音色…</div>
      <div class="listen-note"><button type="button" class="link-btn" id="recheckVoices">重新检测音色</button> · <span id="voiceStatus"></span></div>
    </div>`;
  document.body.append(el);
  listenPanel = el;

  $('#lpClose').addEventListener('click', closeListenPanel);
  $('#lpPlay').addEventListener('click', () => speaker.toggle());
  $('#lpPrev').addEventListener('click', () => speaker.prev());
  $('#lpNext').addEventListener('click', () => speaker.next());
  $('#lpPrevChap').addEventListener('click', () => listenGotoChapter(-1));
  $('#lpNextChap').addEventListener('click', () => listenGotoChapter(1));
  $('#lpRate').addEventListener('input', (e) => {
    const v = Number(e.target.value) / 100;
    saveSettings({ listenRate: v });
    const lab = $('#lpRateVal');
    if (lab) lab.textContent = fmtRate(v);
    $$('#lpRateChips button').forEach((b) => b.classList.toggle('on', Math.abs(Number(b.dataset.r) - v) < 0.01));
    speaker.setConfig({ rate: v });
  });
  $$('#lpRateChips button').forEach((b) =>
    b.addEventListener('click', () => {
      const v = Number(b.dataset.r) || 1;
      saveSettings({ listenRate: v });
      const rng = $('#lpRate');
      if (rng) rng.value = String(Math.round(v * 100));
      const lab = $('#lpRateVal');
      if (lab) lab.textContent = fmtRate(v);
      $$('#lpRateChips button').forEach((x) => x.classList.toggle('on', x === b));
      speaker.setConfig({ rate: v });
    }),
  );
  $('#lpPitch').addEventListener('input', (e) => {
    const v = Number(e.target.value) / 100;
    saveSettings({ listenPitch: v });
    speaker.setConfig({ pitch: v });
  });
  $('#lpVol').addEventListener('input', (e) => {
    const v = Number(e.target.value) / 100;
    saveSettings({ listenVolume: v });
    speaker.setConfig({ volume: v });
  });
  $('#lpVoice').addEventListener('change', (e) => {
    saveSettings({ voiceURI: e.target.value });
    speaker.setConfig({ voiceURI: e.target.value });
  });
  $('#lpMode').addEventListener('change', (e) => {
    speaker.setPreference(e.target.value);
    fillVoiceSelect();
    toast(
      e.target.value === 'server'
        ? '已切换为服务端语音（任何浏览器都能播放）'
        : e.target.value === 'browser'
          ? '已切换为浏览器语音'
          : '已启用自动选择：优先浏览器语音',
    );
  });
  $('#lpAuto').addEventListener('change', (e) => saveSettings({ autoNext: e.target.checked }));
  $('#lpOriginal').addEventListener('click', jumpToSpokenParagraph);
  $('#lpSleep').addEventListener('change', (e) => setSleep(Number(e.target.value)));
  $('#recheckVoices').addEventListener('click', () => {
    speaker.refreshVoices();
    fillVoiceSelect();
    if (speaker.mode === 'server') {
      toast('服务端语音已就绪');
      return;
    }
    toast(speaker.listVoices().length ? `已检测到 ${speaker.listVoices().length} 个音色` : '暂未检测到音色，将使用系统默认音色');
  });
  speaker.addEventListener('mode', () => fillVoiceSelect());
  speaker.addEventListener('voices', () => fillVoiceSelect());
  speaker.addEventListener('state', (e) => updateListenUI(e.detail));
  speaker.refreshVoices();
  fillVoiceSelect();
  loadVoiceTips();
  return el;
}

let voiceTipData = [];
async function loadVoiceTips() {
  const el = $('#voiceTips');
  if (!el) return;
  const r = await api.ttsVoices();
  voiceTipData = r.voices || [];
  el.innerHTML =
    `<span style="cursor:default;color:var(--text-faint)">推荐音色：</span>` +
    voiceTipData.map((v) => `<span title="${esc(v.note)}">${esc(v.name)}</span>`).join('');
}

function fillVoiceSelect() {
  const sel = $('#lpVoice');
  if (!sel) return;
  const status = $('#voiceStatus');
  const note = $('#voiceNote');
  const modeSel = $('#lpMode');
  const serverMode = speaker.mode === 'server';

  if (modeSel && modeSel.value !== speaker.preference) modeSel.value = speaker.preference;

  if (!speaker.supported) {
    sel.innerHTML = `<option value="">暂不可用</option>`;
    if (note) {
      note.innerHTML =
        '⚠️ 暂未检测到可用音色。请点下方「重新检测音色」；若仍不行，请稍后重试（服务端语音正在连接）。';
    }
    if (status) status.textContent = '';
    return;
  }

  const voices = speaker.listVoices();
  if (!voices.length) {
    sel.innerHTML = serverMode
      ? `<option value="">服务端默认音色</option>`
      : `<option value="">系统默认音色（可点下方重新检测）</option>`;
    if (note) {
      note.innerHTML = serverMode
        ? '当前使用<b>服务端语音</b>：由服务器合成后播放，微信 / QQ / 夸克等浏览器也能听。'
        : '音色来自你的设备 / 浏览器。手机上若列表为空，请点「重新检测」，或到系统「设置 → 语音 / 文字转语音」安装中文语音包。';
    }
    if (status) status.textContent = serverMode ? '使用服务端默认音色' : '未检测到音色列表，仍会尝试用系统默认音色朗读';
    return;
  }

  const pv = speaker.pickVoice();
  const saved = voices.some((v) => v.uri === settings.voiceURI) ? settings.voiceURI : '';
  const cur = saved || pv?.uri || pv?.voiceURI || '';
  sel.innerHTML = voices
    .map((v) => {
      const tag = v.server ? '服务端' : v.local ? '本机' : '在线';
      return `<option value="${esc(v.uri)}" ${v.uri === cur ? 'selected' : ''}>${esc(v.name)} · ${tag}</option>`;
    })
    .join('');
  if (saved !== settings.voiceURI && cur) saveSettings({ voiceURI: cur });

  if (note) {
    note.innerHTML = serverMode
      ? '当前使用<b>服务端语音</b>：由服务器合成后播放，微信 / QQ / 夸克等内置浏览器也能正常听书。'
      : '音色来自你的设备 / 浏览器；若没有声音，可切换到「服务端语音」。';
  }
  if (status) {
    status.textContent = serverMode
      ? `服务端语音已就绪（${voices.length} 个音色）`
      : `已检测到 ${voices.length} 个音色`;
  }
}

/** 听书标题用的章节标签：优先章节标题，其次按序号补「第 N 章」 */
function currentChapterLabel(np) {
  const ct = String(np?.chapterTitle || '').trim();
  if (ct) return ct;
  const i = Number(np?.idx);
  return Number.isFinite(i) ? `第 ${i + 1} 章` : '';
}

function updateListenUI(state) {
  if (!state) {
    state = { playing: speaker.playing, index: speaker.index, total: speaker.paragraphs.length, text: speaker.paragraphs[speaker.index] || '' };
  }
  const play = $('#lpPlay');
  if (play) play.textContent = state.playing ? '❚❚' : '▶';

  // 顶栏：主标题=章节名，副标题=「书名 · 第 N/M 段」
  const title = $('#lpTitle');
  if (title) title.textContent = nowPlaying ? currentChapterLabel(nowPlaying) || '🎧 正在听书' : '🎧 正在听书';
  const sub = $('#lpSub');
  if (sub) {
    const seg = state.total ? `第 ${state.index + 1} / ${state.total} 段` : '';
    sub.textContent = [nowPlaying?.bookTitle || '', seg].filter(Boolean).join(' · ') || '—';
  }

  // 章节切换按钮：没有上一/下一章时禁用
  const pc = $('#lpPrevChap');
  const nc = $('#lpNextChap');
  if (pc) pc.disabled = !nowPlaying?.prev;
  if (nc) nc.disabled = !nowPlaying?.next;
}

/** 听书面板切换章节：阅读器内则同步翻章并续播；否则后台直接切换并续播 */
function listenGotoChapter(delta) {
  const np = nowPlaying;
  if (!np) return;
  const target = delta < 0 ? np.prev : np.next;
  if (!target) {
    toast(delta < 0 ? '已是第一章' : '已是最后一章');
    return;
  }
  if (readerCtx && readerCtx.bookId === np.bookId && typeof readerCtx._gotoChapter === 'function') readerCtx._gotoChapter(delta);
  else playChapterInBackground(np.bookId, target);
}

function openListenPanel(autoHide = false) {
  buildListenPanel();
  // 打开面板本身是用户手势，部分手机浏览器此刻才会给出音色列表
  speaker.refreshVoices();
  fillVoiceSelect();
  listenPanel?.classList.add('open');
  updateMiniPlayer();
  if (autoHide) listenAutoHide();
}

function closeListenPanel() {
  listenPanel?.classList.remove('open');
  updateMiniPlayer();
}

/** 开始播放后自动收起听书面板（只在真正播放时收起），让出正文 */
function listenAutoHide(ms = 2400) {
  clearTimeout(listenAutoHideTimer);
  listenAutoHideTimer = setTimeout(() => {
    if (speaker.playing && !speaker.paused) closeListenPanel();
  }, ms);
}

/* ---------- 迷你播放条（后台听书）---------- */

function updateMiniPlayer() {
  updateMediaSession();
  const el = $('#miniPlayer');
  if (!el) return;
  const active = speaker.playing || speaker.paused;
  const panelOpen = !!$('#listenPanel')?.classList.contains('open');
  const show = active && !panelOpen;
  el.hidden = !show;

  // 迷你条是否占位（翻页模式据此让出底部空间）
  const wasMini = document.body.classList.contains('mini-on');
  document.body.classList.toggle('mini-on', show);
  if (wasMini !== show && readerCtx && isPaged()) {
    clearTimeout(readerCtx._relayoutTimer);
    readerCtx._relayoutTimer = setTimeout(() => layoutPagedReader({ keepPage: true }), 60);
  }

  if (!show) return;
  const play = $('#mpPlay');
  if (play) play.textContent = speaker.playing ? '❚❚' : '▶';
  const t = $('#mpTitle');
  const sub = $('#mpSub');
  // 主标题显示章节标题（听书时最关心「在听哪一章」），副标题补书名 + 当前句
  if (t) t.textContent = nowPlaying?.chapterTitle || nowPlaying?.bookTitle || '正在听书';
  const p = speaker.paragraphs[speaker.index] || '';
  const parts = [];
  if (nowPlaying?.chapterTitle && nowPlaying?.bookTitle) parts.push(nowPlaying.bookTitle);
  if (p) parts.push(p.slice(0, 22));
  if (sub) sub.textContent = parts.join(' · ') || '—';
}

function initMiniPlayer() {
  const el = $('#miniPlayer');
  if (!el) return;
  $('#mpPlay')?.addEventListener('click', () => speaker.toggle());
  const open = () => openListenPanel(false);
  $('#mpInfo')?.addEventListener('click', open);
  $('#mpOpen')?.addEventListener('click', open);
  $('#mpClose')?.addEventListener('click', () => {
    speaker.stop();
    toast('已停止听书');
    updateMiniPlayer();
  });
  speaker.addEventListener('state', () => updateMiniPlayer());

  // 锁屏 / 通知栏控制（支持的浏览器：Android Chrome、部分系统浏览器）
  if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    const h = (action, fn) => {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch {
        /* 该浏览器不支持这个动作，忽略 */
      }
    };
    h('play', () => speaker.play());
    h('pause', () => speaker.pause());
    h('previoustrack', () => speaker.prev());
    h('nexttrack', () => speaker.next());
    h('stop', () => speaker.stop());
  }
}

function updateMediaSession() {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try {
    if (nowPlaying && (speaker.playing || speaker.paused)) {
      if (typeof MediaMetadata !== 'undefined') {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: nowPlaying.chapterTitle || nowPlaying.bookTitle || '书声听书',
          artist: nowPlaying.bookTitle || '书声',
          album: '书声 · 听书',
        });
      }
      navigator.mediaSession.playbackState = speaker.playing ? 'playing' : 'paused';
    }
  } catch {
    /* ignore */
  }
}

/* ---------- 跨章连播（阅读页内 / 后台都可用）---------- */

async function playChapterInBackground(bookId, idx) {
  try {
    const data = await api.chapter(bookId, idx);
    if (!data || data.ok === false || !Array.isArray(data.paragraphs)) {
      toast('下一章加载失败，已停止听书');
      speaker.stop();
      return;
    }
    const b = data.book || {};
    nowPlaying = {
      bookId: Number(bookId),
      bookTitle: b.title || nowPlaying?.bookTitle || '',
      idx: Number(data.idx) || Number(idx),
      total: data.total || 0,
      prev: data.prev,
      next: data.next,
      chapterTitle: data.title || '',
    };
    speaker.setContent(data.paragraphs, 0);
    speaker.setConfig({
      rate: settings.listenRate,
      pitch: settings.listenPitch,
      volume: settings.listenVolume,
      voiceURI: settings.voiceURI,
      autoNext: settings.autoNext,
    });
    speaker.play();
    updateMiniPlayer();
    api.recordHistory(nowPlaying.bookId, nowPlaying.idx);
    const n = Math.max(0, Math.min(10, Number(settings.prefetchChapters) || 0));
    if (n > 0 && data.next) api.prefetchChapters(nowPlaying.bookId, nowPlaying.idx, n);
  } catch (e) {
    toast('下一章加载失败：' + (e?.message || e));
    speaker.stop();
  }
}

async function onChapterEnd() {
  if (!settings.autoNext) return;
  const st = nowPlaying;
  if (!st) return;
  if (!st.next) {
    toast('已到最后一章，听书结束');
    return;
  }
  toast('继续播放下一章');
  if (readerCtx && readerCtx.bookId === st.bookId) {
    // 停留在阅读页：正常切章（带 listen=1 自动续播）
    navigate(`#/read/${st.bookId}/${st.next}?listen=1`);
    return;
  }
  // 已离开阅读页：后台取下一章继续播放，不改变当前界面
  await playChapterInBackground(st.bookId, st.next);
}

function setSleep(minutes) {
  clearTimeout(sleepTimer);
  if (!minutes) return toast('已取消定时关闭');
  toast(`${minutes} 分钟后自动停止`);
  sleepTimer = setTimeout(() => {
    speaker.stop();
    toast('定时已到，已停止朗读');
  }, minutes * 60000);
}

function closeLookups() {
  closeListenPanel();
  [...drawers].forEach((d) => closeDrawer(d.id));
}

/* ============================ 书架 / 记录 ============================ */

let shelfCache = null;

async function viewShelf() {
  clearInterval(heroTimer);
  setNav('shelf');
  if (shelfCache) {
    // 已经看过：先秒开旧内容，再后台静默刷新
    paintShelf(shelfCache);
    api.shelf().then((r) => { if (r && Array.isArray(r.books)) { shelfCache = r; paintShelf(r); } }).catch(() => {});
    return;
  }
  main.innerHTML = spinner('整理书架');
  const r = await api.shelf();
  if (!Array.isArray(r.books)) return (main.innerHTML = emptyBox('书架加载失败，请稍后重试'));
  shelfCache = r;
  paintShelf(r);
}

function paintShelf(r) {
  if (!r.books.length) return (main.innerHTML = emptyBox('书架还是空的，去首页逛逛吧'));
  main.innerHTML = `
    <section class="section" style="margin-top:6px">
      <div class="section-head"><h2 class="section-title">我的书架</h2><span class="section-sub">${r.books.length} 本</span></div>
      <div class="grid">${r.books.map(bookCard).join('')}</div>
    </section>`;
}

async function viewHistory() {
  clearInterval(heroTimer);
  setNav('history');
  main.innerHTML = spinner('读取记录');
  const r = await api.history();
  if (!r.items.length) return (main.innerHTML = emptyBox('还没有阅读记录'));
  const items = r.items
    .map((b) => {
      const pct = b.chapterCount ? Math.min(100, Math.round((b.progress / b.chapterCount) * 100)) : 0;
      return `
      <div class="list-row">
        <div class="list-cover">${coverImg(b)}</div>
        <div class="list-body">
          <div class="list-title">${esc(b.title)}</div>
          <div class="list-meta">读到 ${esc(b.chapterTitle || '第 ' + b.progress + ' 章')} · ${esc(b.category)} · ${esc(b.readAt || '')}</div>
          <div class="list-progress"><i style="width:${pct}%"></i></div>
        </div>
        <div class="list-actions">
          <a class="btn primary" href="#/read/${b.id}/${b.progress}">继续</a>
          <button class="btn ghost" data-del="${b.id}">移除</button>
        </div>
      </div>`;
    })
    .join('');
  main.innerHTML = `
    <section class="section" style="margin-top:6px">
      <div class="section-head"><h2 class="section-title">阅读记录</h2>
        <span class="spacer"></span>
        <button class="btn ghost" id="clearHis">清空记录</button>
      </div>
      <div class="list">${items}</div>
    </section>`;
  $$('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api.removeHistory(b.dataset.del);
      viewHistory();
    }),
  );
  $('#clearHis').addEventListener('click', async () => {
    await api.clearHistory();
    viewHistory();
  });
}

/* ============================ 抓取状态 ============================ */

async function viewAdmin() {
  clearInterval(heroTimer);
  setNav('');
  main.innerHTML = spinner('读取状态');
  const r = await api.syncStatus();
  if (Array.isArray(r.sources)) rememberSources(r.sources);
  const s = r.stats || {};
  const sc = r.schedule || {};
  const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '—');
  const pad = (n) => String(n ?? 0).padStart(2, '0');
  main.innerHTML = `
    <section class="section" style="margin-top:6px">
      <div class="section-head"><h2 class="section-title">书库与抓取</h2></div>
      <div class="stat-cards">
        <div class="stat-card"><div class="n">${s.books || 0}</div><div class="l">书籍总数</div></div>
        <div class="stat-card"><div class="n">${s.chapters || 0}</div><div class="l">章节总数</div></div>
        <div class="stat-card"><div class="n">${s.cached || 0}</div><div class="l">已缓存正文</div></div>
        <div class="stat-card"><div class="n">${(r.sources || []).length}</div><div class="l">书源</div></div>
      </div>

      <div class="section-head" style="margin-top:26px"><h2 class="section-title">自动更新</h2></div>
      <div class="notice">
        ${
          sc.enabled
            ? `已开启：每天 <b>${pad(sc.hour)}:${pad(sc.minute)}</b> 自动抓取已有小说更新并扩充书库。
               下次执行：<b>${esc(fmtTime(sc.nextRun))}</b>${sc.lastRun ? ` · 上次：${esc(fmtTime(sc.lastRun))}` : ''}`
            : `每日自动更新已关闭（设置环境变量 <b>AUTO_UPDATE=0</b> 可关闭，<b>UPDATE_HOUR</b> 可改时间）。`
        }
        当前待检查更新的书籍：<b>${r.pendingUpdate || 0}</b> 本。
      </div>

      <div class="section-head" style="margin-top:26px"><h2 class="section-title">内容合规</h2></div>
      <div class="notice">
        ${
          r.contentFilter?.enabled
            ? `已开启：抓取时自动拦截、并定期清理<b>违法涉黄 / 低俗色情</b>作品（书名 / 作者 / 简介命中过滤词）。
               你也可在书籍详情页手动「删除本书」兜底。`
            : `内容合规过滤已关闭（CONTENT_FILTER=0）。`
        }
      </div>

      <div class="chips" style="margin-top:16px">
        <button class="btn primary" id="dailyRun">立即执行每日维护</button>
        <button class="btn" id="purgePreview">预览违规作品</button>
        <button class="btn danger" id="purgeRun">清理违规作品</button>
        <button class="btn" id="syncCat">同步各分类人气榜</button>
        <button class="btn" id="syncUpdate">同步最近更新</button>
        <button class="btn" id="syncDeep" title="遍历全部分类 × 全部榜单（每榜 10 页），约 8000+ 本">🚀 全量抓取（抓满书源）</button>
        <button class="btn" id="syncUltra" title="广度优先：全部分类 × 全部榜单 × 6 档字数 × 3 种状态，深挖长尾（数万本，可随时停止）">🌊 深度抓取（数量拉满）</button>
        <button class="btn" id="rebuildTags" title="按当前题材词表重新扫描全库书名/简介，刷新「题材」标签">🏷 重算题材标签</button>
      </div>
      <div id="syncProgress" class="notice" style="display:none;margin-top:12px"></div>
      <div class="section-head" style="margin-top:26px"><h2 class="section-title">最近抓取日志</h2></div>
      <table class="log-table">
        <thead><tr><th>时间</th><th>类型</th><th>详情</th><th>结果</th><th>数量</th></tr></thead>
        <tbody>
          ${(r.logs || [])
            .map(
              (l) => `<tr><td>${esc(l.created_at)}</td><td>${esc(l.kind)}</td><td>${esc(l.detail)}</td>
            <td><span class="pill ${l.ok ? 'ok' : 'bad'}">${l.ok ? '成功' : '失败'}</span></td><td>${l.count}</td></tr>`,
            )
            .join('') || '<tr><td colspan="5" style="color:var(--text-faint)">暂无日志</td></tr>'}
        </tbody>
      </table>
    </section>`;
  $('#dailyRun').addEventListener('click', (e) => doDaily(e.target));
  $('#purgePreview').addEventListener('click', (e) => doPurge(e.target, true));
  $('#purgeRun').addEventListener('click', (e) => doPurge(e.target, false));
  $('#syncCat').addEventListener('click', (e) => doSync(e.target, { full: true, pages: 2 }));
  $('#syncUpdate').addEventListener('click', (e) => doSync(e.target, { sort: 'lastupdate', pages: 1 }));
  $('#syncDeep').addEventListener('click', () => doDeepSync(false));
  $('#syncUltra').addEventListener('click', () => doDeepSync(true));
  $('#rebuildTags').addEventListener('click', (e) => doRebuildTags(e.target));

  // 若已有全量任务在跑，自动展示进度
  if (r.sync?.running) showSyncProgress(r.sync);
}

/** 全量/深度抓取：后台执行，轮询进度，可随时停止 */
async function doDeepSync(ultra) {
  const msg = ultra
    ? '深度抓取会遍历“全部分类 × 全部榜单 × 字数段 × 状态”（广度优先，约 1500 次请求），可深挖数万本、耗时较久。期间书库持续增长，可随时停止。现在开始？'
    : '全量抓取会遍历全部分类与榜单（约 600 次请求、耗时数分钟），期间书库会持续增长。现在开始？';
  if (!confirm(msg)) return;
  const r = await api.sync(ultra ? { ultra: true } : { deep: true, pages: 10 });
  if (!r.ok) return toast(r.error || '启动失败，请稍后重试');
  showSyncProgress(r.sync);
  toast(ultra ? '已开始深度抓取，可继续浏览，书库会持续增长' : '已开始全量抓取，可继续浏览');
}

/** 轮询并展示抓取进度（带“停止”按钮） */
function showSyncProgress(initial) {
  const box = $('#syncProgress');
  if (!box) return;
  box.style.display = '';
  const render = (st) => {
    const done = st.done || 0;
    const total = st.total || 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const mode = st.mode === 'ultra' ? '深度抓取' : '全量抓取';
    box.innerHTML = st.running
      ? `⏳ 正在${st.mode === 'ultra' ? '深度' : '全量'}抓取：<b>${done}/${total || '…'}</b>（${pct}%）— 已完成 ${st.count || 0} 条
         <button class="btn danger" id="syncStop" style="margin-left:10px">停止抓取</button>`
      : st.error
        ? `❌ 抓取失败：${esc(st.error)}`
        : `✅ 抓取完成：共处理 <b>${st.count || 0}</b> 条记录（${done}/${total}）。`;
    const stop = document.getElementById('syncStop');
    if (stop) stop.onclick = async () => {
      stop.disabled = true;
      const rr = await api.syncCancel();
      if (rr.ok) toast('正在停止…');
    };
  };
  render(initial || { running: true });
  clearInterval(heroTimer);
  heroTimer = setInterval(async () => {
    const s = await api.syncStatus();
    const st = s.sync || {};
    render(st);
    if (!st.running) {
      clearInterval(heroTimer);
      toast(`抓取结束，共处理 ${st.count || 0} 条记录`);
      setTimeout(() => {
        if (location.hash.replace(/^#\/?/, '').startsWith('admin')) viewAdmin();
      }, 1200);
    }
  }, 2500);
}

async function doRebuildTags(btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> 处理中…';
  const r = await api.rebuildTags();
  btn.textContent = old;
  btn.disabled = false;
  if (!r.ok) return toast('操作失败，请稍后重试');
  toast(`已重算 ${r.books} 本书的题材，共 ${Object.keys(r.tags || {}).length} 类`);
}

async function doPurge(btn, dryRun) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> 处理中…';
  const r = await api.purge(dryRun);
  btn.textContent = old;
  btn.disabled = false;
  if (!r.ok) return toast('操作失败，请稍后重试');
  if (dryRun) {
    if (!r.matched) return toast('未发现明显的违规作品 🎉');
    const names = (r.items || []).slice(0, 8).map((x) => `${x.title}（${(x.terms || []).join('、')}）`).join('；');
    toast(`预览：命中 ${r.matched} 本：${names}${r.matched > 8 ? ' 等' : ''}`);
  } else {
    toast(r.removed ? `已清理 ${r.removed} 本违规作品` : '未发现明显的违规作品 🎉');
    viewAdmin();
  }
}

async function doDaily(btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> 维护中…（抓取需一些时间）';
  const r = await api.daily();
  btn.textContent = old;
  btn.disabled = false;
  if (r.ok) {
    toast(`维护完成：扩充 +${r.expand?.total ?? 0} 本，更新 ${r.refresh?.updated ?? 0} 本`);
  } else if (r.error) {
    toast('维护失败：' + r.error);
  } else {
    toast('维护完成（部分源站不可达）');
  }
  viewAdmin();
}

async function doSync(btn, body) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> 抓取中…';
  const r = await api.sync(body);
  btn.textContent = old;
  btn.disabled = false;
  toast(r.ok ? `同步完成，共 ${r.count ?? r.total ?? 0} 条` : '同步失败，请稍后重试');
  viewAdmin();
}

/* ============================ 账号：登录 / 我的 ============================ */

async function viewLogin() {
  clearInterval(heroTimer);
  setNav('login');
  document.body.classList.remove('reading');
  if (me) return viewAccount();

  let mode = 'login';

  const render = () => {
    main.innerHTML = `
      <section class="section auth-wrap" style="margin-top:6px">
        <div class="auth-card">
          <div class="auth-tabs">
            <button type="button" data-mode="login" class="${mode === 'login' ? 'active' : ''}">登录</button>
            <button type="button" data-mode="register" class="${mode === 'register' ? 'active' : ''}">注册</button>
          </div>
          <h2 class="auth-title">${mode === 'login' ? '欢迎回来' : '创建账号'}</h2>
          <p class="auth-note">登录后，书架与阅读记录会保存到你的账号，换设备也不丢。</p>
          <form class="auth-form" id="authForm">
            <label>用户名<input name="username" autocomplete="username" placeholder="2-20 位：中文 / 字母 / 数字" required /></label>
            ${mode === 'register' ? '<label>昵称（可选）<input name="name" autocomplete="nickname" placeholder="展示用昵称" /></label>' : ''}
            <label>密码<input type="password" name="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" placeholder="至少 6 位" required /></label>
            <button class="btn primary block" type="submit">${mode === 'login' ? '登录' : '注册并登录'}</button>
            <p class="auth-error" id="authError"></p>
          </form>
          <p class="auth-foot">离线下载按设备保存；登录后在「离线」页统一管理。</p>
        </div>
      </section>`;

    $$('.auth-tabs [data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        mode = b.dataset.mode;
        render();
      }),
    );

    $('#authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const btn = f.querySelector('button[type=submit]');
      const username = f.username.value.trim();
      const password = f.password.value;
      const name = f.name ? f.name.value.trim() : '';
      const err = $('#authError');
      err.textContent = '';
      if (!username || !password) {
        err.textContent = '请输入用户名和密码';
        return;
      }
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = '请稍候…';
      const r = mode === 'login' ? await api.login(username, password) : await api.register(username, password, name);
      btn.disabled = false;
      btn.textContent = old;
      if (!r.ok) {
        err.textContent = r.error || '操作失败，请重试';
        return;
      }
      me = r.user;
      updateUserButton();
      toast(mode === 'login' ? '登录成功' : '注册成功');
      navigate('#/shelf');
    });
  };

  render();
}

async function viewAccount() {
  clearInterval(heroTimer);
  setNav('account');
  document.body.classList.remove('reading');
  await loadMe();

  main.innerHTML = spinner('读取账号');
  const [r, dls] = await Promise.all([me ? api.me() : Promise.resolve(null), safeListDownloads()]);
  const stats = (r && r.stats) || { shelf: 0, history: 0 };
  const dlBytes = dls.reduce((s, d) => s + (d.bytes || 0), 0);

  const profile = me
    ? `
      <div class="account-card">
        <div class="account-avatar">${esc((me.name || me.username || '书').slice(0, 1))}</div>
        <div class="account-main">
          <div class="account-name">${esc(me.name || me.username)}</div>
          <div class="account-sub">@${esc(me.username)}</div>
        </div>
      </div>
      <div class="stat-row">
        <a class="stat-cell" href="#/shelf"><b>${stats.shelf}</b><span>书架收藏</span></a>
        <a class="stat-cell" href="#/history"><b>${stats.history}</b><span>阅读记录</span></a>
        <a class="stat-cell" href="#/downloads"><b>${formatBytes(dlBytes)}</b><span>离线缓存</span></a>
      </div>`
    : `<div class="account-card">
        <div class="account-avatar">书</div>
        <div class="account-main">
          <div class="account-name">未登录</div>
          <div class="account-sub">登录后书架与阅读记录会同步到账号</div>
        </div>
       </div>
       <div style="margin-top:14px"><a class="btn primary block" href="#/login">登录 / 注册</a></div>`;

  const links = [
    ['#/history', '🕘', '阅读记录'],
    ['#/downloads', '📥', '离线下载'],
    ['#/tags', '🏷️', '题材标签'],
    ['#/rank', '🏆', '排行榜'],
    ['#/share', '📱', '手机扫码访问'],
    ['#/admin', '🛠️', '抓取与书库状态'],
  ];

  main.innerHTML = `
    <section class="section" style="margin-top:6px">${profile}</section>
    <section class="section">
      <div class="app-links">
        ${links
          .map(
            ([href, ico, label]) =>
              `<a class="app-link" href="${href}"><span class="app-link-ico">${ico}</span><span class="app-link-label">${label}</span><span class="app-link-arrow">›</span></a>`,
          )
          .join('')}
      </div>
    </section>
    ${me ? '<section class="section"><button class="btn danger block" id="logoutBtn">退出登录</button></section>' : ''}
    <section class="section">
      <div class="section-head"><h2 class="section-title">阅读主题</h2><span class="section-sub">护眼 / 夜间</span></div>
      <div class="theme-row" id="themeRow">
        ${THEMES.map((t) => `<button class="theme-chip ${settings.theme === t.id ? 'active' : ''}" data-theme-id="${t.id}">${esc(t.name)}</button>`).join('')}
      </div>
    </section>`;

  $('#logoutBtn')?.addEventListener('click', async () => {
    await api.logout();
    me = null;
    updateUserButton();
    toast('已退出登录');
    navigate('#/');
  });
  $$('#themeRow [data-theme-id]').forEach((b) =>
    b.addEventListener('click', () => {
      saveSettings({ theme: b.dataset.themeId });
      $$('#themeRow .theme-chip').forEach((x) => x.classList.toggle('active', x.dataset.themeId === b.dataset.themeId));
      toast('主题：' + (THEMES.find((t) => t.id === b.dataset.themeId)?.name || ''));
    }),
  );
}

/* ============================ 离线下载 ============================ */

const activeDownloads = new Map();

async function safeListDownloads() {
  try {
    return downloadSupported() ? await listDownloads() : [];
  } catch {
    return [];
  }
}

async function startBookDownload(bookId, btn, indexes = null) {
  if (!downloadSupported()) {
    toast('离线下载需在 HTTPS 或外网隧道地址下使用');
    return;
  }
  const id = Number(bookId);
  if (activeDownloads.has(id)) {
    toast('这本书正在缓存中…');
    return;
  }
  activeDownloads.set(id, true);
  const old = btn ? btn.textContent : '';
  if (btn) btn.disabled = true;
  try {
    const meta = indexes
      ? await downloadChapters(id, indexes, {
          onProgress: (done, total) => {
            if (btn) btn.textContent = total ? `缓存中 ${Math.round((done / total) * 100)}%` : '缓存中…';
          },
        })
      : await downloadBook(id, {
          onProgress: (done, total) => {
            if (btn) btn.textContent = total ? `缓存中 ${Math.round((done / total) * 100)}%` : '缓存中…';
          },
        });
    toast(`《${meta.title}》已离线保存（${meta.total} 章）`);
    if (btn) btn.textContent = '✓ 已离线';
  } catch (err) {
    if (err?.name === 'AbortError') toast('已取消下载');
    else toast('下载失败：' + (err?.message || err));
    if (btn) btn.textContent = old;
  } finally {
    activeDownloads.delete(id);
    if (btn) btn.disabled = false;
  }
}

async function viewDownloads() {
  clearInterval(heroTimer);
  setNav('downloads');
  document.body.classList.remove('reading');

  if (!downloadSupported()) {
    main.innerHTML = `
      <section class="section" style="margin-top:6px">
        <div class="section-head"><h2 class="section-title">离线下载</h2></div>
        <div class="empty"><div class="big">📥</div>离线下载需要安全环境（HTTPS 或 localhost）。<br/>请用外网隧道地址在手机浏览器打开后再下载。</div>
        <div style="text-align:center;margin-top:14px"><a class="btn primary" href="#/share">获取外网 / 扫码地址</a></div>
      </section>`;
    return;
  }

  main.innerHTML = spinner('读取离线缓存');
  const list = await safeListDownloads();

  const cards = list.length
    ? list
        .map(
          (d) => `
      <div class="dl-card">
        <a class="dl-cover" href="#/read/${d.bookId}/1">${coverImg({ cover: d.cover, title: d.title })}</a>
        <div class="dl-info">
          <a class="dl-title" href="#/read/${d.bookId}/1">${esc(d.title)}</a>
          <div class="dl-meta">${esc(d.author || '佚名')} · ${d.partial ? '部分章节' : '全本'} · ${formatBytes(d.bytes || 0)}</div>
          <div class="dl-actions">
            <a class="btn primary" href="#/read/${d.bookId}/1">阅读</a>
            <a class="btn" href="#/read/${d.bookId}/1?listen=1">🎧 听书</a>
            <button class="btn danger" data-remove="${d.bookId}">删除</button>
          </div>
        </div>
      </div>`,
        )
        .join('')
    : `<div class="empty"><div class="big">📚</div>还没有离线内容。<br/>打开任意小说，点「⬇ 离线下载」即可缓存整本，断网也能看、能听。</div>`;

  main.innerHTML = `
    <section class="section" style="margin-top:6px">
      <div class="section-head">
        <h2 class="section-title">离线下载</h2>
        <span class="section-sub">缓存在本机浏览器，断网可读可听</span>
      </div>
      <p class="share-note">离线内容按设备保存，不占账号空间；断网听书请选择系统「本地音色」。</p>
      <div class="dl-list">${cards}</div>
    </section>`;

  $$('[data-remove]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('删除该书离线缓存？')) return;
      await removeDownload(b.dataset.remove);
      toast('已删除离线缓存');
      viewDownloads();
    }),
  );
}

/* ============================ 路由 ============================ */

function emptyBox(msg) {
  return `<div class="empty"><div class="big">📖</div>${esc(msg)}</div>`;
}

function pager(page, pages, kind) {
  if (pages <= 1) return '';
  const nums = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - page) <= 2) nums.push(i);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  return `<div class="chapter-pager" data-pager="${kind}">${nums
    .map((n) => (n === '…' ? `<span style="color:var(--text-faint)">…</span>` : `<button data-page="${n}" class="${n === page ? 'active' : ''}">${n}</button>`))
    .join('')}</div>`;
}
function bindPager(cb) {
  $$('[data-page]').forEach((b) => b.addEventListener('click', () => cb(Number(b.dataset.page))));
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  const { parts, query } = parseHash();
  const isReader = parts[0] === 'read';
  if (!isReader) cleanupReader();
  document.body.classList.toggle('reading', isReader);
  window.scrollTo(0, 0);

  try {
    switch (parts[0]) {
      case undefined:
      case '':
        return await viewHome();
      case 'category':
        return await viewCategory(parts, query);
      case 'tag':
        return await viewTag(parts, query);
      case 'tags':
        return await viewTags();
      case 'rank':
        return await viewRank();
      case 'search':
        return await viewSearch(query);
      case 'book':
        return await viewBook(parts[1]);
      case 'read':
        return await viewReader(parts[1], parts[2], query);
      case 'shelf':
        return await viewShelf();
      case 'history':
        return await viewHistory();
      case 'downloads':
        return await viewDownloads();
      case 'login':
        return await viewLogin();
      case 'account':
        return await viewAccount();
      case 'admin':
        return await viewAdmin();
      case 'share':
        return await viewShare();
      default:
        return (main.innerHTML = emptyBox('页面不存在'));
    }
  } catch (err) {
    console.error(err);
    main.innerHTML = emptyBox('出错了：' + (err?.message || err));
  }
}

/* ============================ 扫码 / 分享 ============================ */

function qrImg(url, scale = 6) {
  return `<img class="qr" loading="lazy" alt="二维码" src="/api/qr.svg?scale=${scale}&text=${encodeURIComponent(url)}" />`;
}

async function viewShare() {
  clearInterval(heroTimer);
  setNav('share');
  main.innerHTML = spinner('获取访问地址');
  let info;
  try {
    info = await api.share();
  } catch (e) {
    main.innerHTML = emptyBox('获取失败：' + (e?.message || e));
    return;
  }

  const statusText =
    {
      online: '在线',
      starting: '正在建立…',
      idle: '未启动',
      disabled: '已关闭',
      error: '失败',
      stopped: '已停止',
    }[info.status] || info.status;

  const shareUrl = info.access?.url || info.url;

  const publicCard = info.url
    ? `
      <div class="share-card">
        <div class="share-qr">${qrImg(shareUrl, 6)}</div>
        <div class="share-info">
          <div class="share-label">外网访问 · 手机任意网络（${info.stable ? '固定网址' : '临时网址'}）</div>
          <a class="share-url" href="${esc(shareUrl)}" target="_blank" rel="noreferrer">${esc(shareUrl)}</a>
          ${
            info.access
              ? `<p class="share-note">🔒 已启用访问口令。上面的二维码/链接已内置口令，手机扫码可直接进入，无需再输密码；<b>请勿把该链接发给别人</b>（等同密码）。进站后在浏览器菜单里「添加到主屏幕」即可当 App 用。</p>`
              : ''
          }
          <div class="share-actions">
            <button class="btn ghost" id="copyPublic" data-copy="${esc(shareUrl)}">复制网址</button>
            <button class="btn ghost" id="restartShare">重建隧道</button>
          </div>
          ${info.stable ? '' : '<p class="share-note">⚠️ 临时隧道每次重启网址都会变；想让重启后网址/二维码不变，见下方「固定网址」。</p>'}
        </div>
      </div>`
    : `
      <div class="share-card">
        <div class="share-info" style="flex:1">
          <div class="share-label">外网访问</div>
          <p class="share-note">${
            info.enabled
              ? `状态：${esc(statusText)}${info.error ? '（' + esc(info.error) + '）' : ''}`
              : '已在启动时关闭（SHARE=0）；也可用 <code>npm run share</code> 单独开启。'
          }</p>
          <div class="share-actions"><button class="btn" id="restartShare">建立外网隧道</button></div>
          ${
            info.lastUrl && info.lastUrl !== info.url
              ? `<p class="share-note">上次地址（重启后可能已失效）：<a href="${esc(info.lastUrl)}" target="_blank" rel="noreferrer">${esc(info.lastUrl)}</a></p>`
              : ''
          }
        </div>
      </div>`;

  const lanCards = (info.lan || [])
    .map(
      (ip) => `
      <div class="share-card">
        <div class="share-qr">${qrImg(`http://${ip}:${info.port}`, 5)}</div>
        <div class="share-info">
          <div class="share-label">局域网 · 需连同一 Wi-Fi</div>
          <a class="share-url" href="http://${esc(ip)}:${info.port}" target="_blank" rel="noreferrer">http://${esc(ip)}:${info.port}</a>
        </div>
      </div>`,
    )
    .join('');

  main.innerHTML = `
    <section class="section" style="margin-top:6px">
      <div class="section-head"><h2 class="section-title">手机扫码访问</h2><span class="section-sub">用手机相机/浏览器扫码即可</span></div>
      <p class="share-note">外网地址在手机任何网络（含 4G/5G）都能打开；局域网地址需手机与电脑在同一 Wi-Fi。站内已支持「添加到主屏幕」，装到桌面后体验像 App。</p>
    </section>
    <section class="section">${publicCard}</section>
    ${
      (info.lan || []).length
        ? `<section class="section"><div class="section-head"><h2 class="section-title">局域网地址</h2></div>${lanCards}</section>`
        : ''
    }
    <section class="section">
      <div class="section-head"><h2 class="section-title">固定网址（重启不变）</h2></div>
      <div class="share-info">
        <ul class="share-list">
          <li><b>ngrok 固定域名</b>：注册 ngrok 后设置环境变量 <code>NGROK_AUTHTOKEN=令牌</code> 与 <code>SHARE_DOMAIN=你的固定域名</code> 再启动。</li>
          <li><b>自建 / 命名隧道</b>：已有隧道时设置 <code>SHARE_URL=https://你的域名</code>，服务只做展示（不重复拉起隧道）。</li>
          <li><b>Tailscale Funnel</b>：设置 <code>SHARE_PROVIDER=tailscale</code>，网址固定为 <code>https://节点名.xxx.ts.net</code>。</li>
        </ul>
        <p class="share-note">以上都免费；配置一次后，每次启动网址与二维码都不变。详见 README「手机访问与部署」。</p>
      </div>
    </section>`;

  $('#restartShare')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = '重建中…';
    await api.shareRestart();
    toast('已重新建立隧道');
    viewShare();
  });
  $('#copyPublic')?.addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(e.target.dataset.copy || '');
      toast('网址已复制');
    } catch {
      toast('复制失败，请长按网址手动复制');
    }
  });
}

/* ============================ 初始化 ============================ */

$('#searchbar').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = e.target.q.value.trim();
  if (q) navigate(`#/search?q=${encodeURIComponent(q)}`);
});

$('#themeToggle').addEventListener('click', () => {
  const order = ['ink', 'paper', 'green', 'night'];
  const next = order[(order.indexOf(settings.theme) + 1) % order.length];
  saveSettings({ theme: next });
  toast('主题：' + (THEMES.find((t) => t.id === next)?.name || next));
});

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', () => speaker.stop());
initMiniPlayer();
speaker.addEventListener('chapter-end', onChapterEnd);
loadMe().finally(() => route());
