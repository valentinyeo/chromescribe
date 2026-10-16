# chromescribe CLI

`cli/chromescribe` is a Bash CLI, installed via a `~/.local/bin/chromescribe` symlink.
It defaults to https://chromescribe.yeoux.net; `CHROMESCRIBE_API` overrides API calls, not public links.
Access credentials come from `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`, never from files.

Dependencies: curl, jq, column, Python 3. `learn` also needs yt-dlp (RSS fallback), git, and hax with Codex access.

## Commands

- `list [-n N] [--channel <name>] [--json]`, `search`, `get`, `cat`, `url`, `view`.
- `channels [--json | --refresh]`: `--refresh` repairs YouTube rows with missing @handles or UC-ID names and prints old -> new.
- `subscribe <url|@handle|UC id>`, `unsubscribe <channel>`, `pause <channel>`, `resume <channel>`.
  Selectors accept exact names or handles case-insensitively, UC IDs, and channel URLs; ambiguous selectors fail instead of choosing silently.
- `learn <channel> [--max N] [--no-queue]`: subscribes if needed, lists the newest 30 uploads with yt-dlp or the latest 15 via RSS, queues videos without a transcript, then distills every current transcript for the channel. `--no-queue` never enqueues. Run it again after the server queue drains.
- `lens <channel> "<topic>" [--no-publish]`: needs a built lens. Ranks relevant citations, reuses per-video evidence notes, checks wording against the source transcripts, and builds one cited HTML page with the report-page template. It publishes via `/api/reports` and prints https://chromescribe.yeoux.net/reports/<id>; `--no-publish` saves under the lens repository's `reports/` and prints the path.

## Lenses

- `cli/lenses.py` runs file-backed Codex map/reduce over complete transcript chunks, writing per-video notes and merging incrementally. Only transcript IDs absent from VIDEOS.md are fetched again. Notes carry source checksums so a failed merge resumes without repeating unchanged work. Empty or failed synthesis is not installed.
- Lenses live in the separate git repository `~/projects/channel-lenses`, under `lenses/<lowercase-handle>/`: VIDEOS.md, KNOWLEDGE.md, SKILL.md, and notes/. The CLI initializes that repository but never commits or pushes. `CHROMESCRIBE_LENSES` overrides its location for tests.
- Skills are symlinked as `~/.claude/skills/lens-<handle>`; a blocked symlink prints the exact `ln` command.

## Tests

```bash
node --test cli/test/*.test.mjs
```
