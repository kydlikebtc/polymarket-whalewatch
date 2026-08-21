# Architecture

WhaleWatch answers one question that Polymarket's own UI does not: _who is moving size, and were they right?_
A whale rarely announces themselves — they split a position into sub-threshold orders, trade from
freshly-created wallets, and enter at favorable odds. The system watches the public trade firehose for
those patterns, pushes what it finds to Telegram and X, and then keeps a permanent, auditable record of
whether each published signal actually paid.

The load-bearing architectural judgment is the split between **two paths that never call each other**:

- **The worker is the stateful alert path.** It polls Polymarket, decides what counts as a signal,
  writes to SQLite, and pushes to Telegram / X. It owns every side effect. Dedup and delivery use
  _claim-then-send_: the claim row is written first (`INSERT OR IGNORE` on a unique index), and only a
  successful claim earns the right to send — so a crash re-run or a second engine process cannot
  double-push (`lib/seen.ts`, `lib/signalDelivery.ts`).
- **The dashboard is the stateless exploration path.** `/`, `/accumulation`, `/consensus` and the market
  and wallet pages query Polymarket's public API _live_ on each request and filter in memory. They do not
  archive the trade flow and they do not write to the alert tables. The one deliberate exception is that
  read routes may _read_ engine-populated caches (e.g. `/api/scan` opens the db only to look up the
  `event_category` taxonomy).

The two paths meet at exactly one place: **the SQLite file**. The worker writes it, the dashboard reads
it. That is the whole coupling contract — there is no queue, no IPC, no shared in-process state. This is
why the dashboard stays useful when the engine is dead (it just falls back to what is already on disk and
`/api/health` starts returning 503), and why the engine keeps working with the dashboard closed.

In production the worker is **not** a separate service. `instrumentation.ts` is auto-loaded once per Next
server process; when `NEXT_RUNTIME === "nodejs"` it dynamically imports `worker/embeddedEngine.ts` and
calls `startAlertEngine()`. So `npm run start` (and `npm run dev`) boots the dashboard _and_ the engine in
one process, against one db file, with zero extra configuration — the docker image is a single container.
`npm run worker` (`worker/index.ts`) is the same `startAlertEngine()` without Next, kept for headless
runs. `startAlertEngine` guards a module-level `started` flag, which is a **per-process** singleton only:
running Next and `npm run worker` at once gives you two engines on one db. Alert rows stay deduped and
Telegram pushes stay claim-locked, but the Telegram bot's `getUpdates` long-poll tolerates exactly one
consumer per token, so run one or the other.

## Data flow

```text
                       Polymarket public APIs (no auth, no keys)
   data-api /trades · /positions · /closed-positions · /activity · /v1/leaderboard
   gamma /markets · /events        clob /prices-history · /book
   user-pnl-api                    Polygon public RPC (PUSD balance)
                                      │
              ┌───────────────────────┴────────────────────────┐
              │                                                │
     ╔════════▼═════════════════════════════╗        ┌─────────▼──────────────────┐
     ║  WORKER — stateful (embedded in the  ║        │  DASHBOARD read routes —   │
     ║  Next process via instrumentation.ts)║        │  stateless, live queries   │
     ║                                      ║        │  (/api/scan, /consensus,   │
     ║  alert 4s ── consensus 5m            ║        │   /accumulation, /market,  │
     ║  outcome-backfill 10m ── delivery 30s║        │   /wallet, /positions)     │
     ║  x-broadcast 60s ── bot 2s           ║        │  in-memory filtering,      │
     ║  evidence-backfill 6h ── health 60s  ║        │  short promise caches      │
     ╚════════╤═════════════════════════════╝        └─────────┬──────────────────┘
              │ writes                                         │ reads (caches, records)
              ▼                                                ▼
     ┌───────────────────────────────────────────────────────────────────────┐
     │  SQLite (WAL, better-sqlite3) — the ONLY coupling between the paths   │
     │  ledgers: alerts · seen_trades · strategy_signals · follow_positions  │
     │  credentials: api_keys · x_accounts · tg_targets · webhook_endpoints  │
     │  caches: market_meta · wallet_stats · wallet_age · alert_outcomes     │
     └──────┬─────────────────┬──────────────────┬───────────────┬───────────┘
            │                 │                  │               │
            ▼                 ▼                  ▼               ▼
     Telegram push      X (Twitter)        /api/signals     webhook POST
     (large / consensus (whale · pregame   feed, API-key    (HMAC-SHA256,
      / strategy /       / weekly /         tiered:          circuit-broken
      ops channels)      settled reply)     realtime|delayed after 10 fails)
            │                 │                  │               │
            ▼                 ▼                  └───────┬───────┘
     public + paid TG    growth channel                  ▼
        channels                                  subscriber backends
                                                  (they cache + fan out;
                                                   see "Design constraints")
```

## Subsystems

`lib/` holds 90 non-test TypeScript modules at the top level plus 15 in `lib/i18n/`. The 90 top-level
modules group into eleven functional clusters (A–K); `lib/i18n/` is described separately as L.
Nearly every module has a pure-function core with I/O injected, which is why
the suite runs 1346 tests across 105 files in about two seconds with no network and no fixtures server.

### A. Upstream clients

`polymarket.ts` · `gamma.ts` · `leaderboard.ts` · `priceHistory.ts` · `orderBook.ts` · `holdings.ts` ·
`walletProfile.ts` · `walletAge.ts` · `walletStats.ts` · `pusdBalance.ts` · `fetchWithRetry.ts`

Every outbound request goes through here. `fetchWithRetry` owns the single backoff policy
(`TRANSIENT_STATUS` = 408/425/429/500/502/503/504) so no caller invents its own. `polymarket.ts` parses
`/trades` **row by row** (`parseTradeRows`): one malformed row from upstream shape drift is dropped and
summarized in a warning rather than poisoning the page — the older all-or-nothing fallback returned raw
rows and let `NaN` notionals slip past every filter, because every `NaN` comparison is false, and fired
`$NaN` alerts.

The clients also carry the field-tested facts that are easy to get wrong:

- `walletAge.ts` cannot just ask for the oldest activity. `sortDirection` without `sortBy` is not
  time-ordered, so it requests `sortBy=TIMESTAMP&sortDirection=ASC&limit=10` for a _candidate_, then
  back-verifies with up to 8 reverse probes before accepting a first-seen timestamp.
- `orderBook.ts` re-sorts the CLOB `/book` response unconditionally: the live API returns bids/asks
  **outside-in, best level last**. Walking the array in the conventional order eats the worst level first.
- `walletStats.ts` pages `/closed-positions` and `/positions` at 50 rows × 20 pages (~1000 settled
  positions) and takes net P&L from `user-pnl-api` rather than summing positions, so the number matches
  what Polymarket's own profile shows.
- `pusdBalance.ts` is the only non-Polymarket upstream: an `eth_call` of `balanceOf` on the PUSD
  collateral token via public Polygon RPCs, for the "idle cash" figure on the wallet dossier.

### B. Alert engine

`alertEngine.ts` · `alertConditions.ts` · `alert.ts` · `alertHits.ts` · `poll.ts` · `seen.ts` ·
`trades.ts` · `types.ts`

The original product. Every cycle re-reads the user-editable conditions from the `config` table (so an
edit takes effect on the next 4-second tick), selects unseen trades, claims them in `seen_trades`, renders
HTML, and pushes. `seen_trades` is both the dedup ledger and the cross-process claim lock —
`INSERT OR IGNORE` returning `changes === 1` means _this_ process won the row, and `unmarkSeen` rolls the
claim back when the send fails.

Two defaults in `DEFAULT_CONDITIONS` exist because of measured production data, and they matter for
reading any hit-rate number: `maxPrice: 0.95` (28.6% of alerts landed at ≥0.90 — settlement-sweep fills on
near-certain outcomes that carry roughly zero information) and `cooldownMinutes: 30` (one wallet re-firing
on the same market was 14.2% of all pushes). So "every large fill gets pushed" is not true by default.

### C. Smart-money pool and discovery

`smartWallets.ts` · `admission.ts` · `admissionGate.ts` · `discovery.ts` · `earlyWinner.ts` ·
`discoveryView.ts` · `walletTags.ts`

`smart_wallets` has exactly one entrance. Each UTC day the pool is seeded from the official leaderboard
plus six category boards; three discovery channels write _candidates_ to `wallet_candidates` (firehose
emergence — echo / splitter / insider; early winners found by sweeping settled markets for wallets that
bought early and cheap; category-board specialists). Candidates then face
`evaluateAdmission`: recurrence across ≥3 distinct markets in a 30-day window, plus a track-record check
(win rate ≥0.55 with ≥10 settled, or ROI ≥0.05 with ≥5 settled, and positive net P&L). A wallet with
≥1000 markets traded is classified as a market maker and rejected — its flow is inventory, not an opinion.

### D. Consensus, disagreement, and market-flow analysis

`consensus.ts` · `disagreement.ts` · `marketSignals.ts` · `netPosition.ts` · `accumulate.ts` ·
`marketBrief.ts` · `marketCard.ts` · `cycleMetrics.ts`

One deep trade window feeds three detectors. Consensus is _N_ whitelisted wallets net-buying the same
outcome; disagreement is smart money on both sides, quality-weighted by pool score;
`marketSignals.excludeContestedFromConsensus` keeps the two mutually exclusive at the market level, so a
contested market can never render as two independent consensus signals.
`netPosition.ts` defines net exposure by cost basis rather than raw `buyUsd − sellUsd` cash flow, which
was the fix that eliminated phantom "net buys". Its inputs are BUY/SELL fills only, and redemption is a
separate activity type that never appears in `/trades` — so once a market settles the figure describes
what was _deployed in the window_, not what is _still held_. `gamma.isSettled` is the single definition
of "settled", and `runConsensusCycle` gates the push path on it: a settled market's group is dropped
before the claim, so no push, no `alerts` row, no `consensus_state`. Missing meta defers to the next
cycle rather than guessing either way. `marketCard.ts` is shared verbatim between
`/api/market/[conditionId]` and the Telegram bot's card reply, so the two surfaces cannot drift.
`cycleMetrics.ts` records per-cycle signal density — the only thing that distinguishes "the market cooled
off" from "our thresholds drifted".

### E. Strategy simulation (paper trading)

`follow.ts` · `followCandidate.ts` · `sourceConsensus.ts` · `sourceHeavy.ts` · `sourceLopsided.ts` ·
`sourceResolved.ts` · `sourceWallet.ts` · `reverse.ts` · `followAnalysis.ts` · `followInsights.ts` ·
`followCardView.ts` · `exitCounterfactual.ts` · `fees.ts`

The largest subsystem, and the one the README under-describes. 19 seeded strategies open paper positions
when their detector fires and hold to settlement. `followCandidate.DETECTORS` is a registry mapping a
strategy's `source` field to one of six pure detector functions (`consensus`, `heavy`, `lopsided`,
`resolved`, `lone_wolf`, `early_winner`); adding a signal source is one function plus one registry line,
with zero changes to the entry/guard/fee/execution code. Six of the 19 are **reverse controls**:
`reverse.ts` flips a candidate to the opposite binary outcome (using `MarketMeta.clobTokenIds`) so a
negative-EV tier gets a same-signal, buy-the-other-side mirror. That exists because several tiers measured
negative, and "would fading this have worked?" is otherwise unanswerable.

`fees.ts` is where an early assumption got falsified. "Polymarket has no fees" was true when this project
started and is not true now — verified live against gamma on the top 100 markets by 24h volume: 72 carry
`feesEnabled`, covering 57.8% of volume, across seven fee categories. On a live $500 fill the order-book
slippage measured $0.00 while the taker fee was about 2.5% of notional, making the protocol fee the single
largest cost term. `orderBook.ts` supplies the execution-layer attribution (a book snapshot at entry,
simulated as a market take) and `follow_positions` stores `formation_*`, `markout_*`, `exec_*` and
`fee_usd` as **attribution-only** columns — a hard line: they are displayed, never folded into
`realized_pnl`. `exitCounterfactual.ts` replays a nine-rule take-profit / stop-loss / time-exit grid over
the immutable price paths of already-settled positions.

### F. Validation loop and statistics

`alertOutcomes.ts` · `outcomeBackfill.ts` · `outcomeStats.ts` · `signalRecord.ts`

The subsystem that lets the project make falsifiable claims. `alertOutcomes` fetches 1h/24h follow-through
prices and the final settlement for each alert; because historical prices are immutable, results are
cached permanently and a cold alert costs at most two `prices-history` calls, ever. `outcomeBackfill` runs
this on a worker cadence rather than on page view, so the win-rate denominator is _all_ alerts, not just
the ones somebody happened to open.

`outcomeStats.ts` is the single source of truth for win/loss and for uncertainty. It carries an
`OUTCOME_EPSILON = 0.005` dead zone, settles against the executed price rather than a fixed 0.5, and
exposes both `wilsonInterval` and `clusteredInterval`. The clustered form is the one used for published
conclusions: many alerts on one market are N copies of a single random event, and treating them as
independent understates the error by roughly 1.9×.

### G. Signal bus and outbound delivery

`signalBus.ts` · `strategySignals.ts` · `signalDelivery.ts` · `signalPush.ts` · `signalDigest.ts` ·
`signalFeed.ts` · `strategyFeed.ts` · `recordFeed.ts` · `webhookDelivery.ts` · `apiKeys.ts` ·
`feedAuth.ts` · `adminOverview.ts`

Production of a signal is fully decoupled from its distribution. `strategy_signals` is an immutable fact
ledger; `signalBus` projects other site-wide signal types into `bus_signals` (reading local tables only —
never recomputing); `signalDelivery` fans out with `signal_deliveries (signal_id, event, channel)` as the
idempotency primary key and a per-channel `minEmitAgeSec` that implements the free/paid tiering as a pure
_delay_, not a field-stripped payload. Webhooks are HMAC-SHA256 signed and trip a circuit breaker after 10
consecutive failures. `apiKeys` stores only a sha256 of each key with a `realtime | delayed` tier and an
optional bus-type subscription scope.

`signalDigest.ts` is the credibility artifact: once per UTC day it chains a sha256 over the previous day's
_published_ signals — previous digest included — and posts the digest to the public Telegram channel.
Telegram timestamps it and channel history is not editable, so any third party can recompute and compare.
Chaining rather than per-day independence means rewriting one historical day breaks every digest after it.

### H. Telegram

`telegram.ts` · `tgFormat.ts` · `tgTargets.ts` · `telegramHealth.ts` · `botCommands.ts`

`telegram.ts` classifies failures: a 4xx that is not 429 becomes a `TelegramPermanentError`, so one poison
message cannot wedge the queue behind infinite retries. `tgTargets.ts` promotes the old single
env-configured bot+channel into manageable rows (four kind switches, per-target delay, pause flag) and
falls back to env when the table is empty — that fallback is a production safety line, because an upgrade
must never silently stop the push. `telegramHealth.ts` counts consecutive failures in `config`, pushes a
self-diagnosis at 3, and **rethrows the original error** so upstream claim-rollback semantics survive.
`botCommands.ts` makes the bot bidirectional: DM a market link, slug, or conditionId and get a card back.

### I. X (Twitter) broadcast

`xBroadcast.ts` · `xComposer.ts` · `xPublisher.ts` · `xOauth.ts` · `xAccounts.ts` · `xQuota.ts` ·
`xSettings.ts` · `xPregame.ts` · `xSettled.ts` · `xWeekly.ts`

A pure _consumer_ of the `alerts` table, physically isolated from the Telegram path — any X failure is
logged and dropped, never propagated. `xComposer` is template-only and enforces two hard invariants: ≤280
characters, and no URL except in the weekly post, because a link post costs $0.20 against $0.015 for text.
`xQuota` is a local fail-closed ledger where both `claimed` and `posted` rows count against the budget
(an orphaned claim should over-charge, never under-charge). `xAccounts` / `xOauth` implement 3-legged
OAuth 1.0a with credentials re-resolved every cycle, so switching the broadcast account in `/manage` takes
effect within 60s and never requires a restart. `xSettled` replies to the project's own earlier signal
posts with the settled result — wins and losses both.

### J. Operations and hardening

`heartbeat.ts` · `health.ts` · `dbBackup.ts` · `apiGuard.ts`

`beat(db, loop)` is called after a cycle _completes_, not when it is scheduled, and rolls counters by UTC
day. `evaluateHealth` marks a loop stale past its own threshold (alert 300s, consensus 1200s,
outcome_backfill 2100s, delivery 600s, everything else 3600s) and — importantly — also fails when an
expected loop has _never_ beaten and the process has been up longer than that loop's threshold. That third
condition is the one that catches the worst failure mode: a loop that throws on every single pass writes
no heartbeat row at all, so "the rows we have are fresh" would otherwise rate a total outage as healthy.
`delivery` is in `CONDITIONAL_LOOPS` and exempt from the never-beaten check, because an install without
Telegram credentials legitimately never starts it.

`dbBackup.ts` uses better-sqlite3's online backup API (WAL-safe, non-blocking) once per UTC day, writes to
`${dest}.tmp` and renames, keeps the newest 7, and only marks the day _after_ a successful snapshot. No
cron, no sidecar — deploying the image is enough to have backups.

### K. Infrastructure and utilities

`db.ts` · `config.ts` · `mapLimit.ts` · `promiseCache.ts` · `scanFloor.ts` · `categoryLabel.ts` ·
`markdownDoc.ts` · `seo.ts`

`db.ts` is the only place that creates tables or runs migrations (31 `CREATE TABLE` statements plus
version-gated `ALTER`/re-seed steps keyed off `config` markers). `config.ts` parses env with zod and
_warns and defaults_ on bad values instead of throwing — with a floor of 1000ms on `POLL_INTERVAL_MS`,
because a `NaN` there turns a 4-second poll into a ~1ms busy loop against the trade API.
`promiseCache.ts` caches the in-flight promise, not just the result, so a cold cache under concurrency
collapses to one upstream fetch instead of a stampede. `seo.ts` carries an architectural red line stated
in its header: the SEO layer reads local SQLite only and must never trigger an upstream request, because a
crawler taking thousands of pages a day would otherwise exhaust the same API budget the engine runs on.

### L. Bilingual dictionary

`lib/i18n/core.ts` + `lib/i18n/dict/*` (15 files)

Isomorphic, dependency-free zh/en layer where the **Chinese source string is the key**: `t("已结算胜率")`
returns itself in zh, looks up the dictionary in en, and falls back to Chinese for a missing translation.
Dictionaries are sharded per page so translation work parallelizes; `dict/index.ts` is the single merge
point.

## Worker loops

All eight loops in `worker/embeddedEngine.ts` self-schedule with `setTimeout` (not `setInterval`), so a
slow cycle delays the next one instead of stacking. First runs are staggered to avoid a startup thundering
herd against the shared upstream budget.

| Loop                | First run | Cadence                                       | Responsibility                                                                                                                                                                                                                                                                                                     | Heartbeat          |
| :------------------ | :-------- | :-------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------- |
| `alert`             | immediate | `POLL_INTERVAL_MS`, default 4s (min 1s)       | Fetch `/trades` at `min(minUsd, $10k)` — 250 rows × up to 4 pages, stopping early once a page contains already-seen rows — run `runAlertCycle`, push, persist. Also carries the day-gated daily leaderboard seed, discovery run, `seen_trades` prune, and 🩺 self-check.                                           | `alert`            |
| `consensus`         | 30s       | 5 min                                         | One 6-hour, $2k-floor deep trade window shared by four consumers: consensus detection + push, firehose evidence collection, `runFollowCycle` (all 19 strategies open/settle), and `projectBusSignals`.                                                                                                             | `consensus`        |
| `evidence backfill` | 60s       | 6 h                                           | Fill in gamma market context for candidate evidence rows written before the columns existed. A free no-op in steady state; the slow cadence exists only to retry transient gamma failures.                                                                                                                         | none               |
| `outcome backfill`  | 90s       | 10 min                                        | Rotate through non-terminal alerts filling 1h/24h follow-through and settlement. Same carrier also runs the exit-counterfactual backfill (≤5 upstream calls per cycle) and the daily SQLite snapshot.                                                                                                              | `outcome_backfill` |
| `bot`               | 10s       | 2s gap (20s long-poll)                        | Telegram `getUpdates`; replies to a pasted link/slug/conditionId with a market card. Only starts when Telegram creds are present. Single-consumer per bot token.                                                                                                                                                   | none               |
| `x broadcast`       | 45s       | 60s (pregame every 10 min, weekly on Mondays) | Consume `alerts` as a post queue; re-resolve X credentials each cycle. Only starts when `X_API_KEY` + `X_API_SECRET` are set.                                                                                                                                                                                      | `x_broadcast`      |
| `signal delivery`   | 45s       | 30s                                           | Rebuild the channel list each pass (Telegram targets flagged for strategy signals + active webhook endpoints), fan out `strategy_signals`, run the daily digest. Freezes delivery while any loop is stale — silence beats misleading output — but beats unconditionally so a frozen cycle is not misread as death. | `delivery`         |
| `health ping`       | 120s      | 60s                                           | Dead-man's switch. Evaluates health locally and pings the external URL **only when everything is fresh**, so a silently hung loop and a dead process trip the same external alarm. Only starts when `HEALTHCHECK_PING_URL` is set.                                                                                 | none               |

On startup the engine resumes from `MAX(seen_trades.ts)` clamped to at most 30 minutes back
(`BACKFILL_CAP_SEC`): a restart gap is backfilled, but a long outage does not replay hours of history and
a cold database starts at "now" rather than firing a storm of historical alerts.

## Data model

SQLite in WAL mode, one file (`DASH_DB`, default `data.sqlite`), 31 tables, all created and migrated in
`lib/db.ts`. The README's older claim that the database "holds only rebuildable caches — delete it and the
system rebuilds itself" **was true early on and is not true now**. The honest split:

### Rebuildable caches — deleting costs time and API budget, not information

| Table                                       | Rebuild path                                                                                                                                          |
| :------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `market_meta`, `event_category`             | Re-fetched from gamma on demand.                                                                                                                      |
| `wallet_age`, `wallet_stats`                | Lazily re-probed; both have been purged wholesale by version-gated migrations when their semantics changed.                                           |
| `alert_outcomes`                            | Recomputable from immutable historical prices + gamma settlement (expensive, but exact).                                                              |
| `position_exit_sims`, `position_path_stats` | Replayable from `prices-history`.                                                                                                                     |
| `market_tilt_history`                       | Snapshots with an explicit prune; old rows are disposable.                                                                                            |
| `bus_signals`                               | Projected from source tables, but only within a 1-hour projection window — older signals are not re-projected, so this is _time-limited_ rebuildable. |

### Non-rebuildable state — deleting is permanent loss

- `alerts` — the alert fact ledger. It is simultaneously the X broadcast queue, the denominator of every
  validation statistic, and the raw material for `scripts/edge-audit.ts`. Nothing regenerates it.
- `seen_trades` — dedup ledger and claim lock; also the restart resume point via `MAX(ts)`. Pruned at 7
  days, which is far wider than any fetch window, so pruning cannot resurrect a duplicate.
- `strategy_signals`, `signal_deliveries`, `follow_positions` — the published-signal evidence chain. The
  delivery key includes `channel`, so rotating a key re-delivers every historical signal to it.
- `api_keys` (sha256 only — the plaintext key is shown exactly once at issue), `x_accounts` (OAuth access
  tokens), `tg_targets` (bot tokens), `webhook_endpoints` (shared secrets). These are credentials and
  subscriber assets. Losing them means re-issuing to every subscriber and re-authorizing every X account.
- `config` — user-edited settings plus day-gate markers plus migration version markers; `config_history`
  is the change audit trail that makes "the thresholds were not quietly moved mid-record" checkable.
- `follow_strategies` — the 19 strategy definitions. Seeds are version-gated and only ever `INSERT`, never
  `UPDATE`, because each tier's historical record is bound to the exact parameters that produced it.
- `consensus_state`, `x_posts`, `heartbeats`, `cycle_metrics`, `wallet_candidates`, `early_winner_scans`,
  `pool_purges` — dedup/spend/observability state. `x_posts` doubles as the local spend ledger, so
  deleting it disables the budget circuit breaker.
- `smart_wallets` is mixed: `is_whitelist = 1` manual marks are not rebuildable; automatic rows are.

Practical consequence: the daily backup (7 rotating snapshots) is what makes the record survivable, and it
writes to `backups/` **next to the database**, i.e. inside the same docker volume. That protects against
corruption and bad migrations, not against volume loss. Copy snapshots off-host for real disaster cover.

## Request paths

Three entrances, three different gates. `lib/apiGuard.isPublicDeployment` decides whether guards are
active at all: `PUBLIC_READONLY` forces it either way, otherwise `NODE_ENV === "production"` — and the
docker image sets that, so a compose deploy is guarded with zero configuration while local development
stays friction-free.

### 1. Public read-only pages

`/`, `/accumulation`, `/consensus`, `/discovery`, `/alerts`, `/follow`, `/record`, `/glossary`,
`/market`, `/market/[conditionId]`, `/wallet/[address]`, plus `/status`.

No token. The gate is a two-tier fixed-window rate limiter whose unit is the **upstream request budget**,
not request count: `guardExpensive` charges `cost` = batch size, because these routes fan out per wallet
or per asset (30 requests × 200 wallets is 6000 upstream calls, and a request-counting limiter would wave
that through). The per-IP tier derives its key from `cf-connecting-ip` / `x-forwarded-for`, which are
client-settable if someone reaches the origin port directly — it is explicitly best-effort _attribution_.
The global tier, keyed by route alone, is the real ceiling. Representative budgets per minute
(per-IP / global): `wallet-age` 600/3000, `current-price` 600/3000, `alert-outcomes` 400/1500,
`wallet-stats` 120/400, `market-card` 120/600, `scan` and `consensus` and `record` 60/300.

Several read routes touch only local SQLite with zero upstream calls (`/api/alerts`, `/api/follow`,
`/api/discovery`, `/api/cycle-metrics`, `/api/whitelist`, `/api/health`) and are deliberately ungated —
`/api/record` in particular is left open on purpose, since a publicly verifiable track record that readers
cannot fetch is not a track record; it defends itself with rate limiting, a 60s cache, and zero upstream
fan-out.

`/status` is a third state — public, no token, but removed from the site navigation and the sitemap.
"Is the engine alive" is something every subscriber has a right to check without asking; "which tiers are
pushing, how many keys exist, where the digest chain is" is internal.

### 2. `ADMIN_TOKEN` operator surface

`/manage` and `/api/admin/{keys,signals,webhooks,tg-targets,x-accounts}`, plus **both** methods of
`/api/alert-config`.

`checkWriteAccess` requires an `x-admin-token` header, compared by hashing both sides with sha256 and then
`timingSafeEqual` (hashing first equalizes lengths, and the length itself must not leak). With no
`ADMIN_TOKEN` configured at all, remote writes are disabled entirely — 403, fail closed, not open.

`GET /api/alert-config` moved behind the same gate: thresholds are a rule set that can be evaded once
known, which is a different thing from a track record that can be verified. Transparency lives in
`/record` and the daily digest chain, not in the threshold panel.

`/manage` renders nothing before verification — not even tab labels or KPI skeletons, since the labels
themselves disclose which loops, channels, and strategy tiers exist. The gate's only source of truth is
the status code of `GET /api/admin/signals` (`app/manage/authGate.ts`); anything that is not `ok` —
including a network error or a 500 — is `locked`, so a broken probe can never read as "passed".

### 3. API-key feed and webhooks

`GET /api/signals` accepts either `SIGNAL_FEED_TOKEN` from env (v1 compatibility path, always `realtime`)
or a key from the `api_keys` table (`realtime` or `delayed`), via `x-feed-token` or `Authorization:
Bearer`. On a public deployment with neither configured the feed is closed with 403; configured but wrong
gives 401; local development is always open.

Three properties are load-bearing:

- **Zero upstream calls.** Every field comes from already-persisted state, so a burst of feed traffic can
  never eat into the engine's Polymarket budget.
- **Server-side scope filtering.** A key's `busTypes` are applied on the server, and the cache key
  includes the scope — otherwise a restricted key and an unrestricted key would share a cache entry and
  leak across tenants.
- **`healthy` is evaluated against real `now`.** A `delayed` tier shifts the _data_ timeline by
  `SIGNAL_PUBLIC_DELAY_MIN`; it does not delay the fact that the engine is down. On failure the route
  returns a structurally complete empty feed with `healthy: false`, so a consumer can never misread an
  outage as "no signals today".

Webhooks are registered by the operator (not self-service) against a `realtime` key, so the SSRF and abuse
surface stays inside the trust boundary; revoking the key kills its endpoints.

## Design constraints

These are the decisions that shaped the system, with the reasons that made them non-negotiable.

**Query public APIs only; do not archive the trade flow.** No authentication, no API keys, no trading.
The dashboard queries live and filters in memory; nothing persists the raw firehose. This keeps the
project unambiguously a research tool and keeps the storage footprint tiny — but it is also a real
limitation, and it is why backtesting-based threshold calibration is still open on the roadmap: honest
backtesting needs a trade archive the project has deliberately not built.

**Fetch low, filter in memory — because a high `filterAmount` times out.** The Data API's server-side
amount filter is fast when matches are dense and times out around 5.75 seconds (408) when they are sparse,
because it scans deep history to fill a page. So both `/api/scan` and the alert loop always fetch at a
`SAFE_FLOOR` of $10,000 and apply the user's higher threshold and side filter in memory. The low-floor
result is a strict superset, so the filtered output is exact — and changing amount or side is instant with
no refetch. `scanFloor.quantizeFloor` snaps the floor to fixed steps so the cache key space stays bounded.

**Single-box SQLite is not built to serve app traffic.** The rate limiter is a process-local `Map`; there
is no shared store and no horizontal scaling story. `docs/signals-api.md` states the required topology
explicitly: WhaleWatch → a consumer backend (polling roughly once a minute, doing its own caching and
JWT) → end-user clients. Pointing an app's clients directly at this service is not supported.

**Signal production is decoupled from distribution.** `strategy_signals` records immutable facts;
channels are adapters. This is what allows a paid realtime channel and a free delayed channel to differ
only by delay rather than by payload, and what makes a per-channel idempotency key possible.

**Attribution columns never enter P&L.** `formation_*`, `markout_*`, `exec_*` are computed and displayed,
but excluded from `realized_pnl` by design, because a cost model is an estimate and a track record must be
reproducible from executed facts.

**Statistical claims use the clustered interval, never the naive one.** Alerts cluster by market;
`clusteredInterval` is the only form used for published conclusions. `scripts/edge-audit.ts` encodes the
three corrections that must all be applied together — price calibration (`edge = P(won) − implied`, since
old wallets averaged 0.708 entry against new wallets' 0.577 and raw win rate therefore measures who bought
safer tickets, not who is smarter), fee deduction, and market clustering — and applies a Bonferroni
correction over 60 groups. On the same dataset, different combinations of these corrections produce
results with **opposite signs**. The first run of that script contradicted two of the project's own
headline assumptions; that outcome is documented rather than buried.

**The engine and the dashboard share one process but not one failure mode.** X broadcasting is a pure
consumer of `alerts` and its failures are logged and dropped, never propagated to the Telegram path.
Delivery freezes itself when health is degraded. Telegram permanent errors are classified so one bad
message cannot block a queue. The intent throughout is that a partial failure degrades to silence with a
visible red indicator, never to wrong output presented as right.

**Known gaps, stated plainly.** `/status` shows per-loop heartbeats but no uptime timeline, because
`heartbeats` is keyed by loop and stores same-day counters only — there is no cross-day time series, and
drawing one would mean inventing numbers. `token_map` has exactly one reader (`lib/seo.ts`) and no writer
found in the repository; it may be a leftover. `package.json` declares no `engines` field, so the only
version actually exercised is the Dockerfile's `node:22-bookworm-slim`. Backups sit on the same volume as
the database. And the whole project runs as a single container with the dashboard and the engine in one
Node process — sufficient for its current load, and the first thing that would have to change if it were
not.

## Further reading

- [`README.md`](./README.md) — features, screenshots, quick start, environment variables.
- [`docs/plans/`](./docs/plans/) — 24 design and implementation documents, filename-dated, covering every
  major batch: the original monitor design, paper-trading strategy tiers, the record-correctness fixes,
  the external signal system, reverse controls, exit counterfactuals, the signal bus, SEO/GEO, i18n, and
  X multi-account OAuth. Several of them record decisions that were implemented and then **rejected** —
  `2026-08-16-exit-counterfactual-design.md` opens with the reasons a live-exit strategy tier was reverted.
- [`docs/api-access.md`](./docs/api-access.md) — the subscriber-facing API contract (also rendered in-app
  at `/api-docs`). Field semantics are authoritative here; when it disagrees with anything else, this file
  is the one to fix first.
- [`docs/signals-api.md`](./docs/signals-api.md) — the internal contract for `/api/signals`: design
  trade-offs, the history of definition changes, and the topology constraint.

- [`docs/README.md`](./docs/README.md) — index of the `docs/` tree: all 24 design documents summarised
  one line each, the split between the two API documents, and what every screenshot shows.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — development commands, test conventions, what is out of scope.
- [`SECURITY.md`](./SECURITY.md) — reporting channel, and which secrets live in the SQLite file.
- [`CHANGELOG.md`](./CHANGELOG.md) — what shipped when, including the corrections that changed
  previously reported numbers.
