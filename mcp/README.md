# whalewatch-mcp

MCP (Model Context Protocol) server for **[WhaleWatch](https://whalewatch.wired.fund)** — a 7×24
Polymarket whale & smart-money monitor with a public, hash-chained track record.

Gives any MCP client (Claude Code, Claude Desktop, or your own agent) direct tools over the
WhaleWatch read-only API: live whale fills, smart-money consensus, per-strategy paper records,
the data-continuity clock, and on-demand market depth cards.

## Quick start

```bash
claude mcp add whalewatch -- npx -y whalewatch-mcp
```

With an API key (unlocks the signal tools):

```bash
claude mcp add whalewatch -e WHALEWATCH_API_KEY=<your-key> -- npx -y whalewatch-mcp
```

## Tools

| Tool              | Key required | What it returns                                                             |
| ----------------- | ------------ | --------------------------------------------------------------------------- |
| `get_health`      | no           | Engine liveness: per-loop heartbeats, stale flags                           |
| `get_continuity`  | no           | Day-by-day data coverage, the 30-day uninterrupted streak and its start day |
| `get_record`      | no           | Published-signal scorecard per strategy + the sha256 digest-chain tail      |
| `get_signals`     | yes          | Main machine feed: raw events, folded views, per-strategy paper entries     |
| `list_signals`    | yes          | What THIS key actually receives (enabled definitions + strategy codes)      |
| `get_market_card` | yes          | On-demand depth snapshot for one market (hits upstream; 429 = retry later)  |

Keyed tools without a key answer with instructions instead of disappearing — "you lack the
key" and "the capability does not exist" are different facts.

## Configuration

| Env var               | Default                         | Meaning                                                 |
| --------------------- | ------------------------------- | ------------------------------------------------------- |
| `WHALEWATCH_API_KEY`  | _(unset)_                       | API key issued by the operator (sent as `x-feed-token`) |
| `WHALEWATCH_BASE_URL` | `https://whalewatch.wired.fund` | Point self-hosted deployments at their own base         |

API tiers, scopes and field semantics: <https://whalewatch.wired.fund/api-docs>.

## Notes

- Read-only by design: this package holds no keys of its own, places no orders, and every
  tool maps 1:1 onto a documented public endpoint.
- Source lives in the [polymarket-whalewatch](https://github.com/kydlikebtc/polymarket-whalewatch)
  repository under `mcp/`.
