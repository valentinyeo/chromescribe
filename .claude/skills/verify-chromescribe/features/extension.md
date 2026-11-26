---
name: extension
journey: extension
paths:
  - extension/**
  - process.bat
---

# Chrome extension

The Manifest V3 extension sends the current page to the local web terminal, adds transcribe and watch-channel buttons on YouTube, and queues TikTok favourites.

## Sub-features

- `extension-toolbar` handles a toolbar click in `background.js`: it opens the existing transcript when the page is already transcribed, otherwise it sends the page to the local terminal.
- `extension-terminal` posts the page URL to `http://localhost:7681/`, which runs `process.bat`.
- `extension-youtube-buttons` adds Transcribe and watch-channel actions to watch, channel and card views.
- `extension-tiktok-saves` checks TikTok favourites every 15 minutes and queues new videos through `POST /api/queue`.
- `extension-library-status` marks videos that already have a transcript.

## How to get to it (user POV)

- Load `extension/` as an unpacked extension in Chrome or Edge.
- Click the toolbar icon on a page: an already transcribed page opens its transcript, and any other page is sent to the local terminal.
- On YouTube, use the injected Transcribe, Watch channel and card action buttons.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` is ok.
- The journey reads `extension/manifest.json`, `extension/background.js` and `extension/tiktok-saves.js`, then evaluates `background.js` in a Node VM with a stubbed `chrome` API and a stubbed `fetch` for the dashboard list.

- **Manifest.** Run `cs-verify journey extension`. The journey requires Manifest V3, a `background.js` service worker, a content script on `*://*.youtube.com/*`, and no `default_popup` or `side_panel` entry.
- **Toolbar action.** The journey calls the captured `chrome.action.onClicked` listener for a fresh YouTube page. The service worker must call `chrome.tabs.create` with `http://localhost:7681/`, and the decoded URL must carry `process.bat` and the page URL.
- **Existing transcript.** A second listener run returns one transcript with that video id from the stubbed dashboard list. The service worker must open `/transcript.html?id=42` instead of the terminal.
- **Terminal wiring.** `background.js` must carry `TERMINAL_BASE = "http://localhost:7681/"` and the `process.bat` command.
- **TikTok saves.** `tiktok-saves.js` must post to `/api/queue` on a 15-minute alarm.
- **Proof.** `proof/extension/extension-action.json` records every URL the service worker opened.

## Gotchas

- The extension needs the VPSManager terminal at `localhost:7681`, which the harness does not start. The journey stubs the `chrome` API and proves the service worker's message, not the terminal handshake.
- `background.js` hardcodes the Windows project directory and `process.bat`, so the real terminal command works only on the Windows box. That is a known limitation of this extension, not a verification gap.
- `popup.html`, `popup.js`, `sidepanel.html` and `sidepanel.js` are not referenced by `manifest.json`: the toolbar icon runs the service worker directly. They are dead files, not a user path.
- Loading the extension for real in Chromium needs a persistent context with `--load-extension`. The journey deliberately avoids that flakiness.
- Known product gap: when the dashboard list has no `view_url`, `background.js` builds the transcript link on the workers.dev host, which `CLAUDE.md` forbids showing users. The journey accepts the transcript page it opens and names this gap for the product owner.
