# Security Policy

## What this project is (and what it therefore cannot do to you)

WhaleWatch is a read-only monitoring tool for public Polymarket data:

- It **holds no user funds**, has no wallet, no private keys, and no signing path.
- It **executes no trades and places no orders.** The `/follow` strategy centre
  is a paper simulation — positions are recorded and settled against public
  resolution data, never sent anywhere.
- It **reads public endpoints only**: the Polymarket data API, the Gamma API,
  CLOB price history and order books, `user-pnl-api`, and one public Polygon
  RPC (`eth_call` to read a PUSD balance). None of these require authentication
  from us, and we hold no Polymarket credentials.

So the realistic worst case is not "someone drains a wallet" — it's "someone
reads or rewrites an operator's monitoring state, or steals the outbound
credentials the deployment holds." That's what this policy is about.

## Reporting a vulnerability

**Use GitHub Security Advisories (private):**
<https://github.com/kydlikebtc/polymarket-whalewatch/security/advisories/new>

Please do **not** open a public issue, post it in the Telegram channel, or
describe it in a PR description. A public report on a self-hosted tool means
every running deployment is exposed before any of them can patch.

Include, as far as you can:

- Affected route, module, or script (e.g. `app/api/admin/keys/route.ts`,
  `lib/feedAuth.ts`).
- Whether the deployment posture matters — `PUBLIC_READONLY` / `NODE_ENV`
  changes the guard behaviour materially (`lib/apiGuard.ts`).
- A reproduction: request, headers, expected vs actual response.
- Impact in terms of the sensitive surface below.

This is a single-maintainer project with no on-call rotation. Expect an
acknowledgement within about a week, and don't read silence as dismissal — ping
the advisory thread. Only the latest `main` (and the image built from it) is
supported; there are no tagged releases or backports.

## Sensitive surface

Anything below, reachable by someone who shouldn't have it, is a valid report.

### Credentials in the environment

| Secret                       | Guards / grants                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ADMIN_TOKEN`                | Every write route (`/api/admin/*`) **and** `GET`+`POST /api/alert-config`. Also the only gate on `/manage`, which does not render at all until the token verifies. Compared with `timingSafeEqual` over sha256 digests (`lib/apiGuard.ts`) |
| `SIGNAL_FEED_TOKEN`          | Read access to `/api/signals` at the `realtime` tier. Deliberately separate from `ADMIN_TOKEN` so it can be revoked alone (`lib/feedAuth.ts`)                                                                                              |
| `TELEGRAM_BOT_TOKEN`         | Posting as the bot; combined with `TELEGRAM_CHANNEL_ID` it controls the public channel                                                                                                                                                     |
| `X_API_KEY` / `X_API_SECRET` | The 𝕏 app credentials used for 3-legged OAuth and posting                                                                                                                                                                                  |
| `HEALTHCHECK_PING_URL`       | Low value on its own, but forging pings hides an outage from the operator                                                                                                                                                                  |

### Credentials living in the SQLite file

The database is not just a cache. It stores outbound credentials, in most cases
in plaintext because they must be replayable:

| Table               | Column(s)                       | Storage                                                                                                                                         |
| ------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `api_keys`          | `key_hash`                      | **sha256 only.** The plaintext `wlk_…` key is returned exactly once at issuance and never stored. A database leak does not leak subscriber keys |
| `tg_targets`        | `bot_token`, `chat_id`          | Plaintext — one row per bot+channel delivery target                                                                                             |
| `webhook_endpoints` | `secret`                        | Plaintext — the HMAC-SHA256 signing secret for outbound webhooks                                                                                |
| `x_accounts`        | `access_token`, `access_secret` | Plaintext — 3-legged OAuth tokens for the authorized posting accounts                                                                           |
| `x_oauth_pending`   | `oauth_token_secret`            | Plaintext, 15-minute TTL, single-use (consumed on callback)                                                                                     |

Consequences worth stating plainly: **read access to `data.sqlite` is
equivalent to control of the deployment's Telegram bot, its 𝕏 posting accounts,
and its webhook signatures.** Issued API keys are the one exception.

### Files that must never be publicly served or committed

- `data.sqlite` and its WAL sidecars (`-wal`, `-shm`).
- `<data dir>/backups/data-<utc-day>.sqlite` — the daily snapshots (newest 7
  kept). In the Docker deployment these sit in the same `whalewatch-data`
  volume as the live database, i.e. **the backups are not off-host**; copy them
  elsewhere if you want real disaster cover.
- `.env`.

`.gitignore` already covers `.env`, `*.sqlite*`, and `*.db`. Note that
`.dockerignore` lists only `node_modules/` and `.next/`, so a `docker build`
copies a local `.env` and `data.sqlite` into the **builder** layer. The
published runner stage copies files individually and contains neither — but do
not push builder layers or share a build cache from a machine that has real
credentials on it.

### Classes of bug we consider serious

- Auth bypass on `/api/admin/*`, `/api/alert-config`, or `/api/signals`.
- Tier or scope escape on `/api/signals`: a `delayed` key seeing realtime data,
  or a scoped key seeing signal types outside its `bus_types` (the response
  cache key includes the subscription scope precisely to prevent cross-key
  contamination — a way around that is a real finding).
- Anything that turns a public route into an open proxy for arbitrary upstream
  requests, or that lets an unauthenticated caller burn the shared Polymarket
  rate budget the engine depends on.
- Injection into a SQL statement, a Telegram/𝕏 message, or a webhook payload.
- Leaking any of the credentials above through an API response, a log line, an
  error message, or the `/manage` locked state.
- SSRF via the webhook endpoint registration path (endpoints are operator-
  registered rather than self-service specifically to keep this surface small).

## Out of scope

These are not vulnerabilities in this project, and reports about them will be
closed with a pointer back here:

- **Bugs or outages in Polymarket's own APIs**, or in the Gamma / CLOB /
  `user-pnl-api` / public Polygon RPC endpoints. Report those to their owners.
  Rate limiting, data errors, or resolution disputes upstream are not ours.
- **Deployment misconfiguration.** Exposing the dashboard publicly without
  setting `ADMIN_TOKEN`, running with `PUBLIC_READONLY=0` on a public host,
  serving `data.sqlite` over HTTP, committing `.env`, or leaving the container
  port reachable without a proxy in front are operator errors. Correct
  configuration is documented under "Quick start → Production" and
  "Layer 5 — running it 7×24" in [`README.md`](README.md), and in
  [`.env.example`](.env.example); the guard
  logic itself is in [`lib/apiGuard.ts`](lib/apiGuard.ts). Note that with
  `NODE_ENV=production` (which the Docker image sets) writes are **fail-closed**
  — if `ADMIN_TOKEN` is unset, remote writes return 403 rather than being
  allowed.
- **Known and documented limitations of the rate limiter.** The per-IP layer
  attributes requests via `cf-connecting-ip` / `x-forwarded-for`, which a client
  hitting the container port directly can forge. This is stated in the code
  comments; the global per-route ceiling is the real limit, and the intended
  deployment has a proxy in front. A report that per-IP counters can be evaded
  is not new information — a report that the _global_ ceiling can be evaded is.
- **Missing hardening we never claimed**: no CSP headers, no account system, no
  2FA, no audit log beyond `config_history`, backups not encrypted at rest.
  These are gaps in scope, not defects. Proposals to close them are welcome as
  feature requests.
- Findings from automated scanners with no demonstrated impact, and
  vulnerabilities in dependencies that this codebase does not reach.

## Disclosure

Report privately, give the maintainer a reasonable window to ship a fix, and
publish afterwards. If a fix requires operators to rotate a token or move a
database file, that instruction will go in the advisory and in the release note
for the fixing commit.
