// Translates each cue independently so the subtitle timing is never sent to or
// rewritten by the translation service. Replace this with a self-hosted Argos
// Translate endpoint for a fully self-managed no-subscription deployment.
async function translateCue(text) {
  const endpoint = process.env.TRANSLATE_URL;
  if (!endpoint) throw new Error('TRANSLATE_URL is not configured');
  const body = new URLSearchParams({
    q: text,
    source: 'en',
    target: 'ar',
    format: 'text'
  });
  if (process.env.TRANSLATE_API_KEY) body.set('api_key', process.env.TRANSLATE_API_KEY);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Translation service returned ${response.status}`);
  const data = await response.json();
  if (!data.translatedText) throw new Error('Translation service returned an empty result');
  return data.translatedText;
}
async function translateCues(cues) {
  const translated = [];
  // Small concurrency keeps free/community endpoints from being overwhelmed.
  for (let i = 0; i < cues.length; i += 3) {
    const group = cues.slice(i, i + 3);
    const results = await Promise.all(group.map(async cue => ({
      ...cue,
      text: await translateCue(cue.text)
    })));
    translated.push(...results);
  }
  return translated;
}
module.exports = { translateCues };
