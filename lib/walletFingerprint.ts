import type { DB } from "./db";

// 行为指纹 · 限池内(第二梯队八件套,2026-08-28,设计
// docs/plans/2026-08-28-tier2-octet-design.md §四):池内钱包的交易风格,
// 从本地告警台账一趟扫出 —— 可解释规则型标签,**拒绝黑盒聚类**(每个标签
// 都能一句话说清判定条件,读者可自行核对;k-means 的簇没有这个性质)。
// 零上游:只读 alerts(90 天窗,large/smart —— consensus 组 payload 无
// side/marketCtx,风格轴不适用)与 smart_wallets。
// 标签是稳定 ASCII 键,中文/英文译名在页面侧逐键写死(scorecardLabel 先例
// —— i18n coverage 闸只认页面里的静态 t() 字面量)。

export interface WalletStyle {
  wallet: string;
  alerts: number;
  medPriceCents: number;
  medUsd: number;
  sellShare: number;
  /** 中位距结算小时;marketCtx 缺失过半时 null(不硬造时钟轴)。 */
  medHoursToEnd: number | null;
  winRate: number | null;
  tags: string[];
}

export const STYLE_MIN_ALERTS = 5;
const WINDOW_DAYS = 90;
// 标签阈值(可解释性即合约,改动须同步页面译名 tooltip):
const LONGSHOT_MAX_CENTS = 35; // 冷门猎手
const FAVORITE_MIN_CENTS = 65; // 热门守卫
const HAMMER_MIN_USD = 50_000; // 重锤
const LASTCALL_MAX_H = 6; // 临场
const INTRADAY_MAX_H = 48; // 隔日
const TWOWAY_MIN_SELL = 0.3; // 双向

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** 一趟扫描 → 池内钱包风格表(键 = lowercase 地址)。 */
export function buildPoolStyles(
  db: DB,
  opts: { nowSec?: number; days?: number } = {},
): Map<string, WalletStyle> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const days = opts.days ?? WINDOW_DAYS;
  const pool = new Map<string, number | null>();
  for (const r of db
    .prepare("SELECT address, win_rate FROM smart_wallets")
    .all() as { address: string; win_rate: number | null }[]) {
    pool.set(r.address.toLowerCase(), r.win_rate);
  }
  if (pool.size === 0) return new Map();

  const acc = new Map<
    string,
    {
      prices: number[];
      usds: number[];
      sells: number;
      hours: number[];
      n: number;
    }
  >();
  const rows = db
    .prepare(
      `SELECT payload FROM alerts
        WHERE created_at >= ? AND type IN ('large','smart')`,
    )
    .all(nowSec - days * 86_400) as { payload: string | null }[];
  for (const r of rows) {
    if (!r.payload) continue;
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const w =
      typeof p.proxyWallet === "string" ? p.proxyWallet.toLowerCase() : null;
    if (!w || !pool.has(w)) continue;
    if (typeof p.price !== "number" || typeof p.size !== "number") continue;
    const a = acc.get(w) ?? { prices: [], usds: [], sells: 0, hours: [], n: 0 };
    acc.set(w, a);
    a.n++;
    a.prices.push(p.price);
    a.usds.push(p.size * p.price);
    if (p.side === "SELL") a.sells++;
    const ctx = p.marketCtx as { hoursToEnd?: unknown } | undefined;
    if (ctx && typeof ctx.hoursToEnd === "number") a.hours.push(ctx.hoursToEnd);
  }

  const out = new Map<string, WalletStyle>();
  for (const [wallet, a] of acc) {
    if (a.n < STYLE_MIN_ALERTS) continue;
    const medPriceCents = (median(a.prices) ?? 0) * 100;
    const medUsd = median(a.usds) ?? 0;
    const sellShare = a.sells / a.n;
    // 时钟轴要求覆盖过半 —— 缺 marketCtx 的老告警不该被少数几条带偏。
    const medHoursToEnd = a.hours.length * 2 >= a.n ? median(a.hours) : null;
    const tags: string[] = [];
    if (medPriceCents <= LONGSHOT_MAX_CENTS) tags.push("longshot");
    else if (medPriceCents >= FAVORITE_MIN_CENTS) tags.push("favorite");
    else tags.push("midrange");
    if (medHoursToEnd != null) {
      if (medHoursToEnd <= LASTCALL_MAX_H) tags.push("lastcall");
      else if (medHoursToEnd <= INTRADAY_MAX_H) tags.push("intraday");
      else tags.push("longhaul");
    }
    if (medUsd >= HAMMER_MIN_USD) tags.push("hammer");
    if (sellShare >= TWOWAY_MIN_SELL) tags.push("twoway");
    out.set(wallet, {
      wallet,
      alerts: a.n,
      medPriceCents,
      medUsd,
      sellShare,
      medHoursToEnd,
      winRate: pool.get(wallet) ?? null,
      tags,
    });
  }
  return out;
}

export interface SimilarWallet {
  wallet: string;
  distance: number;
}

/**
 * 池内最近邻:z 分数特征(中位价 / log 中位额 / 时钟 / 胜率)欧氏距离。
 * 缺失特征(时钟 null / 胜率 null)以池中位数顶替 —— 缺数据钱包退化为
 * 「平均风格」而不是被排除。
 */
export function similarWallets(
  styles: Map<string, WalletStyle>,
  address: string,
  k = 3,
): SimilarWallet[] {
  const me = styles.get(address.toLowerCase());
  if (!me || styles.size < 2) return [];
  const all = [...styles.values()];
  const feats = (s: WalletStyle): (number | null)[] => [
    s.medPriceCents,
    Math.log10(Math.max(1, s.medUsd)),
    s.medHoursToEnd,
    s.winRate,
  ];
  const dims = feats(me).length;
  const cols: number[][] = Array.from({ length: dims }, () => []);
  for (const s of all) {
    feats(s).forEach((v, i) => {
      if (v != null && Number.isFinite(v)) cols[i].push(v);
    });
  }
  const fill = cols.map((c) => median(c) ?? 0);
  const mean = cols.map((c, i) =>
    c.length > 0 ? c.reduce((s, v) => s + v, 0) / c.length : fill[i],
  );
  const sd = cols.map((c, i) => {
    if (c.length < 2) return 1;
    const m = mean[i];
    return Math.max(
      Math.sqrt(c.reduce((s, v) => s + (v - m) ** 2, 0) / (c.length - 1)),
      1e-9,
    );
  });
  const vec = (s: WalletStyle): number[] =>
    feats(s).map((v, i) => (((v ?? fill[i]) as number) - mean[i]) / sd[i]);
  const mine = vec(me);
  return all
    .filter((s) => s.wallet !== me.wallet)
    .map((s) => {
      const v = vec(s);
      const d = Math.sqrt(v.reduce((sum, x, i) => sum + (x - mine[i]) ** 2, 0));
      return { wallet: s.wallet, distance: d };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k);
}
