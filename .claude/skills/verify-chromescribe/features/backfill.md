---
name: backfill
journey: backfill
paths:
  - backfill_summaries.sh
  - backfill_summarize.sh
  - backfill_classify.sh
  - refine_category.sh
  - dashboard/src/index.ts
---

# Transcript backfill and category refine

The backfill scripts repair a library that already exists. They ask the Worker to regenerate a summary or a classification for chosen transcripts, and `refine_category.sh` moves every transcript out of one category by classifying it again with that category excluded.

## Sub-features

- `backfill-missing-summaries` reads transcripts missing a TL;DR, or the ids it is given, and posts each to `/api/transcripts/<id>/summarize`.
- `backfill-listed-summaries` posts a fixed id list to the same summarize route and prints a pass/fail total.
- `backfill-classify` classifies every transcript with no category, or every row with `--force`, through `/api/transcripts/<id>/classify`.
- `refine-category` finds every transcript in one category and reclassifies it with that category excluded, with a `--dry-run` that only lists the rows.
- `backfill-endpoints` are the `POST /api/transcripts/<id>/summarize` and `POST /api/transcripts/<id>/classify` handlers the scripts call; both write R2 and D1 through the real Worker.

## How to get to it (user POV)

- Run `bash backfill_summaries.sh <id> [<id> ...]` to fill in missing summaries.
- Run `bash backfill_summarize.sh <id> [<id> ...]` to replace summaries for known ids.
- Run `bash backfill_classify.sh [--force]` to classify uncategorised transcripts.
- Run `bash refine_category.sh "Source Category" [--dry-run]` to move a category's transcripts to better categories.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` and `cs-verify doctor` are ok.
- The fake AI answers the summarize and classify calls deterministically.
- The journey copies the four scripts and `lib/cf_access.sh` into `proof/backfill/stub/backfill/`, replaces the hardcoded workers.dev host with the local base in each copy, and runs them with throwaway Access values.

- **Raw transcript.** Run `cs-verify journey backfill`. The journey creates a scratch article through `POST /api/transcribe` with no TL;DR and no category.
- **Missing summaries.** `backfill_summaries.sh <id>` exits 0, prints `Done. Failed: 0`, and the stored body gains `## TL;DR`.
- **Listed summaries.** `backfill_summarize.sh <id>` exits 0 and prints `Done. 1 ok, 0 failed, 1 total.`
- **Classify.** `backfill_classify.sh` exits 0, prints `Done. Failed: 0`, and `GET /api/transcripts/<id>` returns category `Journey Verification`.
- **Refine.** `refine_category.sh "Journey Verification"` exits 0, prints `Done. Failed: 0`, and the row moves to `Local Verification` because the fake AI is given the source category as excluded.
- **Dry run.** `refine_category.sh "Local Verification" --dry-run` lists the rows in that category and stops before any `Refining #` line.
- **Proof.** `proof/backfill/backfill.json` records the scratch id and every script's stdout.

## Gotchas

- All four scripts hardcode the workers.dev host and ignore `CHROMESCRIBE_API`, unlike `process.sh`, `queue.sh` and `monitor.sh`. That is a product gap; the journey patches a copy to reach the local instance.
- `backfill_summarize.sh` defaults to a fixed id list. Pass ids for a verified run.
- `backfill_summaries.sh` with no ids downloads every transcript body to find the missing ones. Pass ids on the real seed.
- `backfill_classify.sh` classifies every row with no category, and every row with `--force`. With the real seed only the scratch row is uncategorised, so the run stays short.
- The fake AI answers `Journey Verification` for the first classification and `Local Verification` once `Journey Verification` is excluded.
- `refine_category.sh --dry-run` prints the count and exits before the classify loop.
