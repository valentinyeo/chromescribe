---
name: add-video
journey: add-video
paths:
  - dashboard/public/index.html
  - dashboard/src/index.ts
---

# Add video

The Add Video form on the home page posts a link, an optional title and an optional pasted transcript to `POST /api/transcribe`, then reloads the library. The same endpoint takes a multipart audio upload, which is how `process.sh` and `monitor.sh` add a video, and that path runs Whisper, the summary and the classification.

## Sub-features

- `add-open` opens the modal from the `+ Add` button, the empty state, and the phone menu.
- `add-submit` posts the form fields as JSON and shows the `Added!` toast.
- `add-error` shows the API error inside the form when the request fails.
- `add-markdown` writes a transcript when the request carries `markdown_content`.

## How to get to it (user POV)

- Choose `＋ Add` in the home header.
- Choose `Add Video` in the phone menu, or `Add Your First Video` on the empty state.
- Fill the form and choose `Add Video`.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` and `cs-verify doctor` are ok.

- **Open the form.** Run `cs-verify journey add-video`. The journey opens the phone menu with `#mobileMenuBtn`, chooses `Add Video`, and requires `#addModal` without `hidden`. The desktop header button is `button.add-btn`.
- **Submit the form against the real handler.** The journey fills `#videoUrl`, `#videoTitle` and `#srtContent`, then clicks `#addForm button[type="submit"]`. Nothing is intercepted: it waits for the real `POST /api/transcribe` response, requires `200 POST /api/transcribe` in the API call list, requires the handler's own `yt-dlp` instructions in the body, and requires `#toastMessage` to read `Added!` with the modal closed.
- **Drive the AI path through the same endpoint.** The journey posts a small audio file as `multipart/form-data` to `POST /api/transcribe`, the branch `process.sh` and `monitor.sh` use. The real handler runs and calls the fake `env.AI` for Whisper, the summary and the classification.
- **Assert the end state.** 201 with `summarized` and `classified` true and category `Journey Verification`; the fake AI log from `GET /__verify/ai-calls` with one Whisper call whose `input_size` equals the uploaded byte count and two Gemma calls (summarization and classification); the new row from `GET /api/transcripts/:id` and from a read-only D1 query; the stored markdown carrying the fake `## TL;DR`; and the new card on `/`.
- **Proof.** `proof/add-video/add-video-form.png`, `proof/add-video/ai-calls.json` and `proof/add-video/add-video-home.png`.

## Gotchas

- Only `env.AI` is faked, by `scripts/fake-ai-entry.mjs`, which the launch config uses as `main`. No request to our own API is intercepted any more.
- `srt_content` is accepted by the handler and then ignored, so the form's own submit returns the download instructions and creates no transcript. The journey creates its row through the multipart audio branch of the same endpoint.
- The audio upload carries no `url`, so the handler makes no noembed or TikTok oembed call and the journey needs no network.
- The fake AI log lives in the Worker's memory. The journey clears it with `DELETE /__verify/ai-calls` before it starts.
