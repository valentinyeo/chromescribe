---
name: verify-chromescribe
description: Verify ChromeScribe changes by running its Node checks, the CLI against a stub API, and the Worker against in-memory D1. Use after any change to cli/, dashboard/, tools/, process.sh, queue.sh or monitor.sh, or to prove a user journey works before opening a PR.
---

# Verify ChromeScribe

ChromeScribe has no long-running local app. Its surfaces are a Bash CLI (`cli/chromescribe`), a Cloudflare Worker plus static pages (`dashboard/`), shell pipelines (`process.sh`, `queue.sh`, `monitor.sh`) and a Chrome extension. Verification runs the real code against local stubs. Never deploy, never call the live API with the service key, and never print keys.

## Launch

Needs Node 22 or newer, `bash`, `curl`, `jq`, `python3`. No install, no build, no package.json.

```bash
cd <repo root>
node --version
```

Nothing to start. The CLI tests start their own stub HTTP server on a random port and tear it down. The Worker tests call `worker.fetch` directly with an in-memory SQLite D1 (`node:sqlite`).

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

Proof is the command, its exit code, and the tail of the TAP summary (`# tests N`, `# pass N`, `# fail 0`). Save it:

```bash
mkdir -p /tmp/chromescribe-proof && node --test cli/test/*.test.mjs 2>&1 | tail -12 | tee /tmp/chromescribe-proof/cli.txt
```

For a page change, name the `dashboard/test/*-ui.test.mjs` file that covers the changed element. The live site is checked by `tools/live-check.mjs` in `deploy.yml` after a merge to master; do not run it by hand without the repo secrets.

A skipped test, a deleted test, or a comment added to dodge a check is a failure.

## Cleanup

Tests remove their own temp directories and servers. Check nothing leaked:

```bash
git status --short
```

Only your intended changes may appear. Proof under `/tmp/chromescribe-proof` stays. Never kill processes by name.

## Features

`features/README.md` lists journeys: CLI channels, queue lifecycle, transcripts and reports.

## Gotchas

- Master is protected: push a branch, open a PR, wait for `tests` and `secret-scan`.
- No code comments in any file, YAML and shell included; `node tools/strip-comments.mjs .` removes them.
- TikTok and live YouTube downloads do not work from a datacenter host; the pipelines are tested with stubs only.
