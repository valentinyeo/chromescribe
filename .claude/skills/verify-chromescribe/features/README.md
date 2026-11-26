# ChromeScribe verification map

This directory is the maintained source for proving user-facing ChromeScribe behavior. Read this index before driving the app, then use one feature file as the recipe. `../scripts/cs-verify` is the only harness.

## Baseline preconditions

- Launch the app with `cs-verify launch` from the repo root. It starts `wrangler dev` on `127.0.0.1:8799` with local D1 and R2, no `[ai]` binding, and the dashboard pages served from local R2.
- `--seed real` (the default) seeds 4000 transcripts across 82 categories, 76 channels, 157 queue rows in mixed states, and an average of 4600 words per transcript. `--seed small` seeds 6 transcripts for a quick smoke; every journey still runs on it.
- Set `CS_VERIFY_DIR` and `CS_VERIFY_PORT` to run a second instance beside the first.
- Run `cs-verify doctor` before the first journey. It is read-only and names the fix for every failed check.
- Never drive an instance this tool did not start.
- Proof lives under `/tmp/cs-verify/proof/<feature>/` and survives cleanup.

## Driving conventions

- Every journey is `cs-verify journey <feature>`, or `cs-verify journey all`.
- Journeys start from the seeded state. A journey that needs extra rows creates them through the API or the repo stubs and removes them at the end.
- Prefer stable handles: ids, `aria-label`, role and visible text. Never click coordinates.
- A journey asserts user-visible end state and, where the feature writes data, the side effect through the API or a read-only D1 query.
- Workers AI is faked locally by `scripts/fake-ai-entry.mjs`; live YouTube and TikTok downloads are faked too. Features that touch them say so in their Gotchas, and `SKILL.md` lists every step the local setup skips.
- `--video` records a `.webm` of each browser journey beside its screenshots.

## Proof and reporting

- Each journey writes screenshots under `proof/<feature>/` and prints one JSON object with every check, its pass state and its detail.
- Capture the action and the resulting state, not only the final screen.
- A failed check must name the unmet precondition and the command that attempted it.
- Never report a skipped path as verified through a different one.
- Never commit screenshots or videos.

## Feature entry contract

Each feature file starts with YAML front matter carrying `name`, `journey` and a `paths` glob list, then an H1 title with one paragraph. It then uses exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with cs-verify`, `Gotchas`.

- `Sub-features` lists short ids with one line each.
- `How to get to it (user POV)` lists every user entry point.
- `Driving it with cs-verify` starts with `Preconditions:` and pairs each user action with the journey step and the observable result.
- `Gotchas` lists traps that can waste or invalidate a run.

## Features

Coverage: 22 of 22 features mapped.

- [Home list, search and categories](./home.md) covers `/` and `/index.html`, search, category chips, channel filtering and card delete.
- [Home keyboard shortcuts and command menu](./home-commands.md) covers the `?` shortcut list, the `Ctrl+K` command menu, card selection and single-key navigation on `/`.
- [Video page](./video.md) covers `/transcript.html?id=<id>`, summary and transcript tabs, neighbour navigation, More actions, the command menu, read aloud and the missing-id error.
- [Article original link](./article-source.md) covers `/api/transcripts/<id>/source` and the card `Open original` action.
- [Add video](./add-video.md) covers the home Add modal and the transcribe endpoint.
- [Queue page](./queue.md) covers `/queue.html`, the four columns, Retry and Remove.
- [Subscriptions page](./subscriptions.md) covers `/subscriptions.html`, filter, subscribe, pause, resume and remove.
- [Reports and public report pages](./reports.md) covers `/reports.html` and the public `/reports/<id>` page.
- [Stats page](./stats.md) covers `/stats.html` storage, media, transcript and category counts.
- [Settings page](./settings.md) covers `/settings.html` docs and copy buttons.
- [Shared theme](./theme.md) covers the three-state theme on `/` and `/transcript.html`.
- [CLI query commands](./cli-query.md) covers `chromescribe list`, `search`, `get`, `cat`, `url` and `view`.
- [CLI channel commands](./cli-channels.md) covers `channels`, `subscribe`, `unsubscribe`, `pause` and `resume`.
- [CLI learn](./cli-learn.md) covers `chromescribe learn`.
- [CLI lens reports](./cli-lens.md) covers `chromescribe lens`.
- [process.sh pipeline](./process.md) covers the video and article transcription pipeline.
- [queue.sh drain loop](./queue-drain.md) covers the share queue lifecycle.
- [monitor.sh](./monitor.md) covers channel polling, force mode and Telegram gating.
- [Summary repair](./summary-repair.md) covers the analyze retry in `process.sh` and `monitor.sh` and the daily Worker cron that fills missing TL;DRs.
- [Chrome extension](./extension.md) covers the toolbar action, the local terminal wiring and TikTok saves.
- [Phone share API](./phone-share.md) covers `POST /api/queue` for the Android app.
- [Android app updates](./android-updates.md) covers `/api/android/latest` and `/api/android/releases/<versionCode>/app.apk`.
