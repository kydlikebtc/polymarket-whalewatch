import { z } from "zod";
import { fetchWithRetry } from "./fetchWithRetry";

const LB_API = "https://data-api.polymarket.com/v1/leaderboard";

// Verified live: limit is silently clamped to 50 per page regardless of the
// requested value, so completeness comes from offset pagination.
const PAGE_SIZE = 50;

// Verified live: DAY/WEEK/MONTH/ALL are the accepted values (YEAR → 400), and
// they are CALENDAR periods (natural day/week/month), not rolling windows.
export type LeaderboardPeriod = "DAY" | "WEEK" | "MONTH" | "ALL";
export type LeaderboardOrder = "PNL" | "VOL";

// `rank` comes back as a STRING ("1") from the live API; coerce to number.
// NOTE: leaderboard pnl is mark-to-market (includes unrealized gains) — treat
// it as a seed-pool signal, not a settled track record.
const RowSchema = z.object({
  rank: z.union([z.string(), z.number()]).transform(Number),
  proxyWallet: z.string(),
  userName: z.string().nullish().default(""),
  vol: z.number(),
  pnl: z.number(),
});
export type LeaderboardRow = z.infer<typeof RowSchema>;

export async function fetchLeaderboard(opts: {
  period: LeaderboardPeriod;
  orderBy?: LeaderboardOrder;
  maxEntries?: number;
}): Promise<LeaderboardRow[]> {
  const { period, orderBy = "PNL", maxEntries = 100 } = opts;
  const out: LeaderboardRow[] = [];
  const seen = new Set<string>();
  const pages = Math.ceil(maxEntries / PAGE_SIZE);
  for (let page = 0; page < pages; page++) {
    const url = `${LB_API}?timePeriod=${period}&orderBy=${orderBy}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;
    // Transient Cloudflare 5xx are retried (shared backoff); if a page still
    // fails after retries, the collected prefix is returned instead of thrown
    // away — it holds the board's TOP ranks, and the daily seeding window
    // must not lose 100 wallets to one stubborn 502. Total first-page failure
    // still throws so callers can tell "no board" from "short board".
    let res: Response;
    try {
      res = await fetchWithRetry(url, {
        timeoutMs: 10_000,
        headers: { "User-Agent": "polymarket-monitor" },
        label: "fetchLeaderboard",
      });
    } catch (e) {
      if (out.length === 0) throw e;
      console.warn(
        `[fetchLeaderboard] ${period} page ${page} failed after retries — returning ${out.length} collected rows:`,
        e,
      );
      break;
    }
    if (!res.ok) {
      if (out.length === 0) {
        throw new Error(`fetchLeaderboard ${period} ${res.status}`);
      }
      console.warn(
        `[fetchLeaderboard] ${period} page ${page} HTTP ${res.status} — returning ${out.length} collected rows`,
      );
      break;
    }
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) break;
    let fresh = 0;
    for (const row of raw) {
      const parsed = RowSchema.safeParse(row);
      if (!parsed.success) continue;
      const wallet = parsed.data.proxyWallet.toLowerCase();
      // Deep offsets are silently CLAMPED (no 4xx) and re-serve the same rows —
      // wallet-level dedup is the only reliable termination signal.
      if (seen.has(wallet)) continue;
      seen.add(wallet);
      out.push({ ...parsed.data, proxyWallet: wallet });
      fresh++;
    }
    if (fresh === 0) break; // clamped/repeated page — no progress possible
    if (raw.length < PAGE_SIZE) break; // genuine last page
    if (out.length >= maxEntries) break;
  }
  return out.slice(0, maxEntries);
}
