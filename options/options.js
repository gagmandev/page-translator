import { LANGS } from '../lib/engines.js';

const $ = (s) => document.querySelector(s);

const ENGINE_META = [
  { id: 'auto', name: '自动选择', note: '按优先级自动选择，失败自动降级', badge: '推荐' },
  { id: 'tencent', name: '腾讯翻译君', note: '国内直连 · 支持批量 · 免密钥' },
  { id: 'google', name: 'Google 翻译', note: '质量最好 · 需要能访问 Google' },
  { id: 'youdao', name: '有道翻译', note: '国内直连 · 单条请求' },
  { id: 'mymemory', name: 'MyMemory', note: '免费兜底 · 每日有配额限制' },
  { id: 'custom', name: '自定义 API', note: 'OpenAI 兼容接口 · 质量可控' }
];

const TESTABLE = ['tencent', 'google', 'youdao', 'mymemory', 'custom'];

let settings = null;
let saveTimer = null;

/* ---------------------------- 保存 ---------------------------- */

function scheduleSave(patch) {
  Object.assign(settings, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', patch });
    flashSaved();
  }, 350);
}

function flashSaved() {
  const tip = $('#saved-tip');
  tip.classList.add('show');
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => tip.classList.remove('show'), 1400);
}

/* ---------------------------- 渲染 ---------------------------- */

function renderEngines() {
  const list = $('#engine-list');
  list.innerHTML = '';

  for (const meta of ENGINE_META) {
    const label = document.createElement('label');
    label.className = 'engine' + (settings.engine === meta.id ? ' selected' : '');
    label.dataset.engine = meta.id;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'engine';
    radio.value = meta.id;
    radio.checked = settings.engine === meta.id;

    const body = document.createElement('div');
    body.className = 'e-body';

    const name = document.createElement('div');
    name.className = 'e-name';
    name.textContent = meta.name;
    if (meta.badge) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = meta.badge;
      name.appendChild(badge);
    }

    const note = document.createElement('div');
    note.className = 'e-note';
    note.textContent = meta.note;

    body.append(name, note);

    const status = document.createElement('span');
    status.className = 'e-status';
    status.dataset.status = meta.id;

    label.append(radio, body, status);

    radio.addEventListener('change', () => {
      settings.engine = meta.id;
      document.querySelectorAll('.engine').forEach(el => {
        el.classList.toggle('selected', el.dataset.engine === meta.id);
      });
      updateCustomVisibility();
      scheduleSave({ engine: meta.id });
      // 切换引擎后清掉旧的探测结果，避免误导
      clearStatuses();
    });

    list.appendChild(label);
  }
  updateCustomVisibility();
}

function updateCustomVisibility() {
  $('#custom-box').classList.toggle('hidden', settings.engine !== 'custom');
}

function clearStatuses() {
  document.querySelectorAll('.e-status').forEach(el => {
    el.textContent = '';
    el.className = 'e-status';
  });
}

function setStatus(id, kind, text) {
  const el = document.querySelector('.e-status[data-status="' + id + '"]');
  if (!el) return;
  el.className = 'e-status ' + kind;
  el.textContent = text;
  el.title = text;
}

function renderLangs() {
  const sel = $('#target-lang');
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

function renderForm() {
  $('#custom-base').value = settings.customBaseUrl || '';
  $('#custom-key').value = settings.customApiKey || '';
  $('#custom-model').value = settings.customModel || '';
  $('#auto-translate').checked = !!settings.autoTranslate;
  $('#floating-ball').checked = settings.showFloatingBall !== false;
  $('#exclude').value = (settings.excludeHosts || []).join('\n');
}

/* ---------------------------- 测试引擎 ---------------------------- */

async function testAll() {
  const btn = $('#btn-test');
  btn.disabled = true;
  btn.textContent = '测试中…';
  clearStatuses();
  TESTABLE.forEach(id => setStatus(id, 'testing', '测试中…'));

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'PROBE_ENGINES',
      engineIds: TESTABLE
    });
    if (!res || !res.ok) throw new Error((res && res.error) || '测试失败');

    for (const id of TESTABLE) {
      const r = res.results[id] || { ok: false, error: '无结果' };
      if (r.ok) {
        setStatus(id, 'ok', '✓ ' + r.ms + 'ms');
      } else {
        const short = String(r.error || '失败').slice(0, 28);
        setStatus(id, 'fail', '✗ ' + short);
      }
    }
  } catch (e) {
    TESTABLE.forEach(id => setStatus(id, 'fail', '✗ 测试出错'));
  } finally {
    btn.disabled = false;
    btn.textContent = '测试全部';
  }
}

/* ---------------------------- 事件绑定 ---------------------------- */

function bindEvents() {
  $('#target-lang').addEventListener('change', e => {
    scheduleSave({ targetLang: e.target.value });
  });

  $('#mode-group').addEventListener('click', e => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    settings.mode = btn.dataset.mode;
    renderMode();
    scheduleSave({ mode: btn.dataset.mode });
  });

  $('#custom-base').addEventListener('input', e => {
    scheduleSave({ customBaseUrl: e.target.value.trim() });
  });
  $('#custom-key').addEventListener('input', e => {
    scheduleSave({ customApiKey: e.target.value.trim() });
  });
  $('#custom-model').addEventListener('input', e => {
    scheduleSave({ customModel: e.target.value.trim() });
  });

  $('#auto-translate').addEventListener('change', e => {
    scheduleSave({ autoTranslate: e.target.checked });
  });
  $('#floating-ball').addEventListener('change', e => {
    scheduleSave({ showFloatingBall: e.target.checked });
  });

  $('#exclude').addEventListener('input', e => {
    const hosts = e.target.value
      .split('\n')
      .map(s => s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean);
    scheduleSave({ excludeHosts: hosts });
  });

  $('#btn-test').addEventListener('click', testAll);

  // 直接跳到浏览器的扩展快捷键设置页
  $('#btn-shortcuts').addEventListener('click', async () => {
    const isEdge = /Edg\//.test(navigator.userAgent);
    const url = (isEdge ? 'edge://' : 'chrome://') + 'extensions/shortcuts';
    try {
      await chrome.tabs.create({ url });
    } catch (_) {
      alert('请在地址栏手动打开：\n' + url);
    }
  });

  $('#btn-clear').addEventListener('click', async () => {
    const btn = $('#btn-clear');
    btn.disabled = true;
    await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    btn.textContent = '已清除';
    setTimeout(() => {
      btn.textContent = '清除翻译缓存';
      btn.disabled = false;
    }, 1400);
  });
}

/** 显示浏览器实际分配的快捷键（manifest 里的只是建议值，可能因冲突未被采纳） */
async function renderHotkey() {
  const kbd = document.getElementById('hotkey-kbd');
  if (!kbd) return;
  try {
    const cmds = await chrome.commands.getAll();
    const cmd = cmds.find(c => c.name === 'toggle-translate');
    const sc = (cmd && cmd.shortcut) || '';
    kbd.textContent = sc || 'Alt+T（页面内）';
    kbd.title = sc
      ? '浏览器已分配全局快捷键'
      : '浏览器未分配全局快捷键，但网页内按 Alt+T 依然可用';
  } catch (_) { /* 保持默认文案 */ }
}

/* ---------------------------- 初始化 ---------------------------- */

async function init() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  settings = (res && res.settings) || {};

  renderEngines();
  renderLangs();
  renderMode();
  renderForm();
  bindEvents();
  renderHotkey();
}

init().catch(err => {
  document.body.insertAdjacentHTML('afterbegin',
    '<div style="padding:16px;color:#dc2626">加载设置失败：' + (err && err.message) + '</div>');
});
