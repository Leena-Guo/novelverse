const KEY = 'nv-settings';
const SETTINGS_VERSION = 2;

const DEFAULTS = {
  _v: SETTINGS_VERSION,
  theme: 'ink',
  fontSize: 19,
  lineHeight: 1.95,
  fontFamily: 'serif',
  readerWidth: 720,
  listenRate: 1,
  listenPitch: 1,
  listenVolume: 1,
  voiceURI: '',
  autoNext: true,
  sleepMinutes: 0,
  readerImmersive: true,
  readerFullscreen: false,
  prefetchChapters: 3,
  // 阅读翻页方式：scroll=滚动（下拉），hpage=左右翻页，vpage=上下翻页
  pageMode: 'scroll',
};

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY)) || {};
    if ((raw._v || 1) < SETTINGS_VERSION) {
      // v2：阅读页改为「轻点正文弹出底部操作面板」，默认进入时不显示工具条
      raw.readerImmersive = true;
      raw._v = SETTINGS_VERSION;
      localStorage.setItem(KEY, JSON.stringify({ ...DEFAULTS, ...raw }));
    }
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings = read();

export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  localStorage.setItem(KEY, JSON.stringify(settings));
  applySettings();
  document.dispatchEvent(new CustomEvent('settings-changed', { detail: settings }));
}

export function applySettings() {
  const html = document.documentElement;
  html.dataset.theme = settings.theme === 'night' ? 'ink' : settings.theme;
  html.dataset.pageMode = settings.pageMode || 'scroll';

  const root = document.documentElement.style;
  root.setProperty('--reader-size', settings.fontSize + 'px');
  root.setProperty('--reader-line', String(settings.lineHeight));
  root.setProperty('--reader-width', settings.readerWidth + 'px');
  root.setProperty('--reader-font', settings.fontFamily === 'serif' ? 'var(--font-serif)' : 'var(--font-sans)');

  // 阅读主题（= 全局主题，保证沉浸一致）
  const map = { ink: ['#0f1117', '#0f1117'], night: ['#0a0a0c', '#0a0a0c'], paper: ['#f4f1ea', '#f4f1ea'], green: ['#0e1a14', '#0e1a14'] };
  const [bg, text] = map[settings.theme] || map.ink;
  root.setProperty('--reader-bg', bg);
  root.setProperty('--reader-text', settings.theme === 'paper' ? '#23252b' : '#e8ebf2');
}

applySettings();

export const THEMES = [
  { id: 'ink', name: '墨夜' },
  { id: 'paper', name: '纸张' },
  { id: 'green', name: '护眼' },
  { id: 'night', name: '纯黑' },
];
