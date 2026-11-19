---
name: stats
journey: stats
paths:
  - dashboard/public/stats.html
---

# Stats page

The stats page reports R2 storage by prefix, any stored media files, the D1 transcript count and transcripts per category.

## Sub-features

- `stats-storage` shows the R2 total and a per-prefix table.
- `stats-media` states whether any video or audio objects exist.
- `stats-transcripts` shows the D1 transcript count.
- `stats-categories` lists transcripts per category.

## How to get to it (user POV)

- Open `/stats.html` from a page header or the More panel on a video.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` and `cs-verify doctor` are ok.
- The real seed has 4000 transcripts across 82 categories.

- **Open stats.** Run `cs-verify journey stats`. The journey opens `/stats.html` and waits for `#transcript-count`.
- **Counts match.** `#transcript-count` equals `GET /api/transcripts?total`; the `#category-groups` row count equals `GET /api/categories`.
- **Prefixes.** `#r2-groups` includes the `content/` prefix created by the seed markdown.
- **Media.** `#media-banner` reads `No video or audio files stored`.
- **Proof.** `proof/stats/stats-desktop.png`.

## Gotchas

- `GET /api/stats` lists the whole R2 bucket, so it is slower than the other endpoints on the real seed. Wait for the number, do not screenshot early.
- The page is desktop-shaped; the journey screenshots at 390 by 844 and the table scrolls horizontally.
- A large media count is a failure of the no-media rule, not a display bug.
