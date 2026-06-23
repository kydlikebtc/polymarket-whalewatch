import { TradeSchema, type Trade } from "./types";
import { z } from "zod";
const DATA_API = "https://data-api.polymarket.com";
export async function getLargeTrades(
  minUsd: number,
  limit = 500,
): Promise<Trade[]> {
  const url = `${DATA_API}/trades?filterType=CASH&filterAmount=${minUsd}&takerOnly=true&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`getLargeTrades ${res.status}`);
  const raw = await res.json();
  const parsed = z.array(TradeSchema).safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    console.warn(
      `[getLargeTrades] response shape mismatch (falling back to raw): ${issues}`,
    );
    return raw as Trade[];
  }
  if (parsed.data.length === limit) {
    // Full page: more than `limit` large trades may exist this cycle and would be missed.
    // Single-page fetch is the MVP choice; offset pagination is a P2+ item (design §5).
    console.warn(
      `[getLargeTrades] full page (${limit} rows) — some large trades this cycle may be missed`,
    );
  }
  return parsed.data;
}
