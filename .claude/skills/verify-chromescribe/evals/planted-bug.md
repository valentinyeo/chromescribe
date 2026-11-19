# Planted-bug eval of the PR verifier

Run on 2026-11-19 against master 1ad03f9 with pstack 0.15.44. Ticket SOFT-2793.

## Method

One planted bug went into two draft PRs with the same diff and a neutral title, "home: fold the three search field checks into one". The body claimed no behaviour change. Each PR declared a different author family, so the picker chose a different verifier family. Neither PR could merge, and both were closed afterwards.

The bug: the home search lowercased the fields but not the query, so any query with a capital letter stopped matching title, channel and category.

Clean cases are real PRs judged in the same hour by the same workflow.

## Results

| PR | Change | Author family | Verifier | Verdict | How it caught it |
|---|---|---|---|---|---|
| https://github.com/valentinyeo/chromescribe/pull/12 | planted bug | anthropic | deepseek-v4.1-flash | FAIL | `cs-verify journey home` failed "search narrows the grid to the match" with 0 cards; dashboard test 234 failed; named the unlowered needle |
| https://github.com/valentinyeo/chromescribe/pull/13 | planted bug | deepseek | glm-5.3-flash | FAIL | same journey check failed; same test failed on head and passed on base; named the unlowered needle |
| https://github.com/valentinyeo/chromescribe/pull/9 | stuck-claim fix | deepseek, anthropic | glm-5.3-flash | PASS+NOTES | queue tests, formal check, journeys |
| https://github.com/valentinyeo/chromescribe/pull/10 | nightly journeys and release video | anthropic | deepseek-v4.1-flash | PASS+NOTES | found a fail-open path in journey selection, fixed before merge |
| https://github.com/valentinyeo/chromescribe/pull/11 | verdict-only required check | anthropic | deepseek-v4.1-flash | PASS+NOTES | checks and workflow review |

## Rerun

Open a draft PR from master with a one-line planted bug and a neutral body, once per verifier family, by setting the `Author model:` line so `scripts/pick-verifier-model` skips the family under test. Expect FAIL with the failing journey check named. Close the PR and delete its branch.
