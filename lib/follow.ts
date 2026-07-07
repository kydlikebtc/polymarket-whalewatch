import type { ConsensusGroup, ConsensusOptions } from "./consensus";
import { detectConsensus } from "./consensus";
import type { DB } from "./db";
import type { MarketMeta } from "./gamma";
import type { SmartTag } from "./smartWallets";
import type { Trade } from "./types";

// 纸面跟单的单仓 / 策略 / 价格纯函数。全部无副作用,便于 TDD 与复用。
// 约定:所有单仓函数一律「价在前、size 在后」,避免同为 number 的实参误序时
// 编译不报错(footgun)。

/**
 * 以 entryPrice 单价、sizeUsd 美元买入所得份额数。
 * entryPrice<=0(缺价/异常)时返回 0,防止除零产生 Infinity/NaN 污染下游求和。
 */
export function positionShares(entryPrice: number, sizeUsd: number): number {
  return entryPrice > 0 ? sizeUsd / entryPrice : 0;
}

/**
 * 单仓已实现盈亏 = 份额 * (退出价 - 入场价)。
 * 结算 1(赢)时 = +size 的收益方向,结算 0(输)时 = -size(整仓亏光)。
 */
export function positionRealizedPnl(
  entryPrice: number,
  exitPrice: number,
  sizeUsd: number,
): number {
  const shares = positionShares(entryPrice, sizeUsd);
  return shares * (exitPrice - entryPrice);
}

/**
 * 跟单滑点(美元)= 份额 * (自己入场价 - 聪明钱均价)。
 * 我们跟进时比聪明钱买得更贵(entryPrice>smartAvgPrice)为正 —— 即多付出的成本。
 */
export function positionSlippage(
  entryPrice: number,
  smartAvgPrice: number,
  sizeUsd: number,
): number {
  const shares = positionShares(entryPrice, sizeUsd);
  return shares * (entryPrice - smartAvgPrice);
}

/**
 * 策略阈值二次过滤:detectConsensus 在最松阈值下产出 groups,这里按某具体策略的
 * minPerWalletUsd / minWallets 复筛 —— 每组内净买入 >= floor 的钱包数达到 minWallets
 * 才保留。纯函数,不修改入参。
 * 复用 ConsensusOptions(结构同构;策略对象可携带 sizeUsd/exitRule 等额外字段,
 * 结构兼容,此处只读 minWallets/minPerWalletUsd,多余字段无碍)。
 */
export function qualifyingGroups(
  groups: ConsensusGroup[],
  strat: ConsensusOptions,
): ConsensusGroup[] {
  return groups.filter(
    (g) =>
      g.wallets.filter((w) => w.netUsd >= strat.minPerWalletUsd).length >=
      strat.minWallets,
  );
}

/**
 * 窗口内每个 asset 的最近一笔成交价 —— 入场价的回退来源(当无更精确报价时)。
 * 按 timestamp 严格取最大者对应的 price —— 生产窗口成交是 newest-first 排序
 * (lib/polymarket.ts 对 trades 做 b.timestamp - a.timestamp),故不能退化成
 * 「取数组末元素/last-wins」(那会返回最旧价)。严格 `>` ⇒ 时间戳相等时先见者胜
 * (与 newest-first 顺序一致,保留最先出现即最新的那笔)。
 */
export function latestPriceByAsset(trades: Trade[]): Map<string, number> {
  const latestTs = new Map<string, number>();
  const price = new Map<string, number>();
  for (const t of trades) {
    const prev = latestTs.get(t.asset);
    if (prev == null || t.timestamp > prev) {
      latestTs.set(t.asset, t.timestamp);
      price.set(t.asset, t.price);
    }
  }
  return price;
}

// ---------------------------------------------------------------------------
// Task 5: runFollowCycle —— 纸面「共识跟单」一轮。开仓 + 结算,注入式依赖(同
// runConsensusCycle 的写法),便于测试与复用。副作用仅落在 follow_positions 表。
// ---------------------------------------------------------------------------

// 一条启用中的跟单策略(params_json 解析结果 + 行 id)。exitRule 目前只支持
// "settlement"(市场结算即平仓),保留字段以便后续扩展。
interface FollowStrategy {
  id: number;
  minWallets: number;
  minPerWalletUsd: number;
  sizeUsd: number;
  exitRule: string;
}

export interface FollowCycleDeps {
  db: DB;
  fetchWindow: () => Promise<{ trades: Trade[] }>;
  getSmart: () => Map<string, SmartTag>;
  // 现价来源:开仓时传入 now(第二个参数保留时间语义,便于将来做历史回填)。
  fetchPrice: (asset: string, tsSec: number) => Promise<number | null>;
  getMeta: (cids: string[]) => Promise<Record<string, MarketMeta>>;
  nowSec?: number;
}

// params_json 是 seed/后台写入的可信来源,但 JSON.parse 后仍做一次形状校验:
// 阈值字段缺失/非有限数会污染下游 Math.min 与 positionShares(NaN 扩散),宁可
// 跳过该策略并留日志,也不静默开出脏仓。
function parseStrategy(
  id: number,
  paramsJson: string | null,
): FollowStrategy | null {
  if (!paramsJson) return null;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(paramsJson) as Record<string, unknown>;
  } catch (e) {
    console.warn(`[follow] strategy ${id}: params_json 解析失败,跳过:`, e);
    return null;
  }
  const numOr = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const minWallets = numOr(p.minWallets);
  const minPerWalletUsd = numOr(p.minPerWalletUsd);
  const sizeUsd = numOr(p.sizeUsd);
  if (
    minWallets == null ||
    minPerWalletUsd == null ||
    sizeUsd == null ||
    sizeUsd <= 0
  ) {
    console.warn(
      `[follow] strategy ${id}: 阈值字段无效(minWallets/minPerWalletUsd/sizeUsd),跳过`,
    );
    return null;
  }
  return {
    id,
    minWallets,
    minPerWalletUsd,
    sizeUsd,
    exitRule: typeof p.exitRule === "string" ? p.exitRule : "settlement",
  };
}

/**
 * 一轮跟单模拟:
 *  1. 空白名单(getSmart().size===0)→ 直接 no-op,与 consensus 一致(种子未跑/失败
 *     时不应假装无信号)。
 *  2. 读启用策略;用「所有启用策略里最松的 minWallets/minPerWalletUsd」跑一次
 *     detectConsensus 产出候选组,再对每条策略用 qualifyingGroups 二次复筛。
 *  3. 每个(策略 × 合格组)开一仓:先查重(UNIQUE(strategy_id,condition_id,outcome)),
 *     再取现价(fetchPrice→窗口最近价回退),缺价/非正价则跳过等下轮;entry 用现价
 *     而非聪明钱均价(诚实反映「我们跟进时的成本」)。INSERT OR IGNORE,changes===1
 *     才计入 opened。
 *  4. 结算:所有 status='open' 仓位,市场 closed 且对应 outcomePrices 有限 → 按
 *     positionRealizedPnl 回填并标 settled。
 */
export async function runFollowCycle(
  deps: FollowCycleDeps,
): Promise<{ opened: number; settled: number }> {
  const {
    db,
    fetchWindow,
    getSmart,
    fetchPrice,
    getMeta,
    nowSec = Math.floor(Date.now() / 1000),
  } = deps;

  const smart = getSmart();
  if (smart.size === 0) {
    // 空白名单短路:同 runConsensusCycle —— 没有可信钱包就没有可跟的共识。
    console.warn("[follow] 白名单为空,本轮不开仓/结算(等待聪明钱种子完成)");
    return { opened: 0, settled: 0 };
  }

  const stratRows = db
    .prepare("SELECT id, params_json FROM follow_strategies WHERE enabled = 1")
    .all() as { id: number; params_json: string | null }[];
  const strategies = stratRows
    .map((r) => parseStrategy(r.id, r.params_json))
    .filter((s): s is FollowStrategy => s !== null);

  let opened = 0;
  const { trades } = await fetchWindow();
  if (strategies.length > 0 && trades.length > 0) {
    // 最松阈值 = 各启用策略的下确界,让 detectConsensus 一次产出所有策略可能命中的
    // 候选组;再由 qualifyingGroups 对每条策略按其自身阈值复筛。
    const loosest: ConsensusOptions = {
      minWallets: Math.min(...strategies.map((s) => s.minWallets)),
      minPerWalletUsd: Math.min(...strategies.map((s) => s.minPerWalletUsd)),
    };
    const groups = detectConsensus(trades, smart, loosest);
    const latest = latestPriceByAsset(trades);
    const exists = db.prepare(
      "SELECT 1 FROM follow_positions WHERE strategy_id = ? AND condition_id = ? AND outcome = ?",
    );
    const ins = db.prepare(
      `INSERT OR IGNORE INTO follow_positions
         (strategy_id, condition_id, outcome, asset, outcome_index, title, event_slug,
          entry_ts, entry_price, smart_avg_price, size_usd, shares, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    );
    for (const s of strategies) {
      for (const g of qualifyingGroups(groups, s)) {
        // 先查重再取价:已持仓则跳过,避免对已开仓组做无谓的现价请求。
        if (exists.get(s.id, g.conditionId, g.outcome)) continue;
        // 真实注入的 fetchPriceAt 在 CLOB 非 ok 时 throw —— 必须兜住,否则一次 5xx
        // 会 reject 整轮,连带跳过后面独立的结算阶段(参考 computeAlertOutcomes)。
        // 价格抖动只该影响这一仓的开仓,杀不死结算与其它组。
        let priced: number | null = null;
        try {
          priced = await fetchPrice(g.asset, nowSec);
        } catch (e) {
          console.warn(`[follow] fetchPrice failed for ${g.asset}:`, e);
        }
        const entry = priced ?? latest.get(g.asset) ?? null;
        if (entry == null || entry <= 0) {
          // 缺价/异常价:不开这一仓,下轮重试(不写脏 entry_price)。
          console.warn(
            `[follow] strategy ${s.id} 组 ${g.conditionId}/${g.outcome}: 无有效现价(${String(
              entry,
            )}),跳过本轮开仓`,
          );
          continue;
        }
        const shares = positionShares(entry, s.sizeUsd);
        const res = ins.run(
          s.id,
          g.conditionId,
          g.outcome,
          g.asset,
          g.outcomeIndex,
          g.title,
          g.eventSlug,
          nowSec,
          entry,
          g.avgBuyPrice,
          s.sizeUsd,
          shares,
        );
        // changes===0 说明 UNIQUE 命中(并发/竞态下已被开出),不重复计数。
        if (res.changes === 1) opened++;
      }
    }
  }

  // 结算:市场 closed 即按 outcomePrices 平仓。查所有 open 仓一次性拉 meta。
  let settled = 0;
  const openRows = db
    .prepare(
      "SELECT id, condition_id, outcome_index, entry_price, size_usd FROM follow_positions WHERE status = 'open'",
    )
    .all() as {
    id: number;
    condition_id: string;
    outcome_index: number;
    entry_price: number;
    size_usd: number;
  }[];
  if (openRows.length > 0) {
    const cids = [...new Set(openRows.map((r) => r.condition_id))];
    // getMeta 抛错(真实 getMarketMeta 内部已降级,但注入类型允许裸 fetcher)时
    // 降级为空 meta:本轮不结算任何仓,而不是 reject 整轮(对齐 computeAlertOutcomes)。
    let meta: Record<string, MarketMeta> = {};
    try {
      meta = await getMeta(cids);
    } catch (e) {
      console.warn("[follow] getMeta failed, 本轮跳过结算:", e);
    }
    const upd = db.prepare(
      "UPDATE follow_positions SET status = 'settled', exit_ts = ?, exit_price = ?, realized_pnl = ? WHERE id = ?",
    );
    for (const row of openRows) {
      const m = meta[row.condition_id];
      if (!m || !m.closed) continue;
      const exit = m.outcomePrices[row.outcome_index];
      // outcomePrices 缺项/NaN(gamma 归一化对坏值填 NaN)→ 保持 open,下轮再试。
      if (exit == null || !Number.isFinite(exit)) continue;
      const realized = positionRealizedPnl(row.entry_price, exit, row.size_usd);
      upd.run(nowSec, exit, realized, row.id);
      settled++;
    }
  }

  console.log(
    `[follow] cycle done · strategies=${strategies.length} · opened=${opened} · settled=${settled}`,
  );
  return { opened, settled };
}
