// Netflix Arabic AI — نسخة Gemini المجانية فقط
const express = require('express');
const crypto = require('crypto');
const app = express();

const GKEY = process.env.GEMINI_API_KEY;
const BASE = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const MODELS = [process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-2.0-flash'].filter(Boolean);
const SRC = 'https://opensubtitles-v3.strem.io/subtitles';
const BATCH = 80, PARALLEL = 2;

const jobs = new Map();
const sources = new Map();
let goodModel = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SYS = `أنت مترجم سينمائي محترف بمستوى Netflix. ستستلم مصفوفة JSON من أسطر ترجمة (غالباً إنجليزية).
أعد مصفوفة JSON بنفس العدد والترتيب بالضبط، كل عنصر هو الترجمة العربية الفصحى المبسطة لسطر المصدر.
القواعد: صياغة طبيعية وسلسة وليست حرفية؛ اختصر لتناسب القراءة السريعة؛ حافظ على نبرة الشخصية؛
أبقِ فواصل الأسطر \\n كما هي؛ أبقِ الرموز مثل ♪؛ ترجم الشتائم بما يناسب الفصحى.
لا تضف شرحاً ولا تدمج الأسطر. أعد JSON فقط.`;

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  next();
});

app.get('/manifest.json', (req, res) => res.json({
  id: 'community.arabic.ai.subs.gemini',
  version: '2.0.1',
  name: 'Netflix Arabic AI',
  description: 'ترجمة عربية سينمائية بالذكاء الاصطناعي (Gemini) لجميع الأفلام والمسلسلات',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
}));

async function callGemini(content, maxModels = 99) {
  if (!GKEY) throw new Error('GEMINI_API_KEY غير موجود في إعدادات Render');
  const list = (goodModel ? [goodModel] : MODELS).slice(0, maxModels);
  let lastError = '';
  for (const model of list) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        signal: AbortSignal.timeout(25000),
        headers: { 'content-type': 'application/json', 'x-goog-api-key': GKEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYS }] },
          contents: [{ role: 'user', parts: [{ text: content }] }],
          generationConfig: { temperature: 0.3, responseMimeType: 'application/json' }
        })
      });
      const j = await r.json();
      const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
      if (parts) { goodModel = model; return { text: parts.map(p => p.text || '').join(''), model }; }
      lastError = `[${model}] ` + ((j.error && j.error.message) || JSON.stringify(j)).slice(0, 300);
      if (r.status === 429) await sleep(6000);
    } catch (e) { lastError = `[${model}] ` + e.message; }
    console.error('Gemini error:', lastError);
  }
  throw new Error(lastError);
}

app.get('/test', async (req, res) => {
  try {
    const r = await callGemini('["Hello, how are you?","I will be back."]', 2);
    res.json({ ok: true, model: r.model, result: r.text });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/debug', async (req, res) => {
  const info = { hasKey: !!GKEY, keyLength: GKEY ? GKEY.length : 0, keyStart: GKEY ? GKEY.slice(0, 4) : '', baseUrl: BASE, workingModel: goodModel };
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
      signal: AbortSignal.timeout(15000),
      headers: { 'x-goog-api-key': GKEY || '' }
    });
    const j = await r.json();
    info.listStatus = r.status;
    if (j.models) info.flashModels = j.models.map(m => m.name.replace('models/', '')).filter(n => /flash/.test(n)).slice(0, 15);
    else info.listError = (j.error && j.error.message) || JSON.stringify(j).slice(0, 300);
  } catch (e) { info.listError = e.message; }
  res.json(info);
});

function parseSrt(txt) {
  return txt.replace(/^\uFEFF/, '').replace(/\r/g, '').trim().split(/\n\n+/).map(b => {
    const l = b.split('\n');
    const i = l.findIndex(x => x.includes('-->'));
    return i < 0 ? null : { time: l[i].trim(), text: l.slice(i + 1).join('\n') };
  }).filter(Boolean);
}

async function translateBatch(batch) {
  for (let a = 0; a < 4; a++) {
    if (a) await sleep(5000 * a);
    try {
      const r = await callGemini(JSON.stringify(batch.map(c => c.text)));
      const arr = JSON.parse(r.text.replace(/```json|```/g, '').trim());
      if (Array.isArray(arr) && arr.length === batch.length) return arr.map(String);
    } catch (e) { console.error('batch error:', e.message); }
  }
  return null;
}

async function translateSrt(url) {
  const cues = parseSrt(await (await fetch(url)).text());
  if (!cues.length) throw new Error('الترجمة المصدر فارغة');
  const batches = [];
  for (let i = 0; i < cues.length; i += BATCH) batches.push(cues.slice(i, i + BATCH));
  const out = new Array(batches.length);
  let next = 0, failed = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < batches.length) {
      const i = next++;
      out[i] = await translateBatch(batches[i]);
      if (!out[i]) failed++;
    }
  }));
  if (failed === batches.length) throw new Error('فشلت كل الدفعات');
  const flat = out.map((o, i) => o || batches[i].map(c => c.text)).flat();
  return cues.map((c, i) => `${i + 1}\n${c.time}\n${flat[i]}\n`).join('\n');
}

function startJob(key, url) {
  const p = translateSrt(url);
  p.catch(e => { console.error('job failed:', e.message); jobs.delete(key); });
  jobs.set(key, p);
}

app.get(/^\/subtitles\/(movie|series)\/([^/]+?)(?:\/[^/]*)?\.json$/, async (req, res) => {
  try {
    const type = req.params[0], id = decodeURIComponent(req.params[1]);
    const r = await fetch(`${SRC}/${type}/${id}.json`);
    const { subtitles = [] } = await r.json();
    const eng = subtitles.find(s => s.lang === 'eng');
    if (!eng) return res.json({ subtitles: [] });
    const key = crypto.createHash('sha1').update(eng.url).digest('hex').slice(0, 16);
    sources.set(key, eng.url);
    if (!jobs.has(key)) startJob(key, eng.url);
    res.json({ subtitles: [{ id: 'ai-ar-' + key, url: `${BASE}/srt/${key}.srt`, lang: 'ara' }] });
  } catch (e) {
    res.json({ subtitles: [] });
  }
});

app.get('/srt/:key.srt', async (req, res) => {
  const { key } = req.params;
  if (!jobs.has(key) && sources.has(key)) startJob(key, sources.get(key));
  if (!jobs.has(key)) return res.sendStatus(404);
  try {
    res.type('text/plain; charset=utf-8').send(await jobs.get(key));
  } catch (e) {
    res.status(500).send('translation failed');
  }
});

app.listen(process.env.PORT || 7000, () => console.log('Netflix Arabic AI (Gemini) running'));
