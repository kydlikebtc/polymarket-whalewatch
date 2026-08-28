import type { DB } from "./db";
import { isPermanentSendError } from "./telegram";
import { cents, esc, short, urlSeg, usd } from "./tgFormat";
import { dedupKey, notionalUsd } from "./trades";
import type { Trade } from "./types";

// 同批出生检测(第一梯队五件套,2026-08-28,设计
// docs/plans/2026-08-28-tier1-quintet-design.md §五):N 个几乎同时出生的
// 新钱包进入同一市场同一结果方向 = 协同指纹 —— 比任何单个新钱包大单都强的
// 信号形状。零新增上游的两条构造性保证:
//  1. 成交 = consensus 循环已抓的 6h/$2k 深窗口(本模块是它的第五个消费者);
//  2. 年龄 = wallet_age 缓存裸读(discovery.ts:533 先例)。缓存没有 = 不知道,
//     绝不现场抓 —— 覆盖率天然不足(历史实测 43% 且非随机),告警文案强制
//     携带「年龄已知 M/N」声明,检测灵敏度随缓存自然增长。
// 会计口径镜像 consensus 的两道防线:净额按成本敞口(净股数×买入均价,
// 等股买卖不同价的「USD 假净买」不合格)、同市场双边净买的对冲钱包整体剔除。
// 与 consensus 的刻意差异:没有状态表 —— (type, dedup_key) 唯一索引天然给出
// 「只报形成与升级」,不做 TTL 到期提醒(同批出生是一次性事件,不是持续状态)。

export interface CohortOptions {
  /** 地址年龄上限(天):超过它不算「新钱包」。 */
  maxAgeDays: number;
  /** 同批判定:成员出生时刻的最大跨度(小时,含端点)。 */
  birthSpanHours: number;
  minWallets: number;
  /** 逐钱包成本敞口下限(USD)。深窗口抓取下限 $2k,取同值起步。 */
  minPerWalletUsd: number;
  minTotalUsd: number;
}

export const DEFAULT_COHORT: CohortOptions = {
  maxAgeDays: 7,
  birthSpanHours: 48,
  minWallets: 3,
  minPerWalletUsd: 2000,
  minTotalUsd: 10_000,
};

export interface CohortWallet {
  wallet: string;
  /** 成本敞口(净股数 × 买入均价)。 */
  netUsd: number;
  avgBuyPrice: number;
  /** 已验证出生时刻(wallet_age 缓存)。 */
  firstTs: number;
  ageDays: number;
}

// 字段名刻意与 ConsensusGroup 对齐(totalNetUsd/avgBuyPrice/lastTs/asset/
// outcomeIndex/wallets):/api/alerts 的组类 payload 投影与验证回填的
// trackable 分支可以镜像 consensus,不发明第二套字段学。
export interface CohortGroup {
  conditionId: string;
  outcome: string;
  title: string;
  slug: string;
  eventSlug: string;
  asset: string;
  outcomeIndex: number;
  /** 同批成员(净额降序)。 */
  wallets: CohortWallet[];
  walletCount: number;
  totalNetUsd: number;
  /** USD 加权买入均价 —— 验证回填的合成入场价。 */
  avgBuyPrice: number;
  /** 成员钱包在窗口内的最后一笔成交 ts(trackable 的计时锚点)。 */
  lastTs: number;
  /** 成员出生跨度(小时,实际值 ≤ opts.birthSpanHours)。 */
  birthSpanHours: number;
  youngestAgeDays: number;
  oldestAgeDays: number;
  /** 结构合格(敞口过线)的钱包总数 —— 同批只是其中年龄已知且同窗的子集。 */
  groupSize: number;
  /** 结构合格里年龄已知的个数;「年龄已知 M/N」诚实声明的分子。 */
  ageKnown: number;
}

const DAY = 86_400;

interface Acc {
  buyUsd: number;
  sellUsd: number;
  buyShares: number;
  sellShares: number;
  lastOwnTs: number;
}

const netShares = (a: Acc): number => Math.max(0, a.buyShares - a.sellShares);
const avgBuy = (a: Acc): number =>
  a.buyShares > 0 ? a.buyUsd / a.buyShares : 0;
/** 成本敞口(P0.6 同口径):留存净股数 × 买入均价,不是 buyUsd−sellUsd 现金流。 */
const exposureUsd = (a: Acc): number => netShares(a) * avgBuy(a);

/**
 * 纯检测:窗口成交 + 已验证年龄表 → 同批出生组。ages 的键是小写钱包地址,
 * 值是已验证 first_ts(缓存里 NULL 的「已验证无活动」行语义含混,调用方
 * 不应传入 —— v1 只认数值)。
 */
export function detectCohorts(
  trades: Trade[],
  ages: Record<string, number>,
  opts: CohortOptions = DEFAULT_COHORT,
  nowSec: number = Math.floor(Date.now() / 1000),
): CohortGroup[] {
  const seen = new Set<string>();
  const groups = new Map<
    string,
    {
      conditionId: string;
      outcome: string;
      title: string;
      slug: string;
      eventSlug: string;
      asset: string;
      outcomeIndex: number;
      byWallet: Map<string, Acc>;
    }
  >();
  for (const t of trades) {
    const dk = dedupKey(t);
    if (seen.has(dk)) continue;
    seen.add(dk);
    const wallet = t.proxyWallet.toLowerCase();
    const key = `${t.conditionId}:${t.outcome}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        conditionId: t.conditionId,
        outcome: t.outcome,
        title: t.title,
        slug: t.slug,
        eventSlug: t.eventSlug,
        asset: t.asset,
        outcomeIndex: t.outcomeIndex,
        byWallet: new Map(),
      };
      groups.set(key, g);
    }
    let acc = g.byWallet.get(wallet);
    if (!acc) {
      acc = {
        buyUsd: 0,
        sellUsd: 0,
        buyShares: 0,
        sellShares: 0,
        lastOwnTs: 0,
      };
      g.byWallet.set(wallet, acc);
    }
    const tradeUsd = notionalUsd(t);
    if (t.side === "BUY") {
      acc.buyUsd += tradeUsd;
      acc.buyShares += t.size;
    } else {
      acc.sellUsd += tradeUsd;
      acc.sellShares += t.size;
    }
    if (t.timestamp > acc.lastOwnTs) acc.lastOwnTs = t.timestamp;
  }

  // 对冲钱包剔除(镜像 detectConsensus 假对立防线):同市场 ≥2 个结果上都
  // 留有净股数的钱包不是方向性观点,从每个结果组里整体剔除。
  const hedgersByMarket = new Map<string, Set<string>>();
  {
    const perMarket = new Map<string, Map<string, number>>();
    for (const g of groups.values()) {
      let perWallet = perMarket.get(g.conditionId);
      if (!perWallet) {
        perWallet = new Map();
        perMarket.set(g.conditionId, perWallet);
      }
      for (const [wallet, acc] of g.byWallet) {
        if (netShares(acc) > 0) {
          perWallet.set(wallet, (perWallet.get(wallet) ?? 0) + 1);
        }
      }
    }
    for (const [cid, perWallet] of perMarket) {
      const hs = new Set<string>();
      for (const [wallet, n] of perWallet) if (n >= 2) hs.add(wallet);
      if (hs.size > 0) hedgersByMarket.set(cid, hs);
    }
  }

  const out: CohortGroup[] = [];
  const spanSec = opts.birthSpanHours * 3600 + 1e-6; // 含端点(48h 整恰好同批)
  for (const g of groups.values()) {
    const hedgers = hedgersByMarket.get(g.conditionId);
    // 结构合格:敞口过线(与年龄无关 —— groupSize/ageKnown 的分母)。
    const qualified: { wallet: string; acc: Acc }[] = [];
    for (const [wallet, acc] of g.byWallet) {
      if (hedgers?.has(wallet)) continue;
      if (exposureUsd(acc) < opts.minPerWalletUsd) continue;
      qualified.push({ wallet, acc });
    }
    if (qualified.length < opts.minWallets) continue;

    // 年龄已知且新:进入同批滑窗筛选。
    const fresh: { wallet: string; acc: Acc; firstTs: number }[] = [];
    let ageKnown = 0;
    for (const q of qualified) {
      const firstTs = ages[q.wallet];
      if (typeof firstTs !== "number" || !Number.isFinite(firstTs)) continue;
      ageKnown++;
      if ((nowSec - firstTs) / DAY <= opts.maxAgeDays) {
        fresh.push({ ...q, firstTs });
      }
    }
    if (fresh.length < opts.minWallets) continue;

    // 滑窗最大子集:出生升序,双指针找 span 内人数最多的窗(并列取最早)。
    fresh.sort((a, b) => a.firstTs - b.firstTs);
    let bestLo = 0;
    let bestHi = 0; // [lo, hi] 闭区间下标
    let lo = 0;
    for (let hi = 0; hi < fresh.length; hi++) {
      while (fresh[hi].firstTs - fresh[lo].firstTs > spanSec) lo++;
      if (hi - lo > bestHi - bestLo) {
        bestLo = lo;
        bestHi = hi;
      }
    }
    const members = fresh.slice(bestLo, bestHi + 1);
    if (members.length < opts.minWallets) continue;
    const totalNetUsd = members.reduce((s, m) => s + exposureUsd(m.acc), 0);
    if (totalNetUsd < opts.minTotalUsd) continue;

    const wallets: CohortWallet[] = members
      .map((m) => ({
        wallet: m.wallet,
        netUsd: exposureUsd(m.acc),
        avgBuyPrice: avgBuy(m.acc),
        firstTs: m.firstTs,
        ageDays: (nowSec - m.firstTs) / DAY,
      }))
      .sort((a, b) => b.netUsd - a.netUsd);
    // USD 加权买入均价(consensus 同公式):总敞口 ÷ 总股数。
    const totalShares = wallets.reduce(
      (s, w) => s + (w.avgBuyPrice > 0 ? w.netUsd / w.avgBuyPrice : 0),
      0,
    );
    const births = members.map((m) => m.firstTs);
    out.push({
      conditionId: g.conditionId,
      outcome: g.outcome,
      title: g.title,
      slug: g.slug,
      eventSlug: g.eventSlug,
      asset: g.asset,
      outcomeIndex: g.outcomeIndex,
      wallets,
      walletCount: wallets.length,
      totalNetUsd,
      avgBuyPrice: totalShares > 0 ? totalNetUsd / totalShares : 0,
      lastTs: Math.max(...members.map((m) => m.acc.lastOwnTs)),
      birthSpanHours: (Math.max(...births) - Math.min(...births)) / 3600,
      youngestAgeDays: (nowSec - Math.max(...births)) / DAY,
      oldestAgeDays: (nowSec - Math.min(...births)) / DAY,
      groupSize: qualified.length,
      ageKnown,
    });
  }
  out.sort((a, b) => b.totalNetUsd - a.totalNetUsd);
  return out;
}

/** Telegram HTML(镜像 formatConsensusAlert 的分节风格,更小)。 */
export function formatCohortAlert(
  g: CohortGroup,
  opts: { publicUrl?: string } = {},
): string {
  const lines: string[] = [];
  lines.push(`🐣 <b>同批新钱包共进</b>`);
  lines.push(`<b>${esc(g.title)}</b> · ${esc(g.outcome)}`);
  lines.push(
    `同批 <b>${g.walletCount}</b> 个新钱包 · 合计 <b>${usd(g.totalNetUsd)}</b> · 均价 ${cents(g.avgBuyPrice)}`,
  );
  lines.push(
    `出生跨度 ${g.birthSpanHours.toFixed(1)}h · 最新 ${g.youngestAgeDays.toFixed(1)} 天 / 最老 ${g.oldestAgeDays.toFixed(1)} 天`,
  );
  const roster = g.wallets
    .slice(0, 3)
    .map((w) => `${short(w.wallet)} ${usd(w.netUsd)}`)
    .join(" · ");
  if (roster) lines.push(roster + (g.wallets.length > 3 ? " …" : ""));
  // 覆盖诚实声明:年龄来自缓存,查不到的钱包不参与判定 —— 声明分母是结构
  // 合格组,读者据此知道「同批 3」可能是下界。
  lines.push(
    `组内敞口过线 ${g.groupSize} 钱包 · 年龄已知 ${g.ageKnown}/${g.groupSize}(缓存覆盖,未知不计)`,
  );
  if (opts.publicUrl) {
    lines.push(
      `<a href="${escAttrUrl(opts.publicUrl, g.conditionId)}">🎯 市场深度卡</a>`,
    );
  }
  return lines.join("\n");
}

const escAttrUrl = (base: string, cid: string): string =>
  `${base.replace(/\/$/, "")}/market/${urlSeg(cid)}`;

export interface CohortCycleDeps {
  db: DB;
  /** consensus 循环已抓的深窗口成交 —— 本模块绝不自己 fetch。 */
  trades: Trade[];
  send?: (html: string) => Promise<void>;
  opts?: CohortOptions;
  nowSec?: number;
  publicUrl?: string;
}

const IN_CHUNK = 900; // SQLite 变量上限之下(seen.ts 同款)

/** wallet_age 缓存裸读:只认数值 first_ts(NULL=「已验证无活动」不认)。 */
function readCachedAges(db: DB, wallets: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < wallets.length; i += IN_CHUNK) {
    const chunk = wallets.slice(i, i + IN_CHUNK);
    const rows = db
      .prepare(
        `SELECT wallet, first_ts FROM wallet_age
          WHERE wallet IN (${chunk.map(() => "?").join(",")}) AND first_ts IS NOT NULL`,
      )
      .all(...chunk) as { wallet: string; first_ts: number }[];
    for (const r of rows) out[r.wallet] = r.first_ts;
  }
  return out;
}

/**
 * 一轮同批出生检测。claim-then-send 与 consensus 同语义(永久错误保 claim,
 * 瞬态回滚重抛);升级 = 更高 walletCount = 新 dedup key 自然再报。
 */
export async function runCohortCycle(deps: CohortCycleDeps): Promise<number> {
  const {
    db,
    trades,
    send,
    opts = DEFAULT_COHORT,
    nowSec = Math.floor(Date.now() / 1000),
    publicUrl,
  } = deps;
  if (trades.length === 0) return 0;
  const wallets = [...new Set(trades.map((t) => t.proxyWallet.toLowerCase()))];
  const ages = readCachedAges(db, wallets);
  const cohorts = detectCohorts(trades, ages, opts, nowSec);
  if (cohorts.length === 0) return 0;

  const insAlert = db.prepare(
    "INSERT OR IGNORE INTO alerts (type, dedup_key, payload, created_at) VALUES (?, ?, ?, ?)",
  );
  const delAlert = db.prepare(
    "DELETE FROM alerts WHERE type = 'cohort' AND dedup_key = ?",
  );
  let fired = 0;
  for (const g of cohorts) {
    const dk = `cohort:${g.conditionId}:${g.outcome}:${g.walletCount}`;
    // params 快照(P0.3 纪律):记分卡按规则版本分桶靠它。
    const payloadJson = JSON.stringify({ ...g, params: { ...opts } });
    const claimed =
      insAlert.run("cohort", dk, payloadJson, nowSec).changes === 1;
    if (!claimed) continue; // 已报过这个规模(本进程或对进程),升级才有新 key
    if (send) {
      try {
        await send(formatCohortAlert(g, { publicUrl }));
      } catch (e) {
        if (isPermanentSendError(e)) {
          console.error(
            `[cohort] permanent send failure for ${dk} — keeping claim:`,
            e,
          );
        } else {
          delAlert.run(dk);
          throw e;
        }
      }
    }
    fired++;
  }
  return fired;
}
