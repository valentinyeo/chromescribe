---
name: verify-queue-formal
description: Formally checks the ChromeScribe share queue against loss, double-claim, and pending-dedupe properties with TLA+/TLC. Use after any change to dashboard/src/queue-lib.mjs, the /api/queue routes in dashboard/src/index.ts, queue.sh, or formal/queue/.
---

Prior art: checked pstack maintain-formal-verification-skill, create-formal-verification-skill, principle-prove-it-works, rat-stack model-a-protocol, local verification-check; none fits because this file is the project-local verify skill that create-formal-verification-skill requires this repo to own.

# Verify share queue (formal)

## Goal

A shared link must not be lost or processed by two drainers at once. A duplicate share of a still-pending video must not create a second pending row.

## Command

From the repo root (needs Java 11+, network only on first jar download):

```bash
bash formal/queue/check.sh
```

Broken variants (each must fail the named property):

```bash
bash formal/queue/check.sh --broken claim-no-guard
bash formal/queue/check.sh --broken enqueue-no-dedupe
bash formal/queue/check.sh --broken crash-no-recovery
```

`tools/run-checks.sh` runs `formal/queue/check.sh` when `FORMAL=all` or when a file listed in `formal/queue/coverage.json` (or under `formal/queue/`) differs from `origin/master`.

## Tool

TLA+ TLC via `tla2tools.jar` **v1.7.4**, sha256 pinned in `formal/queue/check.sh` as `SHA_A`+`SHA_B` (and `tool_sha256_parts` in `coverage.json`), cached at `.cache/tla/tla2tools.jar` (gitignored). Chosen because the bugs are interleavings of D1 steps and two drainers, not single-input crashes in one function.

## What is verified

Model: `formal/queue/Queue.tla`. Each Next action is one D1 statement or one drainer step that maps to `queue-lib.mjs` / `queue.sh`.

| Property | Harm if broken | Holds on current code? |
|---|---|---|
| `NoDupPending` | Two pending rows for one `video_id` | Yes (`ON CONFLICT ... DO NOTHING` + partial unique index) |
| `NoDoubleProcess` | Two drainers hold the same row | Yes (`UPDATE ... AND status = 'pending'`) |
| `NoLost` / `LiveClaim` | Share stuck with no live claim, or vanished without done/failed/cancel | **No** when a drainer crashes after claim (finding) |

## Bounds

- `Videos = {v1, v2}`, `Drainers = {d1, d2}`, `MaxShares = 2`, `MaxAttempts = 2`
- Main run (no crash): about 1200 distinct states, under 20 s on a GitHub ubuntu runner
- Platform filters (VPS `youtube,article` vs Windows `tiktok`) are omitted: both drainers may see every pending row (strictest claim race)
- Transcript short-circuit in `enqueueSharedUrl` is modeled as "no new row once status is done"
- `MaxAttempts` bounds retries in the model only; product code never auto-fails on attempts
- Download/transcribe work inside `queue.sh` is one abstract step between claim and done/failed

## Assumptions

- One D1 `UPDATE`/`INSERT` is atomic; the SELECT before claim in `updateQueue` does not grant the claim
- Operator `DELETE` of a non-processing row is intentional cancel (`cancelled` in the model)
- No invented recovery for stuck `processing` rows: product has none

## Reading results

- Pass line `PASS: main` plus TLC "No error has been found" means the listed invariants hold inside the bounds
- `PASS: ... breaks <Invariant>` means that variant or finding correctly violated the invariant
- On a real invariant failure against `Broken = "none"` and `EnableCrash = FALSE`, treat it as a product bug: open `/statechart` on `formal/queue/Queue.tla` and read the shortest path in code words (enqueue / list pending / PUT processing / PUT done|failed / retry / delete)
- Move `sync_commit` in `formal/queue/coverage.json` forward only after you confirm the model still matches the covered functions at that commit

## Coverage record

See `formal/queue/coverage.json`: `sync_commit` is the `origin/master` commit modeled; `covered` lists `{file, function}` for every function in the model.

## Finding (current code)

No path resets a `processing` row after a crashed drainer. Counterexample:

1. `enqueueSharedUrl` inserts `status = 'pending'`
2. `listPendingQueue` returns that row
3. `updateQueue(..., {status:'processing'})` claims it (`AND status = 'pending'`)
4. Drainer dies before `updateQueue` done/failed (`queue.sh` notes the row can remain processing)
5. Row stays `processing` with no live claim and is never listed again

Do not invent recovery in the model. Fix product code only on an explicit ticket.
