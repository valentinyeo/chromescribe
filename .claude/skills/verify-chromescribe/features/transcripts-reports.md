# Transcripts and reports

## Sub-features

- Transcript list and search, summaries with timestamps
- Public reports at `/reports/<id>`, open without login

## How to get to it (user POV)

Open https://chromescribe.yeoux.net, then a transcript or report page.

## Driving it with the Worker test harness

`cd dashboard && node --test test/transcripts-list.test.mjs test/summary.test.mjs test/reports-api.test.mjs test/reports-ui.test.mjs test/static-pages.test.mjs`.

## Gotchas

- Report pages stay open without login; every other page and `/api/*` needs the Access login.
- A new page needs its file in `dashboard/public/` and a route in `dashboard/src/index.ts`.
