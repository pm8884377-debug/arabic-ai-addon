const express = require('express');
const crypto = require('crypto');
const app = express();

const KEY = process.env.ANTHROPIC_API_KEY;
const BASE = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const MODEL = process.env.MODEL || 'claude-haiku-5-5';
const SRC = 'https://opensubtitles-v3.strem.io/subtitles';
const BATCH = 50, PARALLEL = 4;

const jobs = new Map();   // key -> Promise<string> (الترجمة الجاهزة)
const sources = new Map(); // key -> رابط الترجمة الإنجليزية

const SYS = `أنت مترجم سينمائي محترف بمستوى Netflix. ستستلم مصفوفة JSON من أسطر ترجمة إنجليزية.
أعد مصفوفة JSON بنفس العدد والترتيب بالضبط، كل عنصر هو الترجمة العربية الفصحى المبسطة لسطر المصدر.
القواعد: صياغة طبيعية وسلسة وليست حرفية؛ اختصر لتناسب القراءة السريعة؛ حافظ على نبرة الشخصية؛
أبقِ فواصل الأسطر \\n كما هي؛ أبقِ الرموز مثل ♪ والأسماء العلمية؛ ترجم الشتائم بما يناسب الفصحى دون تلطيف مبالغ.
أعد JSON فقط بلا أي شرح.`;

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  next();
});

app.get('/manifest.json', (req, res) => res.json({
  id: 'community.arabic.ai.subs',
  version: '1.0.0',
  name: 'Netflix Arabic AI',
  description: 'ترجمة عربية سينمائية بالذكاء الاصطناعي لجميع الأفلام والمسلسلات',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
}));

function parseSrt(txt) {
  return txt.replace(/^\uFEFF/, '').replace(/\r/g, '').trim().split(/\n\n+/).map(b => {
    const l = b.split('\n');
    const i = l.findIndex(x => x.includes('-->'));
    return i < 0 ? null : { time: l[i].trim(), text: l.slice(i + 1).join('\n') };
  }).filter(Boolean);
}

async function translateBatch(batch) {
  const body = {
    model: MODEL, max_tokens: 8000, system: SYS,
    messages: [{ role: 'user', content: JSON.stringify(batch.map(c => c.text)) }]
  };
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body)
      });
      const j = await r.json();
      const arr = JSON.parse(j.content[0].text.replace(/```json|```/g, '').trim());
      if (Array.isArray(arr) && arr.length === batch.length) return arr.map(String);
    } catch (e) { /* إعادة المحاولة */ }
  }
  return batch.map(c => c.text); // احتياطي: النص الأصلي
}

async function translateSrt(url) {
  const cues = parseSrt(await (await fetch(url)).text());
  const batches = [];
  for (let i = 0; i < cues.length; i += BATCH) batches.push(cues.slice(i, i + BATCH));
  const out = new Array(batches.length);
  let next = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < batches.length) {
      const i = next++;
      out[i] = await translateBatch(batches[i]);
    }
  }));
  const flat = out.flat();
  return cues.map((c, i) => `${i + 1}\n${c.time}\n${flat[i]}\n`).join('\n');
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
    if (!jobs.has(key)) jobs.set(key, translateSrt(eng.url)); // يبدأ فوراً في الخلفية
    res.json({ subtitles: [{ id: 'ai-ar-' + key, url: `${BASE}/srt/${key}.srt`, lang: 'ara' }] });
  } catch (e) {
    res.json({ subtitles: [] });
  }
});

app.get('/srt/:key.srt', async (req, res) => {
  const { key } = req.params;
  if (!jobs.has(key) && sources.has(key)) jobs.set(key, translateSrt(sources.get(key)));
  if (!jobs.has(key)) return res.sendStatus(404);
  try {
    res.type('text/plain; charset=utf-8').send(await jobs.get(key));
  } catch (e) {
    jobs.delete(key);
    res.sendStatus(500);
  }
});

app.listen(process.env.PORT || 7000, () => console.log('Netflix Arabic AI running'));
