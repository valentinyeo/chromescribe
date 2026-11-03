# CLI channels

## Sub-features

- `channels`, `channels --json`, `channels --refresh`
- `subscribe`, `unsubscribe`, `pause`, `resume` with name, handle, UC id or URL selectors

## How to get to it (user POV)

A user runs `chromescribe channels` in a shell with the Access login in the environment. See `cli/README.md`.

## Driving it with the stub API

`node --test cli/test/cli.test.mjs`. The test starts a stub server, points `CHROMESCRIBE_API` at it, runs `cli/chromescribe`, and asserts on stdout and on the requests the stub recorded.

## Gotchas

- Ambiguous selectors must fail, not pick one.
- Set `CHROMESCRIBE_YEO_KEY` to empty so no 1Password lookup runs.
