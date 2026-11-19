---
name: subscriptions
journey: subscriptions
paths:
  - dashboard/public/subscriptions.html
  - dashboard/src/channels-lib.mjs
---

# Subscriptions page

The subscriptions page lists monitored channels, filters them, subscribes a new channel, and pauses, resumes or removes one.

## Sub-features

- `subscriptions-list` lists channels grouped by first letter with transcript counts.
- `subscriptions-filter` narrows the list and reports `N of M subscriptions`.
- `subscriptions-add` subscribes a URL, `@handle` or UC id through the form.
- `subscriptions-pause` and `subscriptions-resume` toggle monitoring.
- `subscriptions-remove` removes the channel and keeps its transcripts.

## How to get to it (user POV)

- Open `/subscriptions.html` from a page header or the More panel on a video.
- Paste a channel link in `Add channel` and choose `Subscribe`.
- Choose `Pause`, `Resume` or `Remove` on any row.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` and `cs-verify doctor` are ok.
- The seed contains 76 channels.

- **Subscribe.** Run `cs-verify journey subscriptions`. The journey posts a TikTok profile URL to `POST /api/channels`, which needs no network, and requires the row id `tiktok:@<handle>`.
- **List matches the API.** The journey opens `/subscriptions.html` and compares `#count` with `GET /api/channels`, then finds the new `@handle` row.
- **Filter.** Filling `#filter` with the handle makes `#count` start with `1 of`.
- **Pause and resume.** Clicking the row's `Pause` button makes the row read `Paused` and `GET /api/channels` report `paused: 1`. Clicking `Resume` reverses both.
- **Remove.** Accepting the confirm dialog and clicking `Remove` takes the row out of the list, and the channel disappears from `GET /api/channels`.
- **Proof.** `proof/subscriptions/subscriptions-phone.png` and `subscriptions-after-remove.png`.

## Gotchas

- A YouTube URL or handle makes the API call YouTube to resolve the channel name, which fails offline. The journey subscribes a TikTok profile instead.
- Remove needs a dialog handler.
- Paused channels still count as subscriptions and still appear in the list.
- The seeded channel list includes ten TikTok rows; both platforms share the page.
