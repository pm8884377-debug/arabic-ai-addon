const API = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'NetflixArabicAI/0.1.0';

function headers() {
  const key = process.env.OPENSUBTITLES_API_KEY;
  if (!key) throw new Error('OpenSubtitles free API key is not configured');
  return { 'Api-Key': key, 'User-Agent': USER_AGENT, 'Accept': 'application/json' };
}
async function searchSubtitle({ imdbId, season, episode, language }) {
  const url = new URL(`${API}/subtitles`);
  url.searchParams.set('imdb_id', imdbId.replace(/^tt/, ''));
  url.searchParams.set('languages', language);
  if (season != null) url.searchParams.set('season_number', season);
  if (episode != null) url.searchParams.set('episode_number', episode);
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`OpenSubtitles search failed: ${res.status}`);
  const json = await res.json();
  return (json.data || []).map(item => {
    const a = item.attributes || {};
    const file = (a.files || [])[0];
    return {
      fileId: file?.file_id,
      fileName: file?.file_name || '',
      language: a.language,
      downloads: Number(a.download_count || 0),
      hearingImpaired: Boolean(a.hearing_impaired),
      machineTranslated: Boolean(a.machine_translated),
      fps: a.fps || null
    };
  }).filter(x => x.fileId);
}
async function downloadSubtitle(fileId) {
  const res = await fetch(`${API}/download`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`OpenSubtitles download request failed: ${res.status}`);
  const data = await res.json();
  if (!data.link) throw new Error('OpenSubtitles did not return a download link');
  const fileRes = await fetch(data.link, { signal: AbortSignal.timeout(30000) });
  if (!fileRes.ok) throw new Error('Could not download subtitle file');
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  const name = (data.file_name || '').toLowerCase();
  if (name.endsWith('.zip') || buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buffer);
    const entry = zip.getEntries().find(e => /\.(srt|txt)$/i.test(e.entryName) && !e.isDirectory);
    if (!entry) throw new Error('ZIP did not contain an SRT subtitle');
    return entry.getData().toString('utf8');
  }
  return buffer.toString('utf8');
}
module.exports = { searchSubtitle, downloadSubtitle };
