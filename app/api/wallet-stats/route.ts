import { openDb } from "../../../lib/db";
import { getWalletStats, type WalletStats } from "../../../lib/walletStats";
import { guardExpensive } from "../../../lib/apiGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stats are much heavier than age lookups: a cold wallet fans out to up to
// ~81 upstream requests (closed + open paginate to DEFAULT_MAX_PAGES=40 each,
// plus one user-pnl call), so the per-request cap is lower and the client
// chunks larger sets. 24h SQLite cache keeps warm wallets ~free.
const MAX = 60;

// Reject anything that isn't a proxy-wallet address before it reaches an
// upstream URL or becomes a cache key (same standard as /api/wallet/[address]).
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

type SmartInfo = { score: number | null; isWhitelist: boolean };

// Public-deployment abuse cap, charged in WALLETS: this is the heaviest fanout
// route (a cold wallet paginates closed + open positions plus a pnl call), so
// its budget is the tightest. Shares the "wallet-profile" bucket with
// /api/wallet/[address], which drives the same getWalletStats fanout — one
// budget, so neither route can be used to bypass the other's ceiling.
const LIMITS = { perIp: 120, global: 400 };

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const raw: string[] = Array.isArray(body?.wallets) ? body.wallets : [];
  const wallets = [
    ...new Set(
      raw.map((s) => String(s).toLowerCase()).filter((s) => ADDRESS_RE.test(s)),
    ),
  ].slice(0, MAX);
  const limited = guardExpensive(
    req,
    "wallet-profile",
    { ...LIMITS, cost: wallets.length },
    { stats: {}, smart: {} },
  );
  if (limited) return limited;
  try {
    const db = openDb(process.env.DASH_DB ?? "data.sqlite");
    try {
      const stats: Record<string, WalletStats | null> = await getWalletStats(
        db,
        wallets,
      );
      // Smart-wallet flags come straight from the local table (zero network cost).
      const smart: Record<string, SmartInfo> = {};
      if (wallets.length > 0) {
        const placeholders = wallets.map(() => "?").join(",");
        const rows = db
          .prepare(
            `SELECT address, score, is_whitelist FROM smart_wallets WHERE address IN (${placeholders})`,
          )
          .all(...wallets) as {
          address: string;
          score: number | null;
          is_whitelist: number;
        }[];
        for (const r of rows) {
          smart[r.address] = { score: r.score, isWhitelist: !!r.is_whitelist };
        }
      }
      return Response.json({ stats, smart });
    } finally {
      db.close();
    }
  } catch (e) {
    console.error("[/api/wallet-stats] lookup failed:", e);
    return Response.json(
      {
        stats: {},
        smart: {},
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 200 },
    );
  }
}
