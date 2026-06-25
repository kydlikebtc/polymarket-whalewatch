# 🐳 Polymarket WhaleWatch

Real-time monitoring for **large trades**, **split-buy accumulation**, and **fresh-wallet activity** on [Polymarket](https://polymarket.com) prediction markets.

A whale on Polymarket rarely announces themselves. They split a big position into many small orders, use freshly-created wallets, and buy at favorable odds. WhaleWatch surfaces exactly that — a 7×24 worker that pushes large fills to Telegram, plus a web dashboard to hunt the patterns single-trade alerts miss.

![Polymarket WhaleWatch dashboard](docs/dashboard.png)

_The 24h scanner with the insider-hunt combo applied — price `0.5–0.9` + address age `≤7天` — collapsing the firehose down to a handful of $100k+ buys from brand-new wallets (some only hours old) at favorable odds._

> **中文简介**：监控 Polymarket 上的大额成交、拆单建仓和新钱包行为。后台 worker 实时把大单推送到 Telegram；网页看板可按金额 / 买卖 / 价格(赔率) / 地址年龄筛选，并有专门的"拆单累计买入榜"和地址生命时长标注。组合"价格 0.5–0.9 + 地址年龄 ≤7天"即可猎杀可疑的内部资金。

> ⚠️ Research / monitoring tool only. Uses **public** Polymarket data, no authentication, no trading. Not financial advice.

---

## Features

### 🔔 Large-trade alerts (worker)

- Polls the public Polymarket trades feed every few seconds and pushes **rich Telegram alerts** for fills above a USD threshold (tiered, e.g. `💰 ≥$10k`, `🐳 ≥$50k`).
- **Cold-start seeding** silently marks the existing backlog as seen on first launch, so you don't get blasted with hundreds of historical trades.
- Persistent dedup (SQLite) — a restart never replays or skips alerts.
- Resilient: retries transient API timeouts, process-level guards for 7×24 uptime.

### 📊 Web dashboard (Next.js)

- **24h Scanner** — every large fill in a rolling window. Filter by **amount**, **buy/sell**, **time window (1h/6h/24h)**, **price band (odds)**, and **address age**; sort by time or amount. Live, no database.
- **Split-buy accumulation board (拆单累计买入榜)** — aggregates trades by `(wallet, market, outcome)` and ranks by **NET buy-in**, catching wallets that build a large position through many sub-threshold orders. In live testing, single-trade monitoring missed **~60%** of ≥$10k accumulators.
- **Alert history** — past worker alerts, read from SQLite.
- **Address age on every wallet** — lifespan since the wallet's first Polymarket activity, badged `🆕` for new addresses (hours/minutes under a day, exact days ≤30d). Permanently cached.

### 🎯 The insider-hunt combo

Abnormal insider-information money tends to **buy at favorable odds using relatively new wallets**. Set the scanner to **price `0.5–0.9` + address age `≤7天`** and the firehose collapses to a short list of exactly that signature.

---

## Quick start

Requirements: **Node 20+**.

```bash
npm install

# Web dashboard → http://localhost:3000
npm run dev

# Run tests
npm run test

# Zero-credential live smoke test of the whole pipeline (no Telegram needed)
npx tsx scripts/dry-run.ts

# Live console monitor (no credentials; prints alerts instead of Telegram)
npx tsx scripts/watch.ts
```

### Enable Telegram alerts (worker)

```bash
cp .env.example .env
# edit .env:
#   TELEGRAM_BOT_TOKEN=...        (from @BotFather)
#   TELEGRAM_CHANNEL_ID=@yourchannel   (bot must be an admin of the channel)
#   LARGE_THRESHOLDS=10000,50000
#   POLL_INTERVAL_MS=4000

# send a test message
npx tsx scripts/test-telegram.ts

# start the 7×24 worker
npm run worker
```

---

## How it works

- **Data source:** Polymarket public Data API (`data-api.polymarket.com`) + Gamma API. No auth, no keys.
- **Scanner fetch strategy:** the API times out (HTTP 408, ~5.75s) on expensive high-`filterAmount` queries, so the dashboard always fetches at a **fast low floor** and applies the higher amount/side/price/age filters **client-side**. Switching filters is instant.
- **Address age:** `GET /activity?user=<wallet>&sortDirection=ASC&limit=1` → the oldest activity timestamp ≈ the wallet's "birth" on Polymarket. Cached forever in SQLite (`wallet_age`).
- **Worker ≠ dashboard:** the worker is the _stateful, alerting_ path (writes SQLite, pushes Telegram); the dashboard is the _stateless, exploratory_ path (reads the live API). They're decoupled through SQLite.

Design notes and the runtime-verification checklist live in [`docs/plans/`](docs/plans).

## Project structure

```
lib/        shared core — Polymarket/Telegram clients, types, SQLite, pure logic
  polymarket.ts   trades feed (getLargeTrades / getTradesWindow, retry + validation)
  accumulate.ts   split-buy aggregation (pure)
  walletAge.ts    first-activity lookup + SQLite cache
  alert.ts        Telegram alert formatting
  seen.ts / poll.ts / trades.ts / db.ts / config.ts / telegram.ts
worker/     7×24 polling worker (runOnce + cold-start seedSeen + index loop)
app/        Next.js dashboard
  page.tsx               24h scanner (+ price/age/amount/side filters, sortable)
  accumulation/page.tsx  split-buy ranking board
  alerts/page.tsx        alert history
  api/{scan,accumulation,wallet-age,alerts}/route.ts
scripts/    dry-run.ts · watch.ts · test-telegram.ts
docs/plans/ design + implementation docs
```

**Stack:** TypeScript · Next.js 16 · better-sqlite3 · zod · vitest. 36 unit tests.

---

## Roadmap

- [x] Large-trade Telegram alerts (worker)
- [x] 24h scanner with amount / side / time / **price** / **address-age** filters
- [x] Split-buy accumulation detection (dashboard)
- [x] Wallet-age annotation
- [ ] Accumulation → Telegram alerts (stateful, tier-crossing dedup)
- [ ] Smart-money screening (leaderboard seed → PnL / win-rate / ROI / consistency scoring → watchlist)
- [ ] Event-level accumulation (across correlated sub-markets)

## License

For personal research use. Not affiliated with Polymarket.
