import { LANGS } from '../lib/engines.js';

const $ = (s) => document.querySelector(s);

const ENGINE_LABEL = {
  auto: '自动选择引擎',
  tencent: '腾讯翻译君',
  google: 'Google 翻译',
  youdao: '有道翻译',
  mymemory: 'MyMemory',
  custom: '自定义 API'
};

let tab = null;
let settings = null;
let pageState = null;

/* ---------------------------- 与页面通信 ---------------------------- */

async function sendToTab(message) {
  if (!tab || typeof tab.id !== 'number') return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (_) {
    // content script 尚未注入（例如刚安装扩展），补注入后重试
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content/content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id, allFrames: true },
        files: ['content/content.css']
      });
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (_e) {
      return null;
    }
  }
}

/* ------------------------------ 渲染 ------------------------------ */

function renderLanguages() {
  const sel = $('#lang');
  sel.innerHTML = '';
  for (const lang of LANGS) {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.label;
    if (lang.code === settings.targetLang) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderMode() {
  document.querySelectorAll('.seg').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === settings.mode);
  });
}

function renderStatus() {
  const btn = $('#btn-main');
  const label = $('#btn-main-label');
  const stat = $('#stat');
  const engineLine = $('#engine-line');
  const notice = $('#notice');

  notice.className = 'notice hidden';
  notice.textContent = '';

  // 浏览器内部页面无法注入脚本
  const url = (tab && tab.url) || '';
  const blocked = /^(chrome|edge|about|devtools|chrome-extension|moz-extension):/i.test(url)
    || /^https:\/\/chromewebstore\.google\.com/i.test(url)
    || /^https:\/\/microsoftedge\.microsoft\.com\/addons/i.test(url);

  if (blocked) {
    btn.disabled = true;
    label.textContent = '此页面无法翻译';
    const kbd = btn.querySelector('kbd');
    if (kbd) kbd.style.display = 'none';
    stat.textContent = '浏览器内部页面';
    engineLine.textContent = ENGINE_LABEL[settings.engine] || settings.engine;
    notice.className = 'notice';
    notice.textContent = '浏览器内部页面和扩展商店不允许注入脚本，请在普通网页上使用。';
    return;
  }

  const kbd = btn.querySelector('kbd');
  if (kbd) kbd.style.display = '';
  btn.disabled = false;
  const status = pageState ? pageState.status : 'idle';

  if (status === 'translated') {
    btn.classList.add('restore');
    label.textContent = '还原原文';
    stat.textContent = '已翻译 ' + (pageState.count || 0) + ' 处';
    engineLine.textContent = (ENGINE_LABEL[pageState.engine] || pageState.engine || '')
      + ' · ' + (pageState.mode === 'dual' ? '双语对照' : '替换原文');
  } else if (status === 'translating') {
    btn.classList.remove('restore');
    btn.disabled = true;
    label.textContent = '正在翻译…';
    stat.textContent = '请稍候';
    engineLine.textContent = ENGINE_LABEL[settings.engine] || settings.engine;
  } else {
    btn.classList.remove('restore');
    label.textContent = '翻译此页';
    stat.textContent = '尚未翻译';
    engineLine.textContent = ENGINE_LABEL[settings.engine] || settings.engine;
  }

  // 自动模式下若探测失败，给个提示
  if (settings.engine === 'auto' && pageState && pageState.lastError) {
    notice.className = 'notice error';
    notice.innerHTML = '<b>翻译失败：</b>' + pageState.lastError;
  }
}

/* ------------------------------ 事件 ------------------------------ */

async function onMainClick() {
  const btn = $('#btn-main');
  const status = pageState ? pageState.status : 'idle';
  const action = status === 'translated' ? 'RESTORE_PAGE' : 'TRANSLATE_PAGE';

  btn.disabled = true;
  const res = await sendToTab({ type: 'COMMAND', action });
  if (!res) {
    btn.disabled = false;
    const notice = $('#notice');
    notice.className = 'notice error';
    notice.textContent = '无法在当前页面执行，请刷新页面后重试。';
    return;
  }
  window.close();
}

async function saveSettings(patch) {
  const res = await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', patch });
  if (res && res.ok) settings = res.settings;
}

function bindEvents() {
  $('#btn-main').addEventListener('click', onMainClick);

  $('#mode-group').addEventListener('click', async (e) => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === settings.mode) return;
    settings.mode = mode;
    renderMode();
    await saveSettings({ mode });
    // 已经翻译过的页面需要重排
    await sendToTab({ type: 'SET_MODE', mode });
    pageState = await sendToTab({ type: 'GET_CONTENT_STATE' });
    renderStatus();
  });

  $('#lang').addEventListener('change', async (e) => {
    const targetLang = e.target.value;
    settings.targetLang = targetLang;
    await saveSettings({ targetLang });
    const status = pageState ? pageState.status : 'idle';
    if (status === 'translated') {
      await sendToTab({ type: 'COMMAND', action: 'RESTORE_PAGE' });
      await sendToTab({ type: 'COMMAND', action: 'TRANSLATE_PAGE' });
      window.close();
    }
  });

  const openOptions = () => chrome.runtime.openOptionsPage();
  $('#btn-settings').addEventListener('click', openOptions);
  $('#btn-more').addEventListener('click', openOptions);
}

/* ------------------------------ 快捷键显示 ------------------------------ */

/**
 * 显示浏览器实际分配给本扩展的快捷键。
 * manifest 里的 suggested_key 只是「建议值」，可能因为冲突没被采纳，
 * 直接问 chrome.commands 才知道真实情况。
 */
async function renderHotkey() {
  const kbd = document.getElementById('hotkey-kbd');
  if (!kbd) return;
  try {
    const cmds = await chrome.commands.getAll();
    const cmd = cmds.find(c => c.name === 'toggle-translate');
    const sc = (cmd && cmd.shortcut) || '';
    if (sc) {
      kbd.textContent = sc;
      kbd.title = '浏览器已分配全局快捷键';
    } else {
      // 浏览器没采纳建议值也不影响使用：网页里有按键兜底
      kbd.textContent = 'Alt+T';
      kbd.title = '浏览器未分配全局快捷键，但在网页里按 Alt+T 依然可用';
    }
  } catch (_) { /* 查询失败就保持默认文案 */ }
}

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = activeTab;

  const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  settings = (res && res.settings) || { targetLang: 'zh-CN', mode: 'replace', engine: 'auto' };

  renderLanguages();
  renderMode();
  renderStatus();
  bindEvents();
  renderHotkey();

  pageState = await sendToTab({ type: 'GET_CONTENT_STATE' });
  renderStatus();
}

init().catch(err => {
  const notice = $('#notice');
  notice.className = 'notice error';
  notice.textContent = '初始化失败：' + (err && err.message);
});
