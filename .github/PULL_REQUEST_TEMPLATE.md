# What this changes

<!-- One or two sentences: what problem, what mechanism. English or Chinese, both are read. -->

## Externally visible behaviour

<!--
Anything a user, a subscriber, or an operator can observe. Be specific, and
write "none" if that is the truth — that is a useful claim, not a blank.

Cover whichever apply:
- API fields added/changed (`/api/signals`, `/api/record`, webhook payloads)
- Route auth or rate-limit posture
- Push text or format (Telegram, 𝕏)
- New/changed env vars, or a new default
- Database schema (new table, new column, migration) and whether it is
  rebuildable or permanent state
- A number that is published anywhere and whose measurement conditions changed

Write "none" explicitly if nothing here changes — an empty section reads as
"didn't check", not as "nothing changed".
-->

## How it was verified

<!--
What you actually ran, and what the result was. If a behaviour can't be covered
by a unit test, say how you checked it by hand (a page you loaded, a script you
ran, a row you inspected in SQLite).
-->

## Checklist

- [ ] `npm test` is green (state the count you saw — the suite is 1346 tests / 105 files as of `main`)
- [ ] `npm run typecheck` is clean
- [ ] New logic has tests next to the module it lives in (`lib/yourModule.test.ts`)
- [ ] Externally visible changes are reflected in `README.md` and/or `docs/` — field semantics live in `docs/api-access.md` and that file wins on conflict
- [ ] This change does not add automated trading, order placement, key handling, or any bypass of Polymarket authentication ([why](https://github.com/kydlikebtc/polymarket-whalewatch/blob/main/CONTRIBUTING.md#out-of-scope))
- [ ] No credentials, tokens, `.env` contents, or `*.sqlite` files are included in the diff

## Notes for the reviewer

<!--
Optional. Good things to put here: a tradeoff you made and the alternative you
rejected; a limitation you know about and chose to ship with; a number you
measured that motivated the change. Negative findings are welcome — this repo
documents what turned out to be false as readily as what worked.
-->
