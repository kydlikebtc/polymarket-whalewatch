import type { DB } from "./db";

// The wallet page's "own alert history" lookback. proxyWallet lives inside the
// payload JSON (no dedicated column yet), so matching is a LIKE substring
// probe — SQLite LIKE is ASCII case-insensitive, which is exact enough for
// 0x-hex addresses. UNBOUNDED, that probe had to walk the ENTIRE alerts table
// newest-first whenever a wallet had fewer than LIMIT hits (most wallets), and
// alerts only ever grows — latency degraded linearly with table size while
// contending with the worker's writes. The created_at lower bound keeps the
// scan on idx_alerts_created_at and matches the page's "recent hits" reading.
export const ALERT_HITS_WINDOW_DAYS = 90;

const DEFAULT_LIMIT = 50;

export type AlertHitRow = {
  type: string;
  payload: string;
  created_at: number;
};

// A parsed alert-history row as the wallet page's 历史命中 table consumes it.
export type AlertHit = {
  type: string;
  createdAt: number;
  title: string;
  outcome: string;
  side: string;
  usd: number;
  price: number | null;
  // Polymarket event slug when the payload carried one ("" otherwise) — the
  // page links the title to polymarket.com/event/<slug> exactly like its
  // recent-trades table, closing the 告警 → 档案 → 市场 drill-down.
  eventSlug: string;
};

// Shape one raw alert row into an AlertHit; null for unparseable payloads
// (the caller filters those out). Consensus payloads are group aggregates
// (totalNetUsd, no single fill price); trade payloads price out as size×price.
export function parseAlertHit(row: AlertHitRow): AlertHit | null {
  try {
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    // Trade payloads store eventSlug (slug is the market slug fallback, same
    // precedence as /api/alerts); consensus payloads only ever set eventSlug.
    const eventSlug = String(p.eventSlug ?? p.slug ?? "");
    if (row.type === "consensus") {
      return {
        type: row.type,
        createdAt: row.created_at,
        title: String(p.title ?? ""),
        outcome: String(p.outcome ?? ""),
        side: "BUY",
        usd: Number(p.totalNetUsd ?? 0),
        price: null,
        eventSlug,
      };
    }
    const size = Number(p.size ?? 0);
    const price = Number(p.price ?? 0);
    return {
      type: row.type,
      createdAt: row.created_at,
      title: String(p.title ?? ""),
      outcome: String(p.outcome ?? ""),
      side: String(p.side ?? ""),
      usd: size * price,
      price,
      eventSlug,
    };
  } catch {
    return null;
  }
}

// Raw alert rows mentioning `address` within the recent window, newest first.
export function queryAlertHitRows(
  db: DB,
  address: string,
  opts: { nowSec?: number; limit?: number } = {},
): AlertHitRow[] {
  const { nowSec = Math.floor(Date.now() / 1000), limit = DEFAULT_LIMIT } =
    opts;
  const sinceSec = nowSec - ALERT_HITS_WINDOW_DAYS * 86_400;
  return db
    .prepare(
      `SELECT type, payload, created_at FROM alerts
        WHERE created_at > ? AND payload LIKE ?
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sinceSec, `%${address}%`, limit) as AlertHitRow[];
}
