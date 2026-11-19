---
name: cli-lens
journey: cli-lens
paths:
  - cli/chromescribe
  - cli/lenses.py
---

# CLI lens reports

`chromescribe lens <channel> "<topic>"` builds a cited HTML report from a learned lens, either as a local file or published to `/reports/<id>`.

## Sub-features

- `lens-local` writes HTML under the lens repository's `reports/` and prints the path.
- `lens-publish` posts through `POST /api/reports` and prints the public link.
- `lens-validate` rejects scripts, em dashes, unknown citations and over-long reports.
- `lens-shorten` and `lens-paraphrase` retry once when the draft is too long or copies source wording.

## How to get to it (user POV)

- Run `chromescribe learn "Jake Trinder"` first.
- Run `chromescribe lens "Jake Trinder" "how to get clients" --no-publish` for a local file.
- Run the same without `--no-publish` to publish and get a link.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` is ok.
- The journey writes the same stubs as `cli-learn`, including a `report-page` skill with a template in a throwaway `HOME`.

- **Learn first.** Run `cs-verify journey cli-lens`. The journey runs `learn "Journey Lens Channel" --max 2 --no-queue` as a precondition.
- **Local report.** `lens "Journey Lens Channel" "buyer questions" --no-publish` must exit 0, print an existing `.html` path, and the file must contain `class="verdict"` and a `transcript.html?id=` citation.
- **Publish.** The same command without `--no-publish` must exit 0 and print `https://chromescribe.yeoux.net/reports/<12 hex>`.
- **Stored.** `GET /api/reports` must list the new id; the journey deletes it afterwards.

## Gotchas

- Without a learned lens the command fails with `Lens not built`. The journey always runs `learn` first.
- The report validator rejects em dashes, `workers.dev`, scripts, unknown citation ids and more than 600 visible words. A stub draft must satisfy all of it.
- The `report-page` skill must exist with `SKILL.md` and `template.html`. The journey plants both in a throwaway HOME instead of touching the real one.
- Publishing touches the live site only when `CHROMESCRIBE_API` is unset. The journey always points it at the local instance.
