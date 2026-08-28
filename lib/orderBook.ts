// CLOB 订单簿快照 → 模拟市价吃单。用途:纸面跟单开仓瞬间抓 ask 侧盘口,
// 按本仓名义金额模拟吃单得到「可执行成交均价」,与报价入场价的差 = 执行滑点
// 估计(含跨价差 + 吃深度两段)。红线:与 formation/markout 同级 —— 只做归因
// 展示,绝不参与开仓判定与 realized_pnl。
//
// 实测事实(2026-07-31 live curl,勿凭常识改):
//   GET https://clob.polymarket.com/book?token_id=... →
//   { bids, asks, last_trade_price, tick_size, ... },bids/asks 为
//   {price:string, size:string}[] 且**由外向内排序 —— 最优档在数组末尾**
//   (asks 从 0.99 降到 0.61)。按常规交易所惯例(asks 升序)直接遍历会先吃
//   最差档,故解析层无条件重排升序,不信任来路顺序。

const CLOB_API = "https://clob.polymarket.com";

export interface BookLevel {
  price: number; // 0-1 概率价
  size: number; // 份额(非美元)
}

// ask 侧簿:升序(最优=最低价在前)。空数组=有效但不可成交的空簿。
export interface AskBook {
  asks: BookLevel[];
}

/**
 * /book 响应 → AskBook。字符串数字化、剔除非法档(NaN/非正 price 或 size)、
 * 升序重排。形状不对(缺 asks / 非数组)返回 null;asks 为空数组保留空簿,
 * 「拿到了簿但没人挂卖单」与「没拿到簿」是两种事实,由调用方分别处理。
 */
export function parseAskBook(raw: unknown): AskBook | null {
  if (!raw || typeof raw !== "object") return null;
  const asksRaw = (raw as { asks?: unknown }).asks;
  if (!Array.isArray(asksRaw)) return null;
  const asks: BookLevel[] = [];
  for (const lv of asksRaw) {
    if (!lv || typeof lv !== "object") continue;
    const price = Number((lv as { price?: unknown }).price);
    const size = Number((lv as { size?: unknown }).size);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!Number.isFinite(size) || size <= 0) continue;
    asks.push({ price, size });
  }
  asks.sort((a, b) => a.price - b.price);
  return { asks };
}

/**
 * 拉某 token 的 ask 簿。非 ok 状态码 throw(与 fetchPriceAt 同惯例,由调用方
 * try/catch —— 盘口抖动只该影响这一仓的归因列,杀不死开仓)。
 */
export async function fetchAskBook(tokenId: string): Promise<AskBook | null> {
  const res = await fetch(`${CLOB_API}/book?token_id=${tokenId}`, {
    signal: AbortSignal.timeout(10_000),
    headers: { "User-Agent": "polymarket-monitor" },
  });
  if (!res.ok) throw new Error(`fetchAskBook ${res.status}`);
  return parseAskBook(await res.json());
}

/**
 * 容量标尺(带内深度):自最优档起,累计所有 price ≤ bestAsk + bandCents/100
 * 档位的美元名义额 —— 即「跟随资金在把成交价推出该带之前最多能吃多少钱」。
 * 带宽用绝对 cents(与 markout/mae 同口径);相对百分比在 0-1 概率价的低价端
 * 会塌缩,弃用。空簿/负带宽返回 null:容量未知与「实测 $0 深度」是两种事实。
 * 红线同 exec_*:纯归因展示,不参与开仓判定与 realized_pnl。
 */
export function bookCapacityUsd(
  asks: BookLevel[],
  bandCents: number,
): number | null {
  if (asks.length === 0 || bandCents < 0) return null;
  // 1e-9 浮点容差:0.1+0.01 在二进制下略大于 0.11,朴素 ≤ 会把恰在带缘的档漏掉。
  const limit = asks[0].price + bandCents / 100 + 1e-9;
  let usd = 0;
  for (const lv of asks) {
    if (lv.price > limit) break; // 升序簿(parseAskBook 保证),越界即可停
    usd += lv.price * lv.size;
  }
  return usd;
}

export interface BookFill {
  avgPrice: number; // 成交均价 = 总耗资 ÷ 总份额
  shares: number; // 吃到的总份额
  filledUsd: number; // 实际成交金额;< 目标金额 = 盘太薄吃穿全簿(部分成交)
}

/**
 * 模拟市价买入 notionalUsd 美元:从最优 ask 逐档上吃,每档最多吃
 * price×size 美元,直到花完或吃穿全簿。asks 需升序(parseAskBook 保证)。
 * 空簿或非正金额返回 null。
 */
export function simulateBookBuy(
  asks: BookLevel[],
  notionalUsd: number,
): BookFill | null {
  if (asks.length === 0 || notionalUsd <= 0) return null;
  let remaining = notionalUsd;
  let shares = 0;
  let spent = 0;
  for (const lv of asks) {
    if (remaining <= 1e-9) break;
    const levelUsd = lv.price * lv.size;
    const take = Math.min(remaining, levelUsd);
    shares += take / lv.price;
    spent += take;
    remaining -= take;
  }
  if (shares <= 0) return null;
  return { avgPrice: spent / shares, shares, filledUsd: spent };
}
