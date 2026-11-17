# Netflix Arabic AI — Stremio Add-on Starter

This is a **starter build**, not a finished public service. It implements a Stremio subtitle resource, an OpenSubtitles.com search/download adapter, SRT parsing, Arabic translation through a LibreTranslate-compatible endpoint, and a cache.

## What works in this first build

- Exposes `/manifest.json` and `/subtitles/{type}/{id}.json` for Stremio.
- Searches Arabic subtitles first; otherwise searches English and translates it.
- Copies every cue's start/end timestamps unchanged into WebVTT.
- Caches generated subtitles so the same episode is not translated repeatedly.
- CORS is enabled for Stremio.

## Important limitations

1. Stremio add-ons are remote HTTP services. Stremio Android does not execute this Node.js project inside the app. You must deploy this service to an HTTPS host.
2. OpenSubtitles requires a **free API consumer key**. The API has usage/download limits. This is not a paid subscription, but it is not keyless.
3. Translation depends on the configured LibreTranslate-compatible service. Public instances can be slow, rate-limited, or unavailable. For a fully self-managed translation backend, run Argos Translate on the same server and expose a LibreTranslate-compatible API.
4. This starter preserves the source subtitle timestamps exactly. It does not claim audio-based synchronization against every stream. True audio alignment requires access to the actual video/audio; many HTTP/debrid sources do not expose that to a subtitle add-on.
5. First release supports SRT input. ASS/SSA styling and other formats are not converted yet.

## Run locally

```bash
cp .env.example .env
# Fill OPENSUBTITLES_API_KEY, TRANSLATE_URL, and PUBLIC_URL
npm install
npm start
```

Check `http://localhost:7000/health` and `http://localhost:7000/manifest.json`.

## Deploy

Deploy the folder as a Node 20 web service using the included Dockerfile. Set these environment variables in the hosting dashboard:

- `PUBLIC_URL`: the public HTTPS base URL, with no trailing slash.
- `OPENSUBTITLES_API_KEY`: your free OpenSubtitles API consumer key.
- `TRANSLATE_URL`: a LibreTranslate-compatible `/translate` endpoint.
- `TRANSLATE_API_KEY`: optional, only if your translation endpoint requires it.

Persistent disk storage is recommended for `CACHE_DIR`. A free host may sleep, restart, or remove stored cache, so permanent zero-cost uptime cannot be guaranteed.

## Install in Stremio Android

After deployment, open this URL in Stremio:

`https://YOUR-HOST.example/manifest.json`

Or paste the URL into Stremio's Add-ons search/install field.

## Next engineering milestones

- Add more subtitle providers and rank by release/file match, FPS, language quality, and uploader trust.
- Add subtitle format detection and ASS/SSA handling.
- Add a dedicated Argos Translate worker and chunk-aware contextual translation.
- Add audio-reference alignment only for sources where the server can safely access the actual media timeline.
- Add regression tests for timing preservation and episode identification.
