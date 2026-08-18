# Contributing

WhaleWatch is a read-only research tool: it polls public Polymarket endpoints,
stores what it saw in a local SQLite file, and publishes signals plus an honest
after-the-fact record of how those signals did. Contributions are welcome as
long as they keep it that way — see [Out of scope](#out-of-scope) before you
start building.

## Prerequisites

| Item        | Value                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node        | **22** is what the project is actually built and shipped on (`Dockerfile` uses `node:22-bookworm-slim` for both the build and the runtime stage) |
| Package mgr | npm (the repo has a committed `package-lock.json`; use `npm ci` for reproducible installs)                                                       |
| Native deps | `better-sqlite3` compiles from source when no prebuilt binary matches your platform — you may need `python3`, `make`, and a C++ toolchain        |

Honest caveat: `package.json` has **no `engines` field**, so the repo does not
enforce a Node version. The README badge says Node 22 (the version the Docker
image builds and ships on), and the dependency
ranges in `package-lock.json` do allow 20.9+ (`next` ≥20.9.0, `better-sqlite3`
20.x/22.x/24.x+, `vitest` ^20 || ^22 || >=24) — but nothing in this repo has
been verified on Node 20. If you develop on 20 and hit something odd, try 22
before filing a bug.

```bash
npm install     # or: npm ci
```

## Development commands

Every command below comes from `package.json` — there is nothing else to learn.

```bash
npm run dev          # Next dev server + embedded engine → http://localhost:3000
npm run test         # vitest run — the full suite
npm run typecheck    # tsc --noEmit
npm run build        # next build
npm start            # production server (also runs the embedded engine)
npm run worker       # engine only, no Next (tsx worker/index.ts)
npm run dev:webpack  # dev server on the webpack fallback instead of turbopack
```

Two things worth knowing about `npm run dev`:

- It goes through `scripts/dev-server.mjs`, which loads `.env` **before**
  starting Next so that `PORT` from `.env` actually applies. Next only reads the
  port from `-p` or from the environment at launch, so a plain `next dev` would
  ignore your `.env`. Precedence: shell `PORT` > `.env` `PORT` > 3000.
- The alert engine starts **inside** the Next process via `instrumentation.ts`.
  You do not need `npm run worker` as well — running both points two engines at
  the same SQLite file.

### Zero-credential smoke test

```bash
npx tsx scripts/dry-run.ts
```

This hits the real Polymarket data API and walks the whole pipeline
(fetch → zod validation → cold-start seeding → new-trade selection → tiering →
message formatting → SQLite dedup) against a throwaway `dry-run.sqlite`. It
needs no Telegram credentials and no API keys, and it asserts the two facts
that matter on a cold start: replaying an old backlog fires **0** alerts, and a
genuinely new fill fires exactly **1**. Run it if you touched anything in the
fetch/dedup path.

Other scripts you may want while developing (all take no credentials unless
noted):

| Script                                    | What it does                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `npx tsx scripts/watch.ts`                | Live console monitor — real pipeline, Telegram HTML rendered as text                      |
| `npx tsx scripts/test-telegram.ts`        | Sends one test message (needs `TELEGRAM_BOT_TOKEN` + `..._CHANNEL_ID`)                    |
| `npx tsx scripts/edge-audit.ts`           | Offline edge audit over settled alerts (price-calibrated, fee-adjusted, market-clustered) |
| `node scripts/preview-seed-positions.mjs` | Seeds mock `follow_positions` rows so strategy cards render locally                       |

## Tests

**The bar: `npm test` must be all green before you open a PR.** As of this
writing the suite is **1346 tests across 105 files** and finishes in about 2
seconds — there is no excuse for skipping it.

```bash
npm test                                  # everything
npx vitest run lib/scanFloor.test.ts      # one file
npx vitest run -t "never returns a floor" # one test by name
```

`vitest.config.ts` sets `environment: "node"` and `include: ["**/*.test.ts"]`, and
adds `**/.claude/**` to vitest's default excludes — that directory holds git
worktree copies, and without the exclude the suite is multi-counted (observed:
769 tests reported against a real 262 at the time the exclude was added).

Rules for new code:

- **New logic ships with tests.** If you add a function to `lib/`, add cases to
  the neighbouring `*.test.ts`. If you add a module, add `yourModule.test.ts`
  next to it.
- **Test the reasoning, not the implementation.** The existing tests read like
  arguments: `lib/scanFloor.test.ts` asserts the fetch floor is never rounded
  _above_ the request (that would silently hide trades a caller asked to see),
  not merely that a helper returns a number. Copy that habit — a test that
  documents why a bug was possible survives refactors.
- **DB tests use a real database, not a mock.** 443 call sites do
  `openDb(":memory:")`; a handful that need an on-disk file (backup, WAL
  behaviour) use `mkdtempSync(tmpdir())` and clean up after themselves. Never
  mock `better-sqlite3`.
- **Inject fakes, don't mock modules.** There are 178 `vi.fn(` call sites in
  `lib/` (183 repo-wide) and exactly **one** `vi.mock` in the entire repo
  (`app/api/signals/route.test.ts`). Cycle functions such as `runFollowCycle`
  take their `send` / price-fetch / book-fetch collaborators as parameters
  precisely so tests can pass fakes. Follow the parameter, not the import.

## Code conventions

Read two or three modules before writing any — the style is consistent and it
is easier absorbed than described. `lib/scanFloor.ts` (small, pure, heavily
commented) and `lib/follow.ts` (the large one) are representative.

**Layout.**

| Directory   | Contents                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/`      | 90 non-test modules: pure logic, upstream clients, DB access. Anything imported by both server and client lives here and must stay client-safe (no `better-sqlite3` import in a module a page pulls in) |
| `lib/i18n/` | zh/en dictionaries, sharded per page; Chinese source text is the key                                                                                                                                    |
| `app/`      | Next App Router — 14 pages, 27 API route handlers, plus UI hooks that have their own `*.test.ts`                                                                                                        |
| `worker/`   | The engine: 8 self-scheduling loops in `embeddedEngine.ts`, plus the minimal `runOnce.ts` used by scripts                                                                                               |
| `scripts/`  | One-off CLIs (smoke tests, key issuance, audits). Not part of the running service                                                                                                                       |
| `docs/`     | `docs/plans/` design + implementation docs, `docs/api-access.md` (subscriber-facing API contract)                                                                                                       |

**TypeScript.** `strict: true`, ESM (`"type": "module"`), target ES2022. Keep
`npm run typecheck` clean — Next's generated route types mean a change can pass
a stale `tsc` and break after `.next/dev/types` regenerates, so run the
typecheck rather than trusting your editor.

**Pure logic separated from side effects.** This is the single most load-bearing
convention. Detectors, P&L math, statistics, and view assembly are pure
functions; the loops that fetch, write, and push are thin shells that call them.
`lib/followCandidate.ts` holds a `DETECTORS` registry of pure detector
functions so a new signal source is "write a function, register one line" and
the open/settle code is untouched. Put new analysis in a pure function with
tests; put I/O in the caller.

**Schema lives in one place.** `lib/db.ts` `openDb()` is the only place that
creates tables, adds columns, or runs version-gated migrations. Don't scatter
DDL.

**Comments explain _why_, in Chinese, and often cite the measurement or the bug
that forced the design.** Keep that — an uncommented magic constant will be
asked about in review. English comments are fine for new code if that's what
you write in; do not translate existing ones as drive-by churn.

**Two non-obvious rules you will trip over:**

- Import Node builtins by **bare specifier** — `import { createHash } from "crypto"`,
  not `node:crypto`. The webpack dev fallback can't resolve the `node:` scheme
  in server bundles; bare names work under both webpack and turbopack. See the
  comment at the top of `lib/apiGuard.ts`.
- A Next route module may only export handlers and route config. Helpers that
  want to live "near the route" go in `lib/` instead (that's why
  `lib/scanFloor.ts` exists).

**Architectural red lines that reviewers will enforce:**

- `lib/seo.ts` and the server-rendered SEO layer read **local SQLite only** —
  never an upstream request. A crawler must not be able to make the site burn
  the engine's Polymarket rate budget.
- `/api/signals` and `/record` make **zero upstream calls**; every field comes
  from persisted state. Traffic spikes must not starve the engine.
- Public fields are **append-only**: existing field names and semantics in
  `docs/api-access.md` don't change; new capability arrives as new fields.
- Track-record numbers are quoted with their measurement conditions (settled
  only, price-adjusted, clustered confidence interval). Don't add a headline
  number that drops the qualifier.

## Commits

Run `git log` and copy what you see. The real format is:

```text
<type>: <中文描述> —— <补充说明>
```

Concrete examples from this repo:

```text
fix: 告警阈值不再公开可读 —— /api/alert-config GET 改走 ADMIN_TOKEN
feat: /status 公开状态页 —— 引擎健康度从运营页搬到正门
refactor: /status 撤出全站导航 —— 入口收归 /manage
docs: 统一信号总线设计（全站类型纳入可管理推送·投影而非重算·分两批）
perf: 修复顶栏切换页面卡顿 —— 恢复导航预取 + 路由骨架 + 客户端路由缓存
```

Types in use: `feat`, `fix`, `refactor`, `docs`, `perf`, `style`, `chore`, `ci`.

Notes:

- **Commit subjects and bodies in this repo are written in Chinese.** That's the
  maintainer's working language, and code comments follow the same convention.
  If you can write the subject in Chinese, match the style. If you can't, an
  English subject with the same `type: what —— why` shape is accepted — nobody
  will reject a good patch over language.
- The em-dash clause after `——` carries the _reason_ or the mechanism, not a
  restatement of the subject. `fix: 验证条 95% 区间改按市场数 —— 告警扎堆使误差被低估 1.9 倍`
  tells you the bug, the fix, and the magnitude in one line. Aim for that.
- **PR titles and descriptions may be English or Chinese.** Reviewers read both.

## Out of scope

This project reads public data and publishes analysis. PRs that add any of the
following will be closed regardless of code quality:

- **Automated trading, order placement, or position management** of any kind —
  including "just a dry-run order builder" or an optional/flag-gated path. The
  `/follow` strategy centre is deliberately a _paper_ simulation: it records
  what a strategy would have done and settles it against public resolution
  data. It never sends an order, and it must stay that way.
- **Private keys, wallet signing, seed phrases, or custody** of user funds.
- **Bypassing Polymarket authentication, rate limits, or terms** — including
  scraping authenticated endpoints, rotating identities to evade limits, or
  removing the guard/rate-limit layer in `lib/apiGuard.ts`.
- **Personalized financial advice** in UI copy or push text. The product states
  what was observed and what the historical record was; it does not tell anyone
  what to buy.

If your idea is adjacent to these but you think it fits, open a feature request
first and describe the _problem_. It's cheaper than a rejected PR.

## Opening a PR

1. Branch off `main`.
2. `npm test` green, `npm run typecheck` clean.
3. New logic covered by tests.
4. If you changed anything externally visible — an API field, a route's auth
   posture, an env var, a push format — update `README.md` and/or the relevant
   file in `docs/` in the same PR. Field semantics are governed by
   `docs/api-access.md`; when it and any other doc disagree, that file wins and
   is the one to change first.
5. Fill in the PR template, especially the "externally visible behaviour"
   section.

`.github/workflows/ci.yml` runs `npm ci` → `npm run typecheck` → `npm test` on
every push and pull request to `main`, on Node 22 (the version the Docker image
ships). Running the same three commands locally first saves a round trip. Say in
the PR description what you actually ran — CI covers types and tests, not
whether you exercised the change against live data.
