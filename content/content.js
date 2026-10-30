/**
 * content.js — 页面侧翻译引擎
 *
 * 设计要点：
 * 1. 不依赖浏览器内置翻译，自己遍历 DOM 文本节点，把译文写回页面，
 *    因此不受「无法翻译此页面」的限制。
 * 2. 先翻视口内的内容，再翻剩余部分，大页面也能立刻看到效果。
 * 3. 监听 DOM 变化，无限滚动 / 单页应用的新内容会被增量翻译。
 * 4. 悬浮球与浮层使用 Shadow DOM，完全隔离页面样式。
 */

(() => {
  'use strict';

  // 防止重复注入（background 的兜底注入可能再次执行）
  if (window.__wtTranslatorLoaded) return;
  window.__wtTranslatorLoaded = true;

  const IS_TOP = (() => {
    try { return window.top === window; } catch (_) { return false; }
  })();

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'OPTGROUP', 'BUTTON',
    'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO',
    'MATH', 'HEAD', 'META', 'LINK', 'TITLE'
  ]);

  const BLOCK_TAGS = new Set([
    'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH',
    'BLOCKQUOTE', 'DD', 'DT', 'FIGCAPTION', 'DIV', 'SECTION',
    'ARTICLE', 'SUMMARY', 'LABEL', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER'
  ]);

  const state = {
    status: 'idle',        // idle | translating | translated
    mode: 'replace',       // replace | dual
    targetLang: 'zh-CN',
    engine: null,
    settings: null,
    records: [],           // { node, original, translated, span }
    seen: new WeakMap(),   // TextNode -> record
    observer: null,
    pendingRoots: new Set(),
    flushTimer: null,
    translating: false
  };

  /* ============================ 工具函数 ============================ */

  const CJK = /[\u4E00-\u9FFF\u3400-\u4DBF]/;
  const LETTER = /[A-Za-z\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u3040-\u30FF\uAC00-\uD7AF\u0E00-\u0E7F]/;

  /**
   * 判断文本是否以中文为主。
   *
   * 中英混排（「群晖 DSM+Gitlab CE 遭 C3RB3R 勒索软件攻击」）必须算中文：
   * 这类文本送去翻译，引擎会把「群晖」这种词改写成别的字，反而破坏原文。
   * 所以只要中文达到一定比例就算中文，不能要求中文数多于英文数。
   */
  function isProbablyChinese(text) {
    const cjk = (text.match(/[\u4E00-\u9FFF\u3400-\u4DBF]/g) || []).length;
    if (cjk === 0) return false;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    if (latin === 0) return true;
    return cjk >= 2 && cjk >= latin * 0.5;
  }

  function isProbablyLatin(text) {
    const cjk = (text.match(/[\u4E00-\u9FFF\u3400-\u4DBF]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    if (latin === 0) return false;
    if (cjk === 0) return true;
    return latin >= cjk * 3;
  }

  /** 已经是目标语言的文本直接跳过，避免把好好的中文改写掉 */
  function alreadyTargetLanguage(text) {
    const target = state.targetLang || 'zh-CN';
    if (target.startsWith('zh')) return isProbablyChinese(text);
    if (target === 'en') return isProbablyLatin(text);
    return false;
  }

  function isTranslatableText(text) {
    const t = text.trim();
    if (t.length < 2) return false;
    if (!LETTER.test(t) && !CJK.test(t)) return false;          // 纯数字/符号
    if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return false;       // 纯链接
    if (/^[\w.+-]+@[\w.-]+\.\w+$/.test(t)) return false;         // 纯邮箱
    if (/^[\s\d\p{P}\p{S}]+$/u.test(t)) return false;            // 无实义字符
    if (alreadyTargetLanguage(t)) return false;
    return true;
  }

  function isSkipElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.getAttribute && el.getAttribute('translate') === 'no') return true;
    if (el.hasAttribute && el.hasAttribute('data-wt-skip')) return true;
    if (el.isContentEditable) return true;
    const ce = el.getAttribute && el.getAttribute('contenteditable');
    if (ce !== null && ce !== 'false') return true;
    // 扩展自己的 UI
    if (el.id && String(el.id).startsWith('wt-')) return true;
    if (el.classList && el.classList.contains('wt-trans')) return true;
    return false;
  }

  /* ========================= 收集文本节点 ========================= */

  function collectTextNodes(root, out = []) {
    if (!root) return out;
    const shadowRoots = [];

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.shadowRoot) shadowRoots.push(node.shadowRoot);
            if (isSkipElement(node)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_SKIP;   // 跳过元素本身，继续深入子节点
          }
          // 文本节点
          const text = node.nodeValue;
          if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
          if (!isTranslatableText(text)) return NodeFilter.FILTER_REJECT;
          if (state.seen.has(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === Node.TEXT_NODE) out.push(n);
    }

    for (const sr of shadowRoots) collectTextNodes(sr, out);
    return out;
  }

  function isInViewport(node) {
    try {
      const el = node.parentElement;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.bottom > -200 && rect.top < (window.innerHeight || 800) + 600;
    } catch (_) {
      return false;
    }
  }

  /* ============================ 应用译文 ============================ */

  /**
   * 判断译文是否该用块级插入。
   * 段落被 <code>/<a> 等拆成多个文本节点时，碎片必须保持行内，
   * 否则会把一整句话拆成好几行。
   */
  function shouldUseBlock(parent, node, original) {
    if (!parent || !BLOCK_TAGS.has(parent.tagName)) return false;
    if (original.trim().length <= 15) return false;
    const hasElementChildren = Array.from(parent.children).some(c => c.tagName !== 'BR');
    if (!hasElementChildren) return true;          // 整段都在这个文本节点里
    const total = (parent.textContent || '').length;
    if (!total) return true;
    return original.length / total > 0.7;          // 占绝对多数才算主体
  }

  /**
   * 兜底防线：翻译接口出错时，有的会把错误提示当成译文返回
   * （MyMemory 用 auto 源语言时就会返回 "'AUTO' IS AN INVALID SOURCE LANGUAGE..."）。
   * 这类文本一旦写进页面会把整页内容覆盖掉，所以这里再拦一次。
   */
  function looksLikeApiError(text) {
    if (typeof text !== 'string') return false;
    const t = text.trim();
    if (!t) return false;
    if (/INVALID\s+(SOURCE|TARGET)\s+LANGUAGE|LANGPAIR\s*=|RFC3066|QUOTA|API\s*KEY|RATE\s*LIMIT/i.test(t)) return true;
    if (t.length > 40 && t === t.toUpperCase() && /[A-Z]{4,}/.test(t)) return true;
    return false;
  }

  function applyTranslation(node, translated) {
    const original = node.nodeValue;
    if (!translated || translated === original) return false;
    if (looksLikeApiError(translated)) return false;

    if (state.mode === 'dual') {
      const parent = node.parentElement;
      if (!parent) return false;
      const span = document.createElement('span');
      const isBlock = shouldUseBlock(parent, node, original);
      span.className = 'wt-trans' + (isBlock ? ' wt-trans-block' : '');
      span.setAttribute('data-wt-skip', '1');
      span.textContent = translated;
      parent.insertBefore(span, node.nextSibling);
      const rec = { node, original, translated, span, mode: 'dual' };
      state.records.push(rec);
      state.seen.set(node, rec);
      return true;
    }

    // 替换模式
    node.nodeValue = translated;
    const rec = { node, original, translated, span: null, mode: 'replace' };
    state.records.push(rec);
    state.seen.set(node, rec);
    return true;
  }

  /* ============================ 还原 ============================ */

  function restoreAll() {
    for (const rec of state.records) {
      try {
        if (rec.span && rec.span.parentNode) rec.span.parentNode.removeChild(rec.span);
        if (rec.node && rec.mode === 'replace') rec.node.nodeValue = rec.original;
      } catch (_) { /* 节点可能已被页面移除 */ }
    }
    state.records = [];
    state.seen = new WeakMap();
    state.status = 'idle';
    state.engine = null;
    stopObserver();
    updateBall();
    reportState();
  }

  /* ============================ 请求翻译 ============================ */

  async function requestTranslations(texts, targetLang) {
    const res = await chrome.runtime.sendMessage({
      type: 'TRANSLATE',
      texts,
      targetLang
    });
    if (!res || !res.ok) throw new Error((res && res.error) || '翻译请求失败');
    return res;
  }

  /**
   * 分批翻译一组节点。
   * 每批 30 条，并发 3 批，边翻边写入页面。
   */
  async function translateNodes(nodes, options = {}) {
    if (!nodes.length) return { count: 0, engine: null };

    const CHUNK = 30;
    const CONCURRENCY = 3;
    const batches = [];
    for (let i = 0; i < nodes.length; i += CHUNK) batches.push(nodes.slice(i, i + CHUNK));

    let engine = null;
    let done = 0;
    let cursor = 0;

    async function worker() {
      while (cursor < batches.length) {
        const batch = batches[cursor++];
        const texts = batch.map(n => n.nodeValue);
        try {
          const res = await requestTranslations(texts, state.targetLang);
          engine = res.engine || engine;
          const list = res.translations || [];
          batch.forEach((node, k) => {
            if (typeof list[k] === 'string') applyTranslation(node, list[k]);
          });
        } catch (e) {
          console.warn('[网页翻译助手] 批次失败：', e && e.message);
          if (options.throwOnFail) throw e;
        }
        done++;
        if (IS_TOP) setBallProgress(Math.round((done / batches.length) * 100));
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker);
    await Promise.all(workers);
    return { count: state.records.length, engine };
  }

  /* ============================ 整页翻译 ============================ */

  async function translatePage(options = {}) {
    if (state.translating) return;
    if (!document.body) return;

    // 每次翻译前都重新读设置：用户可能刚在弹窗里改过目标语言或显示方式
    const settings = await loadSettings();
    state.targetLang = options.targetLang || settings.targetLang || 'zh-CN';
    state.mode = options.mode || settings.mode || 'replace';

    const host = location.hostname;
    if (!options.force && Array.isArray(settings.excludeHosts)) {
      if (settings.excludeHosts.some(h => h && (host === h || host.endsWith('.' + h)))) {
        toast('当前站点已在排除列表中');
        return;
      }
    }

    state.translating = true;
    state.status = 'translating';
    updateBall();
    reportState();

    try {
      const all = collectTextNodes(document.body);
      if (!all.length) {
        toast('这个页面没有可翻译的文本');
        state.status = 'idle';
        state.translating = false;
        updateBall();
        reportState();
        return;
      }

      // 视口内的先翻，用户立刻能看到结果。
      // 按父元素缓存可见性判断，避免对上千个节点重复触发布局计算。
      const inView = [];
      const rest = [];
      const rectCache = new Map();
      const vh = window.innerHeight || 800;
      for (const n of all) {
        const el = n.parentElement;
        let visible = false;
        if (el) {
          if (rectCache.has(el)) {
            visible = rectCache.get(el);
          } else {
            try {
              const r = el.getBoundingClientRect();
              visible = r.bottom > -200 && r.top < vh + 600;
            } catch (_) {
              visible = false;
            }
            rectCache.set(el, visible);
          }
        }
        (visible ? inView : rest).push(n);
      }

      if (IS_TOP) setBallProgress(0);

      let engine = null;
      if (inView.length) {
        const r = await translateNodes(inView, { throwOnFail: true });
        engine = r.engine;
      }

      state.status = 'translated';
      state.engine = engine;
      updateBall();
      reportState();

      // 剩余内容在后台继续
      if (rest.length) {
        translateNodes(rest).then(r => {
          if (r.engine) state.engine = r.engine;
          state.status = 'translated';
          updateBall();
          reportState();
          if (IS_TOP) setBallProgress(null);
        }).catch(() => {
          if (IS_TOP) setBallProgress(null);
        });
      } else if (IS_TOP) {
        setBallProgress(null);
      }

      startObserver();
      safeSend({ type: 'BADGE', text: '译', color: '#2563eb' });
    } catch (e) {
      state.status = state.records.length ? 'translated' : 'idle';
      updateBall();
      reportState();
      const detail = (e && e.message) || '未知错误';
      const allDown = /均不可用/.test(detail);
      const text = '翻译失败：' + (detail.length > 220 ? detail.slice(0, 220) + '…' : detail)
        + (allDown ? '\n点扩展图标 → 设置：先「测试全部」看具体状态，再点「清除翻译缓存」后重试' : '');
      toast(text, true);
      if (IS_TOP) setBallProgress(null);
    } finally {
      state.translating = false;
    }
  }

  /* ========================= 动态内容监听 ========================= */

  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.type === 'characterData') {
          const rec = state.seen.get(m.target);
          // 忽略我们自己写入的译文
          if (rec && rec.mode === 'replace' && m.target.nodeValue === rec.translated) continue;
          if (rec) continue;
          if (isTranslatableText(m.target.nodeValue || '')) {
            state.pendingRoots.add(m.target.parentElement);
          }
          continue;
        }
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList && node.classList.contains('wt-trans')) continue;
            if (node.id && String(node.id).startsWith('wt-')) continue;
            state.pendingRoots.add(node);
          } else if (node.nodeType === Node.TEXT_NODE) {
            if (isTranslatableText(node.nodeValue || '')) state.pendingRoots.add(node.parentElement);
          }
        }
      }
      if (state.pendingRoots.size) scheduleFlush();
    });

    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function stopObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    state.pendingRoots.clear();
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
  }

  function scheduleFlush() {
    if (state.flushTimer) clearTimeout(state.flushTimer);
    state.flushTimer = setTimeout(flushPending, 700);
  }

  async function flushPending() {
    state.flushTimer = null;
    if (state.translating) {
      scheduleFlush();
      return;
    }
    const roots = Array.from(state.pendingRoots).filter(r => r && r.isConnected);
    state.pendingRoots.clear();
    if (!roots.length) return;

    const nodes = [];
    const seenSet = new Set();
    for (const root of roots) {
      for (const n of collectTextNodes(root)) {
        if (!seenSet.has(n)) { seenSet.add(n); nodes.push(n); }
      }
    }
    if (!nodes.length) return;

    state.translating = true;
    try {
      await translateNodes(nodes);
      state.status = 'translated';
      updateBall();
      reportState();
    } catch (_) {
      /* 增量翻译失败静默处理，不打扰用户 */
    } finally {
      state.translating = false;
    }
  }

  /* ============================ 悬浮球 ============================ */

  let ballHost = null;
  let ballShadow = null;
  let ballEl = null;
  let progressEl = null;

  function ensureBall() {
    if (ballHost || !IS_TOP || !document.body) return;
    ballHost = document.createElement('div');
    ballHost.id = 'wt-ball-host';
    ballHost.setAttribute('data-wt-skip', '1');
    // 关键：宿主元素必须完全脱离文档流、且不继承页面样式。
    // 否则在 flex / grid 布局的页面上它会占一个格子，或被页面的
    // `body > div` 这类通用选择器命中，把整页布局挤歪（移动端尤其明显）。
    ballHost.style.cssText =
      'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; '
      + 'z-index: 2147483646; pointer-events: none;';
    ballShadow = ballHost.attachShadow({ mode: 'open' });

    ballShadow.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          position: fixed;
          right: calc(20px + env(safe-area-inset-right, 0px));
          bottom: calc(20px + env(safe-area-inset-bottom, 0px));
          z-index: 2147483646;
          pointer-events: auto;   /* 宿主是 none，这里要单独恢复可点击 */
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          -webkit-tap-highlight-color: transparent;
        }
        .ball {
          width: 46px; height: 46px; border-radius: 50%;
          background: #2563eb; color: #fff;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; user-select: none;
          box-shadow: 0 4px 14px rgba(37, 99, 235, .38);
          transition: transform .16s ease, background .16s ease, box-shadow .16s ease;
          position: relative; border: none;
          touch-action: manipulation;
        }
        .ball:hover { transform: scale(1.07); box-shadow: 0 6px 20px rgba(37,99,235,.5); }
        .ball:active { transform: scale(.94); }
        .ball.active { background: #16a34a; box-shadow: 0 4px 14px rgba(22,163,74,.38); }
        .ball.busy { background: #f59e0b; box-shadow: 0 4px 14px rgba(245,158,11,.38); }
        .ball svg { width: 22px; height: 22px; display: block; }
        .ring {
          position: absolute; inset: -4px; border-radius: 50%;
          border: 2px solid rgba(255,255,255,.55);
          clip-path: inset(0 0 0 0); opacity: 0; transition: opacity .2s;
        }
        .ball.busy .ring { opacity: 1; animation: spin 1.1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .tip {
          position: absolute; right: 56px; bottom: 8px; white-space: nowrap;
          background: rgba(17,24,39,.92); color: #fff; font-size: 12px;
          padding: 6px 10px; border-radius: 6px; opacity: 0;
          pointer-events: none; transition: opacity .18s;
        }
        .wrap:hover .tip { opacity: 1; }

        /* 小屏（手机 / 窄窗口）：球缩小、贴边收紧，别挡内容 */
        @media (max-width: 480px) {
          .wrap {
            right: calc(12px + env(safe-area-inset-right, 0px));
            bottom: calc(12px + env(safe-area-inset-bottom, 0px));
          }
          .ball { width: 40px; height: 40px; }
          .ball svg { width: 19px; height: 19px; }
          .tip { display: none; }
        }
      </style>
      <div class="wrap">
        <div class="tip">翻译此页 · Alt+T</div>
        <div class="ball" role="button" tabindex="0">
          <div class="ring"></div>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 5h9M8.5 5c0 4-2 7-4.5 9"/>
            <path d="M5 9c1.5 3 4 5 7 6"/>
            <path d="M13 20l4-9 4 9M14.5 17h5"/>
          </svg>
        </div>
      </div>
    `;

    ballEl = ballShadow.querySelector('.ball');
    progressEl = ballShadow.querySelector('.ring');
    ballEl.addEventListener('click', e => {
      e.stopPropagation();
      if (state.status === 'translated') restoreAll();
      else translatePage();
    });
    ballEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ballEl.click(); }
    });

    document.body.appendChild(ballHost);
    updateBall();
  }

  function setBallProgress(percent) {
    if (!ballEl) return;
    if (percent === null) {
      ballEl.classList.remove('busy');
      ballEl.style.removeProperty('--p');
      return;
    }
    ballEl.classList.add('busy');
    const tip = ballShadow.querySelector('.tip');
    if (tip) tip.textContent = '正在翻译 ' + percent + '%';
  }

  function updateBall() {
    if (!ballEl) return;
    const settings = state.settings;
    if (settings && settings.showFloatingBall === false) {
      if (ballHost) ballHost.style.display = 'none';
      return;
    }
    if (ballHost) ballHost.style.display = '';
    ballEl.classList.toggle('active', state.status === 'translated');
    ballEl.classList.toggle('busy', state.status === 'translating');
    const tip = ballShadow.querySelector('.tip');
    if (tip && state.status !== 'translating') {
      tip.textContent = state.status === 'translated' ? '还原原文 · Alt+T' : '翻译此页 · Alt+T';
    }
  }

  /* ============================ 轻提示 ============================ */

  function toast(message, isError = false) {
    if (!IS_TOP) return;
    const host = document.createElement('div');
    host.setAttribute('data-wt-skip', '1');
    host.style.cssText =
      'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; '
      + 'z-index: 2147483647; pointer-events: none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .t {
          position: fixed; left: 50%; bottom: 88px; transform: translateX(-50%);
          background: ${isError ? '#dc2626' : 'rgba(17,24,39,.94)'};
          color: #fff; font-size: 13px; line-height: 1.55;
          padding: 10px 16px; border-radius: 8px; z-index: 2147483647;
          font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          box-shadow: 0 6px 22px rgba(0,0,0,.24); max-width: 78vw;
          white-space: pre-line; word-break: break-word;
          animation: in .2s ease;
        }
        @keyframes in { from { opacity: 0; transform: translate(-50%, 8px); } }
      </style>
      <div class="t"></div>
    `;
    shadow.querySelector('.t').textContent = message;
    document.body.appendChild(host);
    setTimeout(() => host.remove(), isError ? 9000 : 3200);
  }

  /* ======================= 选中内容翻译浮层 ======================= */

  function showSelectionTranslation(payload) {
    if (!IS_TOP) return;
    const existing = document.getElementById('wt-sel-host');
    if (existing) existing.remove();

    const host = document.createElement('div');
    host.id = 'wt-sel-host';
    host.setAttribute('data-wt-skip', '1');
    host.style.cssText =
      'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });

    const body = payload.error
      ? `<div class="err">${escapeHtml(payload.error)}</div>`
      : `<div class="src">${escapeHtml(payload.original.slice(0, 300))}</div>
         <div class="dst">${escapeHtml(payload.translated || '（无译文）')}</div>`;

    shadow.innerHTML = `
      <style>
        .card {
          position: fixed; right: 24px; top: 24px; width: 360px; max-width: 82vw;
          background: #fff; color: #111827; border-radius: 12px; z-index: 2147483647;
          box-shadow: 0 10px 40px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.06);
          font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          overflow: hidden; animation: slide .22s ease;
        }
        @keyframes slide { from { opacity: 0; transform: translateY(-8px); } }
        .hd {
          display: flex; align-items: center; justify-content: space-between;
          padding: 10px 14px; border-bottom: 1px solid #f1f5f9; font-size: 12px;
          color: #64748b; font-weight: 500;
        }
        .close {
          cursor: pointer; border: none; background: none; font-size: 16px;
          color: #94a3b8; line-height: 1; padding: 2px 4px; border-radius: 4px;
        }
        .close:hover { background: #f1f5f9; color: #334155; }
        .src {
          padding: 12px 14px 8px; font-size: 12px; color: #94a3b8;
          border-bottom: 1px dashed #e2e8f0; max-height: 96px; overflow: auto;
        }
        .dst { padding: 12px 14px 16px; font-size: 15px; line-height: 1.62; color: #0f172a; }
        .err { padding: 14px; font-size: 13px; color: #dc2626; }
        @media (max-width: 480px) {
          .card { left: 12px; right: 12px; width: auto; max-width: none; top: 12px; }
        }
      </style>
      <div class="card">
        <div class="hd"><span>网页翻译助手</span><button class="close">✕</button></div>
        ${body}
      </div>
    `;
    shadow.querySelector('.close').addEventListener('click', () => host.remove());
    document.body.appendChild(host);

    setTimeout(() => host.remove(), 15000);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  /* ============================ 状态上报 ============================ */

  let stateReportTimer = null;

  /** 扩展被重载后 runtime 会失效，此时 sendMessage 是同步抛错而不是 reject */
  function safeSend(message) {
    try {
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === 'function') p.catch(() => {});
      return p;
    } catch (_) {
      return null;
    }
  }

  function reportState() {
    if (!IS_TOP) return;
    if (stateReportTimer) return;
    stateReportTimer = setTimeout(() => {
      stateReportTimer = null;
      safeSend({
        type: 'PAGE_STATE',
        state: {
          status: state.status,
          mode: state.mode,
          targetLang: state.targetLang,
          engine: state.engine,
          count: state.records.length
        }
      });
    }, 120);
  }

  /* ============================ 设置加载 ============================ */

  async function loadSettings() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      state.settings = (res && res.settings) || {};
    } catch (_) {
      state.settings = {};
    }
    state.targetLang = state.settings.targetLang || 'zh-CN';
    state.mode = state.settings.mode || 'replace';
    return state.settings;
  }

  /* ============================ 快捷键兜底 ============================ */

  /**
   * 浏览器级快捷键（manifest 的 commands）在部分系统上会被菜单助记符吞掉——
   * Windows 下 Alt+T 就是传统「工具」菜单的助记键，按下去可能根本到不了扩展。
   * 这里在页面里再监听一次键盘事件作为兜底：只要事件能到达页面，快捷键就有效。
   * 两条路径都汇总到 background 统一广播，避免翻译完又被还原一次。
   */
  function installHotkey() {
    if (!IS_TOP) return;   // 只由主框架发起，否则每个 iframe 都会触发一次
    document.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code !== 'KeyT' && String(e.key).toLowerCase() !== 't') return;
      e.preventDefault();
      safeSend({ type: 'HOTKEY_TOGGLE' });
    }, true);
  }

  /* ============================ 消息入口 ============================ */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'COMMAND') {
      if (msg.action === 'TOGGLE') {
        if (state.status === 'translated') restoreAll();
        else translatePage();
      } else if (msg.action === 'TRANSLATE_PAGE') {
        if (state.status === 'translated') restoreAll();
        translatePage({ force: true });
      } else if (msg.action === 'RESTORE_PAGE') {
        restoreAll();
      }
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'SHOW_SELECTION_TRANSLATION') {
      showSelectionTranslation(msg);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'GET_CONTENT_STATE') {
      // 只让主框架响应：消息会广播到所有 frame，iframe 抢先回答会让弹窗显示错状态
      if (!IS_TOP) return false;
      sendResponse({
        ok: true,
        status: state.status,
        count: state.records.length,
        targetLang: state.targetLang,
        mode: state.mode,
        engine: state.engine
      });
      return true;
    }

    if (msg.type === 'SET_MODE') {
      state.mode = msg.mode;
      // 先把模式写回设置，再重排。否则 translatePage 重新读设置时会把模式覆盖回旧值。
      (async () => {
        try {
          await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', patch: { mode: msg.mode } });
        } catch (_) { /* 保存失败也继续，本次翻译仍用新模式 */ }
        if (state.status === 'translated') {
          restoreAll();
          translatePage({ force: true, mode: msg.mode });
        }
      })();
      sendResponse({ ok: true });
      return true;
    }
  });

  /* ============================ 初始化 ============================ */

  async function init() {
    const settings = await loadSettings();
    installHotkey();
    if (IS_TOP && settings.showFloatingBall !== false && document.body) {
      ensureBall();
    }
    reportState();

    // 自动翻译
    const host = location.hostname;
    const excluded = Array.isArray(settings.excludeHosts)
      && settings.excludeHosts.some(h => h && (host === h || host.endsWith('.' + h)));
    if (settings.autoTranslate && !excluded && IS_TOP) {
      const lang = (document.documentElement.lang || '').toLowerCase();
      const sameLang = state.targetLang.startsWith('zh') && lang.startsWith('zh');
      if (!sameLang) {
        // 等页面稳定一点再翻
        setTimeout(() => translatePage(), 800);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
