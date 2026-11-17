// SRT parser/serializer. Cue timestamps are preserved as integer milliseconds.
function toMs(h, m, s, ms) {
  return (((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000) + Number(ms);
}
function fromMs(value) {
  const n = Math.max(0, Math.round(value));
  const h = Math.floor(n / 3600000);
  const m = Math.floor((n % 3600000) / 60000);
  const s = Math.floor((n % 60000) / 1000);
  const ms = n % 1000;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}
function parseSrt(input) {
  const normalized = input.replace(/^\uFEFF/, '').replace(/\r/g, '').trim();
  const blocks = normalized.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const timeIndex = lines.findIndex(line => line.includes('-->'));
    if (timeIndex < 0) continue;
    const match = lines[timeIndex].match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!match) continue;
    cues.push({
      index: cues.length + 1,
      startMs: toMs(...match.slice(1,5)),
      endMs: toMs(...match.slice(5,9)),
      text: lines.slice(timeIndex + 1).join('\n').trim()
    });
  }
  return cues;
}
function serializeSrt(cues) {
  return cues.map((cue, i) =>
    `${i + 1}\n${fromMs(cue.startMs)} --> ${fromMs(cue.endMs)}\n${cue.text}`
  ).join('\n\n') + '\n';
}
function serializeVtt(cues) {
  return 'WEBVTT\n\n' + cues.map(cue =>
    `${fromMs(cue.startMs).replace(',', '.')} --> ${fromMs(cue.endMs).replace(',', '.')}\n${cue.text}`
  ).join('\n\n') + '\n';
}
module.exports = { parseSrt, serializeSrt, serializeVtt };
