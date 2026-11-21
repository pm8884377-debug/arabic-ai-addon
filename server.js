// ============================================================
//  Netflix Arabic AI  v4  —  ترجمة عربية سينمائية (Gemini / OpenAI / Claude)
//  إضافة Stremio: تجلب أفضل ترجمة إنجليزية وتترجمها للعربية
//  مع الحفاظ على التوقيت. يكفي مفتاح واحد: GEMINI_API_KEY (مجاني) أو OPENAI_API_KEY أو ANTHROPIC_API_KEY
// ============================================================
'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// ---------- الإعدادات ----------
const GKEY = (process.env.GEMINI_API_KEY || '').trim();
const BASE = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const PORT = process.env.PORT || 7000;
const MODELS = [...new Set([process.env.GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'].filter(Boolean))];
const SRC = 'https://opensubtitles-v3.strem.io/subtitles';
const BATCH = parseInt(process.env.BATCH || '200', 10);        // عدد الأسطر في كل طلب
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10); // طلبات متوازية
const PROMPT_VERSION = 'v4';
const RLM = process.env.RTL_MARK === '0' ? '' : '\u200F';       // علامة اتجاه يمين-لليسار
const CACHE_DIR = path.join(os.tmpdir(), 'arabic-ai-cache');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { /* تجاهل */ }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hasArabic = s => /[\u0600-\u06FF]/.test(s);
const stripTags = s => s.replace(/<[^>]+>/g, '');
const needsTranslation = s => /[A-Za-z]{3,}/.test(stripTags(s));

// ---------- تعليمات المترجم (جوهر الجودة) ----------
const SYSTEM = `You are a senior Arabic subtitle translator at the level of Netflix's best localization teams.
Translate English subtitles into natural, elegant Modern Standard Arabic (فصحى مبسطة) that a Gulf, Levantine or North-African viewer reads effortlessly.

QUALITY RULES
1. Translate MEANING and intent, never word-for-word. Rebuild each sentence the way a native Arabic screenwriter would say it. Adapt idioms, slang, sarcasm and humor to equivalent Arabic expressions; if no equivalent exists, convey the sense briefly.
2. Subtitles are read at speed: be concise. Aim for at most 42 characters per line and 2 lines per subtitle. Cut filler words, but never lose meaning, tone or a joke.
3. Keep each character's voice: tough, polite, funny, formal, childish. Use simple Fusha (no regional dialect), with register matching the speaker.
4. Profanity: translate with the same intensity in strong but natural Arabic. Do not censor and do not exaggerate.
5. Names: transliterate character names into Arabic consistently (same spelling every time). Keep famous titles and brands natural (e.g. "Mr." → "السيد", "Doctor" → "دكتور").
6. A subtitle may be a fragment of a sentence that continues in the next line. Translate so the pieces read smoothly together, but still return exactly one output per input line.
7. Sound cues in [brackets] or (parentheses) must be translated briefly (e.g. [door slams] → [صفعة باب]). Keep ♪ music notes and any lyrics lines natural.
8. Preserve: line breaks (\\n), leading dashes for speaker changes ("- "), and tags such as <i>…</i>. Use Arabic punctuation: ، ؟ ؛ and keep numbers as Western digits (0-9).
9. Lines that contain only symbols, numbers or non-linguistic text stay unchanged.

INPUT: a JSON object {"before":[...], "lines":[...], "after":[...]}.
"before" and "after" are neighbouring subtitles for context ONLY — do NOT translate them.
OUTPUT: a JSON array of strings with exactly the same length and order as "lines". No explanations, no extra text.`;

// ---------- مزوّدو الذكاء الاصطناعي (Gemini مجاني + احتياطي مدفوع اختياري) ----------
const OKEY = (process.env.OPENAI_API_KEY || '').trim();
const AKEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const OPENAI_MODELS = [...new Set([process.env.OPENAI_MODEL, 'gpt-4o-mini', 'gpt-4.1-mini'].filter(Boolean))];
const ANTHROPIC_MODELS = [...new Set([process.env.ANTHROPIC_MODEL, 'claude-haiku-5-5', 'claude-sonnet-4-6'].filter(Boolean))];
const ORDER = (process.env.PROVIDER_ORDER || 'gemini,openai,anthropic').split(',').map(x => x.trim());
const HAS = { gemini: !!GKEY, openai: !!OKEY, anthropic: !!AKEY };
const cool = {}; // مزوّد فشل قبل قليل → يُتجاوز مؤقتاً

let goodModel = null;
const goodCfg = {};
const CONFIGS = [
  { schema: true, think0: true },
  { schema: true, think0: false },
  { schema: false, think0: false }
];
const SAFETY = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
  .map(category => ({ category, threshold: 'BLOCK_NONE' }));

function genConfig(c) {
  const g = { temperature: 0.3, responseMimeType: 'application/json', maxOutputTokens: 16000 };
  if (c.schema) g.responseSchema = { type: 'ARRAY', items: { type: 'STRING' } };
  if (c.think0) g.thinkingConfig = { thinkingBudget: 0 };
  return g;
}

let active = 0;
const waiters = [];
async function acquire() {
  if (active < CONCURRENCY) { active++; return; }
  await new Promise(r => waiters.push(r));
}
function release() {
  const w = waiters.shift();
  if (w) w(); else active--;
}

async function httpJson(url, headers, body, timeout) {
  const r = await fetch(url, {
    method: 'POST', signal: AbortSignal.timeout(timeout),
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
  });
  let j = {};
  try { j = await r.json(); } catch (e) { /* تجاهل */ }
  return { r, j };
}

async function callGemini({ system, content, models, timeout = 90000 }) {
  if (!GKEY) throw new Error('GEMINI_API_KEY غير موجود');
  const order = models || (goodModel ? [goodModel, ...MODELS.filter(m => m !== goodModel)] : MODELS);
  let lastError = '';
  for (const model of order) {
    for (let ci = goodCfg[model] || 0; ci < CONFIGS.length; ci++) {
      let r, j;
      try {
        ({ r, j } = await httpJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { 'x-goog-api-key': GKEY },
          {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: content }] }],
            generationConfig: genConfig(CONFIGS[ci]),
            safetySettings: SAFETY
          }, timeout));
      } catch (e) { lastError = `[gemini:${model}] ${e.message}`; break; }
      const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
      const text = parts ? parts.map(p => p.text || '').join('') : '';
      if (text) { goodModel = model; goodCfg[model] = ci; return { text, model: 'gemini:' + model }; }
      const why = (j.error && j.error.message) || (j.promptFeedback && j.promptFeedback.blockReason) ||
        (j.candidates && j.candidates[0] && j.candidates[0].finishReason) || JSON.stringify(j);
      lastError = `[gemini:${model}] ${r.status} ${String(why).slice(0, 700)}`;
      console.error(lastError);
      if (r.status !== 400) break; // 400 = إعداد غير مدعوم → جرّب إعداداً أبسط، غير ذلك → النموذج التالي
    }
  }
  throw new Error(lastError || 'لا يوجد رد من Gemini');
}

async function callOpenAI({ system, content, models, timeout = 90000 }) {
  let lastError = '';
  for (const model of (models || OPENAI_MODELS)) {
    try {
      const { r, j } = await httpJson('https://api.openai.com/v1/chat/completions', { authorization: 'Bearer ' + OKEY },
        { model, messages: [{ role: 'system', content: system }, { role: 'user', content }] }, timeout);
      const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (text) return { text, model: 'openai:' + model };
      lastError = `[openai:${model}] ${r.status} ${String((j.error && j.error.message) || JSON.stringify(j)).slice(0, 500)}`;
    } catch (e) { lastError = `[openai:${model}] ${e.message}`; }
    console.error(lastError);
  }
  throw new Error(lastError);
}

async function callAnthropic({ system, content, models, timeout = 90000 }) {
  let lastError = '';
  for (const model of (models || ANTHROPIC_MODELS)) {
    try {
      const { r, j } = await httpJson('https://api.anthropic.com/v1/messages',
        { 'x-api-key': AKEY, 'anthropic-version': '2023-06-01' },
        { model, max_tokens: 16000, system, messages: [{ role: 'user', content }] }, timeout);
      const text = j.content && j.content[0] && j.content[0].text;
      if (text) return { text, model: 'anthropic:' + model };
      lastError = `[anthropic:${model}] ${r.status} ${String((j.error && j.error.message) || JSON.stringify(j)).slice(0, 500)}`;
    } catch (e) { lastError = `[anthropic:${model}] ${e.message}`; }
    console.error(lastError);
  }
  throw new Error(lastError);
}

const PROVIDERS = { gemini: callGemini, openai: callOpenAI, anthropic: callAnthropic };

// يجرّب المزوّدين المتاحين بالترتيب، وينتقل للتالي عند الفشل
async function callAI({ system, content, timeout = 90000 }) {
  let list = ORDER.filter(p => HAS[p]);
  if (!list.length) throw new Error('لا يوجد أي مفتاح: أضف GEMINI_API_KEY (مجاني) أو OPENAI_API_KEY أو ANTHROPIC_API_KEY في Render ← Environment');
  const ready = list.filter(p => !(cool[p] > Date.now()));
  if (ready.length) list = ready; // تجاوز المزوّد الذي فشل قبل قليل
  await acquire();
  try {
    const errors = [];
    for (const p of list) {
      try {
        const r = await PROVIDERS[p]({ system, content, timeout });
        cool[p] = 0;
        return r;
      } catch (e) { errors.push(e.message); cool[p] = Date.now() + 3 * 60 * 1000; }
    }
    throw new Error(errors.join(' || '));
  } finally { release(); }
}

// ---------- معالجة ملفات SRT ----------
const TIME_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
const AD_RE = /opensubtitles|osdb\.link|advertise your product|vip member|yts\.(mx|am|lt)|yify/i;

function parseSrt(txt) {
  const blocks = txt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/);
  const cues = [];
  const p2 = n => n.padStart(2, '0'), ms = n => n.padEnd(3, '0');
  for (const b of blocks) {
    const lines = b.split('\n');
    const ti = lines.findIndex(l => TIME_RE.test(l));
    if (ti < 0) continue;
    const m = lines[ti].match(TIME_RE);
    const time = `${p2(m[1])}:${m[2]}:${m[3]},${ms(m[4])} --> ${p2(m[5])}:${m[6]}:${m[7]},${ms(m[8])}`;
    const text = lines.slice(ti + 1).join('\n').replace(/\{\\[^}]*\}/g, '').trim();
    if (!text || AD_RE.test(text)) continue;
    cues.push({ time, text });
  }
  return cues;
}

function formatText(t) {
  t = t.replace(/\s*\n\s*/g, '\n').trim();
  if (!t.includes('\n') && stripTags(t).length > 42) {          // سطر طويل → سطرين متوازنين
    const mid = Math.floor(t.length / 2);
    let best = -1;
    for (let d = 0; d < mid; d++) {
      if (t[mid - d] === ' ') { best = mid - d; break; }
      if (t[mid + d] === ' ') { best = mid + d; break; }
    }
    if (best > 0) t = t.slice(0, best) + '\n' + t.slice(best + 1);
  }
  return t.split('\n').map(l => (l.trim() ? RLM + l : l)).join('\n');
}

async function downloadText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(25000), redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  let buf = Buffer.from(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  let txt = new TextDecoder('utf-8').decode(buf);
  if ((txt.match(/\uFFFD/g) || []).length > 5) txt = new TextDecoder('windows-1252').decode(buf);
  return txt;
}

async function getMeta(type, id) {
  try {
    const imdb = id.split(':')[0];
    const r = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdb}.json`, { signal: AbortSignal.timeout(8000) });
    const m = (await r.json()).meta || {};
    let s = `Title: ${m.name || ''}${m.year ? ' (' + m.year + ')' : ''}`;
    if (m.genres && m.genres.length) s += `\nGenres: ${m.genres.join(', ')}`;
    if (m.description) s += `\nSynopsis: ${String(m.description).slice(0, 500)}`;
    if (type === 'series') { const [, se, ep] = id.split(':'); if (se) s += `\nEpisode: Season ${se}, Episode ${ep}`; }
    return m.name ? s : '';
  } catch (e) { return ''; }
}

// ---------- الترجمة ----------
function parseArr(t) {
  const clean = String(t).replace(/^```(?:json)?|```$/gm, '').trim();
  const tryParse = x => { try { return JSON.parse(x); } catch (e) { return undefined; } };
  let v = tryParse(clean);
  if (v === undefined) {
    const a = clean.indexOf('['), b = clean.lastIndexOf(']');
    if (a >= 0 && b > a) v = tryParse(clean.slice(a, b + 1));
  }
  if (!Array.isArray(v) && v && typeof v === 'object') v = Object.values(v).find(Array.isArray);
  return Array.isArray(v) ? v : null;
}

function validOutput(input, out) {
  if (!Array.isArray(out) || out.length !== input.length || out.some(x => typeof x !== 'string')) return false;
  const need = input.map((_, i) => i).filter(i => needsTranslation(input[i]));
  if (!need.length) return true;
  const bad = need.filter(i => !hasArabic(out[i]));
  return bad.length / need.length <= 0.2;
}

async function translateRange(cues, start, end, sys, stats, job) {
  const input = cues.slice(start, end).map(c => c.text);
  const ctx = {
    before: cues.slice(Math.max(0, start - 4), start).map(c => c.text),
    lines: input,
    after: cues.slice(end, end + 2).map(c => c.text)
  };
  let apiFailed = false;
  for (let a = 0; a < 3; a++) {
    if (a) await sleep(7000 * a);
    try {
      const r = await callAI({ system: sys, content: JSON.stringify(ctx) });
      const arr = parseArr(r.text);
      if (validOutput(input, arr)) { job.done += input.length; return arr; }
      apiFailed = false;
      console.error(`مخرجات غير صالحة (${input.length} أسطر، رجع ${Array.isArray(arr) ? arr.length : 'غير مصفوفة'})`);
    } catch (e) { apiFailed = true; stats.lastErr = e.message; }
  }
  // المخرجات غير صالحة (وليس خطأ API) → قسّم الدفعة وأعد المحاولة
  if (!apiFailed && input.length > 6) {
    const mid = start + Math.ceil(input.length / 2);
    const a = await translateRange(cues, start, mid, sys, stats, job);
    const b = await translateRange(cues, mid, end, sys, stats, job);
    return a.concat(b);
  }
  stats.failed += input.length;
  job.done += input.length;
  return input; // الأصل (يُحتسب كفشل)
}

const jobs = new Map();
const sources = new Map();

async function runJob(key, info, job) {
  const file = path.join(CACHE_DIR, key + '.srt');
  try { if (fs.existsSync(file)) { job.total = job.done = 1; return fs.readFileSync(file, 'utf8'); } } catch (e) { /* تجاهل */ }

  const meta = await getMeta(info.type, info.id);
  let cues = [];
  for (const url of info.candidates) {
    try {
      const c = parseSrt(await downloadText(url));
      if (c.length >= 10) { cues = c; break; }
    } catch (e) { console.error('فشل تحميل الترجمة المصدر:', e.message); }
  }
  if (!cues.length) throw new Error('تعذر الحصول على ترجمة إنجليزية صالحة لهذا العنوان');

  job.total = cues.length;
  const sys = SYSTEM + (meta ? '\n\nTITLE CONTEXT (for tone, genre and names only):\n' + meta : '');
  info.parts = info.parts || new Map();
  if (info.parts.size && info.cueCount !== cues.length) info.parts.clear();
  info.cueCount = cues.length;

  const ranges = [];
  for (let i = 0; i < cues.length; i += BATCH) ranges.push([i, Math.min(i + BATCH, cues.length)]);
  const rangeStats = [];
  const results = await Promise.all(ranges.map(async ([s, e]) => {
    const k = `${s}-${e}`;
    if (info.parts.has(k)) { job.done += e - s; return info.parts.get(k); }
    const st = { failed: 0, lastErr: '' };
    rangeStats.push(st);
    const out = await translateRange(cues, s, e, sys, st, job);
    if (st.failed === 0) info.parts.set(k, out);   // الأجزاء الناجحة تبقى لإعادة المحاولة
    return out;
  }));

  const failed = rangeStats.reduce((n, x) => n + x.failed, 0);
  if (failed > 0) {
    const why = rangeStats.map(x => x.lastErr).find(Boolean) || 'مخرجات غير صالحة';
    throw new Error(`الترجمة غير مكتملة (${failed} سطر)، أعد اختيار الترجمة بعد دقيقة. السبب: ${why}`);
  }
  const flat = results.flat();
  const srt = cues.map((c, i) => `${i + 1}\n${c.time}\n${formatText(flat[i] && flat[i].trim() ? flat[i] : c.text)}\n`).join('\n');
  try { fs.writeFileSync(file, srt); } catch (e) { /* تجاهل */ }
  return srt;
}

function startJob(key, info) {
  const job = { state: 'running', done: 0, total: 0, startedAt: Date.now(), title: info.id };
  job.promise = runJob(key, info, job).then(
    srt => { job.state = 'done'; return srt; },
    e => { job.state = 'error'; job.error = e.message; console.error('فشلت المهمة:', e.message); jobs.delete(key); throw e; }
  );
  job.promise.catch(() => {});
  jobs.set(key, job);
  if (jobs.size > 200) jobs.delete(jobs.keys().next().value);
  return job;
}

// ---------- الخادم ----------
const app = express();
app.set('trust proxy', true);
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  next();
});

const baseOf = req => BASE || `${req.protocol}://${req.get('host')}`;

app.get('/manifest.json', (req, res) => res.json({
  id: 'community.arabic.ai.subs.gemini',
  version: '4.0.0',
  name: 'Netflix Arabic AI',
  description: 'ترجمة عربية سينمائية بالذكاء الاصطناعي لجميع الأفلام والمسلسلات',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
}));

app.get(/^\/subtitles\/(movie|series)\/([^/]+?)(?:\/[^/]*)?\.json$/, handleSubs);

async function handleSubs(req, res) {
  try {
    const type = req.params[0];
    const id = decodeURIComponent(req.params[1]);
    const key = crypto.createHash('sha1').update(`${PROMPT_VERSION}|${type}|${id}`).digest('hex').slice(0, 20);
    const cached = fs.existsSync(path.join(CACHE_DIR, key + '.srt'));

    if (!jobs.has(key)) {
      let info = sources.get(key);
      if (!info) {
        let candidates = [];
        if (!cached) {
          const r = await fetch(`${SRC}/${type}/${id}.json`, { signal: AbortSignal.timeout(9000) });
          const { subtitles = [] } = await r.json();
          candidates = subtitles.filter(s => s.lang === 'eng' && s.url).slice(0, 3).map(s => s.url);
          if (!candidates.length) return res.json({ subtitles: [] });
        }
        info = { type, id, candidates, parts: new Map() };
        sources.set(key, info);
      }
      startJob(key, info);          // تبدأ الترجمة فوراً في الخلفية
    }
    res.json({ subtitles: [{ id: 'ai-ar-' + key, url: `${baseOf(req)}/srt/${key}.srt`, lang: 'ara' }] });
  } catch (e) {
    console.error('subtitles error:', e.message);
    res.json({ subtitles: [] });
  }
}

app.get('/srt/:key.srt', async (req, res) => {
  const key = req.params.key;
  let job = jobs.get(key);
  if (!job) {
    const file = path.join(CACHE_DIR, key + '.srt');
    if (fs.existsSync(file)) return res.type('text/plain; charset=utf-8').send(fs.readFileSync(file, 'utf8'));
    const info = sources.get(key);
    if (!info) return res.status(404).send('Unknown subtitle. Reopen the title in Stremio.');
    job = startJob(key, info);
  }
  try {
    const srt = await job.promise;
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('text/plain; charset=utf-8').send(srt);
  } catch (e) {
    res.status(503).send('Translation failed: ' + e.message);
  }
});

// ---------- صفحات المساعدة ----------
app.get('/health', (req, res) => res.send('ok'));

app.get('/test', async (req, res) => {
  const content = JSON.stringify({ before: ['Where are you going?'], lines: ["I'm not afraid of you.", 'You should be.', '- Get down!\n- Go, go, go!'], after: [] });
  const tasks = [];
  if (HAS.gemini) MODELS.slice(0, 5).forEach(m => tasks.push([`gemini:${m}`, () => callGemini({ system: SYSTEM, content, models: [m], timeout: 30000 })]));
  if (HAS.openai) tasks.push(['openai', () => callOpenAI({ system: SYSTEM, content, timeout: 30000 })]);
  if (HAS.anthropic) tasks.push(['anthropic', () => callAnthropic({ system: SYSTEM, content, timeout: 30000 })]);
  if (!tasks.length) return res.json({ ok: false, error: 'لا يوجد أي مفتاح في Render ← Environment' });
  const results = await Promise.all(tasks.map(async ([name, fn]) => {
    const t0 = Date.now();
    const seconds = () => +((Date.now() - t0) / 1000).toFixed(1);
    try { const r = await fn(); return { name, ok: true, seconds: seconds(), result: parseArr(r.text) || r.text }; }
    catch (e) { return { name, ok: false, seconds: seconds(), error: e.message }; }
  }));
  res.json({ ok: results.some(r => r.ok), results });
});

app.get('/debug', async (req, res) => {
  const info = { providers: HAS, order: ORDER, geminiKeyLength: GKEY.length, geminiKeyStart: GKEY.slice(0, 4), geminiModels: MODELS, workingGeminiModel: goodModel };
  if (!GKEY) return res.json(info);
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', { signal: AbortSignal.timeout(15000), headers: { 'x-goog-api-key': GKEY } });
    const j = await r.json();
    info.listStatus = r.status;
    if (j.models) info.flashModels = j.models.map(m => m.name.replace('models/', '')).filter(n => /flash/.test(n)).slice(0, 15);
    else info.listError = (j.error && j.error.message) || JSON.stringify(j).slice(0, 300);
  } catch (e) { info.listError = e.message; }
  res.json(info);
});

app.get('/status', (req, res) => {
  res.json([...jobs.entries()].map(([key, j]) => ({
    key, title: j.title, state: j.state,
    progress: j.total ? Math.round(100 * j.done / j.total) + '%' : '0%',
    seconds: Math.round((Date.now() - j.startedAt) / 1000)
  })));
});

app.get('/', (req, res) => {
  const host = req.get('host');
  res.type('html').send(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Netflix Arabic AI</title><body style="font-family:sans-serif;max-width:520px;margin:30px auto;padding:0 16px;line-height:2">
<h2>Netflix Arabic AI</h2><p>إضافة ترجمة عربية سينمائية لستريميو.</p>
<p><a href="stremio://${host}/manifest.json" style="display:block;background:#7b5bf5;color:#fff;padding:14px;border-radius:10px;text-align:center;text-decoration:none">تثبيت في ستريميو</a></p>
<p>روابط مفيدة: <a href="/test">اختبار Gemini</a> · <a href="/status">حالة الترجمات</a> · <a href="/debug">تشخيص</a></p></body></html>`);
});

module.exports = { app, parseSrt, formatText, validOutput, parseArr, translateRange, runJob, startJob, jobs, handleSubs, callGemini, callAI, SYSTEM };

if (require.main === module) {
  app.listen(PORT, () => console.log('Netflix Arabic AI v3 (Gemini) running on', PORT));
  if (BASE && process.env.KEEP_ALIVE !== '0') {
    setInterval(() => fetch(BASE + '/health', { signal: AbortSignal.timeout(10000) }).catch(() => {}), 9 * 60 * 1000);
  }
}
