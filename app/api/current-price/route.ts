import { fetchPriceAt } from "../../../lib/priceHistory";
import { mapLimit } from "../../../lib/mapLimit";
import { guardExpensive } from "../../../lib/apiGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 持仓中列表「当前价」列的批量取价(见 app/useCurrentPrices.ts)。CLOB
// /prices-history 没有批量端点,只能逐个 token 请求——MAX 是单次请求的硬
// 上限(12 档并行后持仓数不是个位数,但按 asset 去重、且远达不到这个量级,
// 纯防御性上界,不是按真实用量倒推的紧凑值)。
const MAX = 200;

// 60s TTL:这一列是"当前市价快照,仅供参考",不进任何战绩口径(见 OpenTable
// 列头 title),不需要跟 CLOB 一样实时——量级对齐 /api/positions 的现价
// 缓存(同一种"惰性加载 + 短 TTL 服务端缓存"结构),缓存命中时前端重复
// 请求(例如切换持有中/已结算 tab 来回)不产生新的上游调用。
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 2000;

// 公开部署防滥用预算(见 lib/apiGuard.ts 顶部注释):按 asset 数计费而不是
// 按请求数——这条路由每个 asset 恰好 1 次上游 CLOB 调用(不像 wallet-stats
// 单钱包可能扇出到 81 次),量级与 /api/wallet-age 的"单钱包 1 次上游调用"
// 同档,借用它的预算数字。价格不能像钱包年龄那样"缓存到天荒地老"(60s TTL,
// 见上),真实浏览会比 wallet-age 更频繁地重新计费,但请求成本本身也低了
// 一个数量级,两相抵消,直接复用同一组数字是合理的起点。
const LIMITS = { perIp: 600, global: 3000 };

// asset(CLOB token id)→ 缓存的价格快照。null 与"未缓存"是两种不同的状态:
// null = 已经问过 CLOB、明确取不到(mock token、太新太冷的市场);未缓存 =
// 这次请求需要真的去问一次。
const cache = new Map<string, { at: number; price: number | null }>();

async function getCached(
  asset: string,
  nowSec: number,
): Promise<number | null> {
  const hit = cache.get(asset);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.price;
  let price: number | null = null;
  try {
    price = await fetchPriceAt(asset, nowSec);
  } catch (e) {
    console.warn(`[/api/current-price] fetchPriceAt failed for ${asset}:`, e);
  }
  while (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
  cache.set(asset, { at: Date.now(), price });
  return price;
}

// POST { assets: string[] } → { prices: Record<string, number | null> }
//
// 持仓中列表「当前价」列的惰性批量取价(app/useCurrentPrices.ts 挂载时
// 才发起,不随 /api/follow 同步返回)。按 asset 去重(12 档持仓大面积
// 重叠,见设计文档 §9.1)后用 mapLimit 控制并发——不对 CLOB 一次甩几十个
// 请求。取价失败/该 token 无行情数据(mock 数据、太新太冷的市场)记
// null,不是 0、不是把整条请求判失败:调用方据此逐行显示「—」而不是把
// "不知道"误读成"跌到 0"。
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const raw: unknown = (body as { assets?: unknown } | null)?.assets;
  const assets = [
    ...new Set(
      Array.isArray(raw)
        ? raw.filter((a): a is string => typeof a === "string" && a.length > 0)
        : [],
    ),
  ].slice(0, MAX);

  // 按去重+截断后的真实批量计费(不是按调用方声称的量)——这也是这条路由
  // 顺带完成"服务端也去重"这层防御的地方:调用方(useCurrentPrices)已经
  // 去重,这里不信任它,重复一遍。
  const limited = guardExpensive(
    req,
    "current-price",
    { ...LIMITS, cost: assets.length },
    { prices: {} },
  );
  if (limited) return limited;

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const results = await mapLimit(assets, 6, async (asset) => ({
      asset,
      price: await getCached(asset, nowSec),
    }));
    const prices: Record<string, number | null> = {};
    for (const r of results) prices[r.asset] = r.price;
    return Response.json({ prices });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/current-price] failed:", message);
    return Response.json({ prices: {}, error: message });
  }
}
