---
name: video
journey: video
paths:
  - dashboard/public/transcript.html
---

# Video page

The video page shows one transcript: media player or article reader, summary with a TL;DR, the full transcript, neighbour navigation, and actions such as Copy, Chat on Claude, Download MD, Summarize and Delete.

## Sub-features

- `video-summary` renders the TL;DR and Summary sections on the Summary tab.
- `video-transcript` switches between Summary and Transcript on a phone.
- `video-nav` moves to the previous or newer transcript and shows the position.
- `video-actions` opens the More panel with Copy, Chat on Claude, Download MD, Summarize, Retranscribe and Delete.
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
- **Navigation.** `#navCounter` matches `N / M`, and the newer neighbour button is enabled for the newest row.
- **More panel.** The journey clicks `#moreToggle`, asserts `#moreMenu` has `open`, and checks the Queue link, Download MD and Summarize.
- **Desktop layout.** At 1280 by 800 the Summary and Transcript tabs stay, the summary column renders beside the video, and choosing Transcript shows `#content`.
- **Unknown id.** `/transcript.html` without an `id` shows `No transcript ID provided`.
- **Proof.** `proof/video/video-phone-summary.png`, `video-phone-transcript.png` and `video-desktop.png`.

## Gotchas

- The route is `/transcript.html?id=<id>`, not `/transcript?id=<id>`; the short form returns 404.
- Article transcripts (`video_id` begins `article:`) move the summary into the reader column and hide the transcript side, so the journey picks a video row.
- `Read aloud` and `Summarize` need AI or a live Worker AI binding. They are off locally; the journey does not drive them, and the buttons are asserted as present only.
- Delete and Retranscribe change data. The journey leaves them alone; delete is proven on the home page with a scratch row.
