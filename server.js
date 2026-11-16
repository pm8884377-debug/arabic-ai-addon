const express = require('express');
const crypto = require('crypto');
const app = express();

const KEY = process.env.ANTHROPIC_API_KEY;
const BASE = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const MODELS = [process.env.MODEL, 'claude-haiku-5-5', 'claude-sonnet-4-6'].filter(Boolean);
const SRC = 'https://opensubtitles-v3.strem.io/subtitles';
const BATCH = 50, PARALLEL = 4;

const jobs = new Map();
const sources = new Map();
let goodModel = null;

const SYS = `أنت مترجم سينمائي محترف بمستوى Netflix. ستستلم مصفوفة JSON من أسطر ترجمة إنجليزية.
أعد مصفوفة JSON بنفس العدد والترتيب بالضبط، كل عنصر هو الترجمة العربية الفصحى المبسطة لسطر المصدر.
القواعد: صياغة طبيعية وسلسة وليست حرفية؛ اختصر لتناسب القراءة السريعة؛ حافظ على نبرة الشخصية؛
أبقِ فواصل الأسطر \\n كما هي؛ أبقِ الرموز مثل ♪؛ ترجم الشتائم بما يناسب الفصحى.
أعد JSON فقط بلا أي شرح.`;

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  next();
});

app.get('/manifest.json', (req, res) => res.json({
  id: 'community.arabic.ai.subs',
  version: '1.0.1',
  name: 'Netflix Arabic AI',
  description: 'ترجمة عربية سينمائية بالذكاء الاصطناعي لجميع الأفلام والمسلسلات',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
}));

async function callClaude(content) {
  if (!KEY) throw new Error('ANTHROPIC_API_KEY غير موجود في إعدادات Render');
  const list = goodModel ? [goodModel] : MODELS;
  let lastError = '';
  for (const model of list) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 8000, system: SYS, messages: [{ role: 'user', content }] })
      });
      const j = await r.json();
      if (j.content && j.content[0]) { goodModel = model; return { text: j.content[0].text, model }; }
      lastError = `[${model}] ` + ((j.error && j.error.message) || JSON.stringify(j));
    } catch (e) { lastError = `[${model}] ` + e.message; }
    console.error('Claude error:', lastError);
  }
  throw new Error(lastError);
}

app.get('/test', async (req, res) => {
  try {
    const r = await callClaude('["Hello, how are you?","I will be back."]');
    res.json({ ok: true, model: r.model, result: r.text });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function parseSrt(txt) {
  return txt.replace(/^\uFEFF/, '').replace(/\r/g, '').trim().split(/\n\n+/).map(b => {
    const l = b.split('\n');
    const i = l.findIndex(x => x.includes('-->'));
    return i < 0 ? null : { time: l[i].trim(), text: l.slice(i + 1).join('\n') };
  }).filter(Boolean);
}

async function translateBatch(batch) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await callClaude(JSON.stringify(batch.map(c => c.text)));
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

app.listen(process.env.PORT || 7000, () => console.log('Netflix Arabic AI running'));
