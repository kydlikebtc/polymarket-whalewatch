import type { DB } from "./db";

// 反事实退出分析(2026-08-16,设计见 docs/plans/2026-08-16-exit-counterfactual-
// design.md)。回答「如果带止盈/止损/限时退出会怎样」:
//   - 数据 = 已结算仓的价格路径(prices-history 不可变,每仓终生只取一次);
//   - 计算 = 固定九规则网格在回填时一次算完,只存结论(不存原始路径);
//   - 负载 = 骑 outcome backfill 的 10 分钟载波、每轮封顶 —— 存量 1-2 天排空,
//     此后稳态增量 ≈ 每天新结算的几仓,常驻 ≈ 0。
// 这是活体退出档(同日实现后否决,见设计 §0)的替代:先回答「有没有用」,
// 而不是先造机制去等答案。
//
// 口径红线:
//   - 保守成交:按**首个越线观测价**成交(蜡烛间隙里真实止损会成交在线上或
//     更好,不高估退出质量);
//   - ~10min 蜡烛盲区:快盘中 SL 触发被系统性低估,读数是下界;
//   - 纸面对纸面:实际记录与假想退出同为免费观测价口径,对称可比;推及实盘
//     须另计退出侧盘口与费。
//   - 九规则互相独立,不做 SL+TP 组合(首版回答的是单规则有没有用)。

export interface ExitRule {
  id: string;
  kind: "sl" | "tp" | "time";
  /** sl/tp:线距 entry 的 ¢;time:小时。 */
  value: number;
  label: string;
}

export const EXIT_RULES: readonly ExitRule[] = [
  { id: "sl10", kind: "sl", value: 10, label: "止损10¢" },
  { id: "sl20", kind: "sl", value: 20, label: "止损20¢" },
  { id: "sl30", kind: "sl", value: 30, label: "止损30¢" },
  { id: "tp10", kind: "tp", value: 10, label: "止盈10¢" },
  { id: "tp20", kind: "tp", value: 20, label: "止盈20¢" },
  { id: "tp30", kind: "tp", value: 30, label: "止盈30¢" },
  { id: "t24", kind: "time", value: 24, label: "限时24h" },
  { id: "t72", kind: "time", value: 72, label: "限时72h" },
  { id: "t168", kind: "time", value: 168, label: "限时168h" },
];

export interface PricePoint {
  t: number;
  p: number;
}

export interface SimPositionInput {
  entryPrice: number;
  entryTs: number;
  /** 结算时刻(follow_positions.exit_ts)。 */
  exitTs: number;
  /** 实际持有到结算的已实现盈亏 —— 未触发规则的基准锚。 */
  realizedPnl: number;
  sizeUsd: number;
}

export interface RuleSim {
  exited: 0 | 1;
  exitOffsetSec: number | null;
  exitPrice: number | null;
  pnl: number;
}

export interface PathStats {
  points: number;
  maeCents: number | null;
  mfeCents: number | null;
}

/**
 * 单仓 × 九规则的路径模拟(纯函数)。路径点先做卫生:剔除区间外
 * ([entryTs, exitTs] 之外)与非法值,按 t 升序 —— 上游蜡烛顺序不可信。
 */
export function simulatePosition(
  pos: SimPositionInput,
  rawPath: PricePoint[],
): { sims: Record<string, RuleSim>; stats: PathStats } {
  const path = rawPath
    .filter(
      (pt) =>
        typeof pt.t === "number" &&
        typeof pt.p === "number" &&
        Number.isFinite(pt.p) &&
        pt.t >= pos.entryTs &&
        pt.t <= pos.exitTs,
    )
    .sort((a, b) => a.t - b.t);

  const shares = pos.sizeUsd / pos.entryPrice;
  const hold: RuleSim = {
    exited: 0,
    exitOffsetSec: null,
    exitPrice: null,
    pnl: pos.realizedPnl,
  };
  const sims: Record<string, RuleSim> = {};
  for (const rule of EXIT_RULES) {
    let hit: PricePoint | null = null;
    if (rule.kind === "sl") {
      const line = pos.entryPrice - rule.value / 100;
      hit = path.find((pt) => pt.p <= line) ?? null;
    } else if (rule.kind === "tp") {
      const line = pos.entryPrice + rule.value / 100;
      hit = path.find((pt) => pt.p >= line) ?? null;
    } else {
      const deadline = pos.entryTs + rule.value * 3600;
      // 先结算的仓,限时规则没有触发机会(deadline ≥ exitTs 即不成立);
      // 路径太稀(deadline 后无观测点)同样不触发 —— points 披露兜底。
      hit =
        deadline < pos.exitTs
          ? (path.find((pt) => pt.t >= deadline) ?? null)
          : null;
    }
    sims[rule.id] = hit
      ? {
          exited: 1,
          exitOffsetSec: hit.t - pos.entryTs,
          exitPrice: hit.p,
          pnl: shares * (hit.p - pos.entryPrice),
        }
      : { ...hold };
  }

  let mae: number | null = null;
  let mfe: number | null = null;
  for (const pt of path) {
    const d = (pt.p - pos.entryPrice) * 100;
    if (mae == null || d < mae) mae = d;
    if (mfe == null || d > mfe) mfe = d;
  }
  return {
    sims,
    stats: {
      points: path.length,
      // MAE 只记不利侧、MFE 只记有利侧(路径单边时另一侧为 0 而非 null ——
      // 「从未跌破进价」的诚实表达是 0¢ 不利偏移)。
      maeCents: mae == null ? null : Math.min(0, mae),
      mfeCents: mfe == null ? null : Math.max(0, mfe),
    },
  };
}

export interface BackfillDeps {
  fetchSeries: (
    tokenId: string,
    startTs: number,
    endTs: number,
  ) => Promise<PricePoint[]>;
  /** 每轮上游请求封顶(= 仓数,一仓一请求)。 */
  batch?: number;
  nowSec?: number;
}

const DEFAULT_BATCH = 5;

/**
 * 回填一批已结算仓的退出模拟。幂等:path_stats 行存在即出队(含 points=0 的
 * 死 token 墓碑);请求抛错留队下轮重试。每仓一个事务(sims 九行 + stats 行
 * 原子落库,绝不出现"有 sims 无 stats"的半态)。
 */
export async function runExitSimBackfill(
  db: DB,
  deps: BackfillDeps,
): Promise<{ processed: number; failed: number; pending: number }> {
  const batch = deps.batch ?? DEFAULT_BATCH;
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000);
  const due = db
    .prepare(
      `SELECT p.id, p.asset, p.entry_ts, p.exit_ts, p.entry_price, p.size_usd, p.realized_pnl
       FROM follow_positions p
       WHERE p.status = 'settled' AND p.realized_pnl IS NOT NULL
         AND p.exit_ts IS NOT NULL AND p.entry_ts IS NOT NULL
         AND p.exit_ts > p.entry_ts AND p.asset != ''
         AND NOT EXISTS (SELECT 1 FROM position_path_stats s WHERE s.position_id = p.id)
       ORDER BY p.exit_ts DESC LIMIT ?`,
    )
    .all(batch) as {
    id: number;
    asset: string;
    entry_ts: number;
    exit_ts: number;
    entry_price: number;
    size_usd: number;
    realized_pnl: number;
  }[];
  const pendingTotal = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM follow_positions p
         WHERE p.status = 'settled' AND p.realized_pnl IS NOT NULL
           AND p.exit_ts IS NOT NULL AND p.entry_ts IS NOT NULL
           AND p.exit_ts > p.entry_ts AND p.asset != ''
           AND NOT EXISTS (SELECT 1 FROM position_path_stats s WHERE s.position_id = p.id)`,
      )
      .get() as { n: number }
  ).n;

  const insStats = db.prepare(
    "INSERT OR REPLACE INTO position_path_stats (position_id, points, mae_cents, mfe_cents, fetched_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insSim = db.prepare(
    "INSERT OR REPLACE INTO position_exit_sims (position_id, rule, exited, exit_offset_sec, exit_price, pnl) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const writeAll = db.transaction(
    (
      positionId: number,
      stats: PathStats,
      sims: Record<string, RuleSim> | null,
    ) => {
      insStats.run(
        positionId,
        stats.points,
        stats.maeCents,
        stats.mfeCents,
        nowSec,
      );
      if (sims) {
        for (const rule of EXIT_RULES) {
          const s = sims[rule.id];
          insSim.run(
            positionId,
            rule.id,
            s.exited,
            s.exitOffsetSec,
            s.exitPrice,
            s.pnl,
          );
        }
      }
    },
  );

  let processed = 0;
  let failed = 0;
  for (const row of due) {
    let path: PricePoint[];
    try {
      path = await deps.fetchSeries(row.asset, row.entry_ts, row.exit_ts);
    } catch (e) {
      failed++;
      console.warn(
        `[exit-sim] 路径回填失败(留队下轮重试) position ${row.id}:`,
        e,
      );
      continue;
    }
    if (!Array.isArray(path) || path.length === 0) {
      // 死 token 墓碑:points=0 永久出队,不写 sims —— 覆盖率统计会诚实
      // 把它算进「不可回填」。
      writeAll(row.id, { points: 0, maeCents: null, mfeCents: null }, null);
      processed++;
      continue;
    }
    const { sims, stats } = simulatePosition(
      {
        entryPrice: row.entry_price,
        entryTs: row.entry_ts,
        exitTs: row.exit_ts,
        realizedPnl: row.realized_pnl,
        sizeUsd: row.size_usd,
      },
      path,
    );
    writeAll(row.id, stats, sims);
    processed++;
  }
  return { processed, failed, pending: pendingTotal - processed };
}

// ---------------------------------------------------------------------------
// 聚合(服务端调用的纯函数 —— 输入全是普通数据,不碰 db,TDD 直测)。

export interface ExitRuleSummary {
  rule: string;
  label: string;
  /** 触发仓数(covered 内)。 */
  triggered: number;
  /** covered 内的实际合计(基准)与该规则下的假想合计。 */
  actualTotal: number;
  simTotal: number;
  /** simTotal − actualTotal:>0 = 该规则本会多赚/少亏。 */
  delta: number;
  /** 触发仓上的平均 Δ:回答「触发的那些仓里它是救还是害」。 */
  avgDeltaTriggered: number | null;
}

export interface ExitCounterfactualSummary {
  /** 已回填(points>0 且有 sims)的 settled 仓数。 */
  covered: number;
  settledTotal: number;
  /** 路径点数中位数 —— 保真度自证(约 10min 一点)。 */
  medianPoints: number | null;
  rules: ExitRuleSummary[];
}

export function analyzeExitCounterfactual(
  settledRows: { id: number; realizedPnl: number }[],
  simsById: Map<number, Record<string, { exited: number; pnl: number }>>,
  statsById: Map<number, { points: number }>,
): ExitCounterfactualSummary | null {
  const covered = settledRows.filter((r) => simsById.has(r.id));
  if (covered.length === 0) return null;
  const points = covered
    .map((r) => statsById.get(r.id)?.points)
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);
  const medianPoints =
    points.length === 0
      ? null
      : points.length % 2 === 1
        ? points[(points.length - 1) / 2]
        : (points[points.length / 2 - 1] + points[points.length / 2]) / 2;

  const actualTotal = covered.reduce((s, r) => s + r.realizedPnl, 0);
  const rules: ExitRuleSummary[] = EXIT_RULES.map((rule) => {
    let simTotal = 0;
    let triggered = 0;
    let deltaTriggered = 0;
    for (const row of covered) {
      const sim = simsById.get(row.id)![rule.id];
      // 缺该规则行(不应发生,防御)按未触发回退实际值。
      const pnl = sim ? sim.pnl : row.realizedPnl;
      simTotal += pnl;
      if (sim && sim.exited === 1) {
        triggered++;
        deltaTriggered += pnl - row.realizedPnl;
      }
    }
    return {
      rule: rule.id,
      label: rule.label,
      triggered,
      actualTotal,
      simTotal,
      delta: simTotal - actualTotal,
      avgDeltaTriggered: triggered > 0 ? deltaTriggered / triggered : null,
    };
  });
  return {
    covered: covered.length,
    settledTotal: settledRows.length,
    medianPoints,
    rules,
  };
}

/**
 * 给策略视图批量附加反事实摘要(/api/follow 出口)。一次 bulk 查询覆盖全部
 * 策略的 settled 仓,零上游调用;返回新数组不改入参(仓库不可变纪律)。
 */
export function withExitCounterfactual<
  T extends { settled: { id?: number; realized_pnl: number | null }[] },
>(db: DB, views: T[]): (T & { exitCounterfactual: ExitCounterfactualSummary | null })[] {
  const allIds = views.flatMap((v) =>
    v.settled
      .map((row) => row.id)
      .filter((id): id is number => typeof id === "number"),
  );
  const simsById = new Map<
    number,
    Record<string, { exited: number; pnl: number }>
  >();
  const statsById = new Map<number, { points: number }>();
  if (allIds.length > 0) {
    const placeholders = allIds.map(() => "?").join(",");
    const simRows = db
      .prepare(
        `SELECT position_id, rule, exited, pnl FROM position_exit_sims WHERE position_id IN (${placeholders})`,
      )
      .all(...allIds) as {
      position_id: number;
      rule: string;
      exited: number;
      pnl: number;
    }[];
    for (const r of simRows) {
      const bucket = simsById.get(r.position_id) ?? {};
      bucket[r.rule] = { exited: r.exited, pnl: r.pnl };
      simsById.set(r.position_id, bucket);
    }
    const statRows = db
      .prepare(
        `SELECT position_id, points FROM position_path_stats WHERE position_id IN (${placeholders}) AND points > 0`,
      )
      .all(...allIds) as { position_id: number; points: number }[];
    for (const r of statRows) {
      statsById.set(r.position_id, { points: r.points });
    }
  }
  return views.map((v) => ({
    ...v,
    exitCounterfactual: analyzeExitCounterfactual(
      v.settled
        .filter(
          (row): row is typeof row & { id: number; realized_pnl: number } =>
            typeof row.id === "number" &&
            typeof row.realized_pnl === "number",
        )
        .map((row) => ({ id: row.id, realizedPnl: row.realized_pnl })),
      simsById,
      statsById,
    ),
  }));
}
