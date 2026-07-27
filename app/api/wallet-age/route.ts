import { openDb } from "../../../lib/db";
import { getWalletAges } from "../../../lib/walletAge";
import { guardExpensive } from "../../../lib/apiGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX = 200;

// Public-deployment abuse cap, charged in WALLETS (each cold one costs an
// upstream /activity call) rather than requests — 30 requests × 200 wallets
// would otherwise be 6000 upstream calls against the budget the engine shares.
// Ages are cached forever, so real browsing stays far below these.
const LIMITS = { perIp: 600, global: 3000 };

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const raw: string[] = Array.isArray(body?.wallets) ? body.wallets : [];
  const wallets = [
    ...new Set(raw.map((s) => String(s).toLowerCase()).filter(Boolean)),
  ].slice(0, MAX);
  // Charge the post-dedup/post-cap batch size: what the caller can actually
  // make us do, not what they claimed to want.
  const limited = guardExpensive(
    req,
    "wallet-age",
    { ...LIMITS, cost: wallets.length },
    { ages: {} },
  );
  if (limited) return limited;
  try {
    const db = openDb(process.env.DASH_DB ?? "data.sqlite");
    try {
      const tsMap = await getWalletAges(db, wallets);
      const now = Math.floor(Date.now() / 1000);
      const ages: Record<
        string,
        { firstTs: number | null; ageDays: number | null }
      > = {};
      for (const w of wallets) {
        const ts = tsMap[w] ?? null;
        ages[w] = {
          firstTs: ts,
          ageDays: ts != null ? (now - ts) / 86400 : null,
        };
      }
      return Response.json({ ages });
    } finally {
      // Per-request connection, same as /api/wallet-stats: this was the one
      // route that leaked its handle — heavy batch age lookups accumulated
      // open fds until EMFILE took down the whole Next process (dashboard
      // AND embedded engine).
      db.close();
    }
  } catch (e) {
    console.error("[/api/wallet-age] lookup failed:", e);
    return Response.json(
      { ages: {}, error: e instanceof Error ? e.message : String(e) },
      { status: 200 },
    );
  }
}
