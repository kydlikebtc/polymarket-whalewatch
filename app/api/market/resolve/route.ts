import { parseMarketInput } from "../../../../lib/marketBrief";
import { fetchWithRetry } from "../../../../lib/fetchWithRetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GAMMA = "https://gamma-api.polymarket.com";

type GammaMarket = { conditionId?: string; question?: string };

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetchWithRetry(url, {
    timeoutMs: 10_000,
    label: "resolveMarket",
  });
  if (!res.ok) throw new Error(`gamma ${res.status}`);
  return res.json();
}

// Resolve a pasted conditionId / market slug / Polymarket URL to a market.
// A market slug resolves directly; an EVENT slug (what most copied links
// carry) returns its markets as candidates for the user to pick — an event
// can hold many markets and guessing would silently show the wrong one.
export async function GET(req: Request) {
  const input = new URL(req.url).searchParams.get("input") ?? "";
  const parsed = parseMarketInput(input);
  if (!parsed) return Response.json({ error: "empty input" }, { status: 400 });
  if (parsed.kind === "cid") {
    return Response.json({ conditionId: parsed.value });
  }
  try {
    // Try as a MARKET slug first (exact identity), closed markets included.
    for (const extra of ["", "&closed=true"]) {
      const rows = (await fetchJson(
        `${GAMMA}/markets?slug=${encodeURIComponent(parsed.value)}${extra}`,
      )) as GammaMarket[];
      const cid = Array.isArray(rows) ? rows[0]?.conditionId : undefined;
      if (cid) return Response.json({ conditionId: cid });
    }
    // Then as an EVENT slug: surface its markets as candidates.
    const events = (await fetchJson(
      `${GAMMA}/events?slug=${encodeURIComponent(parsed.value)}`,
    )) as { markets?: GammaMarket[] }[];
    const markets = Array.isArray(events) ? (events[0]?.markets ?? []) : [];
    const candidates = markets
      .filter((m) => m.conditionId)
      .map((m) => ({
        conditionId: m.conditionId as string,
        question: m.question ?? "",
      }));
    if (candidates.length === 1) {
      return Response.json({ conditionId: candidates[0].conditionId });
    }
    if (candidates.length > 1) return Response.json({ candidates });
    return Response.json({
      error:
        "未找到该市场——请粘贴 Polymarket 市场链接、market slug 或 conditionId",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/market/resolve] failed:", message);
    return Response.json({ error: message });
  }
}
