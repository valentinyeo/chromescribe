---
name: home-commands
journey: home-commands
paths:
  - dashboard/public/index.html
---

# Home keyboard shortcuts and command menu

The home list can be driven from the keyboard: `j` and `k` move the selection, `Enter` opens the selected transcript, and `Ctrl+K` opens a searchable command menu for the same actions and page navigation.

## Sub-features

- `commands-shortcuts` opens the `?` shortcut list.
- `commands-menu` opens the `Ctrl+K` command menu and filters its commands by name.
- `commands-select` moves the card selection with `j` and `k`.
- `commands-search` focuses the search box with `/`.
- `commands-add` opens the Add Video form with `a`.
- `commands-navigate` jumps to queue, subscriptions, reports and settings with `g q`, `g s`, `g r` and `$`.

## How to get to it (user POV)

- Open `/` and press `?` to see the key list.
- Press `Ctrl+K` to open the command menu, type a command name and press `Enter`.
- Press `j` or `k` to move through cards and `Enter` to open the selected one.
- Press `/` to search, `a` to add a video, or `g` then `s` to open subscriptions.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` and `cs-verify doctor` are ok.
- `/` renders at least two cards at 1280 by 800.

- **Shortcut list.** Run `cs-verify journey home-commands`. The journey opens `/` at 1280 by 800, presses `?`, and requires `#shortcuts` to be open with `Keyboard shortcuts`, `Next video` and `Subscriptions`.
- **Close.** The journey closes the dialog with `.shortcuts-close`.
- **Command menu.** `Ctrl+K` opens `#cmdk`; typing `stats` narrows `#cmdkList` to one `Stats` row; Escape closes it.
- **Selection.** `j` selects the first card, a second `j` selects the second, and `k` returns to the first, with one `.kb-selected` card at each step.
- **Search and add.** `/` focuses `#searchInput`, Escape leaves the search box, and `a` opens `#addModal` until Escape closes it.
- **Navigation.** `g` then `s` opens `/subscriptions.html`; back on `/`, `$` opens `/settings.html`.
- **Proof.** `proof/home-commands/shortcuts.png`, `command-menu.png` and `keyboard-selection.png`.

## Gotchas

- The keys only act when focus is outside an input or the Add form. Press them on the page, not inside `#searchInput`.
- The search box is hidden at phone width, so this journey runs at 1280 by 800 where `/` has a visible target.
- `g` opens a one-second prefix window; press the second key immediately.
- `#` deletes the selected card and opens a confirm dialog. The journey leaves it alone so the seed stays intact.
- `Ctrl+K` and `?` both open a dialog; close one before the next key.
- The shortcut list also names video-page keys, which only apply on `/transcript.html`.
