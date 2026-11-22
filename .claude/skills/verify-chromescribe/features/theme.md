---
name: theme
journey: theme
paths:
  - dashboard/public/index.html
  - dashboard/public/transcript.html
---

# Shared theme

The home and video pages share a three-state theme choice: system, dark or light. The choice is stored in `localStorage` under `cs-theme`, applied before the page paints, and reused on the next page.

## Sub-features

- `theme-choice` cycles system, dark and light from the header menu, the phone menu or the video More panel.
- `theme-system` resolves the system choice through `prefers-color-scheme`.
- `theme-persist` stores the choice in `localStorage` and reapplies it after a reload.
- `theme-shared` applies the same choice on `/` and `/transcript.html`.

## How to get to it (user POV)

- Open `/`, open the header `⋮` menu on desktop or the phone menu, and choose `Theme`.
- Open `/transcript.html?id=<id>`, open the More panel and choose `Theme`.
- Open the video command menu with `Ctrl+K` and choose `Toggle theme`.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` and `cs-verify doctor` are ok.
- The newest transcript opens on `/transcript.html?id=<id>`.

- **Start on system.** Run `cs-verify journey theme`. The journey opens `/` and requires `data-theme-choice` to be `system` and `data-theme` to be `dark` or `light`.
- **Cycle to dark.** The journey opens `#mobileMenuBtn`, chooses `Theme`, and requires `data-theme-choice` and `data-theme` to read `dark`, and `localStorage["cs-theme"]` to read `dark`.
- **Persist.** Reloading `/` keeps `data-theme-choice` and `data-theme` on `dark`.
- **Share the choice.** The journey opens the newest transcript, requires the video page to read `dark`, opens `#menuToggle`, and chooses `#themeToggle` in the More panel. The video page then reads `light`, and a second choice returns it to `system`.
- **Proof.** `proof/theme/theme-home-dark.png` and `proof/theme/theme-video-light.png`.

## Gotchas

- The first choice is `system`, which resolves through the browser's `prefers-color-scheme`; assert the choice, not a fixed first colour.
- The header `#themeToggle` sits inside the `⋮` menu on desktop and is hidden at phone width. The phone menu button and the video More panel are the visible controls at 390 by 844.
- The theme choice is browser-local. The journey uses one context for both pages so the saved value carries over.
- The video page has no visible theme control until the More panel opens.
- The Worker stores nothing for the theme, so a fresh context starts on `system` again.
