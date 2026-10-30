/**
 * 翻译引擎层
 * 每个引擎实现统一签名：translate(texts: string[], targetLang: string, cfg) -> Promise<string[]>
 * 返回数组长度必须与输入一致，顺序一致。
 */

// 统一语言代码 -> 各引擎语言代码
export const LANGS = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: 'English / 英语' },
  { code: 'ja', label: '日本語 / 日语' },
  { code: 'ko', label: '한국어 / 韩语' },
  { code: 'fr', label: 'Français / 法语' },
  { code: 'de', label: 'Deutsch / 德语' },
  { code: 'es', label: 'Español / 西班牙语' },
  { code: 'ru', label: 'Русский / 俄语' },
  { code: 'pt', label: 'Português / 葡萄牙语' },
  { code: 'it', label: 'Italiano / 意大利语' },
  { code: 'ar', label: 'العربية / 阿拉伯语' },
  { code: 'th', label: 'ไทย / 泰语' },
  { code: 'vi', label: 'Tiếng Việt / 越南语' },
  { code: 'id', label: 'Indonesia / 印尼语' },
  { code: 'tr', label: 'Türkçe / 土耳其语' },
  { code: 'nl', label: 'Nederlands / 荷兰语' },
  { code: 'pl', label: 'Polski / 波兰语' },
  { code: 'uk', label: 'Українська / 乌克兰语' }
];

const LANG_TABLE = {
  tencent: { 'zh-CN': 'zh', 'zh-TW': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru', pt: 'pt', it: 'it', ar: 'ar', th: 'th', vi: 'vi', id: 'id', tr: 'tr', nl: 'nl', pl: 'pl', uk: 'uk' },
  google: { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru', pt: 'pt', it: 'it', ar: 'ar', th: 'th', vi: 'vi', id: 'id', tr: 'tr', nl: 'nl', pl: 'pl', uk: 'uk' },
  youdao: { 'zh-CN': 'zh-CHS', 'zh-TW': 'zh-CHT', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru', pt: 'pt', it: 'it', ar: 'ar', th: 'th', vi: 'vi', id: 'id', tr: 'tr', nl: 'nl', pl: 'pl', uk: 'uk' },
  mymemory: { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru', pt: 'pt', it: 'it', ar: 'ar', th: 'th', vi: 'vi', id: 'id', tr: 'tr', nl: 'nl', pl: 'pl', uk: 'uk' }
};

function langOf(engine, code) {
  const t = LANG_TABLE[engine];
  return (t && t[code]) || code;
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------------ */
/* 腾讯翻译君（国内直连，支持批量，默认首选）                            */
/* ------------------------------------------------------------------ */
async function tencentTranslate(texts, targetLang) {
  const out = new Array(texts.length).fill('');
  // 按条数 + 字符数双重分片
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const t of texts) {
    if (cur.length >= 40 || chars + t.length > 4500) {
      if (cur.length) batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(t);
    chars += t.length;
  }
  if (cur.length) batches.push(cur);

  let offset = 0;
  for (const batch of batches) {
    const body = {
      header: {
        fn: 'auto_translation',
        client_key: 'browser-chrome-131.0.0-Windows'
      },
      type: 'plain',
      model_category: 'normal',
      source: { lang: 'auto', text_list: batch },
      target: { lang: langOf('tencent', targetLang) }
    };
    const { signal, done } = withTimeout(15000);
    let data;
    try {
      const res = await fetch('https://transmart.qq.com/api/imt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });
      data = await res.json();
    } finally {
      done();
    }
    if (!data || !data.header || data.header.ret_code !== 'succ') {
      throw new Error('腾讯翻译返回异常：' + JSON.stringify(data && data.header || {}).slice(0, 120));
    }
    const list = data.auto_translation || [];
    for (let i = 0; i < batch.length; i++) {
      out[offset + i] = typeof list[i] === 'string' ? list[i] : '';
    }
    offset += batch.length;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Google 免费接口（质量最好，但需要网络可达）                          */
/* ------------------------------------------------------------------ */
async function googleTranslate(texts, targetLang) {
  const tl = langOf('google', targetLang);
  const out = new Array(texts.length).fill('');

  // 单次请求只接受一个 q，用有限并发逐条翻译
  const CONCURRENCY = 4;
  let idx = 0;

  async function worker() {
    while (idx < texts.length) {
      const i = idx++;
      const text = texts[i];
      if (!text.trim()) { out[i] = text; continue; }
      const url = 'https://translate.googleapis.com/translate_a/single'
        + '?client=gtx&sl=auto&dt=t&tl=' + encodeURIComponent(tl)
        + '&q=' + encodeURIComponent(text);
      const { signal, done } = withTimeout(12000);
      try {
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const segs = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
        out[i] = segs.map(s => (s && s[0]) || '').join('') || text;
      } finally {
        done();
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker));
  return out;
}

/* ------------------------------------------------------------------ */
/* 有道智云演示接口（国内直连，单条）                                   */
/* ------------------------------------------------------------------ */
async function youdaoTranslate(texts, targetLang) {
  const to = langOf('youdao', targetLang);
  const out = new Array(texts.length).fill('');
  const CONCURRENCY = 3;
  let idx = 0;

  async function worker() {
    while (idx < texts.length) {
      const i = idx++;
      const text = texts[i];
      if (!text.trim()) { out[i] = text; continue; }
      const url = 'https://aidemo.youdao.com/trans?from=Auto&to=' + encodeURIComponent(to)
        + '&q=' + encodeURIComponent(text.slice(0, 2000));
      const { signal, done } = withTimeout(12000);
      try {
        const res = await fetch(url, { signal });
        const data = await res.json();
        const arr = data && data.translation;
        // 有道对部分文本会返回 null。此时标记为空串交给上层判断是否降级，
        // 绝不能退回原文——那会把「没翻译」伪装成「翻译成功」。
        if (Array.isArray(arr) && arr.length) {
          out[i] = arr.join('');
        } else if (typeof arr === 'string') {
          out[i] = arr;
        } else {
          out[i] = '';
        }
      } finally {
        done();
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker));
  return out;
}

/* ------------------------------------------------------------------ */
/* MyMemory（免费兜底，有配额限制）                                     */
/* ------------------------------------------------------------------ */

/**
 * 粗略判断源语言。
 * MyMemory 不接受 auto（会返回 403 和一段错误提示），必须给具体语言代码；
 * 用 autodetect 虽然不报错，但它会直接把原文原样返回，等于没翻。
 */
function guessSourceLang(text) {
  const kana = (text.match(/[\u3040-\u30FF]/g) || []).length;
  const hangul = (text.match(/[\uAC00-\uD7AF]/g) || []).length;
  const cjk = (text.match(/[\u4E00-\u9FFF]/g) || []).length;
  const cyrillic = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (kana > 0) return 'ja';
  if (hangul > 0) return 'ko';
  if (cyrillic > latin) return 'ru';
  if (cjk > 0 && cjk >= latin * 0.5) return 'zh-CN';
  return 'en';
}

/**
 * 识别「译文其实是接口报错」的情况。
 * 这类文本一旦写进页面，会把整页内容覆盖掉，必须在写入前拦下来。
 */
export function looksLikeApiError(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  if (/INVALID\s+(SOURCE|TARGET)\s+LANGUAGE|LANGPAIR\s*=|RFC3066|QUOTA|API\s*KEY|RATE\s*LIMIT|TOO\s+MANY\s+REQUESTS/i.test(t)) {
    return true;
  }
  // 全大写的长英文句子，通常是接口错误提示
  if (t.length > 40 && t === t.toUpperCase() && /[A-Z]{4,}/.test(t)) return true;
  return false;
}

async function mymemoryTranslate(texts, targetLang) {
  const to = langOf('mymemory', targetLang);
  const out = new Array(texts.length).fill('');
  let failed = 0;

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    if (!text.trim()) { out[i] = text; continue; }

    const src = guessSourceLang(text);
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text.slice(0, 480))
      + '&langpair=' + encodeURIComponent(src + '|' + to);

    const { signal, done } = withTimeout(12000);
    try {
      const res = await fetch(url, { signal });
      const data = await res.json();

      const status = Number(data && data.responseStatus);
      if (status && status !== 200) {
        out[i] = '';
        failed++;
        continue;
      }

      const t = data && data.responseData && data.responseData.translatedText;
      if (typeof t !== 'string' || !t) {
        out[i] = '';
        failed++;
        continue;
      }
      // 有些错误会以 200 返回，正文却是错误提示
      out[i] = looksLikeApiError(t) ? '' : t;
      if (!out[i]) failed++;
    } catch (_) {
      out[i] = '';
      failed++;
    } finally {
      done();
    }
  }

  if (texts.length >= 3 && failed / texts.length > 0.5) {
    throw new Error('MyMemory 多数请求失败（' + failed + '/' + texts.length + '）');
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 自定义 OpenAI 兼容接口                                              */
/* ------------------------------------------------------------------ */
async function customTranslate(texts, targetLang, cfg) {
  const base = String(cfg.customBaseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置自定义接口地址');

  const langLabel = (LANGS.find(l => l.code === targetLang) || {}).label || targetLang;
  const prompt = [
    '你是专业的网页翻译引擎。将下面 JSON 数组中的每个字符串翻译成' + langLabel + '。',
    '规则：',
    '1. 只输出一个 JSON 数组，元素个数和顺序必须与输入完全一致，不要输出任何解释、注释或代码块标记。',
    '2. 保留原文中的 URL、邮箱、代码、变量名、数字、专有名词和占位符（如 {0}、%s、$1）不要翻译。',
    '3. 如果某条文本已经是目标语言，或只是符号、数字，原样返回。',
    '4. 译文要通顺自然，符合网页语境，不要逐字硬译。'
  ].join('\n');

  const out = new Array(texts.length).fill('');
  const batches = chunk(texts.map((t, i) => ({ i, t })), 20);

  for (const batch of batches) {
    const payload = {
      model: cfg.customModel || 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: JSON.stringify(batch.map(x => x.t)) }
      ]
    };
    const { signal, done } = withTimeout(60000);
    let data;
    try {
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.customApiKey ? { Authorization: 'Bearer ' + cfg.customApiKey } : {})
        },
        body: JSON.stringify(payload),
        signal
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error('自定义接口 HTTP ' + res.status + '：' + txt.slice(0, 160));
      }
      data = await res.json();
    } finally {
      done();
    }

    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '') : '';
    let parsed = null;
    const cleaned = content.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    try {
      const candidate = JSON.parse(cleaned);
      if (Array.isArray(candidate)) parsed = candidate;
    } catch (_) { /* 落到下面的行分割兜底 */ }

    if (!parsed) {
      const lines = cleaned.split('\n').map(s => s.trim()).filter(Boolean);
      parsed = lines.length === batch.length ? lines : null;
    }
    if (!parsed || parsed.length !== batch.length) {
      throw new Error('自定义接口返回格式不正确，期望 ' + batch.length + ' 条，实际 '
        + (parsed ? parsed.length : 0) + ' 条');
    }
    batch.forEach((item, k) => {
      out[item.i] = typeof parsed[k] === 'string' ? parsed[k] : item.t;
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 引擎注册表                                                          */
/* ------------------------------------------------------------------ */
export const ENGINES = {
  tencent: {
    id: 'tencent',
    name: '腾讯翻译君',
    note: '国内直连 · 支持批量 · 免密钥',
    run: (t, l) => tencentTranslate(t, l)
  },
  google: {
    id: 'google',
    name: 'Google 翻译',
    note: '质量最好 · 需能访问 Google',
    run: (t, l) => googleTranslate(t, l)
  },
  youdao: {
    id: 'youdao',
    name: '有道翻译',
    note: '国内直连 · 单条请求',
    run: (t, l) => youdaoTranslate(t, l)
  },
  mymemory: {
    id: 'mymemory',
    name: 'MyMemory',
    note: '免费兜底 · 每日有配额',
    run: (t, l) => mymemoryTranslate(t, l)
  },
  custom: {
    id: 'custom',
    name: '自定义 API',
    note: 'OpenAI 兼容接口 · 质量可控',
    run: (t, l, cfg) => customTranslate(t, l, cfg)
  }
};

/**
 * 自动模式的候选顺序。
 * Google 放最后：国内基本连不通，排在前面每轮探测都要白等满超时。
 * 腾讯 / 有道 / MyMemory 都是国内直连，正常情况第一个就命中。
 */
export const AUTO_ORDER = ['tencent', 'youdao', 'mymemory', 'google'];

export async function runEngine(engineId, texts, targetLang, cfg = {}) {
  const engine = ENGINES[engineId];
  if (!engine) throw new Error('未知翻译引擎：' + engineId);
  const result = await engine.run(texts, targetLang, cfg);
  if (!Array.isArray(result) || result.length !== texts.length) {
    throw new Error(engine.name + ' 返回条数不匹配');
  }
  return result;
}

/** 探测单个引擎是否可用，返回 { ok, ms, error } */
export async function probeEngine(engineId, cfg = {}, timeoutMs = 8000) {
  const started = Date.now();
  try {
    const r = await Promise.race([
      runEngine(engineId, ['Hello world'], 'zh-CN', cfg),
      new Promise((_, reject) => setTimeout(() => reject(new Error('探测超时')), timeoutMs))
    ]);
    const text = (r && r[0]) || '';
    if (!text || !/[^\s]/.test(text)) throw new Error('返回空结果');
    return { ok: true, ms: Date.now() - started, sample: text.slice(0, 60) };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: (e && e.message) || String(e) };
  }
}
