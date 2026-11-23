---
name: home-commands
journey: home-commands
paths:
  - dashboard/public/index.html
---

# Home keyboard shortcuts and command menu

The home page is fully keyboard driven: single keys move the card selection, run the card actions, focus search and open the Add form, two-key chords reach the other pages, and `Ctrl+K` opens a searchable command menu.

## Sub-features

- `commands-select` moves the card selection with `j` and `k`, and `Enter` opens the selected card.
- `commands-card-actions` runs `o` for the selected card's original link and `#` or `Delete` for its delete action.
- `commands-search` focuses the search box with `/` and clears the search with `Escape`.
- `commands-add` opens the Add Video form with `a`.
- `commands-category` moves the category chip with `[` and `]`.
- `commands-navigate` reaches queue, subscriptions, reports and settings through `g q`, `g s`, `g r` and `$`.
- `commands-shortcuts` opens the shortcut list with `?`.
- `commands-palette` opens the command menu with `Ctrl+K`, filters it as the user types, and runs the chosen command with `Enter`.

## How to get to it (user POV)

- Open `/` and press `?` for the shortcut list or `Ctrl+K` for the command menu.
- Choose `Keyboard shortcuts` in the header `⋮` menu.
- Select a card with `j` or `k`, then press `Enter`, `o`, or `#`.
- Press `g` then `q`, `g` then `s`, `g` then `r`, or `$` to leave the page.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch --seed real` and `cs-verify doctor` are ok.
- The home page has at least one card.

- **Select a card.** Run `cs-verify journey home-commands`. At 1280 by 800 the journey presses `j`, requires exactly one `#videoGrid .card.kb-selected`, then presses `k` and requires a selection to remain.
- **Focus search.** `/` focuses `#searchInput`; `Escape` leaves the input.
- **Shortcut list.** `?` opens `#shortcuts`, the dialog text contains `Go to queue`, and its `Close` button closes it.
- **Command menu.** `Ctrl+K` opens `#cmdk`; filling `#cmdkInput` with `stats` narrows `#cmdkList` to the `Stats` command; `Enter` navigates to `/stats.html`.
- **Add form.** Back on `/`, `a` opens `#addModal` and `Escape` closes it.
- **Navigation chord.** `g` then `q` navigates to `/queue.html`.
- **Proof.** `proof/home-commands/home-commands.png` shows the queue page reached by the chord.

## Gotchas

- Single-key actions do nothing while an input, textarea, select or contenteditable element has focus, while the Add modal is open, or while Ctrl, Cmd or Alt is held.
- `g q`, `g s` and `g r` only fire when the second key arrives within one second of the `g`.
- The command menu lists Stats and Settings but not queue, subscriptions or reports, so those pages need the `g` chords or the header menu.
- `?` is Shift+/ on a US layout; the journey sends the question-mark key rather than typing it into search.
- `o` and `#` need a selected card, and `#` opens the confirm dialog. The journey proves selection, search, the dialogs, the command menu and the chords; it leaves the destructive card actions to the `home` journey.
- The list, search, category and theme surfaces have their own feature files; this file covers only the keyboard and command layer.
