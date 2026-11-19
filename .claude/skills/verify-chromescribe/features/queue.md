---
name: queue
journey: queue
paths:
  - dashboard/public/queue.html
  - dashboard/src/queue-lib.mjs
---

# Queue page

The queue page shows the share queue in four columns: Waiting, Processing, Failed and Done. A failed row offers Retry and Remove.

## Sub-features

- `queue-columns` lists processing, waiting, failed and the last 30 done rows.
- `queue-retry` moves a failed row back to Waiting.
- `queue-remove` deletes a failed row after a confirm.
- `queue-live` refreshes every 15 seconds while the tab is visible.

## How to get to it (user POV)

- Open `/queue.html` from any page header, from the More panel on a video, or directly.
- On a failed row choose `Retry` or `Remove`.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` and `cs-verify doctor` are ok.
- The seed contains mixed queue states.

- **Create two rows.** Run `cs-verify journey queue`. The journey posts two YouTube links to `POST /api/queue`, then marks the second `failed` with reason `Journey failure reason` through `PUT /api/queue/<id>`.
- **Columns render.** The journey opens `/queue.html` and compares `#count` with `GET /api/queue/all?limit=200`. The Waiting column shows the first link and the Failed column shows the reason.
- **Retry writes.** The journey accepts the confirm dialog, clicks the row's Retry button and waits for the link in `#pending`. `GET /api/queue/all` then reports `status: pending` for that row.
- **Proof.** `proof/queue/queue-phone.png` shows all four columns and `queue-after-retry.png` shows the row back in Waiting.

## Gotchas

- Retry opens a confirm dialog. Without a dialog handler the click hangs.
- The page polls every 15 seconds. Wait for the rendered row, not a fixed sleep, or a poll may race the assertion.
- Rows created by the journey are deleted at the end, so reruns stay stable. A failed seeded row is not touched.
- A pending video id is unique. Posting the same link twice does not create a second pending row; the share journey covers that.
