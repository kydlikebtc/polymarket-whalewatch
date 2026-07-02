import Database from "better-sqlite3";

// Node runtime is required: better-sqlite3 is a native module and cannot run on
// the Edge runtime. force-dynamic disables caching so each poll reads fresh rows.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AlertRow = {
  id: number;
  type: string | null;
  dedup_key: string | null;
  payload: string | null;
  created_at: number | null;
};

type TradePayload = {
  proxyWallet?: string;
  side?: string;
  size?: number;
  price?: number;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
  outcomeIndex?: number;
  transactionHash?: string;
};

type AlertView = {
  id: number;
  type: string;
  title: string;
  outcome: string;
  side: string;
  usd: number;
  price: number;
  wallet: string;
  eventSlug: string;
  txHash: string;
  createdAt: number;
};

const DB_PATH = process.env.DASH_DB ?? "data.sqlite";

export async function GET() {
  try {
    // Read-only: the dashboard never writes. fileMustExist:false lets us return
    // an empty result instead of throwing when the worker hasn't created the db.
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: false });
    try {
      const rows = db
        .prepare(
          "SELECT id, type, dedup_key, payload, created_at FROM alerts ORDER BY created_at DESC LIMIT 100",
        )
        .all() as AlertRow[];

      const alerts: AlertView[] = rows.map((row) => {
        let p: TradePayload & { totalNetUsd?: number } = {};
        try {
          p = row.payload
            ? (JSON.parse(row.payload) as TradePayload & {
                totalNetUsd?: number;
              })
            : {};
        } catch {
          p = {};
        }
        const type = row.type ?? "large";
        // Consensus payloads are group aggregates, not single fills.
        if (type === "consensus") {
          return {
            id: row.id,
            type,
            title: p.title ?? "(未知市场)",
            outcome: p.outcome ?? "",
            side: "BUY",
            usd: typeof p.totalNetUsd === "number" ? p.totalNetUsd : 0,
            price: 0,
            wallet: "",
            eventSlug: p.eventSlug ?? "",
            txHash: "",
            createdAt: row.created_at ?? 0,
          };
        }
        const size = typeof p.size === "number" ? p.size : 0;
        const price = typeof p.price === "number" ? p.price : 0;
        return {
          id: row.id,
          type,
          title: p.title ?? "(未知市场)",
          outcome: p.outcome ?? "",
          side: p.side ?? "",
          usd: size * price,
          price,
          wallet: p.proxyWallet ?? "",
          eventSlug: p.eventSlug ?? p.slug ?? "",
          txHash: p.transactionHash ?? "",
          createdAt: row.created_at ?? 0,
        };
      });

      return Response.json({ count: alerts.length, alerts });
    } finally {
      db.close();
    }
  } catch (error) {
    // Missing db / missing table / parse issues degrade gracefully to empty.
    console.error("[/api/alerts] failed to read alerts:", error);
    return Response.json({ count: 0, alerts: [] });
  }
}
