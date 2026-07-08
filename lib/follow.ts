import type { ConsensusGroup, ConsensusOptions } from "./consensus";
import { detectConsensus } from "./consensus";
import type { DB } from "./db";
import { DEFAULT_DISAGREEMENT, detectDisagreement } from "./disagreement";
import type { MarketMeta } from "./gamma";
import { excludeContestedFromConsensus } from "./marketSignals";
import { wilsonInterval } from "./outcomeStats";
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
  // 进场价偏离护栏(¢):|现价 − 聪明钱均价|×100 超过该值即不开仓。默认 10。
  maxEntryDeviationCents: number;
}

// 进场价偏离护栏默认阈值(¢)。开仓侧 parseStrategy 与展示侧 parseParamsView 共用,
// 保证两侧默认值永远一致(真机实证:in-play 体育盘 30min 内能跑 20¢,10¢ 是
// 「正常盘口抖动」与「行情已反向」的分界)。
const DEFAULT_MAX_ENTRY_DEVIATION_CENTS = 10;

export interface FollowCycleDeps {
  db: DB;
  fetchWindow: () => Promise<{ trades: Trade[] }>;
  getSmart: () => Map<string, SmartTag>;
  // 现价来源:开仓时传入 now(第二个参数保留时间语义,便于将来做历史回填)。
  fetchPrice: (asset: string, tsSec: number) => Promise<number | null>;
  getMeta: (cids: string[]) => Promise<Record<string, MarketMeta>>;
  // 新鲜度闸门(秒):只对「最近一笔合格成交距 now <= freshSec」的共识组开仓。
  // 默认 1800(30min)。滚动 6h 检测窗口会重复看见几小时前形成的共识 —— 无此闸门
  // 时一启动就会把每个历史共识按当前价补开一遍(接飞刀:信号价 64¢、现价已崩到 13¢
  // 且市场已结算)。注意它拦不住 in-play 体育盘:30min 内现价照样能跑 20¢,故另有
  // 每策略的进场价偏离护栏(maxEntryDeviationCents)在开仓时二次把关。
  freshSec?: number;
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
  // 护栏阈值:显式合法值(有限数且 >0)生效;缺失/非法退默认 10 —— 既有库的
  // params_json 没有该字段,靠这里兜底,无需数据迁移。
  const maxDev = numOr(p.maxEntryDeviationCents);
  return {
    id,
    minWallets,
    minPerWalletUsd,
    sizeUsd,
    exitRule: typeof p.exitRule === "string" ? p.exitRule : "settlement",
    maxEntryDeviationCents:
      maxDev != null && maxDev > 0 ? maxDev : DEFAULT_MAX_ENTRY_DEVIATION_CENTS,
  };
}

/**
 * 一轮跟单模拟:
 *  1. 空白名单(getSmart().size===0)→ 直接 no-op,与 consensus 一致(种子未跑/失败
 *     时不应假装无信号)。
 *  2. 读启用策略;用「所有启用策略里最松的 minWallets/minPerWalletUsd」跑一次
 *     detectConsensus 产出候选组;先按市场级互斥剔除分歧市场(聪明钱两边都买 →
 *     不是共识,双边都不跟,口径与共识页一致),再用新鲜度闸门
 *     (nowSec - g.lastTs <= freshSec)筛掉陈旧组 —— 只跟最近成交的共识,
 *     不补开历史/接飞刀。
 *  3. 一次性取 meta:对「新鲜候选组的 distinct condition_id」∪「现有 open 仓的
 *     condition_id」调用 getMeta(抛错则降级为空 meta,不 reject 整轮);开仓阶段
 *     用它跳过已 closed 的市场,结算阶段复用同一份。
 *  4. 每个(策略 × 合格新鲜组)开一仓:先查重(UNIQUE(strategy_id,condition_id,outcome)),
 *     若市场 meta.closed===true 跳过(meta 缺失=未知≠已结算,仍照常开),再取现价
 *     (fetchPrice→窗口最近价回退),缺价/非正价则跳过等下轮;entry 用现价而非聪明钱
 *     均价(诚实反映「我们跟进时的成本」)。INSERT OR IGNORE,changes===1 才计入 opened。
 *  5. 结算:开仓前已存在的 status='open' 仓位,市场 closed 且对应 outcomePrices 有限
 *     → 按 positionRealizedPnl 回填并标 settled。本轮新开的仓必落在非 closed 市场
 *     (上一步已跳过 closed),故同轮不会被结算,不必纳入结算集。
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
    freshSec = 1800,
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

  const { trades } = await fetchWindow();

  // 新鲜候选组:先跑 detectConsensus,再用新鲜度闸门筛掉陈旧组。滚动窗口会反复看见
  // 几小时前形成的共识 —— 只有「最近一笔合格成交(g.lastTs)距 now <= freshSec」的组
  // 才够新鲜,值得按当前价开仓;陈旧组一律不开(否则接飞刀:信号价与现价早已脱节)。
  let freshGroups: ConsensusGroup[] = [];
  if (strategies.length > 0 && trades.length > 0) {
    // 最松阈值 = 各启用策略的下确界,让 detectConsensus 一次产出所有策略可能命中的
    // 候选组;再由 qualifyingGroups 对每条策略按其自身阈值复筛。
    const loosest: ConsensusOptions = {
      minWallets: Math.min(...strategies.map((s) => s.minWallets)),
      minPerWalletUsd: Math.min(...strategies.map((s) => s.minPerWalletUsd)),
    };
    const groups = detectConsensus(trades, smart, loosest);
    // 分歧市场互斥:detectConsensus 按 (conditionId, outcome) 分组,不同的聪明钱
    // 各买同一市场的对立结果时会产出两个单边「假共识」组(其对冲者剔除只防同一钱包
    // 买两边)—— 真机实锤:激进策略同时持有同一 O/U 盘的 Over 和 Under 双边仓。
    // 产品语义是「只跟共识,不跟分歧」,故复用共识页同一口径(detectDisagreement
    // 默认阈值 + excludeContestedFromConsensus 市场级互斥)把分歧市场整体剔除,
    // 双边都不跟。
    const contested = detectDisagreement(trades, smart, DEFAULT_DISAGREEMENT);
    const uncontested = excludeContestedFromConsensus(groups, contested);
    const dropped = groups.length - uncontested.length;
    if (dropped > 0) {
      const contestedCids = new Set(contested.map((d) => d.conditionId));
      const droppedMarkets = new Set(
        groups
          .filter((g) => contestedCids.has(g.conditionId))
          .map((g) => g.conditionId),
      ).size;
      console.log(
        `[follow] 分歧互斥:剔除 ${dropped} 个单边共识组(${droppedMarkets} 个分歧市场,聪明钱两边都买 → 不跟)`,
      );
    }
    freshGroups = uncontested.filter((g) => nowSec - g.lastTs <= freshSec);
    const stale = uncontested.length - freshGroups.length;
    if (stale > 0) {
      console.log(
        `[follow] 新鲜度闸门:跳过 ${stale} 个陈旧共识组(最近成交距 now > ${freshSec}s),不补开历史`,
      );
    }
  }

  // 开仓前已存在的 open 仓 —— 结算集(本轮新开的仓必落在非 closed 市场,不必纳入)。
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

  // 一次性取 meta:新鲜候选组 ∪ 现有 open 仓的 distinct condition_id。开仓阶段判 closed、
  // 结算阶段复用同一份。getMeta 抛错(真实 getMarketMeta 内部已降级,但注入类型允许裸
  // fetcher)降级为空 meta —— 不 reject 整轮(对齐 computeAlertOutcomes);此时开仓侧
  // 视为「市场状态未知」照常开(缺失≠已结算),结算侧本轮不平任何仓。
  const metaCids = [
    ...new Set([
      ...freshGroups.map((g) => g.conditionId),
      ...openRows.map((r) => r.condition_id),
    ]),
  ];
  let meta: Record<string, MarketMeta> = {};
  if (metaCids.length > 0) {
    try {
      meta = await getMeta(metaCids);
    } catch (e) {
      console.warn("[follow] getMeta failed, 本轮跳过 closed 判定与结算:", e);
    }
  }

  let opened = 0;
  if (freshGroups.length > 0) {
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
      for (const g of qualifyingGroups(freshGroups, s)) {
        // 先查重再取价:已持仓则跳过,避免对已开仓组做无谓的现价请求。
        if (exists.get(s.id, g.conditionId, g.outcome)) continue;
        // 已结算市场不开仓:meta.closed===true 才跳过;meta 缺失(未知)≠已结算,仍照常
        // 开(严格 ===true,别把 undefined/false 误判成 closed)。
        if (meta[g.conditionId]?.closed === true) {
          console.warn(
            `[follow] strategy ${s.id} 组 ${g.conditionId}/${g.outcome}: 市场已结算(closed),跳过开仓`,
          );
          continue;
        }
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
        // 进场价偏离护栏:price 是 0-1 小数、阈值是 ¢,×100 后比较。新鲜度闸门拦不住
        // in-play 体育盘(30min 内可跑 20¢)—— 现价偏离聪明钱均价超阈说明行情已脱离
        // 信号价(追高或已反向/接飞刀),宁可错过也不开;偏离是瞬时态,不像已开仓那样
        // 需要查重,下轮价格回到阈内仍可正常跟进。
        const deviationCents = Math.abs(entry - g.avgBuyPrice) * 100;
        if (deviationCents > s.maxEntryDeviationCents) {
          console.log(
            `[follow] strategy ${s.id} 组 ${g.conditionId}/${g.outcome}(${g.title}): ` +
              `进场价偏离护栏 —— 现价 ${(entry * 100).toFixed(1)}¢ vs 聪明钱均价 ${(
                g.avgBuyPrice * 100
              ).toFixed(1)}¢,偏离 ${deviationCents.toFixed(1)}¢ > ${
                s.maxEntryDeviationCents
              }¢,跳过开仓`,
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

  // 结算:开仓前已存在的 open 仓,市场 closed 即按 outcomePrices 平仓(复用上面同一份 meta)。
  let settled = 0;
  if (openRows.length > 0) {
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

// ---------------------------------------------------------------------------
// Task 6: computeStrategyMetrics —— 某一策略全部仓位(open+settled)的纸面战绩汇总。
// 纯函数、不修改入参:结算盈亏/ROI、Wilson 区间的胜率、净值曲线与最大回撤、平均
// 持仓、滑点成本、按赛道分解。指标口径与 outcomeStats 的 push 处理保持一致:
// realized_pnl===0 视作平局(push),不计入胜率分母。
// ---------------------------------------------------------------------------

// follow_positions 表行的读取视图(TDD 与 UI 层共用的结构契约)。
export interface FollowPositionRow {
  strategy_id: number;
  condition_id: string;
  outcome: string;
  size_usd: number;
  entry_price: number;
  smart_avg_price: number;
  shares: number;
  status: "open" | "settled";
  entry_ts: number;
  exit_ts: number | null;
  exit_price: number | null;
  realized_pnl: number | null;
}

export interface StrategyMetrics {
  totalRealized: number;
  invested: number;
  roi: number | null;
  wins: number;
  settledCount: number;
  winRate: number | null;
  winRateCI: { lo: number; hi: number };
  openCount: number;
  avgHoldingDays: number | null;
  maxDrawdown: number;
  slippageCost: number;
  equityCurve: { ts: number; cum: number }[];
  byCategory: Record<string, { realized: number; settledCount: number }>;
}

/**
 * 单条策略的战绩汇总。入参 positions 是「某一策略」的全部仓位。
 *
 *  - 结算口径:totalRealized/invested/roi 只看 settled;realized_pnl 缺失(应有值)
 *    按 0 计,避免 NaN 扩散。
 *  - 胜率:wins/(wins+losses),realized_pnl===0 为 push 不进分母;winRateCI 用
 *    Wilson 区间诚实反映小样本区间(分母 0 时 wilsonInterval 返回 {lo:0,hi:1})。
 *  - 净值曲线:settled 按 exit_ts 升序累计 realized_pnl。
 *  - maxDrawdown:在 cum 序列上维护 running peak,不引入隐式 0 起点(峰谷只在真实
 *    结算点之间算);空 settled → 0。
 *  - slippageCost:对所有仓位(open+settled,滑点在进场即产生)累计 positionSlippage。
 *  - byCategory:settled 按 categoryByCid 分组,null/缺失归「未分类」。
 */
export function computeStrategyMetrics(
  positions: FollowPositionRow[],
  categoryByCid: Record<string, string | null>,
): StrategyMetrics {
  const settled = positions.filter((p) => p.status === "settled");
  const openCount = positions.filter((p) => p.status === "open").length;
  const settledCount = settled.length;

  const totalRealized = settled.reduce((s, p) => s + (p.realized_pnl ?? 0), 0);
  const invested = settled.reduce((s, p) => s + p.size_usd, 0);
  const roi = invested > 0 ? totalRealized / invested : null;

  // 胜负:realized_pnl>0 赢、<0 输、===0 push(不计分母)。
  let wins = 0;
  let losses = 0;
  for (const p of settled) {
    const pnl = p.realized_pnl ?? 0;
    if (pnl > 0) wins++;
    else if (pnl < 0) losses++;
  }
  const denom = wins + losses;
  const winRate = denom > 0 ? wins / denom : null;
  const winRateCI = wilsonInterval(wins, denom);

  // 净值曲线:按 exit_ts 升序(复制后排序,不改入参)累计已实现盈亏。
  const equityCurve: { ts: number; cum: number }[] = [];
  let cum = 0;
  for (const p of [...settled].sort(
    (a, b) => (a.exit_ts ?? 0) - (b.exit_ts ?? 0),
  )) {
    cum += p.realized_pnl ?? 0;
    equityCurve.push({ ts: p.exit_ts ?? 0, cum });
  }

  // 最大回撤:running peak 与当前点之差的最大值;不引入隐式 0 起点。
  let maxDrawdown = 0;
  let peak = -Infinity;
  for (const pt of equityCurve) {
    if (pt.cum > peak) peak = pt.cum;
    const dd = peak - pt.cum;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // 平均持仓天数:settled 的均值;exit_ts 异常缺失时按 entry_ts 兜底(持仓 0 天,
  // 不产生负值)。无 settled → null。
  const avgHoldingDays =
    settledCount > 0
      ? settled.reduce(
          (s, p) => s + ((p.exit_ts ?? p.entry_ts) - p.entry_ts) / 86400,
          0,
        ) / settledCount
      : null;

  // 滑点成本:对所有仓位(open+settled)—— 滑点在进场即产生,与是否结算无关。
  const slippageCost = positions.reduce(
    (s, p) =>
      s + positionSlippage(p.entry_price, p.smart_avg_price, p.size_usd),
    0,
  );

  // 按赛道分解:仅 settled,categoryByCid 缺失/null 归「未分类」。
  const byCategory: Record<string, { realized: number; settledCount: number }> =
    {};
  for (const p of settled) {
    const cat = categoryByCid[p.condition_id] ?? "未分类";
    const bucket = (byCategory[cat] ??= { realized: 0, settledCount: 0 });
    bucket.realized += p.realized_pnl ?? 0;
    bucket.settledCount += 1;
  }

  return {
    totalRealized,
    invested,
    roi,
    wins,
    settledCount,
    winRate,
    winRateCI,
    openCount,
    avgHoldingDays,
    maxDrawdown,
    slippageCost,
    equityCurve,
    byCategory,
  };
}

// ---------------------------------------------------------------------------
// Task 8: buildFollowView —— /api/follow 只读接口的纯整形层。把「策略行 + 全部仓位
// + 分类映射」组装成每策略一块的视图(参数、指标、open/settled 两列)。无副作用、
// 不修改入参,便于单测与复用;route 层只负责开库、取行、抓分类,整形逻辑全在这里。
// ---------------------------------------------------------------------------

export interface FollowStrategyView {
  id: number;
  name: string;
  enabled: boolean;
  params: {
    minWallets: number;
    minPerWalletUsd: number;
    sizeUsd: number;
    exitRule: string;
    maxEntryDeviationCents: number;
  };
  metrics: StrategyMetrics;
  open: FollowPositionRow[]; // status==='open'
  settled: FollowPositionRow[]; // status==='settled',按 exit_ts 降序(最新在前)
}

/**
 * params_json → 展示用参数。与 parseStrategy(开仓侧,失败即跳过整条策略)不同:
 * 这里是只读展示,任何字段缺失/坏 JSON 都退到安全默认而非丢弃策略 —— 接口要始终
 * 能把策略列出来(哪怕参数是占位默认),让前端可见其存在与仓位/战绩。每次返回全新
 * 对象,避免共享可变默认值。
 */
function parseParamsView(
  paramsJson: string | null,
): FollowStrategyView["params"] {
  const fallback = {
    minWallets: 0,
    minPerWalletUsd: 0,
    sizeUsd: 0,
    exitRule: "settlement",
    // 展示侧默认与开仓侧 parseStrategy 同源:字段缺失时开仓实际生效的就是 10¢,
    // 界面不能展示成 0(会被误读为「无护栏」)。
    maxEntryDeviationCents: DEFAULT_MAX_ENTRY_DEVIATION_CENTS,
  };
  if (!paramsJson) return fallback;
  let p: Record<string, unknown>;
  try {
    const parsed = JSON.parse(paramsJson);
    if (!parsed || typeof parsed !== "object") return fallback;
    p = parsed as Record<string, unknown>;
  } catch {
    return fallback;
  }
  const numOr = (v: unknown, d: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  const maxDev = numOr(
    p.maxEntryDeviationCents,
    DEFAULT_MAX_ENTRY_DEVIATION_CENTS,
  );
  return {
    minWallets: numOr(p.minWallets, 0),
    minPerWalletUsd: numOr(p.minPerWalletUsd, 0),
    sizeUsd: numOr(p.sizeUsd, 0),
    exitRule: typeof p.exitRule === "string" ? p.exitRule : "settlement",
    // 非正数同样退默认(与开仓侧一致:只有 >0 的显式值才生效)。
    maxEntryDeviationCents:
      maxDev > 0 ? maxDev : DEFAULT_MAX_ENTRY_DEVIATION_CENTS,
  };
}

/**
 * 组装 /api/follow 响应体。
 *  - 按 strategy_id 把 positions 分组;每策略 metrics 用「该策略全部仓位」算。
 *  - open/settled 分列;settled 按 exit_ts 降序(最新在前),exit_ts 缺失按 0 兜底
 *    排到末尾。filter/sort 均作用于新数组,不修改入参 positions。
 *  - 策略顺序沿用入参顺序(route 用 ORDER BY id,故稳定按 id 升序)。
 */
export function buildFollowView(
  strategies: {
    id: number;
    name: string;
    enabled: number;
    params_json: string | null;
  }[],
  positions: FollowPositionRow[],
  categoryByCid: Record<string, string | null>,
): { strategies: FollowStrategyView[] } {
  const byStrategy = new Map<number, FollowPositionRow[]>();
  for (const p of positions) {
    const arr = byStrategy.get(p.strategy_id);
    if (arr) arr.push(p);
    else byStrategy.set(p.strategy_id, [p]);
  }

  const views: FollowStrategyView[] = strategies.map((s) => {
    const own = byStrategy.get(s.id) ?? [];
    return {
      id: s.id,
      name: s.name,
      enabled: !!s.enabled,
      params: parseParamsView(s.params_json),
      metrics: computeStrategyMetrics(own, categoryByCid),
      open: own.filter((p) => p.status === "open"),
      settled: own
        .filter((p) => p.status === "settled")
        .sort((a, b) => (b.exit_ts ?? 0) - (a.exit_ts ?? 0)),
    };
  });

  return { strategies: views };
}
