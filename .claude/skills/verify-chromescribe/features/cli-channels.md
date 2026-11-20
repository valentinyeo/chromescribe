---
name: cli-channels
journey: cli-channels
paths:
  - cli/chromescribe
  - cli/lenses.py
---

# CLI channel commands

The CLI manages channel subscriptions from a shell: `channels`, `subscribe`, `unsubscribe`, `pause` and `resume`.

## Sub-features

- `channels [--json | --refresh]` lists subscriptions; `--refresh` repairs YouTube names and handles through `POST /api/channels/<id>/refresh`.
- `` `subscribe <url|@handle|UC id>` `` adds a channel through `POST /api/channels`.
- `` `unsubscribe <channel>` `` removes it through `DELETE /api/channels/<id>` and keeps transcripts.
- `` `pause <channel>` `` and `` `resume <channel>` `` toggle monitoring through `PATCH /api/channels/<id>`.
- Selectors accept a case-insensitive name, an `@handle`, a UC id or a channel URL.

## How to get to it (user POV)

- Run `chromescribe channels` to see what is monitored.
- Run `chromescribe subscribe https://www.tiktok.com/@someone` to add a channel.
- Run `chromescribe pause "Jake Trinder"` to stop monitoring one.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` is ok.
- The journey points `CHROMESCRIBE_API` at the local instance and blanks the vault lookup.

- **List.** Run `cs-verify journey cli-channels`. `channels --json` must return the same channel count as `GET /api/channels`.
- **Subscribe.** `subscribe https://www.tiktok.com/@<handle>` must exit 0 and create the channel.
- **Pause and resume.** `pause <handle>` then `resume <HANDLE>` must exit 0 and flip `paused` in `GET /api/channels`.
- **Unsubscribe.** `unsubscribe <handle>` must remove the row.
- **Unknown channel.** `pause definitely-not-a-channel` must exit non-zero with `Channel not found` and write nothing.

## Gotchas

- `channels --refresh` and subscribing a YouTube selector call YouTube to resolve the channel. The journey never uses them.
- An ambiguous name must fail instead of picking a row. The CLI tests cover that case; the journey only proves the single-match path.
- `unsubscribe` keeps the transcripts. Do not expect the transcript rows to disappear.
