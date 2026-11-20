---
name: add-video
journey: add-video
paths:
  - dashboard/public/index.html
  - dashboard/src/index.ts
---

# Add video

The Add Video form on the home page posts a link, an optional title and an optional pasted transcript to `POST /api/transcribe`, then reloads the library.

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
- **Submit the form.** The journey fills `#videoUrl`, `#videoTitle` and `#srtContent`, then clicks `#addForm button[type="submit"]`.
- **The request is stubbed for the AI path.** The journey intercepts `POST /api/transcribe` with Playwright and answers 201, so it never needs AI. It asserts the request body carried the URL and the pasted text and that `#toastMessage` reads `Added!` and the modal closes.
- **The real non-AI path writes.** The journey then posts `markdown_content` to the same endpoint for real, gets 201, reloads `/` and finds the new card.
- **Proof.** `proof/add-video/add-video-form.png` and `proof/add-video/add-video-home.png`.

## Gotchas

- Transcription needs Workers AI, which is stripped from the local config. The modal's own request is intercepted; the handler is exercised only through its `markdown_content` branch, which needs no AI.
- `srt_content` and `channel` are accepted by the handler and then ignored; the modal's own submit shows `Added!` but writes no transcript. That is why the journey also posts `markdown_content`.
- A YouTube or TikTok link makes the handler call noembed or the TikTok oembed endpoint. The journey uses example.com links so no external call happens.
