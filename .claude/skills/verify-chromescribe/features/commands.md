---
name: commands
journey: commands
paths:
  - dashboard/public/index.html
  - dashboard/public/transcript.html
---

# Keyboard shortcuts and command menu

Both the home page and the video page open a command menu with `Ctrl+K`, list every shortcut with `?`, and route single-key actions while no input has focus.

## Sub-features

- `commands-menu` opens the command menu with `Ctrl+K`, narrows it as the user types, and runs the active command with Enter.
- `commands-shortcuts` opens the keyboard shortcuts dialog with `?`.
- `commands-home` selects cards with `j` and `k`, opens the selection with Enter, opens Add with `a`, focuses search with `/`, and cycles categories with `[` and `]`.
- `commands-pages` navigates from home with `g q`, `g s` and `g r`.
- `commands-video` moves between transcripts with `j` and `k`, toggles Summary and Transcript with `t`, and opens Settings with `$`.

## How to get to it (user POV)

- Open `/` and press `Ctrl+K` for the command menu or `?` for the shortcut list.
- On `/`, press `j`, `k`, `Enter`, `a`, `/`, `[` or `]` without focusing an input.
- Open `/transcript.html?id=<id>` and press `j`, `k`, `t`, `$`, `?` or `Ctrl+K`.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` and `cs-verify doctor` are ok.
- The home grid has at least one card.

- **Shortcut dialog.** Run `cs-verify journey commands`. It opens `/`, presses `?` and requires `#shortcuts` open with the home key map.
- **Command menu.** `Ctrl+K` opens `#cmdk`; typing `settings` narrows `#cmdkList` to one command, and Enter opens `/settings.html`.
- **Home keys.** Back on `/`, `/` focuses `#searchInput`, `a` opens `#addModal`, and Escape closes it.
- **Page jumps.** `g` then `q`, `s` or `r` opens `/queue.html`, `/subscriptions.html` or `/reports.html`.
- **Selection.** `j` marks a card with `kb-selected`, and Enter opens that card on `/transcript.html?id=<id>`.
- **Video keys.** On the video page, `?` opens the shared shortcut dialog and `Ctrl+K` opens the command menu with its video commands.
- **Proof.** `proof/commands/commands-shortcuts.png` and `proof/commands/commands-menu.png`.

## Gotchas

- Single-key actions do nothing while a text input, textarea or editable element has focus. Blur or clear the field first.
- The `/` search shortcut needs desktop width. At phone width the search box is hidden until `#mobileSearchBtn` opens it, so the journey runs at 1280 by 800.
- The home command menu labels its commands by action, not by route. Type the visible label, such as `settings`.
- The video page keeps the same `Ctrl+K` and `?` bindings but has different commands, including Previous, Next and Re-summarize.
- `?` on the video page opens the shortcuts dialog, not the command menu.
