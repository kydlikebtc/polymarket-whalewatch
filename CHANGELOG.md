# Changelog

This project has never been versioned or tagged. `package.json` has said `0.1.0` since the first
commit and there are no git tags, so semver headings here would be fiction. Entries are grouped
into **functional batches** instead — a coherent piece of work, the date range of its commits, and
the short hashes to `git show`. Newest first.

Two habits borrowed from [Keep a Changelog](https://keepachangelog.com): entries describe the
user-visible effect rather than the file diff, and corrections get the same billing as features.
Corrections matter more here than in most repositories, because this one publishes numbers — hit
rates, P&L, edge — and several of those numbers were wrong before they were right. The table below
indexes every fix that changed a published figure.

Scope: 382 commits, 2026-06-23 → 2026-08-21. Test suite at the end of that range: 1516 tests across
112 files (`npm test`).

## Corrections that changed reported numbers

| Date       | Commit    | What was wrong                                                                                                                                                                                                                                                           |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-08-18 | `58c6b16` | 95% intervals were computed per alert, but 3852 settled alerts sat in only 669 markets (one held 201) — alerts in one market are copies of a single random event, which understated the error by ~1.9x. Now clustered by market; the point estimate still counts alerts. |
| 2026-08-18 | `524d682` | X posts read the category from `market_meta.category`, empty for all 745 cached markets; the real data was in `event_category`. Every post shipped with only `#Polymarket`.                                                                                              |
| 2026-08-04 | `80d2d34` | The implied-probability baseline summed the raw fill price for SELL rows while `settleWon` scores a SELL as won when price _falls_. Ten zero-edge SELLs at 0.20 that all went to zero were graded 6.3σ alpha; corrected to 1.58σ, inside noise.                          |
| 2026-08-04 | `bb4fe4f` | Consensus upgrade rows counted one consensus event several times in the record.                                                                                                                                                                                          |
| 2026-08-04 | `0e52e33` | Protocol fees were never booked. P&L split into three explicit tiers, subtractable only within a tier (`fd6c3f4`).                                                                                                                                                       |
| 2026-08-04 | `bbc2b61` | Settlement was pinned on prices a UMA dispute could still overturn; disputed markets are now held.                                                                                                                                                                       |
| 2026-07-28 | `e9c658e` | The ε "tie" dead-band was applied to binary 0/1 settlements, making it one-sided: a 0.997 alert could only lose, a 0.001 alert could only win.                                                                                                                           |
| 2026-07-28 | `d04e08b` | "At least X% after removing luck" was a Wilson lower bound on the _raw_ hit rate — it removed sampling luck but never the market baseline, i.e. it silently used 50% as the yardstick. Replaced with hits vs. implied expectation plus σ.                                |
| 2026-07-26 | `f7bdc01` | Net position was `buyUsd − sellUsd` cash flow, which labels round-trips as net buying. Replaced with share-based cost exposure across consensus, disagreement, accumulation and discovery.                                                                               |
| 2026-07-26 | `1d6eb0b` | Market-maker flow was counted as directional opinion in consensus and disagreement.                                                                                                                                                                                      |
| 2026-07-07 | `42af83b` | Net P&L summed `/closed-positions`, which is sorted by `realizedPnl` descending under a page cap — so it only ever saw the winning slice. One wallet displayed **+$22.96M** against a true **−$6.14M**. Now uses the official user-pnl endpoint.                         |
| 2026-07-07 | `d1b5f69` | Truncated samples still produced a win rate; bot wallets showed fake 100%. Truncated now renders `—`, and wallets trading ≥1000 distinct markets are classified as market makers with no win rate at all.                                                                |
| 2026-07-02 | `163dcb5` | Positions held to zero produce no closing transaction, so they never reach `/closed-positions` — wallets that rode losers to zero showed fake perfect records. One wallet went from `100% · +$56.6m` to `91.1% · +$55.1m` over 439 settled.                              |
| 2026-07-02 | `f302050` | `/activity` sorting is unreliable and Cloudflare caches the mis-sorted payload per URL, so a _wrong_ first-activity timestamp was cached permanently. Now the sorted query is only a candidate, verified with an end-filter probe.                                       |
| 2026-07-02 | `cf13665` | Gamma `/markets` silently returns nothing for settled markets unless `closed=true` is passed, so settlement backfill never fired in production — unit tests mocked the call and hid it.                                                                                  |

## Batches

### 2026-08-21 — the cost basis a `consensus` event never had

Two batches in a row closed the gap between `bus[]` and `active[]` one field at a time, and both
times the field that got left behind was the one a follower actually acts on. This time it was
`avgPrice`.

The read side recognised exactly one key, `payload.price`, which only a `large` event writes. A
`consensus` event's projected payload had never carried a price of any kind — so every consensus
row on the bus reported `avgPrice: null`, forever, by construction. Nothing was lost in transit:
`ConsensusGroup` has always computed a group-level `avgBuyPrice`, the source alert flattens the
whole group into its payload, and `active[]`'s `foldConsensus` has been reading that exact field
the entire time. The projection's whitelist skipped it, the same way it had skipped `wallets`.

The stakes are higher than a missing number. `avgPrice` is documented as the denominator of the
chase gate — current price minus cost basis, don't follow past 10¢ — and `consensus` is the signal
that gate exists for. A consumer holding a consensus event could see who bought and how much, but
not what they paid, which is the one input the gate needs.

The fix is the same shape as last time: the projection now carries the source's `avgBuyPrice`, and
the read side falls back to it when `price` is absent. Order matters — `price` stays first, because
a single fill's actual execution price is a stronger fact than an aggregate, and a future type
carrying both should not silently switch to the derived one.

Consumers should not compute this themselves, and the docs now say so outright. The group figure is
**USD-weighted by shares** (`totalNetUsd / Σ(netUsd / avgBuyPrice)`), not the arithmetic mean of the
per-wallet averages that `wallets[]` now makes so easy to reach for. On a representative group the
two differ by close to a cent against a 10¢ red line — a 7% divergence in the gate, arrived at
silently. A test pins the difference so the distinction can't quietly erode.

Events booked before this change still read `null`. Projection is a one-shot snapshot; no amount of
cleverness on the read side reconstructs a field the payload never held, and returning `0` would
report a sub-penny cost basis rather than an unknown one. The 48h window clears them within a day.

Commits: `0edf02f`, plus the wrap-up commit.

### 2026-08-21 — `bus[]` finally says who bought

The parity pass two days earlier aligned identity, direction and money, and stopped one field short
of the interesting one. `active[]` has carried `wallets` — who bought, how much each, at what cost —
since long before the bus existed; `bus[]` offered a single `walletCount` integer, so a consumer who
wanted the names had to go ask somewhere else. The data was never missing: a `large` event has
carried `payload.wallet` since the bus shipped, and a `consensus` alert's payload is the whole
`ConsensusGroup` flattened, wallet list included. The projection's field whitelist simply never
picked it up.

`wallets` now sits at the top level with the same three keys `active[]` uses. A `large` event
synthesises the single element its `walletCount: 1` already implied, so the number and the list
can't disagree. A `consensus` event carries every participant in the source's net-buy-descending
order, since the order is itself information. `discovery` reports `null`: a wallet entering the pool
has no position, no net buy and no cost basis, and inventing a two-null entry to keep the shape
uniform would be inventing meaning — the address stays in `payload.address`, as before. `null`
rather than `[]` throughout, because an empty array claims zero wallets where the truth is that we
don't know; consensus events booked before this change read `null` and the 48h window flushes them
within a day.

One thing got tightened on the way in. The obvious projection is to copy the source list verbatim,
and the first cut did — which would have shipped `score`, `winRate`, `buyCount` and `qualifiedTs` to
subscribers as a side effect, and would have shipped every future field of an internal type the same
way. The projection layer whitelists fields precisely so that internal changes don't silently become
API changes; that whitelist is what dropped `wallets` in the first place, and adding the field is no
reason to remove the lock. Three keys go in, pinned by a test.

The webhook needed no work: `BusEventV1` embeds the same zod schema and passes the row through, so
the field appeared on both routes at once — the payoff from collapsing three hand-copied field lists
into one definition in the previous batch.

Commits: `73c3abd`, plus the wrap-up commit.

### 2026-08-19 — `bus[]` reaches parity with `active[]`

`bus[]` used to be six top-level fields plus a `payload: Record<string, unknown>` whose shape
changed with `sourceType`. The same question — how much money is this — was `usd` on a `large`
event and `totalNetUsd` on a `consensus` one, so every consumer had to branch on the type before it
knew which key to read. Category and subcategory were absent entirely, which made filtering bus
events by track impossible even though `active[]` had carried both for months.

The normalised fields now sit at the top level under the same names `active[]` uses: market
identity (`slug`, `eventSlug`, `category`, `subcategory`), direction (`outcome`, `outcomeIndex`,
`asset`) and money (`netUsd`, `avgPrice`, `walletCount` — 1 for a `large` fill, because one fill is
one wallet and consumers shouldn't special-case it). One parser now reads both feeds. `payload` is
untouched, so anything already reading `payload.usd` keeps working; `outcomeIndex` and `asset` are
new to the projected payload and read `null` on events booked before this change, which the 48h
window flushes within a day. Category comes from the same `categoriesFor` lookup `active[]` uses —
lifted out of `signalFeed` into `lib/eventCategory.ts`, because two implementations of the same
lookup means one event can be classified two ways and nobody finds out.

"Push and pull are the same fact by two routes" had been a comment above two hand-copied field
lists — `BusSignalRow` as an interface, `BusEventV1Schema` as a zod object, and `buildBusEvent`
enumerating the fields a third time. Adding a field meant editing three places and silently
diverging if you missed one. The zod schema is now the single definition, the type derives from it,
the webhook embeds it, and a regression test computes the expected field set from real data rather
than hardcoding a list.

Commits: `c088be2`, plus the wrap-up commit.

### 2026-08-19 — /manage: what it says is what's true now, and the switches are within reach

Three defects, each found by running the page rather than reading it.

The routing matrix was reading a config that had been retired. Its "bus[]/总线 on/off" columns came
from the legacy `config.bus_signal_settings`, but the source of truth since the taxonomy rework is
`bus_defs` — and the new UI's `defAction` create/update/delete paths never write back to the legacy
key. Enabling a definition through the UI left the matrix reading `false` forever. Confirmed live:
`busDefs.large.enabled` went true while the legacy blob still said false. The predicate now reads
`bus_defs` with the exact expression `EventsSection` uses, and the legacy key has no reader left in
the frontend.

The token gate had two verdicts. `authGate` says only the server decides, but `EventsSection`,
`TgTargetsSection` and `XAccountsSection` each tested a local `!token` string — so on a deployment
with no `ADMIN_TOKEN` (local development included) the header read 已验证 while those three blocks
read 填入管理令牌后加载 and issued no request at all. The replacement predicate has no `token`
parameter; a block cannot consult the token because it isn't given one. Its ready branch carries the
data, which also retired a row of `data!` assertions.

Telegram's last error was cut at 60 characters, which landed inside the prefix: the real failure
read `…downgrade: telegram sendMessage failed permanently (status 401): {"ok":false,…}` and the
operator saw it end at `telegr`. Now 160 characters inline with the full text in the title.

Layout followed. The two concept tables fold away by default — showing a live status line while
collapsed, since folding a dashboard is not the same as folding a lesson — the routing matrix stays
open but can be collapsed, and the verified token field collapses into a chip in the header. First
actionable control: 1082 → 762px on 🧭 信号, 1164 → 908px on 🚚 下游管线 (696px with the matrix
collapsed), against a 900px viewport. `KeysSection` at 795 lines, up against the 800-line ceiling in
CLAUDE.md, split into 375 + 480 with endpoint registration and operations moving out; the data is
still fetched once by the parent, since two components fetching separately would double the request
count against a 30/min per-IP limit.

Commits: `9600b64`.

### 2026-08-19 — Webhook endpoints: test before you trust, restore without relapse

A burnt-out webhook endpoint used to be a dead end. The row showed `已停用 10(transient)` and the
only control was a `停用` button it had already outlived — restoring meant registering a second
endpoint, and the operator had no way to tell whether the subscriber's server was fixed except to
register one and watch. The row now carries the same three controls the TG targets table has had
all along: 测试 / 停用↔恢复 / 删除.

**Test** posts a real `SignalEventV1` through the real delivery path — same `buildDeliveryHeaders`,
same HMAC — because a probe that takes a side road can pass while live delivery keeps failing. The
payload is shaped like a signal and empty like nothing: `id` and `strategy.id` are `0` (real ids
autoincrement from 1), every price, size and wallet count is `null`, `notice` says outright that
this is not a signal and must not be followed, and an extra `X-Signal-Test: 1` header gives
subscribers a second way to drop it. Shaping it as a valid `SignalEventV1` is deliberate: a minimal
`{event:"ping"}` would fail the subscriber's own schema check, return 4xx, and report a healthy
channel as broken. The probe is read-only — it never touches `consecutive_failures` or `active`,
so a manual test cannot nudge an endpoint toward the breaker.

**Restore** clears `consecutive_failures` and `last_error` along with setting `active = 1`. The
breaker fires on `>= WEBHOOK_DISABLE_AFTER`, not `==`, so the counter parks on the threshold: flip
only the flag and the next single failure reads as 11 and trips it again — the button would have
done nothing. Endpoints hanging off a revoked or non-realtime key are refused server-side, not
merely greyed out in the UI, because the delivery query filters them anyway and a restored one
would sit there reading 活跃 while delivering nothing.

**Delete** is a hard delete, secret and all, behind a confirm that says so; 停用 stays for the
reversible case. All of it rides the existing `POST /api/admin/webhooks` with an **optional**
`action` field — omitting it still means register, so the contract published in `docs/signals-api.md`
and any operator `curl` script keeps working.

One diagnosis fix fell out of testing it live. undici packs every network failure into
`TypeError: fetch failed` with the real reason in `cause` — and for the most common case, a closed
port, that cause is an `AggregateError` whose own `message` is empty and whose sub-errors carry the
`ECONNREFUSED ::1:PORT / 127.0.0.1:PORT` text. Reading `cause.message` alone yielded an empty
string, leaving the operator with a bare "fetch failed"; the failure detail now falls through
`cause.message` → sub-errors → `cause.code`.

Commits: `9ee7419`, plus the wrap-up commit.

### 2026-08-19 — X post copy v2: posts measured by X's own ruler, filled to the fold

All five X templates were rewritten against the 280 _weighted_-character fold. Length is now
measured by `weightedLength` (twitter-text v3 weighting: emoji, `└` and `…` count 2) instead of
code points, which under-measured every post by 3–5 — exactly the margin that decides whether a
maxed-out post collapses behind "Show more". Overflow degrades through an explicit `fitPost`
variant ladder: optional lines (promise, evidence row, receipts) are dropped first, and the market
title — the reader's only way to judge relevance — is truncated only as a last resort, inverting
the old truncate-the-title-first behaviour.

The copy moved from category labels to assertions. Whale posts open with a position
(`🐳 WHALE: $200K says NO @ 80¢`; SELL says `sells` — selling is not a directional call), and a
trade bigger than the market's entire 24h volume says so in the headline. Consensus posts carry
per-wallet receipts (`🏆 $12.5K @ 64¢ · 74% win rate`) straight from the alert payload. Pregame
posts tell one of three stories — X-to-1 (floored, never rounded up), every-signal, or SPLIT —
with both sides' money. Settlement posts lift the arithmetic into the headline
(`✅ CALLED IT · 40¢ → $1.00 (+150%)`), and losses — only losses — carry "We post every result,
wins and losses." Two recoveries shipped alongside: `type='smart'` whales regained their 🏆
identity plus a locally-queried Track record line (the broadcast loop had been collapsing smart
and large into identical posts), and crypto entity tags became cashtags (`$BTC`), the stream
traders actually monitor. A settlement promise line prints only behind a double gate — settled
loop on × settlement within 144h — so the account never promises a follow-up it cannot deliver.

Commits: `7849dc9`, `2d9ca62`, `221da64`, `cf92be1`, `1c72a3c`, `756b007`, `d2ea1fb`, `0b1497b`,
`bd1c1db`, `403abea`, `ff6cca2`, plus the wrap-up commit; design and plan under
`docs/plans/2026-08-19-x-post-copy-density*`

### 2026-08-18 — Access boundaries: token-gated operator page, public status page

`/manage` now renders nothing but a token field until `GET /api/admin/signals` returns 200. The
server-side `ADMIN_TOKEN` gate was always in place, but the tab labels and KPI skeletons were
themselves intelligence: which loops run, how many delivery channels exist, how many API keys, how
far the digest chain goes. Engine health moved out to `/status`, a token-free public page reading
the already-public `/api/health`, and was then pulled back out of the top nav — a permanently green
ops light does not belong on a trader's main path, so the entry point is `/manage`. `/api/alert-config`
GET moved behind the same token: thresholds are a rule set that can be evaded, not a record that can
be verified, and the verifiable part lives at `/record`.

Commits: `bff2709`, `c2d9bfc`, `492cdd7`, `11d0580`

### 2026-08-18 — Edge audit script and clustered confidence intervals

`scripts/edge-audit.ts` scores alert conditions against the settled history the validation loop had
already accumulated. It applies three corrections, and the same data changes sign depending on which
are applied: price calibration (`edge = P(won) − implied`; without it you are ranking who bought the
safer ticket — old wallets averaged 0.708, new wallets 0.577), fees from `lib/fees`, and
cluster-robust standard errors, with Bonferroni over 60 groups.

The most useful output is the representativeness header, and it is negative: the local database holds
10 trading days, 95% of alerts inside 6 of them, 78% from one batch of events, and a 43-day gap. No
edge conclusion drawn from it extrapolates, and the script says so before printing any table.

Commits: `688cd5d`, `58c6b16`

### 2026-08-17 → 2026-08-18 — Subscriber API documentation and contract calibration

`docs/api-access.md` is the subscriber-facing contract: every endpoint, every field with its unit and
type, and what a webhook receiver must implement. `/api-docs` renders that same file at runtime
through a zero-dependency CJK-aware markdown renderer rather than duplicating it into JSX, so page
and document cannot drift. A follow-up pass corrected three places where the document would have made
an integrator compute the wrong number. Fixed in the same batch: `/api/signals` advertised a
"structurally complete empty feed" on failure but omitted `heavyMinUsd` and `staleLoops`, so the
promise was false exactly when it mattered.

`docs/signals-api.md` remains the internal contract (design tradeoffs, revision history, and the rule
that app clients must not connect to this service directly). When the two disagree, `api-access.md`
wins and the other is corrected.

Commits: `b76b1c2`, `d50a24e`, `c69bc3f`, `2ab963e`

### 2026-08-17 → 2026-08-18 — Unified signal bus and manageable delivery targets

"Pushable signal" previously meant strategy-tier signals only; every other type had its own ad-hoc
path or none. Batch A projects site-wide signal types into `bus_signals` from the source tables —
projection, not recomputation, and a disabled type is never written rather than written and filtered.
API keys now carry a subscription scope chosen at issue time and enforced server-side, with the scope
included in the cache key so a restricted key cannot be handed a full-scope cached payload. Telegram
delivery targets became database rows an operator can add, pause and delay per signal type, replacing
a single bot+channel pair in `.env` (the env pair remains the fallback when the table is empty, so
upgrading does not stop delivery).

Commits: `d54ba36`, `814bcf7`, `8994711`, `dc3e6f0`

### 2026-08-16 → 2026-08-18 — 𝕏 auto-broadcast account

An English-language X account as an acquisition channel, built as a pure consumer of the `alerts`
table: an independent 60s loop claims a row then posts, so the Telegram path is untouched and X
failures are physically isolated from it. Four content types (whale trade, consensus, pre-game
aggregate, weekly report card rendered through `ImageResponse`), with a local fail-closed budget
ledger — $15/month, both claimed and posted rows count against it, per-kind daily caps — because a
post with a link costs $0.20 against $0.015 without one, which is also why every template except the
weekly one is forbidden from containing a URL. Three-legged OAuth replaced the single `.env` token
pair: accounts are authorized in `/manage`, credentials re-resolve every loop, so switching accounts
takes effect in ≤60s with no restart. Settled recaps self-reply to the original signal post with the
result, win or lose (off by default).

Fixed: category hashtags never worked (see the corrections table). Also fixed: `next dev --webpack`,
documented as the fallback for running from a git worktree, had been broken since the X code landed —
`twitter-api-v2` pulls in `https` and `zlib`, and the webpack externals list was hand-maintained with
three entries; it now enumerates all Node builtins, which removes the whole failure class.

Commits: `2f3c28e`, `1337db4`, `f44fbe2`, `acef223`, `5a43879`, `905b2cc`, `e984119`, `c75ee81`,
`524d682`, `8485313`

### 2026-08-17 — Bilingual UI (Chinese / English, manual switch)

Client-side language context plus a cookie, chosen over per-language routes so the just-built SEO
layer did not need rerouting. Chinese source strings are the dictionary keys: `zh` returns the key
verbatim, `en` looks it up, and a missing translation falls back to Chinese rather than rendering a
key. The dictionary is sharded per page so translation could proceed in parallel, with two quality
gates in the test suite (coverage, duplicate-key conflicts). First visit with no cookie picks a
language from `Accept-Language`.

Commits: `6611f35`, `c963a44`, `1c837c0`, `9602c7e`

### 2026-08-17 — Programmatic SEO and GEO (`llms.txt`)

Wallet and market pages rendered entirely on the client, so crawlers saw a loading placeholder. A
server-rendered SEO layer now emits metadata, JSON-LD, and a short factual snapshot for both, joined
by `robots.ts`, `sitemap.ts`, English metadata and `/llms.txt`. The architectural constraint, enforced
in `lib/seo.ts`: this layer reads local SQLite only and must never trigger an upstream request —
crawler traffic cannot be allowed to spend the engine's Polymarket API budget. Pages with no local
data are `noindex` rather than thin.

Commits: `f44247f`, `62169ff`

### 2026-08-17 — Navigation information architecture and operator page tabs

The top nav went from a flat list to two direct links around three grouped dropdowns, ordered by the
product's own argument: market facts → the actors we identify → our own output → after-the-fact
accounting. Alert-condition editing moved off `/alerts` into `/manage`, which was itself split into
functional tabs. A perceived slowness when switching pages turned out to be disabled nav prefetching;
restoring it plus route skeletons and client-side route caching fixed it.

Commits: `ebc5deb`, `5c5767c`, `095ab84`, `b39f7e3`

### 2026-08-16 — Counterfactual exit analysis

Answers "what if these strategies took profit, cut losses, or timed out" by replaying the immutable
price path of already-settled positions against a nine-rule grid, offline. It rides the existing
10-minute backfill carrier with a capped number of upstream calls per round, stores conclusions
rather than paths, and covers every tier's full history at once with no standing load. The design
document opens with a rejection record: a live-exit strategy tier was implemented the same day and
rolled back in full after review.

Commits: `0f7dacf`, `516ae98`

### 2026-08-15 — `/manage` operator console

An operator console with no navigation entry: alert rules, engine health, API key issuance, and
per-type push switches. Later passes added a status strip, delivery backlog counters, auto-refresh,
and confirmation on destructive actions; the presentation layer was then rewritten against the v3
design system with no logic change.

Commits: `ff04efb`, `b125ce5`, `c966567`

### 2026-08-13 → 2026-08-15 — External signal system (ledger, dual channel, multi-tenant, webhook)

Four batches turned strategy buy triggers into durable, immutable signal facts that fan out through a
delivery bus. `strategy_signals` is an append-only ledger wired into the open/settle path;
`runDeliveryCycle` became the seventh worker loop, idempotent on `(signal_id, event, channel)`;
Telegram gained a paid realtime channel and a public delayed one, where the only difference is delay
and no fields are stripped; `api_keys` adds lightweight multi-tenancy (sha256 storage, realtime or
delayed tier) without building a user system; webhooks are HMAC-SHA256 signed with a circuit breaker
after repeated failures. A daily digest chains sha256 over the day's published signals into the public
channel as a timestamp, and `/record` publishes only signals that were actually broadcast —
deliberately not the full paper history, because the two are different claims.

Commits: `90f5cbd`, `2467e89`, `61b2256`, `0d126b8`, `076a2d6`

### 2026-08-13 — Reverse control strategies (mirrors of the negative-EV tiers)

Live data showed several tiers with low hit rates and deeply negative ROI, which left one question
untested: was the signal worthless, or was the direction backwards? Six negative-EV tiers each got a
mirror that takes the same signal and buys the opposite outcome. The mechanism is one generic
transform rather than six special cases: `MarketMeta` gained `clobTokenIds` (META_V 2→3) to locate
the opposite token of a binary market, and the pure `reverseCandidate` flips a candidate fail-closed
with a stated reason before it re-enters the existing guard chain, so nothing downstream branches on
it. Seed v4 only inserts the 6 new rows, bringing the total to 19; existing tiers are byte-for-byte
untouched, because a tier's recorded history is only meaningful against the parameters that produced
it.

Commits: `72ec34e`, `ea47844`, `d472acb`, `9b1fd83`, `91954cc`

### 2026-08-13 — Track × strategy edge matrix, defect diagnosis, chart interaction

A track × strategy edge matrix aggregated across tiers, intended as the selection pool for designing
new tiers, plus segment-level defect diagnosis on three dimensions (track, holding duration, odds
band) with counterfactual removal, to locate where a given tier actually loses money. Same batch on
the presentation side: the strategy page's three data regions collapsed into sub-tabs, the
deep-analysis comparison table became a bubble quadrant (region shading, adaptive domains, label
collision avoidance), every chart gained a selected-point readout, and the equity curve moved to a
13-hue palette because a dozen similarly-colored lines were unreadable.

Commits: `4930ac0`, `bc95124`, `5b3249d`, `f4ecd80`, `02bc196`, `4603f46`

### 2026-08-13 — Event subcategory (sports split by league)

Once deep analysis shipped, a single "Sports" bucket mixing NBA, NFL, soccer and tennis had no
explanatory power. Gamma's `tags` array already carried the second level; the original implementation
read the first tag and discarded the rest, and tag order alone is not reliable. A whitelist × tag-order
derivation now produces `{category, subcategory}` with lazy backfill into the cache, every market
surface shows the finer label, and the public feed gained `subcategory`. First-level semantics are
unchanged everywhere, so no existing statistic shifted.

Commits: `6704c76`, `3e365fd`, `77fa1fd`, `665e0ae`

### 2026-08-13 — Strategy deep-analysis panel (six dimensions)

Six views over all historical paper bets, aimed at three questions the existing tabs could not answer:
where the money came from, whether the wins are skill or luck, and whether any edge is decaying.
Odds-band calibration edge, P&L scatter, weekly bars, first-half vs. second-half decay, losing-streak
concentration, and holding duration by track. Reachable both as a tab inside a tier's detail modal and
as an all-tier aggregate.

Commits: `74275a2`, `01eda0c`

### 2026-08-12 → 2026-08-13 — Follow page redesign and rename to "Strategy Center"

With 12 tiers, "12 flat cards × 14 metrics each" had become counterproductive. Cards were cut to a
few numbers plus a mini equity curve, detail moved into a modal (later tabbed: overview / deep
analysis / cost breakdown / account simulation / action history / positions), the large charts became
interactive, and a card/list toggle was added with list as the default. The product was renamed from
"paper follow" to "Strategy Center", with "real data · simulated strategy" stated on the first screen
so the rename could not be read as a promotion to something live.

Commits: `f347727`, `6dd6d90`, `213b63d`, `b23dcab`, `5311a9c`, `a06eab0`

### 2026-08-11 → 2026-08-12 — Strategy tiers: 2 → 13, and the detector registry

The two original strategies differed only in a consensus threshold, using about one and a half layers
of the available strategy space. This batch extracted a `FollowCandidate` contract and a detector
registry: six detectors (`consensus`, `heavy`, `lopsided`, `resolved`, `lone_wolf`, `early_winner`),
all pure functions, so adding a signal source is one function plus one registry line and no change to
the open/settle code. Seed v2 added 10 tiers at once without touching the existing two; a 13th
("contrarian minority side") followed as the control for the lopsided tier.

Fixed during the batch: the "disagreement resolved" criterion used `netShares × avgBuyPrice`, which is
blind to capitulation (a zero-buy full exit contributes exactly 0) and sign-flipped on profitable
exits (buy 100 @ 0.5, sell 150 @ 0.9 scored −25). It now uses realized cash flow.

Commits: `37a4c72`, `db70ef4`, `3598c24`, `f594a59`, `af79a1c`, `c77838c`

### 2026-08-04 — Record-correctness quartet

A review of the published performance numbers found four systematic biases, and all four flattered
the result. The SELL-side implied baseline had the wrong sign; consensus upgrade rows double-counted;
protocol fees were never booked; settlement was pinned on prices a UMA dispute could overturn. All
four are in the corrections table. Supporting work: gamma fee-schedule and UMA dispute-status
collection with zero additional upstream calls, and P&L split into three explicit tiers (paper / after
chase cost / after fees) that may only be subtracted from one another within the same tier.

Commits: `80d2d34`, `bb4fe4f`, `0e52e33`, `bbc2b61`, `fd6c3f4`, `ebfb275`, `3fb9377`

### 2026-07-31 — Execution modelling and account simulation

The follow page gained a position tab switch, per-strategy filtering, a fund-style profile, an account
simulation modal (suggested bankroll = peak exposure × 1.25), a dated equity curve, and an
action-history timeline. Then a user pointed out that the column labelled "slippage" was not execution
slippage at all — it was the cost of chasing the smart-money entry price — and that the paper entry
price is not even a fillable price, but a ~10-minute-granularity trade snapshot from CLOB price
history. The column was renamed "chase cost" and the paper caveat disclosed site-wide; execution was
then modelled for real by taking a CLOB `/book` snapshot at open and simulating an aggressive fill.
That work also pinned down a counter-intuitive upstream fact now encoded in `lib/orderBook.ts`:
`/book` levels are sorted outside-in, so the best ask is at the **end** of the array.

Commits: `d43660d`, `b4f5252`, `62102c9`, `2c7e7b6`, `7be0ff1`

### 2026-07-29 — Read-only signal feed (S1–S3)

The first read-only feed for an external consumer. S1 added caching and rate limiting to the expensive
routes as a precondition for exposure, S2 folded the alert stream into consumable cards in
`lib/signalFeed`, S3 shipped `GET /api/signals` with a written contract. The contract also fixes the
topology: app clients must not connect to this service directly — it is a single-process Next + SQLite
research service whose rate limiter is an in-process `Map`, so the consumer's backend polls once a
minute and does its own caching.

Commits: `9b37957`, `85354ef`, `c402653`

### 2026-07-28 — Ops hardening: deployment gate, daily backup, dead-man's switch

Three prerequisites before opening the deployment. Writes require `ADMIN_TOKEN` under a public
deployment, and an unset token disables remote writes rather than opening them; expensive fan-out
routes get two-layer rate limiting priced in _upstream requests_ rather than HTTP requests, because
one wallet-stats call can cost up to ~42 upstream calls (`/traded` + `user-pnl` + up to 20 pages each
of `/closed-positions` and `/positions`). SQLite takes a daily online snapshot (7 kept) so
the record stops being a single point of failure. `/api/health` plus an external ping that only fires
when all loops are fresh makes "no signals today" distinguishable from "the engine died", and makes a
silently hung loop trigger the same external alarm as a dead process.

Two measurement fixes shipped alongside: the asymmetric ε dead-band and the retired "at least X% after
removing luck" phrasing — both in the corrections table.

Commits: `b846a8e`, `a698ae9`, `6d4b991`, `e9c658e`, `d04e08b`

### 2026-07-27 — Credibility groundwork: parameter snapshots, self-carried record, resident engine

Parameter snapshots plus `config_history` make every signal attributable to the rule version that
produced it, and each push carries its own 30-day hit rate rather than a site-wide claim. The
server-resident engine became the default form, with a daily heartbeat self-check. Admission gained a
`netPnl > 0` requirement, so a 58%-win-rate, −$87k "small wins, big losses" wallet can no longer enter
the pool, plus a one-time re-audit that expelled existing members admitted under the looser rule.

One entry here was reversed the next day and is worth knowing about: `6ca04fa` rewrote the Wilson
lower bound as "at least X% after removing luck", which reads well and is wrong, and `d04e08b` retired
it (corrections table).

Commits: `007e3e7`, `f3030a7`, `13fe579`, `0714c21`, `6ca04fa`, `9e252cf`

### 2026-07-27 — Single-market signal card, bot queries, signal-density dashboard

`/market/[conditionId]` is the "ten seconds to a conclusion" exit, reachable from every market row via
a ⧉↗🎯 trio, from a paste box at `/market` that accepts a URL, slug or conditionId, and from a
Telegram DM — the bot answers with the same card built by the same `lib/marketCard` implementation, so
the two surfaces cannot drift. `cycle_metrics` records per-cycle signal density, which is the only
thing that distinguishes "the market cooled off" from "our thresholds drifted".

Commits: `4395a28`, `216417c`, `8fd9fa4`, `b8a7b4b`, `b5eb8b6`

### 2026-07-26 — Validation loop moves into the worker; adversarial review

Outcome backfill moved from on-demand (something had to open a page) to a standing worker loop, so the
hit-rate denominator is the full alert history rather than the alerts somebody happened to look at. A
19-agent, three-perspective adversarial review followed and 11 confirmed defects were fixed; three of
them were measurement-level and are in the corrections table. Also in this batch: upstream silently
lowered the `/activity` limit from 1000 to 500, which took the wallet dossier page down entirely until
pagination was reworked.

Commits: `a2b3140`, `b37e670`, `1d6eb0b`, `f7bdc01`, `06415e1`, `93e6321`

### 2026-07-08 → 2026-07-10 — Smart-money discovery channels and the admission gate

The whitelist stopped being leaderboard-only. Three discovery channels write evidence rows into
`wallet_candidates`: trade-flow emergence (echo / splitter / insider sub-signals), early winners found
by replaying settled markets for wallets that bought correctly, early and cheap, and category-leaderboard
specialists. One admission gate is the only path from candidate to whitelist — win rate ≥0.55 with ≥10
settled, or ROI ≥0.05 with ≥5, positive net P&L required in both, and ≥1000 distinct markets classified
as a market maker and rejected — and `/discovery` shows both funnel levels with the underlying evidence.

A 28-finding adversarial review then fixed a coverage collapse worth stating plainly: gamma's settlement
stream is flooded by 15-minute micro-markets at roughly 700/hour, so the default 500-row window covered
about 45 minutes and silently missed an estimated 97% of eligible settlements. The same review closed a
hole where category-leaderboard rows entered the pool without passing the gate, with a migration that
purged the rows already admitted that way.

Commits: `039fa57`, `fc3e5f3`, `6bdb2bf`, `21c772f`, `a3e94cb`, `4f5a55e`, `64608f4`

### 2026-07-08 — Follow guardrails, three-stage cost attribution, signal-ledger design

Guardrails against the two ways a paper follow flatters itself. It now only follows consensus formed
within the last 30 minutes, skips settled markets, excludes contested (disagreement) markets, and
refuses entry beyond a price-deviation guard (10¢ default, per strategy). Triggering was re-anchored on
`formationTs` with three prices recorded at open and markout backfilled later, which lets the page split
the gap between the smart-money price and ours into delay cost / formation price / markout. The same
day's system-level design document names the underlying coupling — collection, detection, execution and
presentation all live in one Node process — and stages the decomposition.

Commits: `902e5b1`, `ebad7af`, `cf4e3fd`, `6efcf2f`, `26127ec`, `c51d770`

### 2026-07-07 — Paper follow engine (`/follow`) v1

A paper-trading layer on top of read-only consensus detection: when a consensus forms, open a virtual
position at the current price, hold to settlement, aggregate into per-strategy equity curves so strategy
variants run A/B in parallel. Implemented as pure functions (single-position P&L, threshold filtering,
nearest price in window, equity / drawdown / Wilson / per-track metrics) plus an injected
`runFollowCycle` hung off the existing 5-minute consensus loop, two new tables, a read-only `/api/follow`,
and the board itself. Nothing is ever ordered.

Commits: `a014fcb`, `102dd94`, `c57312c`, `0196f4a`, `b347184`

### 2026-07-06 → 2026-07-07 — Disagreement detection, wallet UX, mobile, Docker

Smart-money disagreement joined consensus as its mutually exclusive counterpart on a single page.
Wallet surfaces gained a clickable whitelist dialog, current holdings and new-tab detail; the site lost
horizontal scrolling on mobile; `Dockerfile` and `docker-compose.yml` landed. Three accounting
corrections shipped here: consensus now excludes hedgers, because a wallet holding both outcomes used to
leak into two opposing "consensus" groups; high-frequency market makers are identified by distinct
markets traded (the measured separation was clean — directional traders ≤192, bots ≥1077) and get no win
rate; and net P&L switched off `/closed-positions` summation (corrections table).

Commits: `ba36e97`, `e54b419`, `d1b5f69`, `42af83b`, `dd5f56e`, `8d2cb4f`

### 2026-07-02 → 2026-07-03 — Reliability, noise reduction, and upstream reality

Mostly a batch about upstream behaving differently than documented. Restart no longer misses alerts (a
bounded 30-minute backfill window recovered from `MAX(seen_trades.ts)`) and two processes no longer
double-post: `seen_trades` doubles as a cross-process claim lock via `INSERT OR IGNORE`, claim-then-send,
with the claim rolled back if sending fails. Also shared retry with per-row salvage in the fetch layer,
warn-and-default config validation, default noise reduction on the alert stream, and a hardened Telegram
send chain (encoding, retries, poison-message isolation, throttling) with channel self-diagnosis.

Three upstream facts were established the hard way and are now encoded with regression tests: `/trades`
hard-caps `offset` at 3000 and returns 400 past it (dense windows used to fail outright), gamma
`/markets` omits closed markets unless asked, and `/activity` sorting cannot be trusted (all three in
the corrections table).

Commits: `e94380e`, `8a878c5`, `ccb72d1`, `5521680`, `cf13665`, `d890317`, `f302050`, `ac6e358`

### 2026-07-02 — Smart-money suite: track record, whitelist, consensus, dossier, validation

The project's second pillar landed in one day: a wallet track-record engine with badges on the scanner
and accumulation views, a leaderboard-seeded smart-money whitelist that tags live alerts, gamma market
context (impact ratio, pre-settlement rush), consensus detection with its own board and pushes, the
`/wallet/[address]` dossier, and an on-demand validation loop (follow-through plus settlement backfill)
so alerts are graded after the fact. A 14-finding adversarial review followed; the most consequential
was survivorship bias in the win rate (corrections table). A glossary page with hover tooltips for every
symbol shipped alongside, on the theory that a symbol nobody can decode is not a signal.

Commits: `3f50dc4`, `e52c2b3`, `d19b7d0`, `38e6baf`, `6ed7e2b`, `163dcb5`, `97d31a9`, `f01a679`

### 2026-06-30 — Design system v3, new-record chime, configurable port

Adopted the MM Manage v3 (light) design system across the dashboard, added an optional chime for new
records shared between the alerts page and the 24h scanner, and made the dashboard port configurable via
`PORT` with `.env` support.

Commits: `a95085f`, `3c867eb`, `4687eb3`, `0fc0f7a`

### 2026-06-24 → 2026-06-25 — 24h scanner, accumulation ranking, address age

The dashboard grew from an alert list into a research tool. The 24h large-trade scanner filters by
amount, side, odds and address age with sortable time and amount columns. The split-buy accumulation
ranking aggregates by (wallet, market, outcome) to catch positions assembled from many orders each
sitting under the single-trade alert threshold. Address age is annotated to the exact day under 30 days
and to hours and minutes under one. The embedded alert engine, configurable from the dashboard with
Telegram optional, closed the batch.

Commits: `8e84728`, `2efc9ca`, `3a61426`, `1bca73d`, `481baa0`

### 2026-06-23 → 2026-06-24 — Foundation: large-trade monitor, Telegram push, read-only dashboard

Design document and phased TDD plan first, then a minimal ESM TypeScript skeleton: env-validated config,
a SQLite layer with migrations, a Telegram client that honours `retry_after`, the large-trade client, the
alert formatter, and the pure dedup and poll-selection logic. The resident worker followed, including
silent cold-start seeding so a first run does not fire a storm of alerts for history it has just
discovered, plus process guards and start retry. The read-only Next.js dashboard closed the phase. No
Polymarket authentication anywhere — everything reads public endpoints.

Commits: `e15888c`, `cf8e2d0`, `9ae8bd4`, `4b62c89`, `d9af8e2`, `5b6113a`

## Before this changelog

Nothing precedes it: the first batch above is the first commit. But this file was written after the
fact, on 2026-08-18, by reading `git log`, and it is deliberately lossy — 341 commits compressed into
33 batches, with individual UI fixes, test additions and merge commits omitted.

For anything not here:

- `git log --date=short --pretty=format:'%h %ad %s'` for the full sequence.
- Commit bodies, which are the real record. Most fixes cite the measurement that motivated them
  (live wallet addresses, sample sizes, before/after figures) and the regression test that pins the
  behaviour down.
- `docs/plans/` — 24 design and implementation documents, one pair per major batch, including
  rejection records for approaches that were built and then removed.
- `docs/api-access.md` (subscriber-facing API contract) and `docs/signals-api.md` (internal contract
  and revision history).
