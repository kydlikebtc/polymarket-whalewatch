import { openDb } from "../../../lib/db";
import { getWalletStats, type WalletStats } from "../../../lib/walletStats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stats are heavier than age lookups (up to 8 upstream pages per cold wallet),
// so the per-request cap is lower; the client chunks larger sets.
const MAX = 60;

// Reject anything that isn't a proxy-wallet address before it reaches an
// upstream URL or becomes a cache key (same standard as /api/wallet/[address]).
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

type SmartInfo = { score: number | null; isWhitelist: boolean };

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const raw: string[] = Array.isArray(body?.wallets) ? body.wallets : [];
  const wallets = [
    ...new Set(
      raw.map((s) => String(s).toLowerCase()).filter((s) => ADDRESS_RE.test(s)),
    ),
  ].slice(0, MAX);
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
