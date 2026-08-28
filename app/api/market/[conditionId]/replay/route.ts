import { guardExpensive } from "../../../../../lib/apiGuard";
import { openDb } from "../../../../../lib/db";
import { getMarketMeta } from "../../../../../lib/gamma";
import {
  collectReplayMarkers,
  replayRange,
} from "../../../../../lib/marketReplay";
import { fetchPriceSeries } from "../../../../../lib/priceHistory";
import { createPromiseCache } from "../../../../../lib/promiseCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 时光机 · 市场复盘(2026-08-28 八件套)。本批唯一的按需上游:一条
// prices-history 曲线,**只在用户点「加载复盘」时**拉取(市场卡自身零上游
// 的纪律不被稀释),10 分钟 promise 缓存按市场去重 —— 已结算市场的曲线
// 不可变,重复浏览近乎免费。标记与区间是纯本地读(lib/marketReplay)。

const CID_RE = /^0x[0-9a-fA-F]{64}$/;
const LIMITS = { perIp: 30, global: 120, cost: 2 };
const CACHE_TTL_MS = 600_000;
const seriesCache =
  createPromiseCache<{ t: number; p: number }[]>(CACHE_TTL_MS);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ conditionId: string }> },
) {
  const { conditionId: raw } = await params;
  const conditionId = String(raw ?? "");
  if (!CID_RE.test(conditionId)) {
    return Response.json({ error: "bad conditionId" }, { status: 400 });
  }
  const limited = guardExpensive(req, "market-replay", LIMITS, {});
  if (limited) return limited;
  try {
    const db = openDb(process.env.DASH_DB ?? "data.sqlite");
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const meta = (await getMarketMeta(db, [conditionId]))[conditionId];
      const token = meta?.clobTokenIds?.[0] ?? null;
      if (!token) {
        return Response.json(
          { error: "该市场的 token 元数据不可用,无法取曲线" },
          { status: 404 },
        );
      }
      const outcomeCount = meta?.outcomes?.length ?? 2;
      const markers = collectReplayMarkers(db, conditionId, {
        nowSec,
        outcomeCount,
      });
      const endDateSec = meta?.endDate ? Date.parse(meta.endDate) / 1000 : null;
      const { startTs, endTs } = replayRange(markers, nowSec, {
        closed: meta?.closed === true,
        endDateSec: Number.isFinite(endDateSec) ? endDateSec : null,
      });
      const series = await seriesCache(conditionId, () =>
        fetchPriceSeries(token, startTs, endTs),
      );
      const resolutionPrice =
        meta?.closed === true &&
        typeof meta.outcomePrices?.[0] === "number" &&
        Number.isFinite(meta.outcomePrices[0])
          ? meta.outcomePrices[0]
          : null;
      return Response.json(
        {
          conditionId,
          outcome: meta?.outcomes?.[0] ?? null,
          binary: outcomeCount === 2,
          closed: meta?.closed === true,
          resolutionPrice,
          startTs,
          endTs,
          series: [...series].sort((a, b) => a.t - b.t),
          markers,
        },
        { headers: { "Cache-Control": "public, max-age=300" } },
      );
    } finally {
      db.close();
    }
  } catch (error) {
    console.error("[/api/market/replay] failed:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
