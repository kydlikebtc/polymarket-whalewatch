import { resolveMarketInput } from "../../../../lib/marketCard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin wrapper: resolution logic lives in lib/marketCard (shared with the bot).
export async function GET(req: Request) {
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
