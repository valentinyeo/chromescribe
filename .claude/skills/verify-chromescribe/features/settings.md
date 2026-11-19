---
name: settings
journey: settings
paths:
  - dashboard/public/settings.html
---

# Settings page

The settings page documents the CLI commands, recipes, environment overrides and HTTP API, with copy buttons on each recipe.

## Sub-features

- `settings-cli` lists `chromescribe list`, `search`, `get`, `cat`, `url` and `view`.
- `settings-recipes` shows copyable recipes built on `chromescribe cat 141`.
- `settings-env` lists `CHROMESCRIBE_API` and the two Access variables.
- `settings-api` lists the main HTTP endpoints, including `GET /api/transcripts`.

## How to get to it (user POV)

- Open `/settings.html` from a page header or the More panel.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` is ok.

- **Open settings.** Run `cs-verify journey settings`. The journey opens `/settings.html` and requires the `Settings` heading.
- **CLI and API docs.** The page text contains `chromescribe cat 141`, `GET /api/transcripts`, `CHROMESCRIBE_API` and the env table.
- **Copy.** The journey clicks the first `button.copy` and waits for the button text to read `copied`.
- **Proof.** `proof/settings/settings-desktop.png`.

## Gotchas

- The copy button uses the clipboard API. The journey grants clipboard permissions; a headless browser without them leaves the button unchanged.
- The page is documentation only. It reads nothing from the API, so a bad API cannot break it, and a passing journey does not prove the API works.
