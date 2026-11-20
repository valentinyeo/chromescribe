---
name: phone-share
journey: phone-share
paths:
  - dashboard/src/index.ts
  - dashboard/src/queue-lib.mjs
---

# Phone share API

The Android app shares a link with `POST /api/queue`. The API accepts YouTube, TikTok and article links, refuses the rest, and never creates two pending rows for the same video.

## Sub-features

- `share-youtube` accepts a strict YouTube link and returns `{queued, id, platform}`.
- `share-tiktok` accepts full and short TikTok links.
- `share-article` accepts any other safe https link with an `article:<hash>` id.
- `share-duplicate` returns the existing pending row instead of a second one.
- `share-refuse` rejects unsupported, local, IP, credentialed or malformed links with 400.
- `share-list` feeds `queue.sh` through `GET /api/queue?platforms=youtube,article`.

## How to get to it (user POV)

- Share a link from the ChromeScribe Android app to ChromeScribe.
- The extension's TikTok saves feature calls the same endpoint.
- The link appears on `/queue.html` and is drained by `queue.sh`.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` and `cs-verify doctor` are ok.

- **Queue a link.** Run `cs-verify journey phone-share`. `POST /api/queue` with a YouTube link must return 200 with `queued: true` and `platform: "youtube"`.
- **Duplicate.** Posting the same link again must return the same id with `duplicate: true`, and `GET /api/queue/all?limit=1000` must hold one pending row for it.
- **TikTok.** A full `tiktok.com/@user/video/<id>` link and a short `tiktok.com/t/<code>` link both queue with `platform: "tiktok"`.
- **Refuse.** Posting `not a link`, a `localhost` link or a link with credentials must return 400 with `Unsupported URL`.
- **Article.** Posting an example.com link must queue with `platform: "article"`, and `GET /api/queue?platforms=article` must show it.
- **Cleanup.** The journey deletes the rows it created.

## Gotchas

- The endpoint needs no Access token because the Android app signs in and sends the Access cookie. The local instance runs with the gate off, so the journey proves the queue behaviour, not the login.
- A link already transcribed returns `queued: false` with its `transcript_id` instead of a new row.
- The pending uniqueness rule lives in a partial index. Changing status away from pending frees the video id for another share.
- Queue rows created here are real rows. Delete them in the journey so reruns and the queue page stay stable.
