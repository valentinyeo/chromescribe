---
name: update-transcript
journey: update-transcript
paths:
  - dashboard/src/index.ts
  - update_transcript.py
---

# Update a transcript

`PUT /api/transcripts/<id>` replaces a transcript's stored markdown and updates its title, category and tags, and `update_transcript.py` is the shell entry point that sends a markdown file and an optional title through that route.

## Sub-features

- `update-markdown` replaces the R2 body with `markdown_content` and recomputes the D1 `word_count`.
- `update-title` changes the title shown on the home card and the video page.
- `update-metadata` sets `category` and `tags` through separate fields in the same request.
- `update-script` runs `python3 update_transcript.py <id> <markdown_file> [title]` with the Access values in the environment.
- `update-missing` answers 404 for an unknown transcript id and writes nothing.
- `update-settings` documents the route as `PUT /api/transcripts/:id` on `/settings.html`.

## How to get to it (user POV)

- Run `python3 update_transcript.py 141 notes/edited.md "A better title"` from a shell with `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` set.
- Send `PUT /api/transcripts/141` with `{"markdown_content": "...", "title": "...", "category": "...", "tags": ["..."]}`.
- Read the documented route on `https://chromescribe.yeoux.net/settings.html`.
- Open `/transcript.html?id=141` after the call to see the replaced body and title.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` and `cs-verify doctor` are ok.
- The journey creates a scratch article through `POST /api/transcribe` and deletes it at the end.

- **Create.** Run `cs-verify journey update-transcript`. It writes a scratch article, then copies `update_transcript.py` and `cf_access.py` into `proof/update-transcript/stub/update-transcript/` and points the copy's hardcoded host at the local instance.
- **Update through the script.** The journey runs `python3 update_transcript.py <id> updated.md "Journey updated title <stamp>"` with throwaway Access values. It must exit 0 and print `"updated":true`.
- **Title and body.** `GET /api/transcripts/<id>` must return the new title, `GET /api/transcript/<id>/content` must return the new markdown byte for byte, and the read-only D1 row must carry the recomputed word count.
- **Category and tags.** A second `PUT /api/transcripts/<id>` with only `category` and `tags` must return `updated: true`, and the next GET must return both values.
- **Page and 404.** `/transcript.html?id=<id>` must show the new title and body. `PUT /api/transcripts/999999` must return 404.
- **Proof.** `proof/update-transcript/updated-transcript.png` and `update-transcript.json` record the page and the script output.

## Gotchas

- `update_transcript.py` hardcodes the workers.dev host and does not read `CHROMESCRIBE_API`, so the journey patches that one string in a copy to reach the local instance. The shipped script cannot be pointed at a local instance as written.
- The script sends `markdown_content` and an optional `title` only; category and tags exist on the API route and need a direct request.
- An empty `markdown_content` is ignored, so this route cannot blank a body; send replacement text instead.
- The route reports the same `updated: true` when the body carries no recognized field, so assert the stored row rather than the flag alone.
- The scratch transcript is deleted in the journey's `finally` block, failed runs included.
