---
name: reports
journey: reports
paths:
  - dashboard/public/reports.html
  - dashboard/src/index.ts
---

# Reports and public report pages

The reports page lists published channel lenses. Each report has a public page at `/reports/<id>` that opens without a login.

## Sub-features

- `reports-list` lists title, channel, topic and date newest first.
- `reports-publish` stores HTML through `POST /api/reports` and returns a 12 hex id.
- `reports-public` serves `/reports/<id>` from R2 with no Access login.
- `reports-delete` deletes the row and the stored HTML.

## How to get to it (user POV)

- Open `/reports.html` from a page header or the More panel.
- Choose a report title to open `https://chromescribe.yeoux.net/reports/<id>`.
- A shared public report link needs no Cloudflare Access login.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` and `cs-verify doctor` are ok.

- **Publish.** Run `cs-verify journey reports`. The journey posts a small HTML page to `POST /api/reports` and requires a 12 hex id.
- **List.** `/reports.html` shows `#count` as `N reports` and a link `/reports/<id>` with the title.
- **Public page.** The journey opens the link and requires the page URL, the stored `<h1>` text and no login prompt.
- **Delete.** Deleting through `DELETE /api/reports/<id>` removes the row from `GET /api/reports` and the page returns 404.
- **Proof.** `proof/reports/reports-list.png` and `public-report.png` show the list and the public page.

## Gotchas

- The public route only matches exactly 12 lowercase hex characters. A different id shape gets the normal 404 page.
- The local Worker runs with `CHRO10_API_GATE=0`, so the journey cannot prove the Access bypass. It proves the page is served from R2 with the stored HTML.
- Reports are stored twice: a D1 row and an R2 object at `reports/<id>.html`. Deleting must remove both, and the journey asserts both disappear.
