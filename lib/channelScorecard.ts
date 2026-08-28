import type { DB } from "./db";
import { parseFeeSchedule, takerFeeUsd } from "./fees";
import { settleWon } from "./outcomeStats";
import { clusterStat } from "./walkforward";

// 渠道效果记分卡(2026-08-28,设计见 docs/plans/2026-08-28-channel-scorecard-
// design.md)。回答挂了近两个月的账:哪条发现渠道进来的钱包**向前**真的赢。
//
// 向前观察不需要任何新数据:smart/consensus 告警只对在池钱包触发,每条已被
// 验证闭环打分的告警天然是「该钱包在池期间」的一次前向实验;source 是首发
// 渠道(COALESCE 保序),join 即得每渠道战绩。
//
// 三条口径红线(全部复用既有实现,零新发明):
//   ① 逐行贡献 = won − q − 每股费(edge-audit 同式);共识成员各用各的
//      avgBuyPrice —— 每人的入场赔率是每人自己的,不用组均价;
//   ② fee 不可定价(meta 缺失/费率表不可解析)整行出宇宙并计数,绝不当 0;
//   ③ 区间用 CRVE 聚类(cluster = conditionId,lib/walkforward.clusterStat)——
//      共识展开成 N 成员行后同市场同结算,正是聚类要吃掉的那层相关。
//
// 幸存者盲区:30 天老化与清退会 DELETE smart_wallets 行,离池钱包的告警
// join 不到 source —— 归入「已离池(来源失联)」独立桶如实展示。丢掉它们是
// 反向幸存者偏差(剩下的都是还活着的),桶的大小本身就是读数。

export interface ScorecardRow {
  wallet: string;
  /** 聚类键(市场)。 */
  conditionId: string;
  alertType: "smart" | "consensus";
  /** 押注方向的隐含概率:BUY 取 price,SELL 取 1−price。 */
  q: number;
  won: boolean;
  /** 每股协议费(概率点量纲);loader 已剔除不可定价行。 */
  feePerShare: number;
  /** channelOf 归一后的渠道键。 */
  channel: string;
  isMarketMaker: boolean;
  // 名人堂/反指(2026-08-28 八件套)的最佳/最惨单条展示需要 —— additive,
  // 记分卡自身的分组逻辑不读它们。
  alertId?: number;
  createdAt?: number;
  title?: string | null;
}

export interface ScorecardGroup {
  key: string;
  label: string;
  n: number;
  wallets: number;
  markets: number;
  smartN: number;
  consensusN: number;
  /** 0-1 量纲(展示层 ×100)。 */
  winRate: number;
  implied: number;
  grossEdge: number;
  feePts: number;
  netEdge: number;
  /** CRVE 聚类稳健标准误;单簇为 Infinity。 */
  seC: number;
  verdict: "pos" | "neg" | "flat" | "lowN";
}

export interface ChannelScorecard {
  /** 渠道主表,n 降序。 */
  groups: ScorecardGroup[];
  /** 全局榜 × {做市商, 人类} 横切 —— 72 机器人悬案的直接读数。 */
  mmSplit: ScorecardGroup[];
  disclosures: {
    gradedAlerts: number;
    rows: number;
    feeUnknownDropped: number;
    malformedDropped: number;
    orphanRows: number;
  };
  /** 实际发布判定的组数(主表+横切),多重比较提醒的分母。 */
  groupCount: number;
}

/** 判定最小市场数(edge-audit 的 nc<10 同一条线)。 */
const MIN_VERDICT_MARKETS = 10;
/** wallet_stats.markets_traded 的做市商分类线(与 SmartTag.isMarketMaker 同源)。 */
const MM_MARKETS_TRADED = 1_000;

const CHANNEL_LABELS: Record<string, string> = {
  leaderboard: "全局榜",
  echo: "回声(echo)",
  splitter: "拆单(splitter)",
  insider: "新钱包(insider)",
  early_winner: "早期赢家",
  manual: "手动白名单",
  unattributed: "未归因",
  departed: "已离池(来源失联)",
};

/** source 列 → 渠道键。分类榜保留细分(category:sports…)。 */
export function channelOf(source: string | null, isWhitelist: boolean): string {
  if (source == null) return isWhitelist ? "manual" : "unattributed";
  if (source === "leaderboard") return "leaderboard";
  if (source.startsWith("category:")) return source;
  if (source.startsWith("discovered:"))
    return source.slice("discovered:".length);
  return "unattributed";
}

export function channelLabel(key: string): string {
  if (key.startsWith("category:")) {
    return `分类榜·${key.slice("category:".length)}`;
  }
  return CHANNEL_LABELS[key] ?? key;
}

interface RawAlert {
  id: number;
  created_at: number;
  type: string;
  payload: string;
  won: number | null;
  resolution_price: number | null;
}

/**
 * 单个入场的行构造:方向重判(resolution_price 在场时按各自入场价重跑
 * settleWon —— 分数结算下同一市场不同进价可能不同判;push 返回 null 跳过),
 * fee 不可定价返回 "fee-unknown"。
 */
function buildRow(
  wallet: string,
  conditionId: string,
  alertType: "smart" | "consensus",
  side: "BUY" | "SELL",
  price: number,
  shares: number,
  storedWon: number | null,
  resolutionPrice: number | null,
  meta: {
    feesEnabled: boolean;
    schedule: ReturnType<typeof parseFeeSchedule>;
  } | null,
  channel: string,
  isMarketMaker: boolean,
  extra?: { alertId: number; createdAt: number; title: string | null },
): ScorecardRow | "push" | "fee-unknown" | "malformed" {
  if (!(price > 0 && price < 1) || !(shares > 0)) return "malformed";
  let won: boolean | null;
  if (resolutionPrice != null) {
    won = settleWon(side, price, resolutionPrice);
  } else {
    won = storedWon === 1 ? true : storedWon === 0 ? false : null;
  }
  if (won == null) return "push";
  // meta 整行缺失 = 费用开关未知 —— 比 edge-audit 更严:那边把缺 meta 当
  // feesEnabled=false(猜 0),这里按 walk-forward §0.2 的纪律整行剔除。
  if (meta == null) return "fee-unknown";
  const feeUsd = takerFeeUsd({
    sizeUsd: shares * price,
    price,
    feesEnabled: meta.feesEnabled,
    schedule: meta.schedule,
  });
  if (feeUsd == null) return "fee-unknown";
  return {
    wallet,
    conditionId,
    alertType,
    q: side === "SELL" ? 1 - price : price,
    won,
    feePerShare: feeUsd / shares,
    channel,
    isMarketMaker,
    ...(extra ?? {}),
  };
}

export function loadScorecardRows(db: DB): {
  rows: ScorecardRow[];
  gradedAlerts: number;
  feeUnknownDropped: number;
  malformedDropped: number;
} {
  const alerts = db
    .prepare(
      `SELECT a.id, a.created_at, a.type, a.payload, o.won, o.resolution_price
         FROM alerts a
         JOIN alert_outcomes o ON o.alert_id = a.id
        WHERE a.type IN ('smart', 'consensus') AND o.resolved = 1`,
    )
    .all() as RawAlert[];

  const pool = new Map<string, { channel: string }>();
  for (const w of db
    .prepare("SELECT address, source, is_whitelist FROM smart_wallets")
    .all() as {
    address: string;
    source: string | null;
    is_whitelist: number;
  }[]) {
    pool.set(w.address.toLowerCase(), {
      channel: channelOf(w.source, w.is_whitelist === 1),
    });
  }
  const mm = new Set<string>();
  for (const w of db
    .prepare("SELECT wallet FROM wallet_stats WHERE markets_traded >= ?")
    .all(MM_MARKETS_TRADED) as { wallet: string }[]) {
    mm.add(w.wallet.toLowerCase());
  }
  const metaByCid = new Map<
    string,
    { feesEnabled: boolean; schedule: ReturnType<typeof parseFeeSchedule> }
  >();
  for (const m of db
    .prepare("SELECT condition_id, meta_json FROM market_meta")
    .all() as { condition_id: string; meta_json: string | null }[]) {
    try {
      const parsed = JSON.parse(m.meta_json ?? "null") as {
        feesEnabled?: unknown;
        feeSchedule?: unknown;
      } | null;
      if (!parsed) continue;
      metaByCid.set(m.condition_id, {
        feesEnabled: parsed.feesEnabled === true,
        schedule: parseFeeSchedule(parsed.feeSchedule),
      });
    } catch {
      // 坏 meta_json:当缺失处理(fee-unknown 剔除),不猜。
    }
  }

  const rows: ScorecardRow[] = [];
  let gradedAlerts = 0;
  let feeUnknownDropped = 0;
  let malformedDropped = 0;
  const push = (r: ScorecardRow | "push" | "fee-unknown" | "malformed") => {
    if (r === "fee-unknown") feeUnknownDropped++;
    else if (r === "malformed") malformedDropped++;
    else if (r !== "push") rows.push(r);
  };
  const channelFor = (wallet: string) =>
    pool.get(wallet)?.channel ?? "departed";

  for (const a of alerts) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(a.payload) as Record<string, unknown>;
    } catch {
      malformedDropped++;
      continue;
    }
    const cid = typeof p.conditionId === "string" ? p.conditionId : null;
    if (!cid) {
      malformedDropped++;
      continue;
    }
    const meta = metaByCid.get(cid) ?? null;
    if (a.type === "smart") {
      const wallet =
        typeof p.proxyWallet === "string" ? p.proxyWallet.toLowerCase() : null;
      const price = typeof p.price === "number" ? p.price : NaN;
      const size = typeof p.size === "number" ? p.size : NaN;
      if (!wallet) {
        malformedDropped++;
        continue;
      }
      gradedAlerts++;
      push(
        buildRow(
          wallet,
          cid,
          "smart",
          p.side === "SELL" ? "SELL" : "BUY",
          price,
          size,
          a.won,
          a.resolution_price,
          meta,
          channelFor(wallet),
          mm.has(wallet),
          {
            alertId: a.id,
            createdAt: a.created_at,
            title: typeof p.title === "string" ? p.title : null,
          },
        ),
      );
    } else {
      const members = Array.isArray(p.wallets) ? p.wallets : [];
      if (members.length === 0) {
        malformedDropped++;
        continue;
      }
      gradedAlerts++;
      for (const m of members as Record<string, unknown>[]) {
        const wallet =
          typeof m.wallet === "string" ? m.wallet.toLowerCase() : null;
        const avg = typeof m.avgBuyPrice === "number" ? m.avgBuyPrice : NaN;
        const netUsd = typeof m.netUsd === "number" ? m.netUsd : NaN;
        if (!wallet) {
          malformedDropped++;
          continue;
        }
        push(
          buildRow(
            wallet,
            cid,
            "consensus",
            "BUY", // 共识按构造只聚合净买方
            avg,
            netUsd / avg,
            a.won,
            a.resolution_price,
            meta,
            channelFor(wallet),
            mm.has(wallet),
            {
              alertId: a.id,
              createdAt: a.created_at,
              title: typeof p.title === "string" ? p.title : null,
            },
          ),
        );
      }
    }
  }
  return { rows, gradedAlerts, feeUnknownDropped, malformedDropped };
}

export function groupOf(
  key: string,
  label: string,
  rows: ScorecardRow[],
): ScorecardGroup {
  const contribs = rows.map((r) => ({
    contrib: (r.won ? 1 : 0) - r.q - r.feePerShare,
    cluster: r.conditionId,
  }));
  const s = clusterStat(contribs)!;
  const winRate = rows.filter((r) => r.won).length / rows.length;
  const implied = rows.reduce((a, r) => a + r.q, 0) / rows.length;
  const feePts = rows.reduce((a, r) => a + r.feePerShare, 0) / rows.length;
  const verdict: ScorecardGroup["verdict"] =
    s.nc < MIN_VERDICT_MARKETS || !Number.isFinite(s.seC)
      ? "lowN"
      : s.point - 1.96 * s.seC > 0
        ? "pos"
        : s.point + 1.96 * s.seC < 0
          ? "neg"
          : "flat";
  return {
    key,
    label,
    n: rows.length,
    wallets: new Set(rows.map((r) => r.wallet)).size,
    markets: s.nc,
    smartN: rows.filter((r) => r.alertType === "smart").length,
    consensusN: rows.filter((r) => r.alertType === "consensus").length,
    winRate,
    implied,
    grossEdge: winRate - implied,
    feePts,
    netEdge: s.point,
    seC: s.seC,
    verdict,
  };
}

export function computeChannelScorecard(
  rows: ScorecardRow[],
): ChannelScorecard {
  const byChannel = new Map<string, ScorecardRow[]>();
  for (const r of rows) {
    const g = byChannel.get(r.channel);
    if (g) g.push(r);
    else byChannel.set(r.channel, [r]);
  }
  const groups = [...byChannel.entries()]
    .map(([key, rs]) => groupOf(key, channelLabel(key), rs))
    .sort((a, b) => b.n - a.n);

  const lb = rows.filter((r) => r.channel === "leaderboard");
  const mmSplit: ScorecardGroup[] = [];
  const bots = lb.filter((r) => r.isMarketMaker);
  const humans = lb.filter((r) => !r.isMarketMaker);
  if (bots.length > 0) {
    mmSplit.push(groupOf("leaderboard:mm", "全局榜·做市商", bots));
  }
  if (humans.length > 0) {
    mmSplit.push(groupOf("leaderboard:human", "全局榜·非做市商", humans));
  }

  return {
    groups,
    mmSplit,
    disclosures: {
      gradedAlerts: 0, // loader 填;compute 只见行(两函数拼装见 buildScorecard)
      rows: rows.length,
      feeUnknownDropped: 0,
      malformedDropped: 0,
      orphanRows: rows.filter((r) => r.channel === "departed").length,
    },
    groupCount: groups.length + mmSplit.length,
  };
}

/** 一步到位:读库 → 展开 → 聚合,披露计数拼装完整。/api/discovery 用它。 */
export function buildChannelScorecard(db: DB): ChannelScorecard {
  const { rows, gradedAlerts, feeUnknownDropped, malformedDropped } =
    loadScorecardRows(db);
  const sc = computeChannelScorecard(rows);
  return {
    ...sc,
    disclosures: {
      ...sc.disclosures,
      gradedAlerts,
      feeUnknownDropped,
      malformedDropped,
    },
  };
}
