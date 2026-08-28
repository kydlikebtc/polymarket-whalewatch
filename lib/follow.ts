import type { ConsensusGroup, ConsensusOptions } from "./consensus";
import type { DB } from "./db";
import {
  DEFAULT_DISAGREEMENT,
  detectDisagreement,
  type DisagreementMarket,
} from "./disagreement";
import { takerFeeUsd } from "./fees";
import { DETECTORS, isFollowSourceKind } from "./followCandidate";
import type {
  DetectorCtx,
  FollowCandidate,
  MarketTiltSnapshot,
  StrategyParams,
} from "./followCandidate";
import type { MarketMeta } from "./gamma";
import type { AskBook } from "./orderBook";
import { simulateBookBuy, bookCapacityUsd } from "./orderBook";
import { wilsonInterval } from "./outcomeStats";
import { createPromiseCache } from "./promiseCache";
import { reverseCandidate } from "./reverse";
import type { SmartTag } from "./smartWallets";
import {
  backfillSignalSettlement,
  recordStrategySignal,
} from "./strategySignals";
import { latestPriceByAsset } from "./trades";
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
 * 追价成本(展示旧称「跟单滑点」,美元)= 份额 * (自己入场价 - 聪明钱均价)。
 * 我们跟进时比聪明钱买得更贵(entryPrice>smartAvgPrice)为正 —— 即多付出的成本。
 * 注意:这不是盘口执行滑点 —— entryPrice 是报价快照(prices-history 最近点),
 * 价差/深度等执行成本未建模,纸面盈亏相对实盘系统性偏乐观。
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
 *
 * 注意:P1 起 runFollowCycle 不再走「最松阈值跑一次 + 本函数复筛」—— 复筛拿不到
 * 正确的 formationTs(跨线时刻依赖各策略自己的 floor),改为每策略各跑一次
 * detectConsensus(trades 在内存、纯函数,S 个策略成本微秒级)。本函数保留给
 * 测试与未来的轻量筛选场景。
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
// Moved to lib/trades.ts so the consensus push (chase-cost line) can share it
// without a follow ↔ consensus require cycle; re-exported to keep existing
// imports/tests stable.
export { latestPriceByAsset };

// ---------------------------------------------------------------------------
// Task 5: runFollowCycle —— 纸面「共识跟单」一轮。开仓 + 结算,注入式依赖(同
// runConsensusCycle 的写法),便于测试与复用。副作用仅落在 follow_positions 表。
// ---------------------------------------------------------------------------

// 一条启用中的跟单策略(params_json 解析结果 + 行 id)复用 followCandidate.ts 的
// StrategyParams —— 该类型本就是为「解析后的策略参数」设计的通用契约,detector
// 注册表(Task 4)与这里的开仓循环消费的是同一个对象,不必另立一套只在本文件
// 使用的窄接口。exitRule 目前只支持 "settlement"(市场结算即平仓)。

// 进场价偏离护栏默认阈值(¢)。开仓侧 parseStrategy 与展示侧 parseParamsView 共用,
// 保证两侧默认值永远一致(真机实证:in-play 体育盘 30min 内能跑 20¢,10¢ 是
// 「正常盘口抖动」与「行情已反向」的分界)。
const DEFAULT_MAX_ENTRY_DEVIATION_CENTS = 10;
// 最高进场价(0-1 小数)。与 alertConditions 的 maxPrice 同口径。
// 生产实测(见 alertConditions.ts 的 DEFAULT_CONDITIONS 注释):28.6% 的告警落在
// >=0.90 —— 近确定结果上的结算清扫单,零信息量。跟单此前没有任何价格上限,账本里
// 混着「买 0.97 赚 3¢」的仓:胜率被拉得很高很好看,但每次翻车亏掉 30 次的利润
// (赔率极度不对称,Wilson 区间衡量的是胜率不确定性,救不了这个)。故设为全局基础
// 参数而非某档的可选项。
const DEFAULT_MAX_PRICE = 0.95;
// 新鲜度闸门默认值,从 FollowCycleDeps 的全局参数下放到每策略(A5 首发共识要 300)。
const DEFAULT_FRESH_SEC = 900;

// ---------------------------------------------------------------------------
// Task 9: market_tilt_history 读写 + 保留期清理。C2(sourceResolved,「分歧
// 解除」)判定"少数边转净卖"需要跨轮对比 —— 本轮重新聚合的净额,要跟"上一次
// 我们观察到这个市场处于分歧状态"时的快照相减,单轮数据看不出"转变"。
// ---------------------------------------------------------------------------

// 保留期与 MARKOUT_MAX_AGE_SEC(runFollowCycle 内,7 天)同量级:快照只服务
// 下一轮 C2 判定,没有 7 天之外的价值,轮末顺手清理,不单独起定时任务。
const TILT_HISTORY_RETENTION_SEC = 7 * 86400;

/**
 * 读上一轮各市场的 tilt 快照:每个 condition_id 只取 ts 最大的那一条 ——
 * "上一次观察到的状态",不是历史全量。JOIN 一个按 condition_id 分组取
 * MAX(ts) 的子查询,而不是相关子查询(逐行 SELECT MAX),两者语义等价但
 * JOIN 版本能用上 PRIMARY KEY (condition_id, ts) 自带的索引一次扫完,不会
 * 对每个 condition_id 各起一次子查询。
 *
 * 四个业务字段(lead_outcome/minor_outcome/minor_net_usd/tilt_pct)在表结构
 * 里都允许 NULL,但 writeMarketTiltSnapshots 写入时永远四个一起给值 —— 一行
 * 读出来缺任何一个都说明数据不是这条写入路径产生的(手工改库 / 未来某次
 * 迁移留下的半行),整行不可信,直接跳过而不是拿 null 兜底喂给 C2(fail-closed:
 * 宁可这个市场本轮没有 prevTilt、C2 不触发,也不要用残缺快照硬算出一个
 * 三不知的"转变")。
 *
 * ⚠️ 调用时机纪律(整个读写链路的核心不变量):必须在本轮 writeMarketTiltSnapshots
 * 之前调用。JS 单线程同步执行,没有并发路径能让写抢在读之前跑 —— 这条不变量
 * 完全靠"读的调用点在 runFollowCycle 里写在写的调用点前面"这个纯粹的代码顺序
 * 保证,不是靠锁或事务。写反了的后果:读到的会是本轮自己刚写的行,
 * prev.minorNetUsd 恒等于本轮重新算出的净额,C2 的判据(prev>0 且本轮<0)
 * 永远不成立,整档静默失效且没有任何报错 —— 这类 bug 除了看这行注释 +
 * followCycle.test.ts 里锁死顺序的用例,没有别的办法在运行时自己暴露出来,
 * 所以特别在这里写清楚"为什么不能顺手挪到 writeMarketTiltSnapshots 后面"。
 */
export function readMarketTiltSnapshots(
  db: DB,
): Map<string, MarketTiltSnapshot> {
  const rows = db
    .prepare(
      `SELECT t.condition_id AS conditionId, t.ts AS ts,
              t.lead_outcome AS leadOutcome, t.minor_outcome AS minorOutcome,
              t.minor_net_usd AS minorNetUsd, t.tilt_pct AS tiltPct
       FROM market_tilt_history t
       JOIN (
         SELECT condition_id, MAX(ts) AS max_ts
         FROM market_tilt_history
         GROUP BY condition_id
       ) latest
         ON latest.condition_id = t.condition_id AND latest.max_ts = t.ts`,
    )
    .all() as {
    conditionId: string;
    ts: number;
    leadOutcome: string | null;
    minorOutcome: string | null;
    minorNetUsd: number | null;
    tiltPct: number | null;
  }[];
  const out = new Map<string, MarketTiltSnapshot>();
  for (const r of rows) {
    if (
      r.leadOutcome == null ||
      r.minorOutcome == null ||
      r.minorNetUsd == null ||
      r.tiltPct == null
    ) {
      continue; // 残缺行(见函数头注释),不可信,跳过
    }
    out.set(r.conditionId, {
      conditionId: r.conditionId,
      leadOutcome: r.leadOutcome,
      minorOutcome: r.minorOutcome,
      minorNetUsd: r.minorNetUsd,
      tiltPct: r.tiltPct,
      ts: r.ts,
    });
  }
  return out;
}

/**
 * 轮末写:为本轮每个 contested 市场写一条快照(sides[0]=主导边、sides[1]=
 * 少数边 —— DisagreementMarket.sides 恒 >= 2 且按 weightedUsd 降序,contested
 * 数组里的市场都满足这个前提,见 lib/disagreement.ts)。INSERT OR REPLACE:
 * PRIMARY KEY 是 (condition_id, ts),同一秒同一市场重复写(理论上不会发生,
 * nowSec 是每轮的入参、轮次之间必然推进)会覆盖而不是抛 UNIQUE 冲突,幂等
 * 总是更安全。
 *
 * 写失败只记日志、不向上抛出(归因列纪律,同 exec_ 系列字段/markout 的既有写法):
 * 这张表只服务 C2 detector 的下一轮判定,不是任何一仓开仓判定的输入,写失败
 * 不该拖累已经跑完的开仓/结算/markout 段——那些副作用必须保留。
 *
 * 返回写入的行数(供调用方日志汇总;失败时返回 0,不是"写了 0 个市场"与
 * "写失败"的区别在日志里会与 contested.length 一起读,不会混淆)。
 */
export function writeMarketTiltSnapshots(
  db: DB,
  contested: DisagreementMarket[],
  nowSec: number,
): number {
  if (contested.length === 0) return 0;
  try {
    const ins = db.prepare(
      `INSERT OR REPLACE INTO market_tilt_history
         (condition_id, ts, lead_outcome, minor_outcome, minor_net_usd, tilt_pct)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const tx = db.transaction((rows: DisagreementMarket[]) => {
      for (const m of rows) {
        ins.run(
          m.conditionId,
          nowSec,
          m.sides[0].outcome,
          m.sides[1].outcome,
          m.sides[1].netUsd,
          m.tiltPct,
        );
      }
    });
    tx(contested);
    return contested.length;
  } catch (e) {
    console.warn(
      "[follow] market_tilt_history 写入失败(下轮 C2 判定可能缺这一条快照,不阻塞本轮开仓/结算):",
      e,
    );
    return 0;
  }
}

/**
 * 保留期清理:与 markout 的 MARKOUT_MAX_AGE_SEC 同量级(7 天)。不像
 * lib/seen.ts 的 maybePruneSeen 那样按天数门控 —— seen_trades 是每笔成交
 * 一行、多进程(embedded engine + standalone worker)共享同一张表,门控是为了
 * 不在每次开库时都跑一次全表量级的 DELETE 抢 WAL 锁;market_tilt_history 只由
 * follow 引擎本轮的 contested 市场(个位数)写入,单表量级天然小,按索引列
 * (idx_market_tilt_history_ts)删也很便宜,没有必要额外引入门控状态。
 */
export function pruneMarketTiltHistory(db: DB, nowSec: number): number {
  try {
    return db
      .prepare("DELETE FROM market_tilt_history WHERE ts < ?")
      .run(nowSec - TILT_HISTORY_RETENTION_SEC).changes;
  } catch (e) {
    console.warn("[follow] market_tilt_history 保留期清理失败(下轮再试):", e);
    return 0;
  }
}

export interface FollowCycleDeps {
  db: DB;
  // truncated(可选):窗口深抓被页数上限/瞬态失败裁短时为 true。截断窗口里
  // 截断边缘前的成交不可见,可见跨线会把 formationTs 系统性后移 —— 新鲜度
  // 闸门与形成价护栏被同一错误时间戳同时削弱,故截断轮次跳过开仓(结算/
  // markout 只依赖已有仓位,照常)。与 worker 推送路径的『窗口仅覆盖 ~Xh』
  // 诚实标注同源:consensus 是标注着推,follow 动"仓"故直接不动。
  fetchWindow: () => Promise<{ trades: Trade[]; truncated?: boolean }>;
  getSmart: () => Map<string, SmartTag>;
  // 现价来源:开仓时传入 now;markout 回填时传入 formation_ts+Δ(第二个参数的
  // 时间语义在此兑现)。
  fetchPrice: (asset: string, tsSec: number) => Promise<number | null>;
  // 形成价来源(可选):按共识 formationTs 回查彼时市价,embeddedEngine 注入
  // (a,t)=>fetchPriceAt(a,t,{atOrBefore:true}) —— 只取 ≤formationTs 的历史点,
  // 防前视偏差(形成后价格通常朝进场方向移动,取"之后的最近点"会系统性低估
  // 延迟成本)。失败/缺依赖 → formation_price 存 null,不阻塞开仓。
  fetchFormationPrice?: (
    asset: string,
    tsSec: number,
  ) => Promise<number | null>;
  // 盘口来源(可选):开仓瞬间抓 ask 簿(AskBook 契约:升序、已数字化,由
  // parseAskBook 保证),用本仓 sizeUsd 模拟吃单 → exec_* 执行滑点归因列。
  // 盘口只有当下快照、无历史,故只能开仓时点采集,老仓恒 null。失败/缺依赖
  // → exec_* 存 null,绝不阻塞开仓;红线:不参与任何开仓判定与 realized_pnl。
  fetchBook?: (asset: string) => Promise<AskBook | null>;
  getMeta: (cids: string[]) => Promise<Record<string, MarketMeta>>;
  // 新鲜度闸门不再是这里的全局参数 —— 12 档/4 类信号源改造(Task 4)把它下放到
  // StrategyParams.freshSec(每策略各自的值,parseStrategy 已兜底默认 900),由
  // DETECTORS 注册表分派到的各 detector(见 lib/sourceConsensus.ts 等)在检测
  // 阶段自行按 nowSec - formationTs <= params.freshSec 过滤。核实过全仓库:
  // worker/embeddedEngine.ts 与 lib/followCycle.test.ts 均未传入过这个字段
  // (靠这里曾经的默认值 900),故直接删除不是破坏性变更。formationTs 而非
  // lastTs 锚定、以及 in-play 体育盘新鲜度闸门拦不住需靠 maxEntryDeviationCents
  // 二次把关的论证,原样保留在 lib/consensus.ts 的 ConsensusGroup.formationTs
  // 与本文件 DEFAULT_MAX_ENTRY_DEVIATION_CENTS 的字段注释里,未随这段一起删。
  nowSec?: number;
}

// params_json 是 seed/后台写入的可信来源,但 JSON.parse 后仍做一次形状校验:
// 阈值字段缺失/非有限数会污染下游 Math.min 与 positionShares(NaN 扩散),宁可
// 跳过该策略并留日志,也不静默开出脏仓。
//
// source 扩展(12 档/4 类信号源改造)的向后兼容契约:既有库两条策略("保守"
// "激进")的 params_json 没有 source 字段 —— 缺失即 "consensus",零迁移,
// 它们的解析结果(id/minWallets/minPerWalletUsd/sizeUsd/exitRule/
// maxEntryDeviationCents)必须与改造前逐字段相同。这是整个 12 档扩充的守门员:
// 见 lib/follow.test.ts 的 "parseStrategy — source/maxPrice/freshSec 扩展"。
function parseStrategy(
  id: number,
  paramsJson: string | null,
): StrategyParams | null {
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

  // source:缺失 → "consensus"(既有两条策略零迁移);未知值 → 跳过整条策略
  // (宁可少一档也不要一个 detector 注册表分派不到的“影子策略”悄悄不生效)。
  const rawSource = p.source ?? "consensus";
  if (!isFollowSourceKind(rawSource)) {
    console.warn(
      `[follow] strategy ${id}: 未知 source "${String(rawSource)}",跳过`,
    );
    return null;
  }

  const sizeUsd = numOr(p.sizeUsd);
  if (sizeUsd == null || sizeUsd <= 0) {
    console.warn(`[follow] strategy ${id}: sizeUsd 无效,跳过`);
    return null;
  }

  // consensus 源仍强制要求这两个阈值(它们决定 formationTs 的跨线时刻);
  // 其它源各有自己的必需字段,由对应 detector 校验并在缺失时产出空候选
  // (detector 是纯函数、无法在此处提前校验各自的专属字段)。
  const minWallets = numOr(p.minWallets);
  const minPerWalletUsd = numOr(p.minPerWalletUsd);
  if (
    rawSource === "consensus" &&
    (minWallets == null || minPerWalletUsd == null)
  ) {
    console.warn(
      `[follow] strategy ${id}: consensus 源缺 minWallets/minPerWalletUsd,跳过`,
    );
    return null;
  }

  // 护栏/价格/新鲜度:显式合法值生效,缺失或非法退默认(既有库无这些字段,靠这里
  // 兜底,无需数据迁移)。「字段缺失」与「字段存在但非法」区别对待:前者是正常
  // 情况(既有库没有这些字段),静默退默认;后者留痕 —— 最典型的现实成因是配置
  // 手滑(比如把 0-1 小数的 maxPrice 误写成百分数 50),而 maxPrice 这道护栏
  // 存在的唯一理由就是拦住 DEFAULT_MAX_PRICE 注释里说的那类高价清扫单,配置
  // 错误此时恰好静默落回护栏本该拦住的区间。Task 4 会直接消费这里吐出的
  // 「已消毒」值、不再重新校验,此刻不留痕以后就永远查不出这个值被改写过。
  const maxDev = numOr(p.maxEntryDeviationCents);
  const maxPrice = numOr(p.maxPrice);
  if (
    p.maxPrice !== undefined &&
    !(maxPrice != null && maxPrice > 0 && maxPrice <= 1)
  ) {
    console.warn(
      `[follow] strategy ${id}: maxPrice=${JSON.stringify(p.maxPrice)} 非法` +
        `(需 0<x<=1 的小数),已退默认 ${DEFAULT_MAX_PRICE}`,
    );
  }
  const freshSec = numOr(p.freshSec);
  if (p.freshSec !== undefined && !(freshSec != null && freshSec > 0)) {
    console.warn(
      `[follow] strategy ${id}: freshSec=${JSON.stringify(p.freshSec)} 非法` +
        `(需 >0 的秒数),已退默认 ${DEFAULT_FRESH_SEC}`,
    );
  }
  // side(lopsided 专属,第 13 档「逆势少数边」用):同上一套"显式合法值生效、
  // 缺失静默退默认、存在但非法留痕"纪律。既有 12 条策略(含「一边倒分歧」)的
  // params_json 都没有这个字段——缺失是正常情况,不 warn;只有显式写了
  // 非 "lead"/"minor" 的值(配置手滑)才留痕。
  const sideValid = p.side === "lead" || p.side === "minor";
  if (p.side !== undefined && !sideValid) {
    console.warn(
      `[follow] strategy ${id}: side=${JSON.stringify(p.side)} 非法` +
        `(需 "lead" 或 "minor"),已退默认 "lead"`,
    );
  }
  // reverse(反向对照档):side 同一套纪律。非布尔一律退 false —— 这个开关
  // 决定一条策略买信号的同边还是对面,被脏值悄悄置真的后果是整档方向反掉,
  // 必须显式 true 才生效。
  const reverseValid = typeof p.reverse === "boolean";
  if (p.reverse !== undefined && !reverseValid) {
    console.warn(
      `[follow] strategy ${id}: reverse=${JSON.stringify(p.reverse)} 非法` +
        `(需布尔),已退默认 false`,
    );
  }

  return {
    id,
    source: rawSource,
    sizeUsd,
    exitRule: typeof p.exitRule === "string" ? p.exitRule : "settlement",
    maxEntryDeviationCents:
      maxDev != null && maxDev > 0 ? maxDev : DEFAULT_MAX_ENTRY_DEVIATION_CENTS,
    // 价格是 0-1 小数,>1 一律视为非法(防把 95 当成 95¢ 写进来)。
    maxPrice:
      maxPrice != null && maxPrice > 0 && maxPrice <= 1
        ? maxPrice
        : DEFAULT_MAX_PRICE,
    freshSec: freshSec != null && freshSec > 0 ? freshSec : DEFAULT_FRESH_SEC,
    minWallets: minWallets ?? undefined,
    minPerWalletUsd: minPerWalletUsd ?? undefined,
    minTotalNetUsd: numOr(p.minTotalNetUsd) ?? undefined,
    minWalletScore: numOr(p.minWalletScore) ?? undefined,
    minSingleFillUsd: numOr(p.minSingleFillUsd) ?? undefined,
    minTiltPct: numOr(p.minTiltPct) ?? undefined,
    minPerSideUsd: numOr(p.minPerSideUsd) ?? undefined,
    side: sideValid ? (p.side as "lead" | "minor") : "lead",
    reverse: reverseValid ? (p.reverse as boolean) : false,
    minNetUsd: numOr(p.minNetUsd) ?? undefined,
  };
}

// 测试导出:parseStrategy 是模块私有的,但它的兼容性是整个扩充的守门员,
// 必须能被直接单测(而不是只能透过 runFollowCycle 间接观察)。
export const parseStrategyForTest = parseStrategy;

/**
 * 一轮跟单模拟:
 *  1. 空白名单(getSmart().size===0)→ 直接 no-op,与 consensus 一致(种子未跑/失败
 *     时不应假装无信号)。
 *  2. 读启用策略;按每条策略的 source 从 DETECTORS 注册表(lib/followCandidate.ts)
 *     查表分派到对应 detector(trades, params, ctx)—— 新增信号源只需写一个纯函数 +
 *     注册表加一行,这里零改动。分歧互斥仍每轮只算一次:用 DEFAULT_DISAGREEMENT
 *     检测,剔除 contested cid,通过 ctx.contested 对所有策略生效(聪明钱两边都买
 *     → 不是共识,双边都不跟,口径与共识页一致)。新鲜度闸门(曾经的全局 freshSec)
 *     已下放到各 detector 内部按 params.freshSec 自行过滤(见 FollowCycleDeps 里
 *     freshSec 字段删除处的注释)。单个 detector 抛错只置该策略本轮候选为空,不
 *     掀翻其它策略与后面的结算段。
 *  3. 一次性取 meta:对「各策略候选的 distinct condition_id」∪「现有 open 仓的
 *     condition_id」调用 getMeta(抛错则降级为空 meta,不 reject 整轮);开仓阶段
 *     用它跳过已 closed 的市场,结算阶段复用同一份。
 *  4. 每个(策略 × 该策略的候选)开一仓:先查重(UNIQUE(strategy_id,condition_id,outcome)),
 *     若市场 meta.closed===true 跳过(meta 缺失=未知≠已结算,仍照常开),再取现价
 *     (fetchPrice→窗口最近价回退,轮内按 asset+nowSec 缓存),缺价/非正价则跳过
 *     等下轮;entry 用现价而非聪明钱均价(诚实反映「我们跟进时的成本」)。价格上限
 *     (entry > s.maxPrice 即跳过,拦近确定结果的结算清扫单)先于偏离护栏判定。
 *     偏离护栏基准 = formationPrice(形成时刻的市价,fetchFormationPrice 回查,轮内
 *     按 asset+formationTs 缓存;null 时回退 candidate.referencePrice)。INSERT 落
 *     formation_ts/formation_price 归因列;OR IGNORE,changes===1 才计入 opened。
 *  5. 结算:开仓前已存在的 status='open' 仓位,市场 closed 且对应 outcomePrices 有限
 *     → 按 positionRealizedPnl 回填并标 settled。本轮新开的仓必落在非 closed 市场
 *     (上一步已跳过 closed),故同轮不会被结算,不必纳入结算集。
 *  6. markout 惰性回填:formation_ts 非空、markout 列为 null 且已过 formation_ts+Δ+300
 *     的仓位(open+settled 都要),fetchPrice(asset, formation_ts+Δ) 回填
 *     markout_30m(Δ=1800)/markout_2h(Δ=7200),每轮每列最多 ~10 仓防风暴,失败跳过
 *     下轮再试。红线:formation_price/markout 只用于归因展示,绝不参与 realized_pnl。
 *     这段不走第 4 步的轮内缓存 —— 按 (asset, formation_ts+Δ) 取,key 天然与开仓
 *     取价不同,且单仓失败要能逐仓重试(缓存的失败驱逐语义与"整批各自重试"不匹配)。
 */
export async function runFollowCycle(
  deps: FollowCycleDeps,
): Promise<{ opened: number; settled: number }> {
  const {
    db,
    fetchWindow,
    getSmart,
    fetchPrice,
    fetchFormationPrice,
    fetchBook,
    getMeta,
    nowSec = Math.floor(Date.now() / 1000),
  } = deps;

  // 轮内共享缓存:12 档下同一 asset 会被多条策略反复取价(参数完全相同 ——
  // 开仓现价按 asset+nowSec 取,形成价按 asset+formationTs 取)。createPromiseCache
  // 缓存的是 PROMISE 而非值,所以即使多条策略在下面串行 await 的循环里先后走到
  // 同一个 key,第一个发起后其余直接拿到同一个 in-flight promise,一次往返都不
  // 多花。每轮 new 实例(而非设时间 TTL):语义最干净 —— 轮内共享、轮间必须重取,
  // 不会有陈旧价格跨轮泄漏。markout 回填段(本函数末尾)按 (asset, formation_ts+Δ)
  // 取,key 天然与这里不同,且它的失败要能逐仓重试,故不复用这三个缓存,见该段
  // 注释。
  const priceCache = createPromiseCache<number | null>(Infinity);
  const formationPriceCache = createPromiseCache<number | null>(Infinity);
  const bookCache = createPromiseCache<AskBook | null>(Infinity);

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
    .filter((s): s is StrategyParams => s !== null);

  const { trades, truncated = false } = await fetchWindow();
  if (truncated) {
    console.warn(
      "[follow] window truncated — formationTs untrustworthy this cycle, opening skipped (settlement/markout proceed)",
    );
  }

  // 每策略各自的候选。分歧互斥只检测一次(DEFAULT_DISAGREEMENT 与策略阈值无关),
  // 剔除的 contested 市场对所有策略生效(通过 ctx.contested 传给每个 detector);
  // 各 detector 按 source 从 DETECTORS 注册表(lib/followCandidate.ts)查表分派 ——
  // 新增信号源 = 写一个纯函数 + 注册表加一行,这段代码零改动,不再需要 Task 3 那种
  // 临时的 source 显式门禁(注册表按 source 查表分派,天然不会把 heavy 之类的
  // 非 consensus 策略误送进 consensus 的检测逻辑,即便其 params_json 残留了
  // minWallets/minPerWalletUsd 字段 —— 见 followCycle.test.ts 的多 source 集成用例)。
  const candidatesByStrategy = new Map<number, FollowCandidate[]>();
  // 本轮 contested 市场,轮末喂给 writeMarketTiltSnapshots(见函数尾部)——
  // 声明在 if 块外面,好让"轮末才写"这句话字面成立:写用的是本轮真实检测到的
  // contested(哪怕它在下面的 if 里才被赋值),不是另开一次独立的 detectDisagreement
  // 调用。截断/无策略/空窗口时保持 []:与"opening skipped"同一套 fail-closed 纪律,
  // 不拿不可信的窗口写脏 market_tilt_history。
  let contestedThisCycle: DisagreementMarket[] = [];
  if (!truncated && strategies.length > 0 && trades.length > 0) {
    // 分歧市场互斥:detectConsensus 按 (conditionId, outcome) 分组,不同的聪明钱
    // 各买同一市场的对立结果时会产出两个单边「假共识」组(其对冲者剔除只防同一钱包
    // 买两边)—— 真机实锤:激进策略同时持有同一 O/U 盘的 Over 和 Under 双边仓。
    // 产品语义是「只跟共识,不跟分歧」,故复用共识页同一口径(detectDisagreement
    // 默认阈值 + excludeContestedFromConsensus 市场级互斥,后者在 detector 内部
    // 调用)把分歧市场整体剔除,双边都不跟。
    const contested = detectDisagreement(trades, smart, DEFAULT_DISAGREEMENT);
    contestedThisCycle = contested;
    // ⚠️ 读写顺序(Task 9 核心不变量):readMarketTiltSnapshots 必须在
    // writeMarketTiltSnapshots(函数尾部,结算/markout 之后)之前调用 —— 这里
    // 就是"之前":JS 单线程同步执行,这一行永远先于函数尾部那行跑完。读到的是
    // 上一轮(或更早)写入的快照,不会读到本轮自己即将写的行。详细论证见
    // readMarketTiltSnapshots 的函数头注释。
    const prevTilt = readMarketTiltSnapshots(db);
    // D2(early_winner)钱包预取:每轮一次,与 prevTilt 同级 —— 由 discovery 侧
    // (lib/earlyWinner.ts runEarlyWinnerScan)持续写入 wallet_candidates 的
    // channel='early_winner' 行,这里只读、不写,供本轮所有策略共享(不必每条
    // 策略各查一次)。DISTINCT 是因为该表 PRIMARY KEY 是
    // (address, channel, condition_id) —— 同一钱包在多个市场上都留下过
    // early_winner 证据时会有多行,detectEarlyWinnerCandidates 只关心钱包本身
    // 是否曾经入选,不关心具体是哪个/几个市场。
    //
    // 查询失败(表损坏等极端情况)降级为空 Set —— D2 本轮无候选,不影响其它
    // source 的策略,与 getMeta/fetchPrice 等既有降级纪律一致:局部依赖失败
    // 不该拖垮整轮。
    let earlyWinnerWallets = new Set<string>();
    try {
      const ewRows = db
        .prepare(
          "SELECT DISTINCT address FROM wallet_candidates WHERE channel = 'early_winner'",
        )
        .all() as { address: string }[];
      // recordEvidence(lib/discovery.ts)写入前已经 toLowerCase 过 ——
      // CandidateEvidence.address 字段注释明确「lowercased」,
      // extractEarlyWinnerEvidence(lib/earlyWinner.ts)构造证据行时也是
      // `t.proxyWallet.toLowerCase()`。这里再 toLowerCase 一次纯属防御性:
      // 万一未来某个写入路径疏漏了小写化,这里不会因此与 detector 里同样小写
      // 的 wallet 比较静默失配(detectWalletCandidates 里 `t.proxyWallet.
      // toLowerCase()` 是比较的另一侧,两边必须口径一致)。
      earlyWinnerWallets = new Set(ewRows.map((r) => r.address.toLowerCase()));
    } catch (e) {
      console.warn("[follow] early_winner 钱包预取失败,D2 本轮无候选:", e);
    }
    const ctx: DetectorCtx = {
      smart,
      nowSec,
      contested,
      earlyWinnerWallets,
      prevTilt,
    };
    for (const s of strategies) {
      try {
        candidatesByStrategy.set(s.id, DETECTORS[s.source](trades, s, ctx));
      } catch (e) {
        // 单个 detector 的异常只该影响这一条策略,杀不死其它策略与后面的结算段。
        console.warn(
          `[follow] strategy ${s.id} (${s.source}) detector 抛错,本轮无候选:`,
          e,
        );
        candidatesByStrategy.set(s.id, []);
      }
    }
  }
  const allCandidates = [...candidatesByStrategy.values()].flat();

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

  // 一次性取 meta:各策略候选 ∪ 现有 open 仓的 distinct condition_id。开仓阶段判
  // closed、结算阶段复用同一份。getMeta 抛错(真实 getMarketMeta 内部已降级,但注入
  // 类型允许裸 fetcher)降级为空 meta —— 不 reject 整轮(对齐 computeAlertOutcomes);
  // 此时开仓侧视为「市场状态未知」照常开(缺失≠已结算),结算侧本轮不平任何仓。
  const metaCids = [
    ...new Set([
      ...allCandidates.map((c) => c.conditionId),
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
  if (allCandidates.length > 0) {
    const latest = latestPriceByAsset(trades);
    const exists = db.prepare(
      "SELECT 1 FROM follow_positions WHERE strategy_id = ? AND condition_id = ? AND outcome = ?",
    );
    const ins = db.prepare(
      `INSERT OR IGNORE INTO follow_positions
         (strategy_id, condition_id, outcome, asset, outcome_index, title, event_slug,
          entry_ts, entry_price, smart_avg_price, size_usd, shares, status,
          formation_ts, formation_price, exec_price, exec_best_ask, exec_filled_usd,
          fee_usd, book_cap_1c, book_cap_3c)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of strategies) {
      for (const c0 of candidatesByStrategy.get(s.id) ?? []) {
        // 反向对照档:候选先经 reverseCandidate 翻到对面 outcome,再进下面的
        // 既有守卫链 —— 查重键、closed 判定、现价/形成价/盘口/费用、INSERT 全部
        // 消费翻转后的候选,下游零特判。必须放在守卫链最前(尤其查重之前):
        // 反向档的仓开在对面 outcome 上,拿翻转前的 outcome 查重会永远查不到
        // 自己已开的仓。meta 此时已按候选取好(metaCids 由翻转前候选算出,翻转
        // 不改 conditionId,覆盖天然成立)。弃权即跳过本轮(fail-closed,原因
        // 见 lib/reverse.ts),下轮 meta 恢复后若信号仍新鲜可正常跟进。
        let c = c0;
        if (s.reverse) {
          const flipped = reverseCandidate(c0, meta[c0.conditionId]);
          if ("skip" in flipped) {
            console.log(
              `[follow] strategy ${s.id} 反向翻转弃权 组 ${c0.conditionId}/${c0.outcome}: ${flipped.skip}`,
            );
            continue;
          }
          c = flipped.candidate;
        }
        // 先查重再取价:已持仓则跳过,避免对已开仓组做无谓的现价请求。
        if (exists.get(s.id, c.conditionId, c.outcome)) continue;
        // 已结算市场不开仓:meta.closed===true 才跳过;meta 缺失(未知)≠已结算,仍照常
        // 开(严格 ===true,别把 undefined/false 误判成 closed)。
        if (meta[c.conditionId]?.closed === true) {
          console.warn(
            `[follow] strategy ${s.id} 组 ${c.conditionId}/${c.outcome}: 市场已结算(closed),跳过开仓`,
          );
          continue;
        }
        // 真实注入的 fetchPriceAt 在 CLOB 非 ok 时 throw —— 必须兜住,否则一次 5xx
        // 会 reject 整轮,连带跳过后面独立的结算阶段(参考 computeAlertOutcomes)。
        // 价格抖动只该影响这一仓的开仓,杀不死结算与其它组。轮内缓存:同一 asset
        // 被多条策略命中时(参数完全相同的现价请求)只发一次往返,见函数头缓存
        // 声明处的注释。
        let priced: number | null = null;
        try {
          priced = await priceCache(`price:${c.asset}:${nowSec}`, () =>
            fetchPrice(c.asset, nowSec),
          );
        } catch (e) {
          console.warn(`[follow] fetchPrice failed for ${c.asset}:`, e);
        }
        const entry = priced ?? latest.get(c.asset) ?? null;
        if (entry == null || entry <= 0) {
          // 缺价/异常价:不开这一仓,下轮重试(不写脏 entry_price)。
          console.warn(
            `[follow] strategy ${s.id} 组 ${c.conditionId}/${c.outcome}: 无有效现价(${String(
              entry,
            )}),跳过本轮开仓`,
          );
          continue;
        }
        // 价格上限:拦的是 entry(我们的实际入场价),不是 referencePrice —— 清扫仓的
        // 问题是「我们买在 0.97」,不是「聪明钱买在 0.97」。严格 >:0.95 可开、0.951
        // 不可。与偏离护栏同为瞬时态,不写查重,下轮价格回落仍可正常跟进。放在
        // 偏离护栏判定之前:没有形成价意义的极端现价没必要再多花一次形成价查询。
        if (entry > s.maxPrice) {
          console.log(
            `[follow] strategy ${s.id} 组 ${c.conditionId}/${c.outcome}: 现价 ${(entry * 100).toFixed(1)}¢ ` +
              `> 价格上限 ${(s.maxPrice * 100).toFixed(1)}¢(近确定结果的结算清扫,零信息量),跳过开仓`,
          );
          continue;
        }
        // 形成价:按 formationTs 回查彼时市价(atOrBefore 由注入方保证,防前视)。
        // 失败/null 不阻塞开仓 —— formation_price 落 null,护栏回退旧基准。轮内
        // 缓存 key 按 asset+formationTs(而非 nowSec)—— 与现价缓存是两个独立
        // 命名空间,互不冲突。
        let formationPrice: number | null = null;
        if (fetchFormationPrice) {
          try {
            formationPrice = await formationPriceCache(
              `fprice:${c.asset}:${c.formationTs}`,
              () => fetchFormationPrice(c.asset, c.formationTs),
            );
          } catch (e) {
            console.warn(
              `[follow] fetchFormationPrice failed for ${c.asset}@${c.formationTs}:`,
              e,
            );
          }
          if (
            formationPrice != null &&
            (!Number.isFinite(formationPrice) || formationPrice <= 0)
          ) {
            formationPrice = null; // 异常价视同缺失,不进护栏也不落库
          }
        }
        // 进场价偏离护栏:price 是 0-1 小数、阈值是 ¢,×100 后比较。新鲜度闸门拦不住
        // in-play 体育盘 —— 现价偏离基准超阈说明行情已脱离信号价(追高或已反向/接
        // 飞刀),宁可错过也不开;偏离是瞬时态,不像已开仓那样需要查重,下轮价格回到
        // 阈内仍可正常跟进。基准 = formationPrice(形成后的真实漂移);为 null 时回退
        // referencePrice(聪明钱的成本基准 —— consensus 是加权均价、heavy 是那一笔
        // 成交价)。均价差含聪明钱的信息租金(他们买得早/便宜),会误拦正常跟进或
        // 漏拦真漂移,formation 价才是「形成后漂移」的正确基准。
        const baseline = formationPrice ?? c.referencePrice;
        const baselineName =
          formationPrice != null ? "形成价" : "聪明钱均价(形成价缺失,回退)";
        if (formationPrice == null && fetchFormationPrice) {
          console.log(
            `[follow] strategy ${s.id} 组 ${c.conditionId}/${c.outcome}: 形成价缺失,护栏回退聪明钱均价基准`,
          );
        }
        const deviationCents = Math.abs(entry - baseline) * 100;
        if (deviationCents > s.maxEntryDeviationCents) {
          console.log(
            `[follow] strategy ${s.id} 组 ${c.conditionId}/${c.outcome}(${c.title}): ` +
              `进场价偏离护栏 —— 现价 ${(entry * 100).toFixed(1)}¢ vs ${baselineName} ${(
                baseline * 100
              ).toFixed(1)}¢,偏离 ${deviationCents.toFixed(1)}¢ > ${
                s.maxEntryDeviationCents
              }¢,跳过开仓`,
          );
          continue;
        }
        // 执行层归因:开仓瞬间盘口快照模拟吃单(exec_*)。盘口无历史、只能此刻
        // 采集;任何失败(网络/空簿/形状)→ 三列 null,开仓照常 —— 与 formation
        // 同级的纯归因,杀不死开仓,也不参与护栏判定。
        let execPrice: number | null = null;
        let execBestAsk: number | null = null;
        let execFilledUsd: number | null = null;
        // 容量标尺(同一份簿快照顺手算,零额外抓取):+1¢/+3¢ 带内深度 =
        // 跟随资金把成交价推出该带之前的最大美元容量。空簿/无簿恒 null。
        let bookCap1c: number | null = null;
        let bookCap3c: number | null = null;
        if (fetchBook) {
          try {
            const book = await bookCache(`book:${c.asset}`, () =>
              fetchBook(c.asset),
            );
            if (book && book.asks.length > 0) {
              execBestAsk = book.asks[0].price;
              const fill = simulateBookBuy(book.asks, s.sizeUsd);
              if (fill) {
                execPrice = fill.avgPrice;
                execFilledUsd = fill.filledUsd;
              }
              bookCap1c = bookCapacityUsd(book.asks, 1);
              bookCap3c = bookCapacityUsd(book.asks, 3);
            }
          } catch (e) {
            console.warn(`[follow] fetchBook failed for ${c.asset}:`, e);
          }
        }
        // 协议 taker 费:2026-08-04 实测推翻「Polymarket 零手续费」——
        // 头部 100 市场 72 个 feesEnabled,占 24h 量 57.8%,而同一笔 $500 单
        // 的盘口滑点实测 $0.00、taker 费约名义额 2.5%。执行成本里最大的一
        // 项此前完全没进账。价格优先用模拟成交均价(真实吃到的),回退报价。
        // 归因列纪律同 exec_*:未知落 null(绝不当 0),不参与 realized_pnl。
        const m = meta[c.conditionId];
        const feeUsd = m
          ? takerFeeUsd({
              sizeUsd: s.sizeUsd,
              price: execPrice ?? entry,
              feesEnabled: m.feesEnabled,
              schedule: m.feeSchedule,
            })
          : null;
        const shares = positionShares(entry, s.sizeUsd);
        const res = ins.run(
          s.id,
          c.conditionId,
          c.outcome,
          c.asset,
          c.outcomeIndex,
          c.title,
          c.eventSlug,
          nowSec,
          entry,
          c.referencePrice,
          s.sizeUsd,
          shares,
          c.formationTs,
          formationPrice,
          execPrice,
          execBestAsk,
          execFilledUsd,
          feeUsd,
          bookCap1c,
          bookCap3c,
        );
        // changes===0 说明 UNIQUE 命中(并发/竞态下已被开出),不重复计数。
        if (res.changes === 1) {
          opened++;
          // 对外信号台账接线(批次 0):开仓成功即落一条不可变信号事实,
          // position_id 是信号 → 仓位的因果链。台账是下游功能(投递总线/
          // API/存证都只消费它),故任何台账故障只 warn —— 绝不反向影响
          // 纸面开仓主流程,这条红线与 exec_*/formation 归因列同级。
          try {
            recordStrategySignal(db, {
              strategyId: s.id,
              positionId: Number(res.lastInsertRowid),
              conditionId: c.conditionId,
              outcome: c.outcome,
              outcomeIndex: c.outcomeIndex,
              asset: c.asset,
              title: c.title,
              slug: c.slug,
              eventSlug: c.eventSlug,
              formationTs: c.formationTs,
              referencePrice: c.referencePrice,
              walletCount: c.walletCount,
              totalNetUsd: c.totalNetUsd,
              entryPrice: entry,
              sizeUsd: s.sizeUsd,
              emittedAt: nowSec,
              // 向前落库(2026-08-28):触发钱包+彼时评分+逐钱包金额的快照,
              // detector 给什么记什么,不重排不加工 —— 这三样无法回填,
              // 是未来 walk-forward 回放 score 维/真逐钱包阈值的唯一原料。
              wallets: c.wallets,
            });
          } catch (e) {
            console.warn(
              `[follow] strategy_signals 台账写入失败(不影响开仓) ${c.conditionId}/${c.outcome}:`,
              e,
            );
          }
        }
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
      // UMA 争议门:争议中的 closed 市场,outcomePrices 是「提案结果」不是终局
      // —— UMA 可以推翻它。而结算是一次性写入(写完 realized_pnl 就不再重算),
      // 所以按争议中的价格结算 = 把一个可能错的数字永久钉死。保持 open 下轮
      // 再试是唯一可回退的选择。严格 ===true:null(未知/上游没这个字段)照常
      // 结算,fail-open —— 新字段拿不到不该冻结全局结算。
      if (m.umaDisputed === true) {
        console.log(
          `[follow] ${row.condition_id}: UMA 争议中,暂缓结算(下轮再试)`,
        );
        continue;
      }
      const exit = m.outcomePrices[row.outcome_index];
      // outcomePrices 缺项/NaN(gamma 归一化对坏值填 NaN)→ 保持 open,下轮再试。
      if (exit == null || !Number.isFinite(exit)) continue;
      const realized = positionRealizedPnl(row.entry_price, exit, row.size_usd);
      upd.run(nowSec, exit, realized, row.id);
      settled++;
      // 对外信号台账联动(批次 0):结算结果回填到对应信号行(按 position_id
      // 定位)。老仓(台账上线前开的)无台账行 → no-op;容错纪律同开仓接线。
      try {
        backfillSignalSettlement(db, row.id, {
          settledTs: nowSec,
          exitPrice: exit,
          realizedPnl: realized,
        });
      } catch (e) {
        console.warn(
          `[follow] strategy_signals 结算回填失败(不影响结算) position ${row.id}:`,
          e,
        );
      }
    }
  }

  // markout 惰性回填:量化「形成 → 我们跟进」的延迟成本(formation+Δ 时刻的市价,
  // 与 formation_price 相减即 Δ 期 markout,由展示层计算)。open+settled 都要 ——
  // 已结算仓的形成后漂移同样是归因样本。每轮每列最多 MARKOUT_BATCH 仓防请求风暴
  // (5min 轮询下积压会摊到后续轮);单仓失败跳过,列仍为 null,下轮自然重试。
  // 到期判定留 300s 缓冲:价格历史点位是 ~10min 蜡烛,刚过 Δ 的点可能还没落。
  // 红线:formation_price/markout 只用于归因展示,绝不参与 realized_pnl。
  const MARKOUT_GRACE_SEC = 300;
  const MARKOUT_BATCH = 10;
  // 死仓截止期:fetchPriceAt 对已失活/过期 token 恒返回 null,这类仓的 markout
  // 永远填不上。不设截止的话,积累 ≥MARKOUT_BATCH 个死仓后它们会永久占住每轮
  // 名额(饿死所有新仓的回填)并每轮空烧 HTTP —— 形成超过 7 天还填不上的仓
  // 直接出队,不再重试(7 天后回补的 markout 归因价值也早已衰减)。
  const MARKOUT_MAX_AGE_SEC = 7 * 86400;
  let markouts = 0;
  for (const spec of [
    { col: "markout_30m", delta: 1800 },
    { col: "markout_2h", delta: 7200 },
  ]) {
    // ORDER BY formation_ts DESC:新仓优先 —— 反复取不到价的死仓自然沉底,不会
    // 像 ORDER BY id 那样永远霸占 LIMIT 名额;配合上面的 7 天截止彻底出队。
    const due = db
      .prepare(
        `SELECT id, asset, formation_ts FROM follow_positions
          WHERE formation_ts IS NOT NULL AND ${spec.col} IS NULL
            AND formation_ts + ? < ?
            AND formation_ts > ?
          ORDER BY formation_ts DESC LIMIT ?`,
      )
      .all(
        spec.delta + MARKOUT_GRACE_SEC,
        nowSec,
        nowSec - MARKOUT_MAX_AGE_SEC,
        MARKOUT_BATCH,
      ) as {
      id: number;
      asset: string;
      formation_ts: number;
    }[];
    if (due.length === 0) continue;
    const upd = db.prepare(
      `UPDATE follow_positions SET ${spec.col} = ? WHERE id = ?`,
    );
    for (const row of due) {
      const targetTs = row.formation_ts + spec.delta;
      try {
        // 这里取常规最近点(不用 atOrBefore):formation+Δ 是回看,不存在前视问题。
        const p = await fetchPrice(row.asset, targetTs);
        if (p != null && Number.isFinite(p)) {
          upd.run(p, row.id);
          markouts++;
        } else {
          console.warn(
            `[follow] markout ${spec.col} 仓 ${row.id}: ${row.asset}@${targetTs} 无价格点,下轮再试`,
          );
        }
      } catch (e) {
        console.warn(
          `[follow] markout ${spec.col} 仓 ${row.id} 取价失败(下轮再试):`,
          e,
        );
      }
    }
  }

  // market_tilt_history:轮末写(结算/markout 之后)+ 保留期清理。C2
  // (sourceResolved)下一轮靠 readMarketTiltSnapshots 读回这里写的行 —— 顺序
  // 上这一段必须在函数顶部的 readMarketTiltSnapshots 调用之后(它已经是了,
  // 见那里的注释),两者合起来才是"读上一轮、写本轮"这条链路的完整闭环。
  // contestedThisCycle 在截断/无策略/空窗口时是 []([]时 writeMarketTiltSnapshots
  // 直接 no-op),不会用不可信窗口写脏这张表。写/清理失败都只记日志,不影响
  // 已经跑完的 opened/settled/markouts。
  const tiltWritten = writeMarketTiltSnapshots(db, contestedThisCycle, nowSec);
  const tiltPruned = pruneMarketTiltHistory(db, nowSec);

  console.log(
    `[follow] cycle done · strategies=${strategies.length} · opened=${opened} · settled=${settled} · markouts=${markouts} · tiltSnapshots=${tiltWritten} · tiltPruned=${tiltPruned}`,
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
  /**
   * follow_positions 行 id。/api/follow 的 SELECT 恒带(反事实退出分析按它
   * join 模拟结果);标记可选仅为兼容大量既有测试夹具 —— 消费方须自行判空。
   */
  id?: number;
  /**
   * 开仓时的协议 taker 费(USD)。null = 未知(上线前的老仓,或费率表拿不到),
   * 0 = 该市场确实免费。红线同 markout/exec_*:归因列,不参与 realized_pnl。
   */
  fee_usd: number | null;
  /**
   * 容量标尺:开仓瞬间 ask 簿的 +1¢/+3¢ 带内深度(USD)。null = 未知(老仓/
   * 无簿)。可选仅为兼容既有测试夹具;红线同 fee_usd。
   */
  book_cap_1c?: number | null;
  book_cap_3c?: number | null;
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
  /** 全部仓位(open+settled)的累计追价成本 —— 追价成本在进场即产生。 */
  slippageCost: number;
  /**
   * 只算已结算仓的追价成本。存在的唯一理由:要跟 totalRealized/feeCost
   * (都是 settled 口径)相减出「含成本净盈亏」。拿全量去减已结算盈亏,等于
   * 把还没结算的仓的成本提前记进已结算账。
   */
  slippageCostSettled: number;
  /** 已结算且费用已知的仓的协议费合计(USD)。 */
  feeCost: number;
  /** 上面那个数覆盖了几仓 —— 「含协议费」一档必须带覆盖率一起看。 */
  feeSamples: number;
  /** 已结算但费用未知的仓数(上线前的老仓)。 */
  feeUnknown: number;
  /**
   * 「含追价成本 + 协议费」的净额,**只覆盖 feeSamples 那批仓**。
   * 三项(realized / 追价 / 协议费)都限定在同一子集上算 —— 不是拿部分覆盖的
   * 费用去减全量盈亏。展示时必须同时给出 feeSamples/settledCount 覆盖率。
   */
  netAfterCostsCovered: number;
  equityCurve: { ts: number; cum: number }[];
  byCategory: Record<string, { realized: number; settledCount: number }>;
  /**
   * 容量标尺:开仓时 +1¢/+3¢ 带内深度的中位数(USD,open+settled 一视同仁,
   * 容量在进场即产生)。中位数抗离群 —— 一次厚簿会把均值拉到没人信的量级。
   * null = 零样本(页面留白,不显示 $0);bookCapSamples 是覆盖率,必须同展。
   */
  bookCap1cMedian: number | null;
  bookCap3cMedian: number | null;
  bookCapSamples: number;
}

/** 中位数;空数组返回 null。偶数样本取中间两数均值。 */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
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

  const slippageCostSettled = settled.reduce(
    (s, p) =>
      s + positionSlippage(p.entry_price, p.smart_avg_price, p.size_usd),
    0,
  );

  // 协议 taker 费:与 realized 同口径只看 settled(它要跟已结算净盈亏相减),
  // 且只累计「已知」的。fee_usd===0 是已知的零(免费市场),必须与 null(未知)
  // 区分 —— 把未知当 0 正是「零手续费」这个错误前提能活六周的机制。
  const feeSettled = settled.filter((p) => p.fee_usd != null);
  const feeCost = feeSettled.reduce((s, p) => s + (p.fee_usd ?? 0), 0);
  const feeSamples = feeSettled.length;
  const feeUnknown = settledCount - feeSamples;

  // 「含全部成本」净额:三项都限定在【费用已知】的那批仓上算,而不是拿部分
  // 覆盖的费用去减全量盈亏。这么定的原因:费用是 append-only 的,上线前的
  // 老仓永远为 null —— 若沿用「有一个未知就整档留白」的规则,这个指标会
  // 因为历史仓的存在而永远不亮,等于白做。限定子集后三项同口径、数字自洽,
  // 且随着老仓逐渐结算完毕,这个子集会自然收敛到全量。展示层必须同时给出
  // feeSamples/settledCount 的覆盖率,否则读者会把子集当全量。
  const netAfterCostsCovered = feeSettled.reduce(
    (s, p) =>
      s +
      (p.realized_pnl ?? 0) -
      positionSlippage(p.entry_price, p.smart_avg_price, p.size_usd) -
      (p.fee_usd ?? 0),
    0,
  );

  // 容量标尺:open+settled 一视同仁(容量在进场即产生),只统计已知值。
  const cap1s = positions
    .map((p) => p.book_cap_1c)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const cap3s = positions
    .map((p) => p.book_cap_3c)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const bookCap1cMedian = medianOf(cap1s);
  const bookCap3cMedian = medianOf(cap3s);
  const bookCapSamples = cap1s.length;

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
    slippageCostSettled,
    feeCost,
    feeSamples,
    feeUnknown,
    netAfterCostsCovered,
    equityCurve,
    byCategory,
    bookCap1cMedian,
    bookCap3cMedian,
    bookCapSamples,
  };
}

// ---------------------------------------------------------------------------
// 基金式档案指标 —— 把一条跟单策略当一只小基金看:何时成立、跑了多久、最多同时
// 押了多少本金、按峰值本金折算的年化。纯函数、不修改入参;红线:全部只做展示归因,
// 绝不反向影响开仓/结算逻辑。
// ---------------------------------------------------------------------------

export interface FundMetrics {
  // 成立时间(秒):策略 created_at;缺失(老库/异常)回退最早开仓 entry_ts;
  // 两者皆无(全新策略零仓位且无 created_at)为 null。
  startTs: number | null;
  // 运行天数:(nowSec − startTs) / 86400;startTs 缺失为 null。
  runDays: number | null;
  // 峰值占用资金($):任一时刻同时处于持有状态的仓位 size_usd 之和的历史最大值。
  // 即「照这套策略实盘,需要准备多少本金」。open 仓从 entry 起占用至今不释放。
  maxConcurrentUsd: number;
  // 平均年化 = (结算净值 ÷ 峰值占用) × (365 ÷ 运行天数)。仅结算盈亏口径(与整页
  // 一致,不含浮盈)。无结算仓 / 峰值占用为 0 / 运行不足 1 天(短窗年化爆炸)为 null。
  annualizedRoi: number | null;
}

/**
 * 单条策略的基金式档案。positions 是该策略的全部仓位(open+settled)。
 *
 * 峰值占用用扫描线:每仓在 entry_ts 记 +size,settled 仓在 exit_ts 记 −size
 * (open 仓不记出场 —— 资金仍被占用);按时间升序扫,同一时刻「先入后出」——
 * 结算回款与新开仓同秒发生时,新仓的本金必须先备好,这是保守(偏大)的本金
 * 口径,宁可高估所需本金也不虚报资金效率。
 */
export function computeFundMetrics(
  positions: FollowPositionRow[],
  createdAt: number | null,
  nowSec: number,
): FundMetrics {
  const firstEntryTs =
    positions.length > 0
      ? positions.reduce((m, p) => Math.min(m, p.entry_ts), Infinity)
      : null;
  const startTs = createdAt ?? firstEntryTs;
  const runDays = startTs != null ? (nowSec - startTs) / 86400 : null;

  // 扫描线:+entry / −exit 事件按 ts 升序;同 ts 时正 delta(入场)排前(保守峰值)。
  const events: { ts: number; delta: number }[] = [];
  for (const p of positions) {
    events.push({ ts: p.entry_ts, delta: p.size_usd });
    if (p.status === "settled") {
      // settled 却无 exit_ts 属数据异常,与 avgHoldingDays 同口径按 entry_ts 兜底
      // (视作零时长占用,不让异常行虚增峰值)。
      events.push({ ts: p.exit_ts ?? p.entry_ts, delta: -p.size_usd });
    }
  }
  events.sort((a, b) => a.ts - b.ts || b.delta - a.delta);
  let running = 0;
  let maxConcurrentUsd = 0;
  for (const ev of events) {
    running += ev.delta;
    if (running > maxConcurrentUsd) maxConcurrentUsd = running;
  }

  // 年化:仅在「有结算样本 + 有真实本金 + 运行 ≥1 天」时给数,否则诚实置 null ——
  // 几小时窗口的年化没有解释力,宁缺毋滥(与全站小样本标注文化一致)。
  const totalRealized = positions
    .filter((p) => p.status === "settled")
    .reduce((s, p) => s + (p.realized_pnl ?? 0), 0);
  const settledCount = positions.filter((p) => p.status === "settled").length;
  const annualizedRoi =
    settledCount > 0 && maxConcurrentUsd > 0 && runDays != null && runDays >= 1
      ? (totalRealized / maxConcurrentUsd) * (365 / runDays)
      : null;

  return { startTs, runDays, maxConcurrentUsd, annualizedRoi };
}

// ---------------------------------------------------------------------------
// 账户推演 —— 回答「跟这条策略该在账户里备多少钱」。固定 $/仓 + 仓位互相独立
// 使得反事实可以**精确回放**(不像真实复利仓位存在路径耦合):把历史仓位按开仓
// 顺序重演一遍,资金不够就错过、结算即释放,得到每个账户档位下的接住/错过/
// 落袋/效率——账户额建议由数据推导,不靠拍脑袋。纯函数,只做展示归因。
// ---------------------------------------------------------------------------

export interface AccountSimRow {
  accountUsd: number; // 档位:若账户只备这么多钱
  taken: number; // 接住仓数
  missed: number; // 资金不足错过的仓数
  realizedPnl: number; // 接住且已结算的落袋合计
  missedPnl: number; // 错过且已结算的盈亏合计(机会成本;负值=幸运避亏)
  annualizedRoi: number | null; // (realizedPnl ÷ accountUsd) × 365 ÷ 运行天数
  utilization: number | null; // 该档下时间加权平均占用 ÷ accountUsd
}

export interface AccountPlan {
  rows: AccountSimRow[]; // 0.25/0.5/0.75/1/1.25 × 峰值 的档位阶梯
  recommendedUsd: number | null; // 恰好接住全部历史信号的最小资金 = 峰值占用
  // 建议跟单额度 = 峰值 × 1.25(按最小仓量向上取整,恒等于阶梯最高档)。
  // 峰值是「历史恰好够」的下限,~25% 冗余吸收未来峰值抬升;历史口径,非承诺。
  suggestedUsd: number | null;
  avgOccupiedUsd: number; // 全接住时的时间加权平均占用(含零仓闲置期)
  utilization: number | null; // avgOccupiedUsd ÷ recommendedUsd
  annualizedOnRecommended: number | null; // 峰值档年化(与 fund.annualizedRoi 同口径)
}

// 单账户档回放。同刻先入后出:t 时刻退出的资金在 t 时刻不可用(与
// computeFundMetrics 扫描线同口径,保守——宁可高估所需本金)。同刻多笔开仓
// 沿用入参顺序(生产行序≈引擎开仓顺序),不引入额外偏好。
function simulateAccount(
  positions: FollowPositionRow[],
  accountUsd: number,
  startTs: number | null,
  nowSec: number,
): {
  taken: number;
  missed: number;
  takenSettled: number;
  realizedPnl: number;
  missedPnl: number;
  avgOccupiedUsd: number;
} {
  const sorted = [...positions].sort((a, b) => a.entry_ts - b.entry_ts);
  const releases: { ts: number; size: number }[] = []; // 按 ts 升序的待释放资金
  const occEvents: { ts: number; delta: number }[] = []; // 接住仓的占用事件(积分用)
  let occupied = 0;
  let taken = 0;
  let missed = 0;
  let takenSettled = 0;
  let realizedPnl = 0;
  let missedPnl = 0;
  for (const p of sorted) {
    while (releases.length > 0 && releases[0].ts < p.entry_ts) {
      occupied -= releases.shift()!.size;
    }
    if (occupied + p.size_usd > accountUsd) {
      missed++;
      if (p.status === "settled") missedPnl += p.realized_pnl ?? 0;
      continue;
    }
    taken++;
    occupied += p.size_usd;
    occEvents.push({ ts: p.entry_ts, delta: p.size_usd });
    if (p.status === "settled") {
      takenSettled++;
      realizedPnl += p.realized_pnl ?? 0;
      const exitTs = p.exit_ts ?? p.entry_ts; // 数据异常兜底:视作零时长占用
      occEvents.push({ ts: exitTs, delta: -p.size_usd });
      // 有序插入(N 小,线性即可),保持 releases 按 ts 升序。
      let i = releases.length;
      while (i > 0 && releases[i - 1].ts > exitTs) i--;
      releases.splice(i, 0, { ts: exitTs, size: p.size_usd });
    }
  }

  // 时间加权平均占用:∫占用 dt ÷ (nowSec − startTs),含零仓闲置期(闲置现金是
  // 账户体验的一部分)。窗口前的事件夹到 startTs、窗口后的丢弃。
  let avgOccupiedUsd = 0;
  if (startTs != null && nowSec > startTs && occEvents.length > 0) {
    const clamped = occEvents
      .filter((e) => e.ts <= nowSec)
      .map((e) => ({ ts: Math.max(e.ts, startTs), delta: e.delta }))
      .sort((a, b) => a.ts - b.ts);
    let integral = 0;
    let cur = 0;
    let prevTs = startTs;
    for (const e of clamped) {
      integral += cur * (e.ts - prevTs);
      cur += e.delta;
      prevTs = e.ts;
    }
    integral += cur * (nowSec - prevTs);
    avgOccupiedUsd = integral / (nowSec - startTs);
  }

  return {
    taken,
    missed,
    takenSettled,
    realizedPnl,
    missedPnl,
    avgOccupiedUsd,
  };
}

/**
 * 账户档位推演表。档位 = {0.25, 0.5, 0.75, 1, 1.25} × 峰值占用,按最小仓量向上
 * 取整、去重、滤掉接不住任何一仓的档;1.25 冗余档刻意保留——它接住的仓与峰值档
 * 相同,但效率更低,把「多备钱的闲置拖累」摆在明面。年化护栏与 fund 同口径:
 * 无结算接住仓 / 运行不足 1 天 → null。
 */
export function computeAccountPlan(
  positions: FollowPositionRow[],
  fund: FundMetrics,
  nowSec: number,
): AccountPlan {
  const peak = fund.maxConcurrentUsd;
  const sizes = positions.map((p) => p.size_usd).filter((s) => s > 0);
  if (peak <= 0 || sizes.length === 0) {
    return {
      rows: [],
      recommendedUsd: null,
      suggestedUsd: null,
      avgOccupiedUsd: 0,
      utilization: null,
      annualizedOnRecommended: null,
    };
  }
  const minSize = Math.min(...sizes);
  const roundUp = (x: number) => Math.ceil(x / minSize) * minSize;
  // 建议跟单额度:1.25 冗余档。suggested ≥ roundUp(peak) ≥ peak,必然存活于
  // 阶梯(dedupe 只合并等值、filter 不会滤掉 ≥ minSize 的它)。
  const suggestedUsd = roundUp(peak * 1.25);
  const ladder = [
    ...new Set(
      [0.25, 0.5, 0.75, 1, 1.25].map((f) =>
        f === 1 ? peak : roundUp(peak * f),
      ),
    ),
  ]
    .filter((usd) => usd >= minSize)
    .sort((a, b) => a - b);

  const { runDays, startTs } = fund;
  const rows: AccountSimRow[] = ladder.map((accountUsd) => {
    const sim = simulateAccount(positions, accountUsd, startTs, nowSec);
    const annualizedRoi =
      sim.takenSettled > 0 && runDays != null && runDays >= 1
        ? (sim.realizedPnl / accountUsd) * (365 / runDays)
        : null;
    return {
      accountUsd,
      taken: sim.taken,
      missed: sim.missed,
      realizedPnl: sim.realizedPnl,
      missedPnl: sim.missedPnl,
      annualizedRoi,
      utilization:
        startTs != null && nowSec > startTs
          ? sim.avgOccupiedUsd / accountUsd
          : null,
    };
  });

  // 峰值档 = 恰好接住全部(峰值定义使然),其占用轨迹即无约束轨迹,直接复用。
  const recRow = rows.find((r) => r.accountUsd === peak) ?? null;
  const avgOccupiedUsd =
    recRow != null && recRow.utilization != null
      ? recRow.utilization * peak
      : 0;
  return {
    rows,
    recommendedUsd: peak,
    suggestedUsd,
    avgOccupiedUsd,
    utilization: recRow?.utilization ?? null,
    annualizedOnRecommended: recRow?.annualizedRoi ?? null,
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
    // source 是展示用的自由字符串(非 FollowSourceKind):展示侧的纪律是「任何
    // 字段缺失/坏值都退安全默认,绝不因此丢弃整条策略」,即便 params_json 里
    // 塞了个 isFollowSourceKind 认不出的值也要能显示出来,不能因为一个展示字段
    // 打回 parseStrategy 那种「未知即跳过」的严格校验。
    source: string;
    maxPrice: number;
    freshSec: number;
    // 12 档扩充(Task 13 展示层)新增:每个字段只被它对应的信号族读取 ——
    // consensus 用 minWalletScore(A3)/minTotalNetUsd(A4),heavy 用
    // minSingleFillUsd(必需)+minWalletScore(B3),lopsided 用 minTiltPct,
    // lone_wolf 用 minWalletScore+minNetUsd,early_winner 用 minNetUsd。
    // 与 minWallets/minPerWalletUsd(仅 consensus)同一套纪律:某条策略的
    // params_json 里没有这个字段就是 undefined,不是「阈值为 0」—— 展示层
    // 必须按 != null 判断要不要画出对应半句,不能直接当数字渲染(那会把
    // 「未配置」误显示成「阈值 0」)。刻意不收 minPerSideUsd:它对 C1/C2 都是
    // 纯文档字段(两个 detector 都不读),展示侧没有依据能替它宣称"这是一个
    // 生效阈值",详见 lib/db.ts 种子里 C1/C2 两条注释。
    minWalletScore?: number;
    minTotalNetUsd?: number;
    minSingleFillUsd?: number;
    minTiltPct?: number;
    minNetUsd?: number;
    /**
     * 反向对照档标记(2026-08-13):true = 该档对每个信号买对面 outcome
     * (lib/reverse.ts)。展示层靠它画「反向对照」Tag 与参数提示的反向前缀。
     * 恒有值(缺失/脏值 → false),与开仓侧 parseStrategy 同默认 —— 方向
     * 开关的展示绝不能与实际开仓行为对不上。
     */
    reverse: boolean;
  };
  metrics: StrategyMetrics;
  fund: FundMetrics; // 基金式档案:成立/运行/峰值占用/年化(仅展示,不参与任何决策)
  account: AccountPlan; // 账户推演:备多少钱→接住多少信号(仅展示,不参与任何决策)
  open: FollowPositionWithCategory[]; // status==='open'
  settled: FollowPositionWithCategory[]; // status==='settled',按 exit_ts 降序(最新在前)
  /**
   * 反事实退出分析(2026-08-16,lib/exitCounterfactual.ts):该档已结算仓在
   * 九个退出规则下的假想结果聚合。null/缺失 = 尚无已回填路径(回填中或全部
   * 不可回填),面板整块省略。
   */
  exitCounterfactual?:
    import("./exitCounterfactual").ExitCounterfactualSummary | null;
}

/**
 * 视图行 = 仓位行 + 赛道。categoryByCid 此前只喂给 metrics.byCategory 聚合,
 * 没随行下发 —— 深度分析面板(2026-08-13 设计 §4)要在客户端按赛道重切
 * (胜率/均入场价等 byCategory 没有的维度),故逐行附上。缺失 → null,
 * 展示层归「未分类」(与 computeStrategyMetrics 同一兜底口径)。
 * subcategory(2026-08-13 二级分类):体育按 NBA/MLB/足球等联盟细分,
 * 派生规则见 lib/gamma.ts SUBCATEGORIES;null = 无二级/未知。
 */
export type FollowPositionWithCategory = FollowPositionRow & {
  category: string | null;
  subcategory: string | null;
};

/**
 * 每市场的事件税法(一级 + 二级)。与 gamma.EventTaxonomy 同构但独立声明 ——
 * 本文件对 gamma 的既有依赖只有 MarketMeta 的 type import,税法就两个字段,
 * 为它引一条新 import 链不如就地声明(结构兼容,route 直接把
 * getEventCategories 的结果透传进来)。
 */
export type TaxonomyByCid = Record<
  string,
  { category: string | null; subcategory: string | null } | null
>;

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
    // source/maxPrice/freshSec 同样与开仓侧同源默认(见同名常量定义处的注释)——
    // 两侧默认值永远一致,否则界面会展示出一套跟实际开仓行为对不上的参数。
    source: "consensus",
    maxPrice: DEFAULT_MAX_PRICE,
    freshSec: DEFAULT_FRESH_SEC,
    reverse: false,
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
  // 与 numOr 的区别:这五个字段没有「跨 source 通用」的安全默认值可退 ——
  // 0 对 minWalletScore/minSingleFillUsd/...都不是「未配置」的诚实占位(0 分/
  // $0 门槛看着像"什么都能通过"的合法阈值,会被误读成"这条策略真的这么松"),
  // 只有 undefined 才能诚实表达「这个 source 家族没有这项门槛/这条策略没配」。
  // 展示层(paramsHint)据此用 != null 判断要不要画出对应半句。
  const numOrUndef = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const maxDev = numOr(
    p.maxEntryDeviationCents,
    DEFAULT_MAX_ENTRY_DEVIATION_CENTS,
  );
  const maxPrice = numOr(p.maxPrice, DEFAULT_MAX_PRICE);
  const freshSec = numOr(p.freshSec, DEFAULT_FRESH_SEC);
  return {
    minWallets: numOr(p.minWallets, 0),
    minPerWalletUsd: numOr(p.minPerWalletUsd, 0),
    sizeUsd: numOr(p.sizeUsd, 0),
    exitRule: typeof p.exitRule === "string" ? p.exitRule : "settlement",
    // 非正数同样退默认(与开仓侧一致:只有 >0 的显式值才生效)。
    maxEntryDeviationCents:
      maxDev > 0 ? maxDev : DEFAULT_MAX_ENTRY_DEVIATION_CENTS,
    source: typeof p.source === "string" ? p.source : "consensus",
    // 价格是 0-1 小数,>1 视为非法,与开仓侧同一判定式。
    maxPrice: maxPrice > 0 && maxPrice <= 1 ? maxPrice : DEFAULT_MAX_PRICE,
    freshSec: freshSec > 0 ? freshSec : DEFAULT_FRESH_SEC,
    minWalletScore: numOrUndef(p.minWalletScore),
    minTotalNetUsd: numOrUndef(p.minTotalNetUsd),
    minSingleFillUsd: numOrUndef(p.minSingleFillUsd),
    minTiltPct: numOrUndef(p.minTiltPct),
    minNetUsd: numOrUndef(p.minNetUsd),
    // 严格 === true:方向开关被脏值悄悄置真会把整档展示成反向,展示与开仓
    // (parseStrategy 的 reverse 消毒)必须落到同一个答案。
    reverse: p.reverse === true,
  };
}

/**
 * 组装 /api/follow 响应体。
 *  - 按 strategy_id 把 positions 分组;每策略 metrics 用「该策略全部仓位」算。
 *  - fund 档案:created_at + nowSec 流入 computeFundMetrics(nowSec 参数化以便
 *    测试注入固定时刻;route 侧用默认「当前时刻」)。
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
    created_at: number | null;
  }[],
  positions: FollowPositionRow[],
  taxByCid: TaxonomyByCid,
  nowSec: number = Math.floor(Date.now() / 1000),
): { strategies: FollowStrategyView[] } {
  const byStrategy = new Map<number, FollowPositionRow[]>();
  for (const p of positions) {
    const arr = byStrategy.get(p.strategy_id);
    if (arr) arr.push(p);
    else byStrategy.set(p.strategy_id, [p]);
  }

  // metrics.byCategory 只吃一级(键稳定纪律,见二级分类设计 §2 红线):
  // 从税法里投影出与旧 categoryByCid 完全同形的映射喂给
  // computeStrategyMetrics,该函数与它的 byCategory 键零变化。
  const categoryByCid: Record<string, string | null> = {};
  for (const [cid, tax] of Object.entries(taxByCid)) {
    categoryByCid[cid] = tax?.category ?? null;
  }

  const views: FollowStrategyView[] = strategies.map((s) => {
    const own = byStrategy.get(s.id) ?? [];
    const fund = computeFundMetrics(own, s.created_at, nowSec);
    // 逐行附赛道(展开成新对象,不改入参行 —— 见 FollowPositionWithCategory
    // 的注释;route 直选的额外列随展开原样保留)。
    const withCat = (p: FollowPositionRow): FollowPositionWithCategory => ({
      ...p,
      category: taxByCid[p.condition_id]?.category ?? null,
      subcategory: taxByCid[p.condition_id]?.subcategory ?? null,
    });
    return {
      id: s.id,
      name: s.name,
      enabled: !!s.enabled,
      params: parseParamsView(s.params_json),
      metrics: computeStrategyMetrics(own, categoryByCid),
      fund,
      account: computeAccountPlan(own, fund, nowSec),
      open: own.filter((p) => p.status === "open").map(withCat),
      settled: own
        .filter((p) => p.status === "settled")
        .map(withCat)
        .sort((a, b) => (b.exit_ts ?? 0) - (a.exit_ts ?? 0)),
    };
  });

  return { strategies: views };
}
