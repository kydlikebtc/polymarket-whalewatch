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

// Raw alert rows mentioning `address` within the recent window, newest first.
// Payload parsing/shaping stays with the caller (the wallet route).
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
