import { resolveMarketInput } from "../../../../lib/marketCard";
import { guardExpensive } from "../../../../lib/apiGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin wrapper: resolution logic lives in lib/marketCard (shared with the bot).
// Every resolve is a gamma lookup on caller-supplied text, so it is a free
// upstream proxy without a guard — cheap per call, but unbounded in aggregate.
const LIMITS = { perIp: 60, global: 400 };

export async function GET(req: Request) {
  const limited = guardExpensive(req, "market-resolve", LIMITS, {
    error: "rate limited",
  });
  if (limited) return limited;
  const input = new URL(req.url).searchParams.get("input") ?? "";
  const r = await resolveMarketInput(input);
  if (r.kind === "cid") return Response.json({ conditionId: r.conditionId });
  if (r.kind === "candidates")
    return Response.json({ candidates: r.candidates });
  return Response.json(
    { error: r.message },
    { status: r.message === "empty input" ? 400 : 200 },
  );
}
