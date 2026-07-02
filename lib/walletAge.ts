import type { DB } from "./db";
import { mapLimit } from "./mapLimit";

const DATA_API = "https://data-api.polymarket.com";

const PROBE_PAGE = 500;
const MAX_VERIFY_PROBES = 8;

// One /activity page. `_cb` busts Cloudflare's per-URL cache: the origin
// occasionally returns MIS-SORTED responses and the CDN then serves that bad
// payload for the same URL indefinitely (verified live 2026-07-02).
async function fetchActivityPage(
  wallet: string,
  params: string,
): Promise<{ timestamp: number }[]> {
  const cb =
    Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
  const url = `${DATA_API}/activity?user=${encodeURIComponent(wallet)}&${params}&_cb=${cb}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { "User-Agent": "polymarket-monitor" },
  });
  if (!res.ok) throw new Error(`fetchActivityPage ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows)
    ? rows.filter(
        (r): r is { timestamp: number } => typeof r?.timestamp === "number",
      )
    : [];
}

/**
 * First Polymarket activity timestamp (unix sec) for a wallet, or null if none.
 *
 * The API's sort is NOT trustworthy (sortBy=TIMESTAMP is usually honored but
 * the origin sometimes ignores it, and sortDirection WITHOUT sortBy doesn't
 * sort by time at all), so the sorted query only produces a CANDIDATE. The
 * candidate is then VERIFIED with the reliable `end` filter: an empty
 * `end=candidate-1` page proves nothing older exists. If older rows do come
 * back (the sort lied), we walk the candidate down by min(timestamp) until
 * the probe comes up empty.
 */
export async function fetchFirstActivityTs(
  wallet: string,
): Promise<number | null> {
  const sorted = await fetchActivityPage(
    wallet,
    "sortBy=TIMESTAMP&sortDirection=ASC&limit=10",
  );
  if (sorted.length === 0) return null;
  let candidate = Math.min(...sorted.map((r) => r.timestamp));
  for (let i = 0; i < MAX_VERIFY_PROBES; i++) {
    const older = await fetchActivityPage(
      wallet,
      `end=${candidate - 1}&limit=${PROBE_PAGE}`,
    );
    if (older.length === 0) return candidate; // proven: nothing earlier exists
    candidate = Math.min(...older.map((r) => r.timestamp));
  }
  // Hyperactive wallet + persistently lying sort: give the best (oldest seen)
  // candidate rather than nothing — an upper bound on the true age.
  console.warn(
    `[walletAge] first-ts unverified after ${MAX_VERIFY_PROBES} probes for ${wallet} — using best candidate`,
  );
  return candidate;
}

// Returns wallet(lowercased) -> firstTs|null. SQLite-cached; only real (non-null) ages
// are persisted permanently (errors stay uncached so they retry). Misses are fetched
// with a concurrency cap. `fetcher` is injectable for tests.
export async function getWalletAges(
  db: DB,
  wallets: string[],
  opts: {
    concurrency?: number;
    fetcher?: (w: string) => Promise<number | null>;
  } = {},
): Promise<Record<string, number | null>> {
  const { concurrency = 6, fetcher = fetchFirstActivityTs } = opts;
  const distinct = [...new Set(wallets.map((w) => w.toLowerCase()))];
  const sel = db.prepare("SELECT first_ts FROM wallet_age WHERE wallet = ?");
  const ins = db.prepare(
    "INSERT OR REPLACE INTO wallet_age (wallet, first_ts, fetched_at) VALUES (?, ?, ?)",
  );
  const result: Record<string, number | null> = {};
  const misses: string[] = [];
  for (const w of distinct) {
    const row = sel.get(w) as { first_ts: number | null } | undefined;
    if (row) result[w] = row.first_ts;
    else misses.push(w);
  }
  const fetched = await mapLimit(misses, concurrency, async (w) => {
    try {
      return await fetcher(w);
    } catch {
      return null;
    }
  });
  const now = Math.floor(Date.now() / 1000);
  misses.forEach((w, idx) => {
    const ts = fetched[idx];
    if (ts !== null) ins.run(w, ts, now); // cache only successful lookups
    result[w] = ts;
  });
  return result;
}
