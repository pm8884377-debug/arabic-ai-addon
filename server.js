const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { searchSubtitle, downloadSubtitle } = require('./opensubtitles');
const { parseSrt, serializeVtt } = require('./srt');
const { translateCues } = require('./translate');

const app = express();
const PORT = Number(process.env.PORT || 7000);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CACHE_DIR = process.env.CACHE_DIR || './cache';
fs.mkdirSync(CACHE_DIR, { recursive: true });

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const manifest = {
  id: 'org.netflixarabicai.subtitles',
  version: '0.1.0',
  name: 'Netflix Arabic AI',
  description: 'Arabic subtitles translated from English while preserving original cue timings.',
  resources: [{ name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: false, configurationRequired: false }
};
app.get('/manifest.json', (_req, res) => res.json(manifest));

function safeImdbId(id) {
  const match = String(id || '').match(/tt\d+/);
  return match ? match[0] : null;
}
function cachePath(key) { return path.join(CACHE_DIR, `${key}.vtt`); }

app.get('/subtitles/:type/:id.json', async (req, res) => {
  try {
    const imdbId = safeImdbId(req.params.id);
    if (!imdbId) return res.json({ subtitles: [] });
    const season = req.query.season;
    const episode = req.query.episode;
    const cacheKey = crypto.createHash('sha256')
      .update([imdbId, season || '', episode || '', 'ar-v1'].join('|')).digest('hex');
    const file = cachePath(cacheKey);

    if (!fs.existsSync(file)) {
      // Prefer an existing Arabic subtitle. If none exists, translate the best
      // English candidate. Timing values are copied cue-for-cue without edits.
      const arabic = await searchSubtitle({ imdbId, season, episode, language: 'ara' });
      let sourceText;
      if (arabic.length) {
        const chosen = arabic.sort((a,b) => b.downloads - a.downloads)[0];
        sourceText = await downloadSubtitle(chosen.fileId);
        const cues = parseSrt(sourceText);
        if (!cues.length) throw new Error('Arabic subtitle is not a supported SRT file');
        fs.writeFileSync(file, serializeVtt(cues), 'utf8');
      } else {
        const english = await searchSubtitle({ imdbId, season, episode, language: 'eng' });
        const candidates = english
          .filter(x => !x.machineTranslated)
          .sort((a,b) => b.downloads - a.downloads);
        if (!candidates.length) return res.json({ subtitles: [] });
        sourceText = await downloadSubtitle(candidates[0].fileId);
        const cues = parseSrt(sourceText);
        if (!cues.length) throw new Error('English subtitle is not a supported SRT file');
        const translated = await translateCues(cues);
        fs.writeFileSync(file, serializeVtt(translated), 'utf8');
      }
    }

    return res.json({
      subtitles: [{
        id: `naai-ar-${cacheKey.slice(0, 16)}`,
        lang: 'ara',
        label: 'العربية — Netflix Arabic AI',
        url: `${PUBLIC_URL}/subtitle/${cacheKey}.vtt`
      }]
    });
  } catch (error) {
    console.error('[subtitle request]', error.message);
    return res.status(200).json({ subtitles: [] });
  }
});

app.get('/subtitle/:key.vtt', (req, res) => {
  if (!/^[a-f0-9]{64}$/.test(req.params.key)) return res.sendStatus(404);
  const file = cachePath(req.params.key);
  if (!fs.existsSync(file)) return res.sendStatus(404);
  res.type('text/vtt; charset=utf-8').send(fs.readFileSync(file, 'utf8'));
});

app.get('/health', (_req, res) => res.json({ ok: true, name: manifest.name, version: manifest.version }));
app.listen(PORT, () => console.log(`Netflix Arabic AI listening on ${PORT}`));
