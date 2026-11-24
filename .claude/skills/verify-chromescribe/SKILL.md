---
name: verify-chromescribe
description: Verify ChromeScribe changes with cs-verify. Launches the real Worker and pages locally against seeded D1 and R2 with only the Workers AI binding faked, checks readiness, drives every user feature in headless Chromium or through the real CLI and shell pipelines, saves proof, and reports one JSON object per command. Use after any change to dashboard/, cli/, tools/, process.sh, queue.sh, monitor.sh or extension/, and for screenshot or journey proof before a PR.
---

# Verify ChromeScribe

ChromeScribe has four surfaces: the web app (Cloudflare Worker plus static pages in `dashboard/`, primary), a Bash CLI (`cli/chromescribe`), shell pipelines (`process.sh`, `queue.sh`, `monitor.sh`) and a Chrome extension. One tool drives all of them.

```bash
S=.claude/skills/verify-chromescribe/scripts
$S/cs-verify launch
$S/cs-verify doctor
$S/cs-verify journey all
$S/cs-verify select --base origin/master
$S/cs-verify cleanup
```

Every subcommand prints one JSON object on stdout. Exit 0 means the command worked, 1 means a check failed, 2 means bad usage. `--help` on the tool or any subcommand prints the usage, options, output shape, examples and notes as JSON.

Rules that do not change:

- Never deploy. Deploys run from `master` through `.github/workflows/deploy.yml`.
- Never call the live API with the service key, and never print a key.
- The local config always drops the `[ai]` block and starts the Worker through `scripts/fake-ai-entry.mjs`. Never put the binding back to drive an AI route: Workers AI runs remote and bills.
- Only `env.AI` is faked. The handler, D1, R2 and every page are the real ones, so a journey never intercepts our own routes.

## Launch

`$S/cs-verify launch [--port N] [--seed small|real]` from the repo root.

It copies `dashboard/wrangler.toml` without the `[ai]` block into `$CS_VERIFY_DIR` (default `/tmp/cs-verify`), points `main` at `scripts/fake-ai-entry.mjs`, applies `dashboard/schema.sql` and the seed rows to a fresh local D1, writes every `dashboard/public/*.html` page and every transcript body to local R2, then starts `wrangler dev` on `127.0.0.1:8799` with `CHRO10_API_GATE=0`.

`scripts/fake-ai-entry.mjs` imports the real Worker from `dashboard/src/index.ts` and adds one thing to `env`: an `AI` object whose `run(model, input, options)` answers deterministically and never touches the network. Whisper `@cf/openai/whisper-large-v3-turbo` returns `text` plus `segments`; `@cf/google/gemma-4-26b-a4b-it` returns a three-section `## TL;DR` / `## Summary` / `## Talking Points` markdown for the summary call and a JSON `{category, tags}` for the classification call. It logs every call as model, gateway task, input unit and input size, served at `GET /__verify/ai-calls` and cleared with `DELETE /__verify/ai-calls`.

Ready means `GET /api/transcripts` returns `"success":true` and one seeded transcript body reads back from R2. A full real seed takes about 35 seconds.

- `--seed real` (default) seeds 4000 transcripts across 82 categories and 76 channels, 157 queue rows in mixed states, and an average of 4600 words per transcript.
- `--seed small` seeds 6 transcripts for a quick smoke. Every journey still runs.
- The tool refuses to start when its own instance is running or the port belongs to another process. Set `CS_VERIFY_PORT` and `CS_VERIFY_DIR` to run a second instance beside the first.
- Needs Node 22, global `wrangler` and global `playwright` with Chromium in `~/.cache/ms-playwright`. A missing tool fails with the install command.

## Doctor

`$S/cs-verify doctor` is read-only and takes a few seconds. It checks the recorded pid is alive, the local config has no `[ai]` block, the config's `main` is the fake AI entry, `GET /__verify/ai-calls` answers on the running instance, the API answers, the home page is 200, a transcript body reads back from R2, and prints the D1 counts and the commit. Every failed check carries the command that fixes it.

Run it before the first journey and whenever anything looks off.

## Drive

`$S/cs-verify journey <feature|all> [--video]` runs the scripted journeys declared by the feature files. Journeys run one at a time against the one instance.

- Browser journeys open the real pages in headless Chromium at 390 by 844, or 1280 by 800 where the layout differs.
- CLI and shell journeys run the real `cli/chromescribe`, `process.sh`, `queue.sh`, `monitor.sh` or extension popup with the repo's existing stubs.
- Each journey asserts user-visible end state plus the side effect where the feature writes data: the API response, a read-only D1 row, a file on disk.
- `--video` records a `.webm` of each browser journey.
- A failed journey still lets the rest run, so one command reports every failure.

Pick journeys by hand or let `select` pick:

```bash
$S/cs-verify select --base origin/master
```

It reads the `paths:` globs in each feature file and lists the features whose files changed. An unmatched change under `dashboard/src` or `dashboard/public` selects every feature; docs-only changes select none.

Use the browser for anything a user sees. Use the Node test suites for logic, and the CLI and shell journeys for the pipelines. The suites are the commands of CI's `tests` job:

```bash
node --test tools/*.test.js
node --test cli/test/*.test.mjs
cd dashboard && node --test test/*.test.mjs
```

AI routes (`/api/whisper`, `/api/transcribe` audio, `/api/transcripts/:id/analyze`, `/summarize`, `/classify`) run locally against the fake AI, so a journey can prove them through the real handler and the fake AI call log. `add-video` does exactly that. Remote inference, billing and model quality stay out of reach, which is what `dashboard/test/` covers.

## Steps the local setup skips

Production does each of these and the local instance does not. Each line names where the step is covered instead.

- **Workers AI and AI Gateway.** Locally `scripts/fake-ai-entry.mjs` answers `env.AI`. The real handlers run against that fake. Model output, gateway tags and billing are seen only on the live site.
- **Access login and the API gate.** Launch sets `CHRO10_API_GATE=0`. The gate is covered by `dashboard/test/access-gate.test.mjs`, and every deploy runs `tools/live-check.mjs --require-login`, which fails unless the live API refuses calls without a login.
- **Remote D1, R2 and the custom domain.** Locally they are wrangler's local stores on `127.0.0.1`. `tools/live-check.mjs` checks the live pages, the API and the public reports after every deploy.
- **YouTube and TikTok downloads.** `yt-dlp` is faked. TikTok blocks datacenter IPs, so real downloads run only on the Windows box.
- **ffmpeg chunking for audio over 500 KB.** The fake download is 10 seconds of audio, so only the direct upload runs. The chunked path and `/api/whisper` chunk uploads are not driven by any journey.
- **Jina Reader, FXTwitter and YouTube oEmbed.** The `curl` wrapper answers these outside hosts and passes every other URL to the real `curl`.
- **VPSManager terminal.** The `extension` journey stubs the `chrome` API because the terminal at `localhost:7681` is not started.
- **Codex through `hax`.** `cli-learn` and `cli-lens` fake `hax` and `yt-dlp`, so they prove the CLI plumbing, not the learning output.
- **Telegram.** Notifications are off by default (`CHROMESCRIBE_TELEGRAM`). The `monitor` journey checks that no message is sent, and the pipeline `curl` wrapper answers Telegram if one is.
- **Windows TikTok drain task.** The journeys never queue or drain TikTok; that task runs only on the Windows box.
- **The Android app.** It lives in its own repo. The `phone-share`, `android-updates` and `queue` journeys drive the API it calls.
- **Known gap: the `monitor` journey still stubs `curl` for our own API.** `queue-drain` runs the real `monitor.sh` against the local Worker for one video, which covers the force path. The channel polling path is covered only by that stub.

## Evidence

- Journeys save screenshots under `/tmp/cs-verify/proof/<feature>/` and return every check with its pass state and detail.
- `$S/cs-verify shot <path> <name> [--width N] [--height N]` saves one page to `proof/<name>-<width>.png` and prints its `/api/` calls with status plus console errors. 390 by 844 is the phone frame; 1280 by 800 is desktop.
- Thumbnails 404 locally because seed rows have no stored thumbnail. That console error is expected.
- For a page change, proof is a phone screenshot from `shot` before and after the change, plus the journey that covers the changed control.
- For an action, the proof is the request, the response, the written row or file, and the page showing it.

Save proof outside the repo:

```bash
mkdir -p /tmp/chromescribe-proof
$S/cs-verify journey all > /tmp/chromescribe-proof/journeys.json
```

Attach screenshots to the ticket. Never commit them. A skipped journey, a deleted assertion, or a weaker check is a failure.

## Cleanup

`$S/cs-verify cleanup [--dry-run]` stops only the pid this tool recorded, then removes local D1 and R2 state, the generated config and the seed SQL. It never kills processes by name. Proof under `proof/` survives.

Run it after every local run, failed runs included. Check nothing leaked:

```bash
git status --short
```

## Helpers

`scripts/cs-verify` is the whole harness: launch, doctor, journey, select, shot and cleanup. `scripts/journeys.mjs` holds one journey function per feature. `scripts/fake-ai-entry.mjs` is the only fake inside our own code: it swaps `env.AI` and leaves the Worker as it ships. There is no package.json and no build step; the tool finds global `wrangler` and `playwright` through `npm root -g`.

## Features

`features/README.md` indexes 21 mapped features, and each file carries its own `paths:` globs and `journey:` id:

home and video pages, the article original link, add video, queue, subscriptions, reports and the public report page, stats, settings, the shared theme, keyboard shortcuts and the command menu, the CLI query and channel commands, CLI learn and lens, `process.sh`, `queue.sh`, `monitor.sh`, the extension, the phone share API, and the Android app update API.

`tools/feature-map.test.js` fails when a page route, a `dashboard/public/*.html` file, a literal `/api/` route, an API module, a shell pipeline, a `cli/chromescribe` subcommand or a `cli/README.md` command is missing from the map, when a feature file lacks front matter or the four H2 sections, or when the README index drifts.

## Gotchas

- Master is protected: push a branch, open a PR with `Author model:` lines, and wait for the `pstack-verifier` verdict. It is the only required check. Never merge on FAIL.
- No code comments in any file, YAML and shell included. `node tools/strip-comments.mjs .` removes them.
- TikTok and live YouTube downloads do not work from a datacenter host. The shell journeys use stubs, and the real paths run on the Windows box.
- `queue.sh`, `process.sh` and `monitor.sh` read the API base from `CHROMESCRIBE_API`, default the workers.dev host. Their journeys point it at the local instance and fake only outside systems: `yt-dlp`, Jina Reader, FXTwitter, YouTube oEmbed and Workers AI. No journey stubs `curl` on the `queue-drain` and `process` paths.
- A second instance needs its own `CS_VERIFY_DIR` and `CS_VERIFY_PORT`. Two runs sharing one state directory corrupt each other.
- The real seed writes about 120 MB of transcript markdown into the state directory. `cleanup` removes it.

pstack: 0.15.46

## Evals

`evals/planted-bug.md` records the verifier catching a planted bug with two model families and passing clean PRs, with the steps to rerun it.
