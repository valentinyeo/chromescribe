---
name: extension
journey: extension
paths:
  - extension/**
---

# Chrome extension

The Manifest V3 extension sends the current page to the local web terminal, adds transcribe and watch-channel buttons on YouTube, and queues TikTok favourites.

## Sub-features

- `extension-popup` sends `{action: "process", tab}` for the active tab.
- `extension-terminal` posts the page URL to `http://localhost:7681/`, which runs `process.bat`.
- `extension-youtube-buttons` adds Transcribe and watch-channel actions to watch, channel and card views.
- `extension-tiktok-saves` checks TikTok favourites every 15 minutes and queues new videos through `POST /api/queue`.
- `extension-library-status` marks videos that already have a transcript.

## How to get to it (user POV)

- Load `extension/` as an unpacked extension in Chrome or Edge.
- Click the toolbar icon on a page and choose `Process with Pi`.
- On YouTube, use the injected Transcribe and Watch channel buttons.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` is ok.
- The journey reads `extension/manifest.json` and `extension/background.js`, then loads `extension/popup.html` in Chromium with a stubbed `chrome` API.

- **Manifest.** Run `cs-verify journey extension`. The journey requires Manifest V3, a `background.js` service worker, and a content script on `*://*.youtube.com/*`.
- **Terminal wiring.** `background.js` must carry `TERMINAL_BASE = "http://localhost:7681/"` and the `process.bat` command.
- **Popup.** The journey injects a stub `chrome.tabs.query` that returns `https://www.youtube.com/watch?v=JOURNEYEXT1`, clicks `#btn-pi`, and requires the popup to send `{action: "process"}` with that tab.
- **TikTok saves.** `tiktok-saves.js` must post to `/api/queue`.
- **Proof.** `proof/extension/extension-popup.png`.

## Gotchas

- The extension needs the VPSManager terminal at `localhost:7681`, which the harness does not start. The journey stubs the `chrome` API and proves the popup message and the background wiring, not the terminal handshake.
- The manifest uses hardcoded Windows paths. That is a known limitation of this extension, not a verification gap.
- Loading the extension for real in Chromium needs a persistent context with `--load-extension`. The journey deliberately avoids that flakiness.
- `extension/config.js` is gitignored and may be absent.
