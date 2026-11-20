---
name: cli-query
journey: cli-query
paths:
  - cli/chromescribe
---

# CLI query commands

The `chromescribe` CLI reads the library from a shell: list, search, get, cat, url and view.

## Sub-features

- `list [-n N] [--channel <name>] [--json]` lists newest first.
- `` `search <query> [--json]` `` matches titles, channels and video ids through `/api/search`.
- `` `get <id> [--json]` `` shows one row.
- `` `cat <id|link>` `` prints the markdown body for an id or a pasted `transcript.html?id=<id>` link, and refuses the Access login page.
- `` `url <source-url> [--json]` `` finds a row by YouTube or TikTok link.
- `` `view <id>` `` prints the dashboard link.
- `` `help` `` prints every command and its examples.

## How to get to it (user POV)

- Run `chromescribe list` in a terminal with the Access values in the environment.
- Pipe `chromescribe cat 42` into a pager or a file.
- Read `cli/README.md` for the full command list.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` is ok.
- The journey sets `CHROMESCRIBE_API` to the local instance, gives throwaway `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` values, and sets `CHROMESCRIBE_YEO_KEY` to empty so no vault lookup runs.

- **List.** Run `cs-verify journey cli-query`. The journey runs `bash cli/chromescribe list -n 3 --json` and compares the ids with `GET /api/transcripts?limit=3`.
- **Search and get.** A word from the first title must return that id, and `get <id> --json` must return the same row.
- **Cat.** `cat <id>` must exit 0, print more than 1000 characters and contain the video id; `cat https://chromescribe.yeoux.net/transcript.html?id=<id>` reads the same body, and a link with no `id=` exits non-zero.
- **Url and view.** `url` with the row's YouTube link must find it; `view <id>` must print `https://chromescribe.yeoux.net/transcript.html?id=<id>`.
- **Failure and help.** `get 999999` must exit non-zero and print `error:`; `--help` must name `list`, `cat`, `channels`, `subscribe`, `learn` and `lens`.

## Gotchas

- `list` downloads every transcript and filters with `jq`. On the real seed that is about 4000 rows per call.
- Access values are required by the real site. Locally the gate is off, so throwaway values still work, but never reuse a real service token here.
- The CLI defaults to the live site. Always set `CHROMESCRIBE_API` for a local run, and never point it at the live site with real keys during verification.
