/**
 * background.js — 扩展的服务端逻辑
 * 负责：设置读写、引擎选择与故障降级、翻译缓存、右键菜单、快捷键、角标
 */
import { runEngine, probeEngine, ENGINES, AUTO_ORDER, looksLikeApiError } from './lib/engines.js';

const DEFAULTS = {
  engine: 'auto',          // auto | tencent | google | youdao | mymemory | custom
  targetLang: 'zh-CN',
  mode: 'replace',         // replace | dual
  autoTranslate: false,    // 打开页面后自动翻译
  showFloatingBall: true,  // 页面右下角悬浮球
  excludeHosts: [],        // 不翻译的域名
  customBaseUrl: '',
  customApiKey: '',
  customModel: 'gpt-4o-mini'
};

const PROBE_TTL = 30 * 60 * 1000;   // 引擎探测成功结果有效期
const PROBE_FAIL_TTL = 30 * 1000;   // 失败结果只缓存 30 秒，让用户能尽快重试
const CACHE_LIMIT = 4000;

// 各标签页的翻译状态，供弹窗查询
const tabState = new Map();

/* ---------------------------- 设置 ---------------------------- */

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set(next);
  return next;
}

/* ------------------------- 引擎探测缓存 ------------------------- */

async function readProbeCache() {
  try {
    const { probeCache } = await chrome.storage.session.get('probeCache');
    return probeCache || {};
  } catch (_) {
    return {};
  }
}

async function writeProbe(engineId, result) {
  try {
    const cache = await readProbeCache();
    cache[engineId] = { ...result, ts: Date.now() };
    await chrome.storage.session.set({ probeCache: cache });
  } catch (_) { /* session 存储不可用时忽略 */ }
}

/**
 * 选择要用的引擎。
 * auto 模式下按优先级顺序探测，结果缓存 30 分钟。
 *
 * 注意：这里刻意不用「并发探测、谁快用谁」。实测有道响应比腾讯快，
 * 但它对部分文本会静默返回 null，导致页面只翻了一半。宁可多等几百毫秒，
 * 也要用稳定完整的引擎。
 */
async function pickEngine(settings) {
  if (settings.engine !== 'auto') return settings.engine;

  const cache = await readProbeCache();
  const now = Date.now();
  const fresh = AUTO_ORDER.filter(id => cache[id] && cache[id].ok && now - cache[id].ts < PROBE_TTL);
  if (fresh.length) return fresh[0];

  // 刚全部失败过就别再让用户干等一轮（每个引擎都要等满超时）
  const failedRecently = AUTO_ORDER.every(id =>
    cache[id] && !cache[id].ok && now - cache[id].ts < PROBE_FAIL_TTL);
  if (failedRecently) {
    throw new Error('翻译引擎均不可用 —— ' + describeFailures(cache));
  }

  const failures = [];
  for (const id of AUTO_ORDER) {
    const r = await probeEngine(id, settings, 5000);
    await writeProbe(id, r);
    if (r.ok) return id;
    failures.push(`${(ENGINES[id] || {}).name || id}: ${shorten(r.error)}`);
  }

  throw new Error('翻译引擎均不可用 —— ' + failures.join('；'));
}

function shorten(msg, max = 36) {
  const s = String(msg || '未知原因');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function describeFailures(cache) {
  return AUTO_ORDER
    .map(id => `${(ENGINES[id] || {}).name || id}: ${shorten((cache[id] || {}).error)}`)
    .join('；');
}

// service worker 每次启动时检查一次：缓存里如果全是失败记录，说明上一轮整体不可用，
// 直接清掉，免得用户下次翻译还要先绕一圈错误提示。
(async () => {
  try {
    const cache = await readProbeCache();
    const ids = Object.keys(cache);
    if (ids.length && ids.every(id => !cache[id].ok)) {
      await chrome.storage.session.remove('probeCache');
    }
  } catch (_) { /* 忽略 */ }
})();

/* --------------------------- 翻译缓存 --------------------------- */

const cache = new Map();

function cacheKey(engineId, lang, text) {
  return engineId + '\u0001' + lang + '\u0001' + text;
}

function cacheGet(engineId, lang, text) {
  return cache.get(cacheKey(engineId, lang, text));
}

function cacheSet(engineId, lang, text, value) {
  if (cache.size > CACHE_LIMIT) {
    let drop = 1000;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (--drop <= 0) break;
    }
  }
  cache.set(cacheKey(engineId, lang, text), value);
}

/* ---------------------- 带降级的翻译主流程 ---------------------- */

/**
 * 依次尝试主引擎和备选引擎，任一成功即返回。
 * 这是「不会像浏览器自带翻译一样整体失效」的关键。
 */
async function translateWithFallback(texts, targetLang, settings) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { engine: null, translations: [], cached: 0 };
  }

  let order;
  if (settings.engine === 'auto') {
    let primary = null;
    try {
      primary = await pickEngine(settings);
    } catch (e) {
      // 探测失败 ≠ 翻译一定失败。探测只是快速判断，不能当成硬门槛，
      // 否则一次网络抖动就会让整个功能彻底不可用。
      console.warn('[网页翻译助手] 引擎探测未通过，改为逐个直接尝试：', e && e.message);
    }
    order = primary
      ? [primary, ...AUTO_ORDER.filter(id => id !== primary)]
      : [...AUTO_ORDER];
  } else if (settings.engine === 'custom') {
    order = ['custom'];
  } else {
    order = [settings.engine, ...AUTO_ORDER.filter(id => id !== settings.engine)];
  }

  // 先看缓存，只请求没命中过的
  const missingIndexes = [];
  const missingTexts = [];
  const results = new Array(texts.length).fill(null);
  let cachedCount = 0;

  texts.forEach((t, i) => {
    for (const id of order) {
      const hit = cacheGet(id, targetLang, t);
      if (typeof hit === 'string') {
        results[i] = hit;
        cachedCount++;
        return;
      }
    }
    missingIndexes.push(i);
    missingTexts.push(t);
  });

  if (missingTexts.length === 0) {
    return { engine: order[0], translations: results, cached: cachedCount };
  }

  let lastError = null;
  for (const engineId of order) {
    try {
      const translated = await runEngine(engineId, missingTexts, targetLang, settings);

      // 质量校验：某个引擎对一批文本大量返回空、或返回的其实是接口错误提示，
      // 说明这轮不可靠，直接换下一个。没有这道检查，整页会被错误文本覆盖。
      const bad = translated.filter(t =>
        typeof t !== 'string' || !t.trim() || looksLikeApiError(t)).length;
      if (translated.length >= 3 && bad / translated.length > 0.4) {
        throw new Error('返回结果异常（' + bad + '/' + translated.length + ' 条不可用）');
      }

      missingIndexes.forEach((originalIndex, k) => {
        const value = translated[k];
        if (typeof value !== 'string' || !value.trim()) return;   // 个别空结果保留原文
        if (looksLikeApiError(value)) return;                     // 单条是接口报错，丢弃
        results[originalIndex] = value;
        cacheSet(engineId, targetLang, missingTexts[k], value);
      });
      return { engine: engineId, translations: results, cached: cachedCount };
    } catch (e) {
      lastError = e;
      console.warn('[网页翻译助手] 引擎 ' + engineId + ' 失败：', e && e.message);
    }
  }

  throw lastError || new Error('翻译失败');
}

/* ---------------------------- 角标 ---------------------------- */

async function setBadge(tabId, text, color) {
  if (typeof tabId !== 'number') return;
  try {
    await chrome.action.setBadgeText({ tabId, text: text || '' });
    if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch (_) { /* 标签页可能已关闭 */ }
}

/* -------------------------- 消息处理 -------------------------- */

async function handleMessage(msg, sender) {
  switch (msg && msg.type) {
    case 'TRANSLATE': {
      const settings = await getSettings();
      const targetLang = msg.targetLang || settings.targetLang;
      const result = await translateWithFallback(msg.texts || [], targetLang, settings);
      return { ok: true, ...result, targetLang };
    }

    case 'GET_SETTINGS':
      return { ok: true, settings: await getSettings() };

    case 'SET_SETTINGS': {
      const settings = await setSettings(msg.patch || {});
      if (msg.patch && Object.prototype.hasOwnProperty.call(msg.patch, 'engine')) {
        try { await chrome.storage.session.remove('probeCache'); } catch (_) {}
      }
      return { ok: true, settings };
    }

    case 'PROBE_ENGINES': {
      const settings = await getSettings();
      const ids = msg.engineIds || [...AUTO_ORDER, 'custom'];
      const entries = await Promise.all(ids.map(async id => {
        if (id === 'custom' && !settings.customBaseUrl) {
          return [id, { ok: false, ms: 0, error: '未配置接口地址' }];
        }
        const r = await probeEngine(id, settings);
        await writeProbe(id, r);
        return [id, r];
      }));
      return { ok: true, results: Object.fromEntries(entries) };
    }

    case 'ACTIVE_ENGINE': {
      const settings = await getSettings();
      try {
        const engine = await pickEngine(settings);
        return { ok: true, engine, name: (ENGINES[engine] || {}).name || engine };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case 'CLEAR_CACHE':
      cache.clear();
      try { await chrome.storage.session.remove('probeCache'); } catch (_) {}
      return { ok: true };

    case 'BADGE': {
      const tabId = sender && sender.tab ? sender.tab.id : msg.tabId;
      await setBadge(tabId, msg.text || '', msg.color || '#2563eb');
      return { ok: true };
    }

    // 页面内的按键兜底（见 content.js 的 installHotkey）
    case 'HOTKEY_TOGGLE': {
      const tabId = sender && sender.tab ? sender.tab.id : msg.tabId;
      await toggleInTab(tabId);
      return { ok: true };
    }

    default:
      return { ok: false, error: '未知消息类型：' + (msg && msg.type) };
  }
}

/**
 * 统一的消息入口。
 * 注意：只注册这一个 onMessage 监听器，避免多个监听器互相抢答 sendResponse。
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  // 页面状态上报：同步处理，立即回执
  if (msg.type === 'PAGE_STATE') {
    if (sender && sender.tab && typeof sender.tab.id === 'number') {
      tabState.set(sender.tab.id, { ...msg.state, ts: Date.now() });
    }
    sendResponse({ ok: true });
    return false;
  }

  // 弹窗查询页面状态
  if (msg.type === 'GET_PAGE_STATE') {
    sendResponse({ ok: true, state: tabState.get(msg.tabId) || null });
    return false;
  }

  handleMessage(msg, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
  return true;
});

/* ------------------------ 右键菜单与快捷键 ------------------------ */

const MENU_ITEMS = [
  { id: 'wt-translate-page', title: '翻译此页面', contexts: ['page'] },
  { id: 'wt-restore-page', title: '还原原文', contexts: ['page'] },
  { id: 'wt-sep', type: 'separator', contexts: ['page', 'selection'] },
  { id: 'wt-translate-selection', title: '翻译选中内容', contexts: ['selection'] }
];

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const item of MENU_ITEMS) {
      // 分隔符不能带 title，普通项必须带 title，两者属性不同，不能混着传
      const props = { id: item.id, contexts: item.contexts || ['page'] };
      if (item.type === 'separator') {
        props.type = 'separator';
      } else {
        props.title = item.title;
      }
      chrome.contextMenus.create(props, () => {
        // 主动读一次 lastError，否则它会冒到扩展错误页变成未捕获异常
        void chrome.runtime.lastError;
      });
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  buildMenus();
  // 重装 / 更新后清掉上一轮的探测结果，避免旧的失败记录影响第一次翻译
  chrome.storage.session.remove('probeCache').catch(() => {});
});
chrome.runtime.onStartup.addListener(buildMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || typeof tab.id !== 'number') return;
  const frameId = typeof info.frameId === 'number' ? info.frameId : 0;

  if (info.menuItemId === 'wt-translate-page' || info.menuItemId === 'wt-restore-page') {
    const action = info.menuItemId === 'wt-translate-page' ? 'TRANSLATE_PAGE' : 'RESTORE_PAGE';
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'COMMAND', action }, { frameId });
    } catch (_) {
      // content script 未注入（如刚安装），补注入后重试
      await injectContentScript(tab.id);
      chrome.tabs.sendMessage(tab.id, { type: 'COMMAND', action }, { frameId }).catch(() => {});
    }
    return;
  }

  if (info.menuItemId === 'wt-translate-selection') {
    const text = (info.selectionText || '').trim();
    if (!text) return;
    await setBadge(tab.id, '…', '#2563eb');
    try {
      const settings = await getSettings();
      const result = await translateWithFallback([text], settings.targetLang, settings);
      chrome.tabs.sendMessage(tab.id, {
        type: 'SHOW_SELECTION_TRANSLATION',
        original: text,
        translated: result.translations[0] || '',
        engine: result.engine,
        targetLang: result.targetLang
      }, { frameId }).catch(() => {});
      await setBadge(tab.id, '', '#2563eb');
    } catch (e) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'SHOW_SELECTION_TRANSLATION',
        original: text,
        translated: '',
        error: (e && e.message) || '翻译失败'
      }, { frameId }).catch(() => {});
      await setBadge(tab.id, '!', '#dc2626');
    }
  }
});

let lastToggleAt = 0;

/**
 * 统一的「切换翻译」入口。
 * 浏览器快捷键和页面内按键兜底都会走到这里，必须节流：
 * 同一次按键如果被执行两遍，就会翻译完立刻又被还原，看起来就是「没反应」。
 */
async function toggleInTab(tabId) {
  if (typeof tabId !== 'number') return;
  const now = Date.now();
  if (now - lastToggleAt < 600) return;
  lastToggleAt = now;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'COMMAND', action: 'TOGGLE' });
  } catch (_) {
    await injectContentScript(tabId);
    chrome.tabs.sendMessage(tabId, { type: 'COMMAND', action: 'TOGGLE' }).catch(() => {});
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-translate') return;
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (target) await toggleInTab(target.id);
});

/* --------------------- 兜底注入（针对安装前已打开的页面） --------------------- */

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content/content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ['content/content.css']
    });
  } catch (e) {
    console.warn('[网页翻译助手] 注入失败：', e && e.message);
  }
}

/* ------------------- 标签页状态（用于弹窗显示） ------------------- */

chrome.tabs.onRemoved.addListener(tabId => tabState.delete(tabId));
