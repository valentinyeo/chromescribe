---
name: verify-chromescribe
description: Verify ChromeScribe changes. Runs the real Worker and pages locally (wrangler dev, local D1 and R2, seeded videos, no AI) and drives them in headless Chromium for screenshots, plus the Node checks and the CLI against a stub API. Use after any change to cli/, dashboard/, tools/, process.sh, queue.sh or monitor.sh, and for screenshot proof of any page change before a PR.
---

# Verify ChromeScribe

Surfaces: the web app (Cloudflare Worker plus static pages in `dashboard/`, primary), a Bash CLI (`cli/chromescribe`), shell pipelines (`process.sh`, `queue.sh`, `monitor.sh`) and a Chrome extension. The web app runs locally with `wrangler dev` against local D1 and R2 and is driven in headless Chromium. Never deploy, never call the live API with the service key, and never print keys.

## Local web app

Needs global `wrangler` and `playwright` (`npm root -g` must hold both) plus its Chromium in `~/.cache/ms-playwright`. Scripts live in `.claude/skills/verify-chromescribe/scripts/`; run them from the repo root.

```bash
S=.claude/skills/verify-chromescribe/scripts
bash $S/launch.sh
bash $S/doctor.sh
node $S/shot.mjs / home 390 844
node $S/shot.mjs "/transcript.html?id=1" video 390 844
node $S/shot.mjs / home-desktop 1280 800
bash $S/cleanup.sh
```

- `launch.sh` copies `dashboard/wrangler.toml` to `/tmp/cs-verify/wrangler.toml` with the `[ai]` block removed, so no call can reach Workers AI or bill the account. It applies `dashboard/schema.sql` to a fresh local D1, uploads every `dashboard/public/*.html` to local R2 (the Worker serves pages from R2), runs `seed.sh` (six transcripts `seedvideo01`..`06` with TL;DR and Summary), and starts the Worker on `127.0.0.1:8799` with `CHRO10_API_GATE=0`. Ready means `GET /api/transcripts` returns `"success":true`, about 15 s. It refuses to start if its own instance is running or the port is taken; set `CS_VERIFY_PORT` and `CS_VERIFY_DIR` to run a second one side by side.
- `doctor.sh` is read-only: our pid alive, no AI binding, API answers, home page 200, prints transcript count and commit. Run it first whenever anything looks off.
- `shot.mjs <path> <name> [width] [height]` opens the page, waits for network idle, saves `/tmp/cs-verify/proof/<name>-<width>.png`, and prints the `/api/` calls with status plus console errors. 390 x 844 is the phone frame; 1280 x 800 is desktop.
- `cleanup.sh` stops only the pid that `launch.sh` started and deletes local D1, R2 and seed files. `/tmp/cs-verify/proof` stays.

Routes that call AI (`/api/whisper`, `/api/transcribe`, `/api/transcripts/:id/analyze`, `/summarize`, `/classify`) fail locally by design. Never put `[ai]` back to drive them: Workers AI always runs remote and bills. Prove those with the Worker tests in `dashboard/test/`.

Use the browser for anything a user sees. Use the test suites below for logic, the CLI and the shell pipelines.

## Test suites

Needs Node 22 or newer, `bash`, `curl`, `jq`, `python3`. No install, no build, no package.json.

```bash
cd <repo root>
node --version
```

The test suites start nothing long-lived. The CLI tests start their own stub HTTP server on a random port and tear it down. The Worker tests call `worker.fetch` directly with an in-memory SQLite D1 (`node:sqlite`).

## Doctor

Read-only, a few seconds:

```bash
node --version && command -v curl jq python3 && git status --short
node tools/strip-comments.mjs --check . && node tools/encoding-check.mjs && node tools/media-check.mjs && node tools/client-key-check.mjs
```

All four checkers must exit 0. Node below 22 or a missing `jq` means results are not trustworthy.

## Drive

Run the suite that matches the change, then the full set before a PR. These are the commands of CI's `tests` job.

```bash
node --test tools/*.test.js
node --test cli/test/*.test.mjs
cd dashboard && node --test test/*.test.mjs
```

Pick by surface:

| Changed | Run |
| --- | --- |
| `cli/chromescribe`, `cli/lenses.py` | `node --test cli/test/*.test.mjs` (about 50 s, drives the real CLI against a stub API and checks the requests it sent) |
| `dashboard/src/*` API, queue, channels, reports | `cd dashboard && node --test test/<area>-api.test.mjs` |
| `dashboard/public/*.html` | `cd dashboard && node --test test/static-pages.test.mjs test/<page>-ui.test.mjs` |
| `process.sh`, `queue.sh`, `monitor.sh`, `lib/` | `cd dashboard && node --test test/process-shell.test.mjs test/queue-shell.test.mjs test/monitor-*.test.mjs` |
| `tools/*` | `node --test tools/<name>.test.js` |

To drive the CLI by hand, copy the stub server from `setup()` in `cli/test/cli.test.mjs`, point the `CHROMESCRIBE_API` variable at it, give the CLI throwaway Access values for the two `CF_ACCESS_CLIENT_*` variables, set `CHROMESCRIBE_YEO_KEY` to empty (turns off the 1Password lookup), then run `cli/chromescribe list --json`. A change with no matching test needs a new test in the same folder before it counts as verified.

Assert on requests the stub received and files written, not on printed text alone.

## Evidence

For a page change, proof is a 390 px screenshot from `shot.mjs` before and after the change (run `launch.sh` on master, then on the branch), plus its printed API calls with no unexpected errors. Thumbnails 404 locally because seed rows have no thumbnail; that console error is expected. For an action, capture the request, the response body, the D1 row it wrote, and the page showing it (see `features/queue.md`). Attach screenshots to the ticket, never commit them.

For tests, proof is the command, its exit code, and the tail of the TAP summary (`# tests N`, `# pass N`, `# fail 0`). Save it:

```bash
mkdir -p /tmp/chromescribe-proof && node --test cli/test/*.test.mjs 2>&1 | tail -12 | tee /tmp/chromescribe-proof/cli.txt
```

For a page change, name the `dashboard/test/*-ui.test.mjs` file that covers the changed element. The live site is checked by `tools/live-check.mjs` in `deploy.yml` after a merge to master; do not run it by hand without the repo secrets.

A skipped test, a deleted test, or a comment added to dodge a check is a failure.

## Cleanup

Run `bash .claude/skills/verify-chromescribe/scripts/cleanup.sh` after every local web app run, failed runs included. Tests remove their own temp directories and servers. Check nothing leaked:

```bash
git status --short
```

Only your intended changes may appear. Proof under `/tmp/cs-verify/proof` and `/tmp/chromescribe-proof` stays. Never kill processes by name.

## Features

`features/README.md` lists journeys: home and video pages, queue lifecycle, transcripts and reports, CLI channels.

## Gotchas

- Master is protected: push a branch, open a PR, wait for `tests` and `secret-scan`.
- No code comments in any file, YAML and shell included; `node tools/strip-comments.mjs .` removes them.
- TikTok and live YouTube downloads do not work from a datacenter host; the pipelines are tested with stubs only.
