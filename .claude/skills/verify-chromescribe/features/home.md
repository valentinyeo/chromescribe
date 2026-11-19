---
name: home
journey: home
paths:
  - dashboard/public/index.html
  - dashboard/src/index.ts
---

# Home list, search and categories

The home page lists every transcript newest first, filters by category chip, by channel link and by the search box, and lets a user delete a transcript from its card.

## Sub-features

- `home-list` renders the library count, category chips and lazily loaded cards.
- `home-search` filters titles, channels, categories and tags as the user types.
- `home-categories` filters by a category chip and restores All.
- `home-channel` filters by a channel through `/?channel=<name>`.
- `home-delete` deletes one transcript from the card actions after a confirm.

## How to get to it (user POV)

- Open `/` (the route also answers on `/index.html`).
- Type in the search box marked `Search transcripts`.
- Choose a chip under the category bar, or choose the channel name on any card.
- Open a card's `⋮` actions and choose `Delete`.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` reports ready and `cs-verify doctor` is ok.
- The seed contains at least one category and one channel.

- **Library loads.** Run `cs-verify journey home`. The card grid fills and `#stats` shows the same total as `GET /api/transcripts?total`.
- **Chips match the API.** The journey compares the chip count with `GET /api/categories` plus the five fixed chips (All and four pinned clusters).
- **A new transcript appears.** The journey publishes a scratch article through `POST /api/transcribe`, reloads `/` and finds its title in the grid.
- **Search narrows.** The journey fills `#searchInput` with the scratch title. Only one card remains.
- **Category filters.** The journey reads the first card's category and clicks the matching chip in the category bar. `#stats` reads `N of M videos` and every rendered card carries that category.
- **Channel filters.** The journey opens `/?channel=<name>` from a card's channel link and checks the same `N of M` line.
- **Delete writes.** The journey opens the card's `⋮`, accepts the confirm dialog and chooses `Delete`. The card leaves the grid, the page sends `DELETE /api/transcripts/<id>`, and `GET /api/transcripts/<id>` returns 404.
- **Proof.** `proof/home/home-phone.png` shows the populated grid, and `proof/home/home-after-delete.png` shows the scratch card gone.

## Gotchas

- The page loads every transcript in the background so search sees the whole library. With the real seed that is 4000 rows and the page stays busy for a few seconds after the first cards render.
- Thumbnails 404 locally because seed rows have no stored thumbnail; that console error is expected and is not an assertion.
- Search is client-side. It only matches rows already loaded, so assert after `#stats` carries a number.
- Deleting a seeded row changes later counts. The journey creates and deletes its own scratch transcript, so reruns keep the seed intact.
