---
name: article-source
journey: article-source
paths:
  - dashboard/src/source-lib.mjs
  - dashboard/src/index.ts
  - dashboard/public/index.html
  - dashboard/public/transcript.html
---

# Article original link

An article transcript stores its original link in the markdown `**Source:**` line. The Worker redirects `/api/transcripts/<id>/source` to that link, so a card can open the article itself, and the video page reads the same line directly.

## Sub-features

- `source-redirect` answers 302 with the first complete http(s) `**Source:**` URL from the stored markdown.
- `source-card` puts the redirect behind `Open original` in an article card's actions on `/`.
- `source-parse` accepts only a complete http(s) source line and rejects javascript, protocol-relative, file and malformed values.
- `source-missing` returns 404 when the transcript, the stored body or a usable source line is missing.

## How to get to it (user POV)

- Open `/`, open an article card's `⋮` actions and choose `Open original`.
- Open an article transcript at `/transcript.html?id=<id>` and choose `Open original` in the More panel.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` and `cs-verify doctor` are ok.
- The journey creates a scratch article through `POST /api/transcribe` with `markdown_content`.

- **Create.** Run `cs-verify journey article-source`. It posts a scratch article whose body carries `**Source:** https://example.com/<slug>`.
- **Redirect.** `GET /api/transcripts/<id>/source` without following redirects returns 302 and `Location: https://example.com/<slug>`.
- **Card link.** Reload `/`, find the scratch card's `Open original` anchor and require `href="/api/transcripts/<id>/source"`.
- **Missing.** `GET /api/transcripts/<unknown id>/source` returns 404.
- **Cleanup.** The journey deletes the scratch transcript.
- **Proof.** `proof/article-source/article-source-card.png`.

## Gotchas

- Do not follow redirects when asserting the route, or the browser or fetch lands on example.com.
- The source line must stand on its own and start with `**Source:**`; a link inside a sentence is not used.
- The video page reads the same markdown directly for its own `Open original`, so only the card uses the redirect.
- The local Worker runs with the API gate off; the redirect is same-origin, and the Access bypass is a production concern.
- Delete the scratch transcript at the end so a rerun does not leave rows.
