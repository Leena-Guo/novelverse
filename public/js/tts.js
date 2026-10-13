/**
 * 听书控制器：支持两种引擎，自动选择。
 *
 *  - 浏览器模式（browser）：Web Speech API（speechSynthesis）
 *  - 服务端模式（server） ：请求 /api/tts/speak 合成 mp3，用 <audio> 播放
 *
 * 微信 / QQ / 夸克 等 App 内置浏览器没有 Web Speech API，
 * 会自动回退到服务端模式，手机也能正常听书。
 *
 * 统一能力：逐段朗读、段落高亮、上一段/下一段、跨章连播、语速/音调/音量/音色调节。
 */
const clamp = (v, a, b) => Math.min(b, Math.max(a, Number(v) || 0));
const MODE_KEY = 'nv-tts-mode';

// 服务端模式：向后预取/预合成的段数。服务端按段串行合成约 0.5~1.3s，
// 靠「提前 4 段」把合成排到播放前面，录音之间不再干等。
const PREFETCH_AHEAD = 4;
// 单段合成失败（上游偶发 503、网络抖动）在客户端的重试次数
const TTS_FETCH_TRIES = 3;

export class Speaker extends EventTarget {
  constructor() {
    super();
    this.paragraphs = [];
    this.index = 0;
    this.playing = false;
    this.paused = false;
    this.autoNext = true;
    this.rate = 1;
    this.pitch = 1;
    this.volume = 1;
    this.voiceURI = '';

    // 浏览器引擎状态
    this._utt = null;
    this._keepAlive = null;
    this._voices = [];
    this._seq = 0;
    this._unlocked = false;
    this._voicePoll = null;

    // 服务端引擎状态
    this._serverChecked = false;
    this._serverOk = false;
    this._serverVoices = [];
    this._serverProvider = '';
    // 双 <audio> 交替：一个在播，另一个预载下一段，播完立即切 → 无缝
    this._players = null;
    this._pi = 0;
    this._sseq = 0;
    this._urls = new Map(); // index -> objectURL
    this._pending = new Map(); // index -> Promise<objectURL>
    this._urlGen = 0; // 清空缓存时自增，用于丢弃「换音色/重播前」遗留的异步结果

    this._loadVoices();
    if (typeof speechSynthesis !== 'undefined') {
      try {
        speechSynthesis.addEventListener('voiceschanged', () => this._loadVoices());
      } catch {
        /* ignore */
      }
    }
    // 手机上音色列表常常异步才就绪，轮询若干秒直到拿到
    this._startVoicePoll();
    this.detectServer();
  }

  /* ---------------- 能力检测 ---------------- */

  get browserSupported() {
    return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  get serverSupported() {
    return this._serverOk;
  }

  get supported() {
    return this.browserSupported || this._serverOk;
  }

  get provider() {
    return this._serverProvider;
  }

  _preference() {
    try {
      return localStorage.getItem(MODE_KEY) || 'auto';
    } catch {
      return 'auto';
    }
  }

  get preference() {
    return this._preference();
  }

  /** 当前实际使用的引擎：'browser' | 'server' */
  get mode() {
    const pref = this._preference();
    const b = this.browserSupported;
    const s = this._serverOk;
    if (pref === 'browser') return b ? 'browser' : s ? 'server' : 'browser';
    if (pref === 'server') return s ? 'server' : 'browser';
    // auto：浏览器可用就用浏览器；否则用服务端（手机上就是这种情况）
    if (b && (this._voices.length || !s)) return 'browser';
    return s ? 'server' : 'browser';
  }

  /** 手动切换优先引擎：auto | browser | server */
  setPreference(pref) {
    try {
      localStorage.setItem(MODE_KEY, pref);
    } catch {
      /* ignore */
    }
    this.stop();
    this.dispatchEvent(new CustomEvent('mode', { detail: { mode: this.mode, server: this._serverOk, provider: this._serverProvider } }));
    this.dispatchEvent(new CustomEvent('voices', { detail: this.listVoices() }));
    this._emit();
  }

  /** 询问服务端是否提供语音合成 */
  async detectServer() {
    let info = { provider: 'browser', server: false, voices: [] };
    try {
      const r = await fetch('/api/tts/voices', { headers: { Accept: 'application/json' } });
      if (r.ok) info = await r.json();
    } catch {
      /* 离线 / 旧版本：保持不可用 */
    }
    this._serverChecked = true;
    this._serverProvider = info.provider || '';
    const voices = Array.isArray(info.voices) ? info.voices : [];
    this._serverOk = !!info.server && voices.length > 0;
    this._serverVoices = voices.map((v) => ({
      uri: v.id || v.name,
      name: v.name,
      note: v.note || '',
      lang: 'zh-CN',
      local: false,
      server: true,
    }));
    this.dispatchEvent(new CustomEvent('mode', { detail: { mode: this.mode, server: this._serverOk, provider: this._serverProvider } }));
    this.dispatchEvent(new CustomEvent('voices', { detail: this.listVoices() }));
    this._emit();
  }

  /* ---------------- 浏览器音色 ---------------- */

  _loadVoices() {
    if (!this.browserSupported) return;
    let v = [];
    try {
      v = speechSynthesis.getVoices() || [];
    } catch {
      v = [];
    }
    const changed =
      v.length !== this._voices.length ||
      (v[0] && v[0].voiceURI) !== (this._voices[0] && this._voices[0].voiceURI);
    this._voices = v;
    if (changed) {
      this.dispatchEvent(new CustomEvent('mode', { detail: { mode: this.mode, server: this._serverOk, provider: this._serverProvider } }));
      this.dispatchEvent(new CustomEvent('voices', { detail: this.listVoices() }));
    }
  }

  /** 主动刷新一次音色（可在用户点击手势里调用） */
  refreshVoices() {
    this._loadVoices();
    if (!this._voices.length) this._startVoicePoll();
    if (!this._serverChecked) this.detectServer();
  }

  _startVoicePoll() {
    if (this._voicePoll || !this.browserSupported) return;
    let tries = 0;
    this._voicePoll = setInterval(() => {
      this._loadVoices();
      if (this._voices.length || ++tries > 60) {
        clearInterval(this._voicePoll);
        this._voicePoll = null;
      }
    }, 250);
  }

  /** iOS 要求第一次 speak() 必须在用户手势内调用，先播一个静音空句解锁 */
  _unlock() {
    if (!this.browserSupported || this._unlocked) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      u.rate = 2;
      speechSynthesis.speak(u);
      this._unlocked = true;
    } catch {
      /* ignore */
    }
  }

  /** 音色列表：服务端模式返回服务端音色；浏览器模式中文优先 */
  listVoices() {
    if (this.mode === 'server') return [...this._serverVoices];
    const score = (v) => {
      const l = (v.lang || '').toLowerCase();
      if (l.startsWith('zh-cn') || l.startsWith('zh_cn')) return 0;
      if (l.startsWith('zh')) return 1;
      if (l.startsWith('en')) return 2;
      return 3;
    };
    return [...this._voices]
      .sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))
      .map((v) => ({ uri: v.voiceURI, name: v.name, lang: v.lang, local: v.localService }));
  }

  pickVoice() {
    if (this.mode === 'server') {
      if (!this._serverVoices.length) return null;
      const found = this._serverVoices.find((v) => v.uri === this.voiceURI);
      return found || this._serverVoices[0];
    }
    if (!this._voices.length) return null;
    if (this.voiceURI) {
      const found = this._voices.find((v) => v.voiceURI === this.voiceURI);
      if (found) return found;
    }
    const zh = this._voices.find((v) => (v.lang || '').toLowerCase().startsWith('zh'));
    return zh || this._voices[0];
  }

  /* ---------------- 通用控制 ---------------- */

  setContent(paragraphs, startIndex = 0) {
    this.stop();
    this.paragraphs = (paragraphs || []).filter((p) => p && p.trim());
    this.index = Math.min(Math.max(0, startIndex), Math.max(0, this.paragraphs.length - 1));
    this._emit();
  }

  setConfig({ rate, pitch, volume, voiceURI, autoNext }) {
    let browserChanged = false; // 浏览器引擎：任何变化都要重读
    let serverResynth = false; // 服务端引擎：只有音色/音调变化才需要重新合成
    let rateChanged = false;
    if (rate !== undefined && Number(rate) !== this.rate) {
      this.rate = clamp(rate, 0.5, 4);
      rateChanged = true;
      browserChanged = true;
    }
    if (pitch !== undefined && Number(pitch) !== this.pitch) {
      this.pitch = Number(pitch);
      browserChanged = true;
      serverResynth = true;
    }
    if (volume !== undefined) {
      const v = clamp(volume, 0, 1);
      if (Math.abs(v - this.volume) > 0.001) browserChanged = true;
      this.volume = v;
      for (const p of this._players || []) p.volume = v;
    }
    if (voiceURI !== undefined && (voiceURI || '') !== this.voiceURI) {
      this.voiceURI = voiceURI || '';
      browserChanged = true;
      serverResynth = true;
    }
    if (autoNext !== undefined) this.autoNext = !!autoNext;

    if (!this.playing) return;
    if (this.mode === 'server') {
      // 语速：直接调 <audio>.playbackRate，实时生效、无需重新合成
      if (rateChanged) this._applyRate();
      if (serverResynth) {
        this._clearUrls();
        this._serverSpeak(this.index);
      }
    } else if (browserChanged) {
      this._speakIndex(this.index);
    }
  }

  setIndex(i, autoplay = false) {
    const n = this.paragraphs.length;
    if (!n) return;
    const target = Math.min(Math.max(0, i), n - 1);
    if (autoplay || this.playing) {
      if (autoplay && this.mode === 'browser') this._unlock();
      this._speakIndex(target);
    } else {
      this.index = target;
      this._emit();
    }
  }

  play() {
    if (!this.supported || !this.paragraphs.length) return;
    if (this.mode === 'server') return this._serverPlay();
    this._unlock();
    if (this.paused && speechSynthesis.paused) {
      speechSynthesis.resume();
      this.playing = true;
      this.paused = false;
      this._emit();
      return;
    }
    this._speakIndex(this.index);
  }

  pause() {
    if (!this.supported) return;
    if (this.mode === 'server') {
      const a = this._active();
      if (a && !a.paused) {
        try {
          a.pause();
        } catch {
          /* ignore */
        }
      }
      this.playing = false;
      this.paused = true;
      this._emit();
      return;
    }
    if (speechSynthesis.speaking && !speechSynthesis.paused) {
      speechSynthesis.pause();
      this.paused = true;
      this.playing = false;
      this._stopKeepAlive();
      this._emit();
    }
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  stop() {
    this._stopKeepAlive();
    this._seq++;
    if (this.browserSupported) {
      try {
        speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    }
    this._sseq++;
    if (this._players) {
      for (const a of this._players) {
        try {
          a.pause();
          a.removeAttribute('src');
          a._nvIndex = -1;
          if (a.load) a.load();
        } catch {
          /* ignore */
        }
      }
    }
    this._clearUrls();
    this.playing = false;
    this.paused = false;
    this._utt = null;
    this._emit();
  }

  next() {
    if (this.index >= this.paragraphs.length - 1) {
      this._chapterEnd();
      return;
    }
    this.setIndex(this.index + 1, true);
  }

  prev() {
    this.setIndex(Math.max(0, this.index - 1), true);
  }

  _chapterEnd() {
    this.playing = false;
    this._emit();
    this.dispatchEvent(new CustomEvent('chapter-end'));
  }

  /** 从第 i 段开始朗读（自动分派到当前引擎） */
  _speakIndex(i) {
    if (this.mode === 'server') {
      this._serverSpeak(i);
      return;
    }
    if (!this.browserSupported) return;
    this.index = i;
    const text = this.paragraphs[i];
    if (!text) {
      this._chapterEnd();
      return;
    }
    const seq = ++this._seq;
    try {
      speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    this._emit();
    // Chrome 中 cancel() 后立即 speak() 偶发丢句，稍作延迟更稳
    setTimeout(() => {
      if (seq !== this._seq) return;
      const u = new SpeechSynthesisUtterance(text);
      const v = this.pickVoice();
      if (v) u.voice = v;
      u.lang = v?.lang || 'zh-CN';
      u.rate = Math.min(4, Math.max(0.5, this.rate));
      u.pitch = Math.min(2, Math.max(0, this.pitch));
      u.volume = Math.min(1, Math.max(0, this.volume));
      u.onstart = () => {
        if (seq !== this._seq) return;
        this.playing = true;
        this.paused = false;
        this._startKeepAlive();
        this._emit();
      };
      u.onend = () => {
        if (seq !== this._seq) return;
        if (this.index < this.paragraphs.length - 1) {
          this._speakIndex(this.index + 1);
        } else {
          this._stopKeepAlive();
          this._chapterEnd();
        }
      };
      u.onerror = (e) => {
        if (seq !== this._seq) return;
        if (e.error === 'interrupted' || e.error === 'canceled') return;
        this._stopKeepAlive();
        this.playing = false;
        this._emit();
      };
      this._utt = u;
      speechSynthesis.speak(u);
    }, 40);
  }

  /* ---------------- 服务端引擎 ---------------- */

  _active() {
    return this._players ? this._players[this._pi] : null;
  }

  _idle() {
    return this._players ? this._players[1 - this._pi] : null;
  }

  _ensureAudio() {
    if (this._players) return this._active();
    if (typeof Audio === 'undefined') return null;
    const mk = () => {
      const a = new Audio();
      a.preload = 'auto';
      a.volume = clamp(this.volume, 0, 1);
      a._nvIndex = -1;
      a.addEventListener('play', () => {
        if (a !== this._active()) return;
        this.playing = true;
        this.paused = false;
        this._applyRateEl(a);
        this._emit();
      });
      a.addEventListener('ended', () => {
        if (a === this._active()) this._onTrackEnd();
      });
      a.addEventListener('error', () => {
        if (a === this._active()) this._onTrackError();
      });
      return a;
    };
    this._players = [mk(), mk()];
    this._pi = 0;
    return this._active();
  }

  /** 服务端模式：把当前倍速实时应用到 <audio>，无需重新合成。0.5~4 倍速 */
  _applyRateEl(a) {
    if (!a) return;
    try {
      a.playbackRate = clamp(this.rate, 0.5, 4);
      // 保持音高自然（Chrome/Safari 现代版默认开；老内核用带前缀属性兜底）
      a.preservesPitch = true;
      if ('mozPreservesPitch' in a) a.mozPreservesPitch = true;
      if ('webkitPreservesPitch' in a) a.webkitPreservesPitch = true;
    } catch {
      /* ignore */
    }
  }

  _applyRate() {
    for (const p of this._players || []) this._applyRateEl(p);
  }

  async _serverPlay() {
    const a = this._ensureAudio();
    if (!a) return;
    this._applyRate();
    const cur = this._active();
    if (this.paused && cur && cur.currentSrc && cur.currentTime > 0) {
      try {
        await cur.play();
        this._warm();
        return;
      } catch {
        /* 继续从头播当前段 */
      }
    }
    this._serverSpeak(this.index);
  }

  async _serverSpeak(i) {
    if (!this._serverOk) return;
    const n = this.paragraphs.length;
    if (i < 0 || i >= n) return;
    this.index = i;
    const seq = ++this._sseq;
    this.playing = true;
    this.paused = false;
    this._emit();
    // 停掉正在播放的元素（跳段/重播），避免两段声音重叠
    for (const p of this._players || []) {
      try {
        p.pause();
      } catch {
        /* ignore */
      }
    }
    let url;
    try {
      url = await this._audioUrl(i);
    } catch (e) {
      if (seq !== this._sseq) return;
      this.playing = false;
      this._emit();
      this.dispatchEvent(new CustomEvent('error', { detail: { index: i, error: String(e?.message || e) } }));
      return;
    }
    if (seq !== this._sseq) return;
    const a = this._ensureAudio();
    if (!a) return;
    const el = this._active();
    el._nvIndex = i;
    el.src = url;
    el.volume = clamp(this.volume, 0, 1);
    this._applyRateEl(el);
    try {
      await el.play();
    } catch {
      // 自动播放被拦截：保持暂停态，等用户点播放键
      this.playing = false;
      this.paused = true;
      this._emit();
      this.dispatchEvent(new CustomEvent('blocked'));
      return;
    }
    this._warm();
  }

  /** 播放稳定后：向后多段预合成，并把下一段预载到空闲元素，便于无缝切换 */
  _warm() {
    const n = this.paragraphs.length;
    for (let k = 1; k <= PREFETCH_AHEAD; k++) {
      const j = this.index + k;
      if (j < n) this._prefetch(j);
    }
    this._prepare(this.index + 1);
  }

  /** 把第 i 段预载到空闲 <audio>（仅缓冲，不播放），供段间无缝切换 */
  async _prepare(i) {
    if (i < 0 || i >= this.paragraphs.length) return;
    const el = this._idle();
    if (!el) return;
    if (el._nvIndex === i && el.readyState >= 2) return;
    const gen = this._sseq;
    let url;
    try {
      url = await this._audioUrl(i);
    } catch {
      return; // 合成失败：交给真正播到该段时的 _serverSpeak 重试
    }
    if (gen !== this._sseq) return; // 期间发生跳段
    if (el !== this._idle()) return;
    el._nvIndex = i;
    el.src = url;
    el.volume = clamp(this.volume, 0, 1);
    this._applyRateEl(el);
    try {
      if (el.load) el.load();
    } catch {
      /* ignore */
    }
  }

  /** 一段播完：优先无缝切到已预载好的下一段 */
  _onTrackEnd() {
    const n = this.paragraphs.length;
    const next = this.index + 1;
    if (next >= n) {
      this.playing = false;
      this.paused = false;
      this._emit();
      this._chapterEnd();
      return;
    }
    const other = this._idle();
    if (other && other._nvIndex === next && other.readyState >= 2) {
      // 下一段已备好：交换当前元素直接开播，几乎无间隙
      this._pi = 1 - this._pi;
      this.index = next;
      this.playing = true;
      this.paused = false;
      this._applyRateEl(other);
      other.volume = clamp(this.volume, 0, 1);
      this._emit();
      const gen = this._sseq;
      Promise.resolve(other.play()).catch(() => {
        // 仅在用户未另作跳转（seq 未变）时回退重播
        if (gen === this._sseq) this._serverSpeak(this.index);
      });
      this._warm();
      return;
    }
    // 还没备好（合成慢/失败）：退回单段播放，由它去等待
    this._serverSpeak(next);
  }

  /** 播放层出错（极少见）：丢弃该段缓存，重新合成并续播 */
  _onTrackError() {
    const i = this.index;
    const url = this._urls.get(i);
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
      this._urls.delete(i);
    }
    this._serverSpeak(i);
  }

  _audioUrl(i) {
    if (this._urls.has(i)) return Promise.resolve(this._urls.get(i));
    if (this._pending.has(i)) return this._pending.get(i);
    const text = this.paragraphs[i];
    if (!text) return Promise.reject(new Error('空段落'));
    const p = this._fetchAudio(i, text, 0);
    this._pending.set(i, p);
    p.catch(() => {}).finally(() => this._pending.delete(i));
    return p;
  }

  /** 取一段合成音频；失败自动退避重试（上游 TTS 偶发 503 / 网络抖动） */
  async _fetchAudio(i, text, attempt) {
    const gen = this._urlGen;
    try {
      const r = await fetch('/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 服务端固定按基准速度合成（缓存可跨倍速复用），倍速由前端 <audio>.playbackRate 实时控制
        body: JSON.stringify({ text, rate: 1, voice: this.voiceURI || 'baidu' }),
      });
      if (!r.ok) {
        let msg = `语音合成失败（${r.status}）`;
        try {
          const j = await r.json();
          if (j && j.error) msg = j.error;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      const blob = await r.blob();
      if (!blob.size) throw new Error('语音合成返回空音频');
      const url = URL.createObjectURL(blob);
      // 期间若换了音色 / 重播（缓存已清空），这段结果作废，避免播出旧音色
      if (gen !== this._urlGen) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
        throw new Error('已取消');
      }
      this._urls.set(i, url);
      this._trimUrls();
      return url;
    } catch (e) {
      if (attempt + 1 < TTS_FETCH_TRIES) {
        await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
        return this._fetchAudio(i, text, attempt + 1);
      }
      throw e;
    }
  }

  _prefetch(i) {
    if (i < 0 || i >= this.paragraphs.length) return;
    if (this._urls.has(i) || this._pending.has(i)) return;
    this._audioUrl(i).catch(() => {});
  }

  /** 限制本地缓存的音频段数，避免超长章节在手机上占用过多内存 */
  _trimUrls(max = 48) {
    if (this._urls.size <= max) return;
    for (const [i, url] of [...this._urls]) {
      if (this._urls.size <= max) break;
      if (i >= this.index - 2) break; // 只回收早已播过的段
      this._urls.delete(i);
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }
  }

  _clearUrls() {
    this._urlGen++;
    for (const url of this._urls.values()) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }
    this._urls.clear();
    // 元素上记录的段落号一并作废，避免复用到已 revoke 的 blob
    for (const p of this._players || []) p._nvIndex = -1;
  }

  /* ---------------- 浏览器 keep-alive ---------------- */

  /** Chrome 长文本朗读会自动暂停的规避：定时唤醒 */
  _startKeepAlive() {
    this._stopKeepAlive();
    this._keepAlive = setInterval(() => {
      try {
        if (speechSynthesis.speaking && speechSynthesis.paused) speechSynthesis.resume();
      } catch {
        /* ignore */
      }
    }, 8000);
  }

  _stopKeepAlive() {
    if (this._keepAlive) clearInterval(this._keepAlive);
    this._keepAlive = null;
  }

  _emit() {
    this.dispatchEvent(
      new CustomEvent('state', {
        detail: {
          playing: this.playing,
          paused: this.paused,
          index: this.index,
          total: this.paragraphs.length,
          text: this.paragraphs[this.index] || '',
          mode: this.mode,
        },
      }),
    );
  }
}

export const speaker = new Speaker();
