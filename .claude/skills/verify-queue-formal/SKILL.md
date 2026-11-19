---
name: verify-queue-formal
description: Formally checks the ChromeScribe share queue against loss, double-claim, and pending-dedupe properties with TLA+/TLC. Use after any change to dashboard/src/queue-lib.mjs, the /api/queue routes in dashboard/src/index.ts, queue.sh, or formal/queue/.
---

Prior art: checked pstack maintain-formal-verification-skill, create-formal-verification-skill, principle-prove-it-works, rat-stack model-a-protocol, local verification-check; none fits because this file is the project-local verify skill that create-formal-verification-skill requires this repo to own.

# Verify share queue (formal)

pstack: 0.15.44

## Goal

A shared link must not be lost or processed by two drainers at once, and a row abandoned by a crashed drainer must come back to the waiting list instead of staying in progress forever. A duplicate share of a still-pending video must not create a second pending row.

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
| `NoDoubleProcess` | Two drainers hold the same row | Yes (`UPDATE ... AND status = 'pending'`, and the lease reclaim is guarded on status and `started_at`) |
| `NoLost` | A share vanished without done, failed or cancel | Yes |
| `Recovers` (temporal) | A row abandoned by a crashed drainer stays in progress forever | Yes, with the 30 minute lease in `listPendingQueue`; the `crash-no-recovery` variant fails it |

## Bounds

- `Videos = {v1, v2}`, `Drainers = {d1, d2}`, `MaxShares = 2`, `MaxAttempts = 2`
- Main run (`EnableCrash = TRUE`, recovery on): 15,254 states generated, 3,705 distinct, plus a 7,410 state liveness graph; the whole `check.sh` takes about 2 minutes on one worker
- Platform filters (VPS `youtube,article` vs Windows `tiktok`) are omitted: both drainers may see every pending row (strictest claim race)
- Transcript short-circuit in `enqueueSharedUrl` is modeled as "no new row once status is done"
- `MaxAttempts = 2` matches `QUEUE_MAX_ATTEMPTS` in `queue-lib.mjs`. Both a claim and a lease return increment `attempts`, so a row gets two processing runs before the lease fails it
- Time is not modelled. A processing row with no holder is a claim whose drainer died after the lease expired: that is exactly when `recoverStaleClaims` returns it to pending. A slow but live drainer can therefore still run twice, which the model leaves out and the ticket accepts as a risk
- A lease return only happens when no other row for the video is pending, because the partial unique index allows one pending row per video
- Liveness needs strong fairness on each drainer step. Weak fairness is not enough: a drainer can loop list and skip forever while a stale row is reclaimable
- Download/transcribe work inside `queue.sh` is one abstract step between claim and done/failed

## Assumptions

- One D1 `UPDATE`/`INSERT` is atomic; the SELECT before claim in `updateQueue` does not grant the claim
- Operator `DELETE` of a non-processing row is intentional cancel (`cancelled` in the model)
- No invented recovery for stuck `processing` rows: product has none

## Reading results

- Pass line `PASS: main` plus TLC "No error has been found" means the listed invariants hold and `Recovers` holds inside the bounds
- `PASS: ... breaks <Invariant>` means that variant correctly violated the invariant
- `PASS: ... breaks Recovers` means the no-recovery variant produced a counter-example behavior. TLC prints `Error: The following behavior constitutes a counter-example:` for a temporal property, and the trace ends in `Stuttering`
- On a real invariant failure against `Broken = "none"` and `EnableCrash = FALSE`, treat it as a product bug: open `/statechart` on `formal/queue/Queue.tla` and read the shortest path in code words (enqueue / list pending / PUT processing / PUT done|failed / retry / delete)
- Move `sync_commit` in `formal/queue/coverage.json` forward only after you confirm the model still matches the covered functions at that commit

## Coverage record

See `formal/queue/coverage.json`: `sync_commit` is the commit whose product code the model matches, and `covered` lists `{file, function}` for every function in the model.

## Recovery (SOFT-2800)

Before the fix no path reset a `processing` row after a crashed drainer. Counterexample:

1. `enqueueSharedUrl` inserts `status = 'pending'`
2. `listPendingQueue` returns that row
3. `updateQueue(..., {status:'processing'})` claims it (`AND status = 'pending'`)
4. Drainer dies before `updateQueue` done/failed (`queue.sh` notes the row can remain processing)
5. Row stayed `processing` with no live claim and was never listed again

`listPendingQueue` now calls `recoverStaleClaims`, which selects `processing` rows whose `started_at` is older than `QUEUE_LEASE_SECONDS` (30 minutes) and, per row:

- under `QUEUE_MAX_ATTEMPTS`: a guarded `UPDATE ... SET status = 'pending', attempts = attempts + 1 WHERE status = 'processing' AND started_at = ?`, so only one of two listing drainers returns it
- at or past `QUEUE_MAX_ATTEMPTS`: a guarded `UPDATE ... SET status = 'failed', error = 'Drainer stopped before finishing ...'`, which the queue page shows with Retry

The model represents the first case as `Recover(id)` and the second as the same action's `attempts = MaxAttempts` branch. The `crash-no-recovery` broken variant turns `Recover` off and must fail `Recovers`.
