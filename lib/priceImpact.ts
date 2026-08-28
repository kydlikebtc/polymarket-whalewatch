import type { DB } from "./db";
import { clusteredInterval } from "./outcomeStats";

// 价格影响持久性(第二梯队八件套,2026-08-28,设计
// docs/plans/2026-08-28-tier2-octet-design.md §二):某钱包的告警落地后,
// 市场的 10 分钟初动有没有被 24h 走势留住。回落 = 噪声/被市场无视,
// 留住 = 市场认为他知道些什么 —— 与 PnL 正交的「被市场相信程度」。
//
// 口径:
//  - 方向化位移 m_h = sign·(p_h − p0),sign = BUY:+1 / SELL:−1;
//    p0 = 单笔告警的成交价,consensus 用**成员自己的** avgBuyPrice
//    (记分卡同款成员展开,不用组均价 —— 每人是自己的前向实验)。
//  - 「可测初动」= m_10m ≥ +2¢ 且 24h 价在场。只测被跟随的初动:负初动
//    (落地即被打回)的「留存」问题不适定,计入会把分母灌水。实现期把设计
//    稿的 |m_10m| 收紧为 m_10m ≥ 0(见八件套设计的实现期修正段)。
//  - 「留住」= m_24h ≥ 0.5·m_10m(24h 后至少保住初动的一半)。
//  - 区间按市场聚簇:同市场多条告警共享同一段行情演化,按行数算区间会虚窄。
// 红线:描述统计,不是策略信号 —— verdict 文案不出现任何跟单措辞。

export interface WalletPriceImpact {
  /** 该钱包窗口内已评级且带 10m 标记的行数(含未达可测门槛的)。 */
  n: number;
  /** 可测初动行数(m_10m ≥ 2¢ 且 24h 在场)。 */
  measured: number;
  retained: number;
  rate: number | null;
  ciLo: number | null;
  ciHi: number | null;
  /** 可测行覆盖的去重市场数 —— 区间与 verdict 的有效样本量。 */
  markets: number;
  /** 可测行的中位初动 / 中位 24h 位移(¢,方向化)。 */
  medImpactCents: number | null;
  med24hCents: number | null;
  verdict: "followed" | "faded" | "mixed" | "insufficient";
}

const WINDOW_DAYS = 90;
const MIN_IMPACT = 0.02;
const RETAIN_FRAC = 0.5;
const MIN_MARKETS = 8;

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

interface Row {
  type: string | null;
  payload: string | null;
  price_10m: number | null;
  price_24h: number | null;
}

/** 纯本地读(alerts LIKE + created_at 界,走 created_at 索引),零上游。 */
export function walletPriceImpact(
  db: DB,
  address: string,
  opts: { nowSec?: number; days?: number } = {},
): WalletPriceImpact {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const days = opts.days ?? WINDOW_DAYS;
  const addr = address.toLowerCase();
  const rows = db
    .prepare(
      `SELECT a.type, a.payload, ao.price_10m, ao.price_24h
         FROM alerts a JOIN alert_outcomes ao ON ao.alert_id = a.id
        WHERE a.created_at >= ?
          AND a.type IN ('large','smart','consensus')
          AND a.payload LIKE ?
          AND ao.price_10m IS NOT NULL`,
    )
    .all(nowSec - days * 86_400, `%${addr}%`) as Row[];

  let n = 0;
  const points: { m10: number; m24: number; cid: string }[] = [];
  for (const r of rows) {
    if (!r.payload || r.price_10m == null) continue;
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const cid = typeof p.conditionId === "string" ? p.conditionId : null;
    if (!cid) continue;
    let p0: number | null = null;
    let sign = 1;
    if (r.type === "consensus") {
      const members = Array.isArray(p.wallets)
        ? (p.wallets as { wallet?: unknown; avgBuyPrice?: unknown }[])
        : [];
      const me = members.find(
        (m) => typeof m.wallet === "string" && m.wallet.toLowerCase() === addr,
      );
      if (!me || typeof me.avgBuyPrice !== "number") continue;
      p0 = me.avgBuyPrice;
    } else {
      const w = typeof p.proxyWallet === "string" ? p.proxyWallet : null;
      if (!w || w.toLowerCase() !== addr) continue;
      if (typeof p.price !== "number") continue;
      p0 = p.price;
      sign = p.side === "SELL" ? -1 : 1;
    }
    if (!(p0 > 0 && p0 < 1)) continue;
    n++;
    if (r.price_24h == null) continue;
    const m10 = sign * (r.price_10m - p0);
    if (m10 < MIN_IMPACT) continue;
    points.push({ m10, m24: sign * (r.price_24h - p0), cid });
  }

  const measured = points.length;
  const retainedPts = points.filter((x) => x.m24 >= RETAIN_FRAC * x.m10);
  const markets = new Set(points.map((x) => x.cid)).size;
  if (markets < MIN_MARKETS) {
    return {
      n,
      measured,
      retained: retainedPts.length,
      rate: null,
      ciLo: null,
      ciHi: null,
      markets,
      medImpactCents: median(points.map((x) => x.m10 * 100)),
      med24hCents: median(points.map((x) => x.m24 * 100)),
      verdict: "insufficient",
    };
  }
  const retained = retainedPts.length;
  const rate = retained / measured;
  const { lo, hi } = clusteredInterval(retained, measured, markets);
  const verdict = lo > 0.5 ? "followed" : hi < 0.5 ? "faded" : "mixed";
  return {
    n,
    measured,
    retained,
    rate,
    ciLo: lo,
    ciHi: hi,
    markets,
    medImpactCents: median(points.map((x) => x.m10 * 100)),
    med24hCents: median(points.map((x) => x.m24 * 100)),
    verdict,
  };
}
