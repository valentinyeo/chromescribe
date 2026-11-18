# Home and video pages

## Sub-features

- Home list: category chips, rows with thumbnail, title, category and read time, search, the + Add Video button
- Video page: summary under the title, Summary and Transcript tabs, Prev, Chat on Claude, Next

## How to get to it (user POV)

Open https://chromescribe.yeoux.net, tap a row, read the summary, switch to Transcript.

## Driving it with headless Chromium

```bash
S=.claude/skills/verify-chromescribe/scripts
bash $S/launch.sh
node $S/shot.mjs / home 390 844
node $S/shot.mjs "/transcript.html?id=1" video 390 844
bash $S/cleanup.sh
```

Proof: `home-390.png` shows six "Seed video" rows and the + button; `video-390.png` shows "Seed video 1", the Summary tab selected with "Seed lead line for video 1.", and the Prev, Chat on Claude, Next bar. The printed API calls include `200 GET /api/transcripts` and `200 GET /api/transcript/1/content`.

## Gotchas

- The video page is `/transcript.html?id=<id>`; `/transcript?id=` returns 404.
- Thumbnails 404 locally because seed rows have none.
- Add Video starts a transcription that needs AI, which is off locally; prove it with `dashboard/test/` instead.
