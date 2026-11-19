---
name: cli-learn
journey: cli-learn
paths:
  - cli/chromescribe
  - cli/lenses.py
---

# CLI learn

`chromescribe learn <channel>` subscribes if needed, queues missing uploads, distills every current transcript for the channel, and installs a lens skill.

## Sub-features

- `learn-subscribe` subscribes an unknown channel first.
- `learn-uploads` lists uploads with `yt-dlp` and falls back to RSS.
- `learn-queue` queues uploads that have no transcript; `--no-queue` never queues.
- `learn-distill` writes per-video notes and a cited `KNOWLEDGE.md`.
- `learn-skill` symlinks `lens-<handle>` into `~/.claude/skills`.

## How to get to it (user POV)

- Run `chromescribe learn "Jake Trinder"` once, wait for the queue to drain, then run it again.
- Run `chromescribe learn "Jake Trinder" --no-queue` to read only what is already transcribed.
- Read `cli/README.md` for the lens repository layout.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` is ok.
- The seed has a `Journey Lens Channel` with two short transcripts.
- The journey writes a fake `yt-dlp`, a fake `hax` and a throwaway `HOME` with a `report-page` skill into `proof/cli-learn/stub/learn/`.

- **Learn.** Run `cs-verify journey cli-learn`. The journey runs `bash cli/chromescribe learn "Journey Lens Channel" --max 2 --no-queue` with `CHROMESCRIBE_LENSES` pointing at a temp repository.
- **Counts.** stdout must match `<N> transcribed, 0 queued`.
- **Artifacts.** `lenses/journeylenschannel/KNOWLEDGE.md` must carry `[transcript:<id>]` citations and `VIDEOS.md` must link both source transcripts.
- **Skill.** `~/.claude/skills/lens-journeylenschannel/SKILL.md` must exist in the throwaway HOME.

## Gotchas

- Real learning calls Codex through `hax` and takes minutes. The journey stubs `hax` and `yt-dlp`, so it proves the CLI plumbing, file layout and citations, not model quality.
- `learn` rejects non-YouTube channels.
- The lens repository is a separate git repository. The CLI initializes it but never commits or pushes.
- A second run skips transcripts whose checksum is unchanged. The journey starts from a fresh temp repository.
