---
name: video
journey: video
paths:
  - dashboard/public/transcript.html
  - dashboard/src/index.ts
  - dashboard/src/timestamps.mjs
---

# Video page

The video page shows one transcript: media player or article reader, summary with a TL;DR, the full transcript, neighbour navigation, and actions such as Copy, Chat on Claude, Download MD, Summarize and Delete.

## Sub-features

- `video-summary` renders the TL;DR and Summary sections on the Summary tab.
- `video-transcript` switches between Summary and Transcript on a phone.
- `video-nav` moves to the previous or newer transcript and shows the position.
- `video-actions` offers Copy and Chat on Claude in the header plus Open original, Download MD, Read aloud, Summarize, Retranscribe and Delete in the More panel.
- `video-read-aloud` plays the spoken summary from `GET /api/speak/<id>`, cached in R2 and served with byte ranges.
- `video-commands` opens the `Ctrl+K` command menu and the `?` keyboard shortcuts dialog, and routes the single-key actions.
- `video-ai` refreshes a transcript through `POST /api/transcripts/<id>/analyze`; the Worker also exposes `POST /api/transcripts/<id>/summarize` and `POST /api/transcripts/<id>/classify` for the backfill scripts.
- `video-missing` explains a missing or unknown `id`.

## How to get to it (user POV)

- Choose any card on `/`, which opens `/transcript.html?id=<id>`.
- Open `https://chromescribe.yeoux.net/transcript.html?id=<id>` directly.
- Use the `Prev` and `Next` controls, or the `Summary` and `Transcript` tabs on a phone.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` and `cs-verify doctor` are ok.
- The newest transcript body exists in local R2.

- **Open the newest transcript.** Run `cs-verify journey video`. The journey reads the newest row from `GET /api/transcripts?limit=1`, then opens `/transcript.html?id=<id>` at 390 by 844.
- **Summary matches the body.** The journey reads `GET /api/transcript/<id>/content`, takes the `## TL;DR` block and requires its first 40 characters inside `#mobileSummary`.
- **Transcript tab.** The journey clicks the `Transcript` tab, asserts `#transcriptSide[data-tab="transcript"]`, and requires `#content` to hold the full text.
- **Navigation.** `#navCounter` matches `N / M`; the newest row has the older `Next` button enabled and the newer `Prev` button disabled, matching `GET /api/transcripts?around=<id>`.
- **More panel.** On a phone the journey clicks `#menuToggle`, asserts `#pageHeader` has `menu-open`, and checks the `#morePanel` Queue link, Read aloud, Download MD and Summarize.
- **Command menu.** `Ctrl+K` opens `#cmdk`, typing `download` narrows `#cmdkList` to the Download MD command, and `?` opens the `#shortcuts` dialog.
- **Desktop layout.** At 1280 by 800 the Summary and Transcript tabs stay, the summary column renders beside the video, and choosing Transcript shows `#content`.
- **Unknown id.** `/transcript.html` without an `id` shows `No transcript ID provided`.
- **Proof.** `proof/video/video-phone-summary.png`, `video-phone-transcript.png` and `video-desktop.png`.

## Gotchas

- The route is `/transcript.html?id=<id>`, not `/transcript?id=<id>`; the short form returns 404.
- Article transcripts (`video_id` begins `article:`) move the summary into the reader column and hide the transcript side, so the journey picks a video row.
- `Read aloud` needs the Deepgram speech API and `Summarize` needs Workers AI. Both are off locally; the journey asserts the controls are present and leaves the calls alone.
- `DELETE /api/transcripts/<id>` and Retranscribe change data. The journey leaves them alone; delete is proven on the home page with a scratch row.
