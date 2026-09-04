import type { DB } from "./db";
import { getWalletStats, type WalletStats } from "./walletStats";
import { computeScore } from "./smartWallets";
import {
  ADMIT_MIN_WIN_RATE,
  ADMIT_MIN_SETTLED,
  ADMIT_MIN_ROI,
  ADMIT_MIN_SETTLED_ROI,
  evaluateAdmission,
  type AdmissionVerdict,
} from "./admissionGate";

// ---------------------------------------------------------------------------
// 聪明钱自测(设计文档 2026-08-28-smart-money-selftest-design.md):访客粘贴
// 地址领判决书。判决口径的红线是**严格复用**——权威判定原样透传
// evaluateAdmission(准入闸唯一实现),本模块只做三件闸门不做的事:
//   1. 在 hold 之上分「为什么判不了」(truncated / 样本不足 / 净盈亏不可得),
//      因为「你没过」与「我判不了」混为一谈是本站最不能犯的那类错;
//   2. 池内三轴 midrank 分位(样本=当前 smart_wallets,本地读,零上游);
//   3. admit 时标出走的是哪条路(admittedPath)——判决卡要在两条路上出
//      「✅ 走这条过的」/「未走这条」徽章,而闸门只回一个 admit。这是**归因**
//      不是第二次判决:只在闸门已经说 admit 时才问,阈值全部引用同一份常量。
// 复发广度(30 天 ≥3 市场)刻意不在此处:它是发现渠道的候选资格闸,不是
// 战绩质量闸——池内成员续期同样只考战绩(见 lib/admission.ts)。
// ---------------------------------------------------------------------------

export type SelfTestVerdictKind =
  "pass" | "fail" | "bot" | "unjudged" | "no_data";

export type UnjudgedReason = "truncated" | "small_sample" | "pnl_unavailable";

/** 准入两条路的归属:1=胜率路、2=ROI 路、both=两条都到线。 */
export type AdmittedPath = 1 | 2 | "both";

export interface PoolMemberRow {
  address: string; // lowercased
  score: number | null;
  winRate: number | null;
  netPnl: number | null;
}

export interface AxisPercentile {
  /** midrank 分位(0-100):严格低于者 + 同值一半,除以该轴样本数。 */
  pct: number;
  /** 该轴非 null 的池成员数 —— 分位声明的样本口径。 */
  sampleN: number;
}

export interface SelfTestVerdict {
  verdict: SelfTestVerdictKind;
  unjudgedReason: UnjudgedReason | null;
  /** evaluateAdmission 原始结果 —— 权威口径,展示层不得另判。 */
  gate: AdmissionVerdict;
  /**
   * gate="admit" 时走的是哪条路 —— 同样是权威口径,展示层照标不复算。
   * 非 admit 为 null;admit 却两条都不匹配(闸门口径漂移)也为 null:
   * 宁可不标归属,也不编一条路出来。
   */
  admittedPath: AdmittedPath | null;
  stats: WalletStats | null;
  /**
   * admission 同款构造的 0-100 评分(vol=0,效率轴走 settled roi)。
   * 做市商为 null:其胜率/ROI 无意义,评分失去与池的可比性。
   */
  score: number | null;
  percentiles: {
    winRate: AxisPercentile | null;
    netPnl: AxisPercentile | null;
    score: AxisPercentile | null;
  };
  poolSize: number;
  inPool: boolean;
  /** 展示口径快照 —— 引用 admissionGate 常量,永不另抄阈值。 */
  criteria: {
    minWinRate: number;
    minSettled: number;
    minRoi: number;
    minSettledRoi: number;
  };
}

/** midrank 分位:(严格低于 + 同值×0.5) / n × 100。空样本由调用方挡住。 */
export function midrankPercentile(value: number, sample: number[]): number {
  let below = 0;
  let ties = 0;
  for (const s of sample) {
    if (s < value) below++;
    else if (s === value) ties++;
  }
  return ((below + ties * 0.5) / sample.length) * 100;
}

function axis(
  value: number | null,
  sample: (number | null)[],
): AxisPercentile | null {
  if (value == null) return null;
  const clean = sample.filter((s): s is number => s != null);
  if (clean.length === 0) return null;
  return { pct: midrankPercentile(value, clean), sampleN: clean.length };
}

/**
 * 「过了闸,过的是哪条路」—— 判定权仍在 evaluateAdmission:调用方只在闸门
 * 已经回 admit 时问这个问题,这里做的是归因,不是重判一次。两条路的条件与
 * 阈值全部引用 admissionGate 的同一份导出常量(与 evaluateAdmission 里的
 * 两个分支逐条对应),永不另抄数字;闸门口径改到两条都不匹配时返回 null。
 */
function admittedVia(stats: WalletStats): AdmittedPath | null {
  const profitable = stats.netPnl != null && stats.netPnl > 0;
  const viaWinRate =
    profitable &&
    stats.winRate != null &&
    stats.settledCount >= ADMIT_MIN_SETTLED &&
    stats.winRate >= ADMIT_MIN_WIN_RATE;
  const viaRoi =
    profitable &&
    stats.roi != null &&
    stats.roi >= ADMIT_MIN_ROI &&
    stats.settledCount >= ADMIT_MIN_SETTLED_ROI;
  if (viaWinRate && viaRoi) return "both";
  if (viaWinRate) return 1;
  if (viaRoi) return 2;
  return null;
}

/**
 * 纯函数:stats(可为 null=上游取数失败)+ 池成员 → 判决书。
 * 判决分层见文件头注;分位样本=传入的池(调用方声明口径)。
 */
export function buildSelfTestVerdict(
  address: string,
  stats: WalletStats | null,
  pool: PoolMemberRow[],
): SelfTestVerdict {
  const gate = evaluateAdmission(stats);
  // 归属紧挨判定产出:同一份 stats、同一组常量,中间不插别的逻辑。
  const admittedPath = stats && gate === "admit" ? admittedVia(stats) : null;
  const addr = address.toLowerCase();

  let verdict: SelfTestVerdictKind;
  let unjudgedReason: UnjudgedReason | null = null;
  if (!stats) {
    verdict = "no_data";
  } else if (gate === "reject_bot") {
    verdict = "bot";
  } else if (gate === "admit") {
    verdict = "pass";
  } else if (stats.truncated) {
    // 截断=按盈亏降序的赢家切片,胜率/ROI 已被 walletStats 判为 null;
    // 判决同样降级 —— 绝不显示错数,也绝不把「判不了」说成「没过」。
    verdict = "unjudged";
    unjudgedReason = "truncated";
  } else if (stats.settledCount < ADMIT_MIN_SETTLED_ROI) {
    // 两条路的最低样本线(ROI 路的 5)都没到 —— 哪条路都无从谈起。
    verdict = "unjudged";
    unjudgedReason = "small_sample";
  } else if (stats.netPnl == null) {
    // 闸门对未知净盈亏的语义是「拒绝凭信仰判定」(admissionGate P0.4),
    // 自测沿用:这不是 fail,是判不了。
    verdict = "unjudged";
    unjudgedReason = "pnl_unavailable";
  } else {
    verdict = "fail";
  }

  // 评分:与 lib/admission.ts 给发现钱包评分的同一构造(无榜单 vol,
  // 效率轴走 settled roi,pnl/vol 回退项贡献 0 —— 诚实偏保守)。
  const score =
    stats && !stats.isMarketMaker
      ? computeScore({
          pnl: stats.netPnl ?? 0,
          vol: 0,
          winRate: stats.winRate,
          roi: stats.roi,
          truncated: stats.truncated,
        })
      : null;

  return {
    verdict,
    unjudgedReason,
    gate,
    admittedPath,
    stats,
    score,
    percentiles: {
      winRate: axis(
        stats?.winRate ?? null,
        pool.map((m) => m.winRate),
      ),
      netPnl: axis(
        stats?.netPnl ?? null,
        pool.map((m) => m.netPnl),
      ),
      score: axis(
        score,
        pool.map((m) => m.score),
      ),
    },
    poolSize: pool.length,
    inPool: pool.some((m) => m.address === addr),
    criteria: {
      minWinRate: ADMIT_MIN_WIN_RATE,
      minSettled: ADMIT_MIN_SETTLED,
      minRoi: ADMIT_MIN_ROI,
      minSettledRoi: ADMIT_MIN_SETTLED_ROI,
    },
  };
}

/** 分位样本:当前池全体成员。本地表一趟读,零上游。 */
export function readPool(db: DB): PoolMemberRow[] {
  const rows = db
    .prepare("SELECT address, score, win_rate, realized_pnl FROM smart_wallets")
    .all() as {
    address: string;
    score: number | null;
    win_rate: number | null;
    realized_pnl: number | null;
  }[];
  return rows.map((r) => ({
    address: r.address.toLowerCase(),
    score: r.score,
    winRate: r.win_rate,
    // 物理列名沿革:realized_pnl 列存的是 netPnl(见 lib/walletStats)。
    netPnl: r.realized_pnl,
  }));
}

/**
 * 只读缓存、绝不回源的战绩读取 —— 降级判决与嵌入卡共用(嵌入卡是病毒
 * 分发面,每次展示都是请求,零上游是红线)。实现走 localOnlyDossier 同款
 * 抛错 fetcher + 超长 TTL:命中(不限龄)即返回,miss 立刻拒绝 → null 且
 * 不污染缓存。fetchedAt 单独读出,供「数据截至」诚实标注。
 */
export async function readLocalStats(
  db: DB,
  address: string,
): Promise<{ stats: WalletStats | null; fetchedAt: number | null }> {
  const addr = address.toLowerCase();
  const localOnly = () =>
    Promise.reject(new Error("self-test local read never hits upstream"));
  const stats = await getWalletStats(db, [addr], {
    ttlSec: Number.MAX_SAFE_INTEGER,
    fetcher: localOnly,
  });
  return {
    stats: stats[addr] ?? null,
    fetchedAt: readStatsFetchedAt(db, addr),
  };
}

/** wallet_stats 行的拉取时间(秒)—— 实时路径也要标「数据截至」。 */
export function readStatsFetchedAt(db: DB, address: string): number | null {
  const row = db
    .prepare("SELECT fetched_at FROM wallet_stats WHERE wallet = ?")
    .get(address.toLowerCase()) as { fetched_at: number } | undefined;
  return row?.fetched_at ?? null;
}

/** /api/selftest 响应契约(路由是薄接线,契约随判决层住在 lib)。 */
export interface SelfTestResponse extends SelfTestVerdict {
  address: string;
  /** 判决计算时间(秒)。缓存命中时返回原判决的计算时间,不冒充新算。 */
  computedAt: number;
  /** 战绩数据的拉取时间(秒)—— 即使实时路径也可能来自 24h SQLite 缓存。 */
  statsFetchedAt: number | null;
  degraded?: "rate_limited" | "upstream_error";
  retryAfterSec?: number;
}
