// 𝕏 播报的数字参数(日上限/金额阈值/窗口/预算)—— /manage 可配。
//
// 与 xSettings 的内容类型开关同一套纪律:config 表 JSON 一行、逐键校验、
// 坏值降级默认、真实变更才写 config_history。引擎每轮读一次,所以改完
// 下一轮(≤60s)生效,无需重启 —— 与账号切换/类型开关同一个即时性承诺。
//
// budgetUsd / whaleMinTradeUsd 的默认值继续来自 env(X_MONTHLY_BUDGET_USD /
// X_MIN_TRADE_USD):没在后台保存过的部署行为一丝不变;保存过之后库里的值
// 优先 —— UI 明示这个优先级。其余键的默认值取各模块的出厂常量,数字只有
// 一个家(DAILY_CAP / PREGAME_MIN_H / WEEKLY_POST_UTC_HOUR),这里不抄第二份。
//
// 刻意不可配的项见 docs/plans/2026-08-25-x-broadcast-params-design.md:
// 单价($0.015/$0.20)是 X 平台计费事实,改了只会腐蚀台账口径;cap 不允许 0
// (「不发」永远用类型开关表达,两个入口一个语义是配置陷阱)。
import type { DB } from "./db";
import { DAILY_CAP } from "./xQuota";
import { PREGAME_MIN_H, PREGAME_MAX_H } from "./xPregame";
import { WEEKLY_POST_UTC_HOUR } from "./xWeekly";
import { PULSE_POST_UTC_HOUR } from "./xPulse";
import { SCORECARD_POST_UTC_HOUR } from "./xScorecard";
import { WHALE_SIREN_USD } from "./xComposer";

export interface XBroadcastParams {
  /** 月预算熔断($/UTC 月),全类型共享。必填硬熔断,不可「不限」。 */
  budgetUsd: number;
  /** 日/周花费上限($,月熔断之下的细分闸);null = 不限(出厂)。 */
  dailySpendCapUsd: number | null;
  weeklySpendCapUsd: number | null;
  /** 巨鲸单笔金额阈值($),低于它的大单在解析阶段就跳过。 */
  whaleMinTradeUsd: number;
  /** 巨鲸日上限(条/天)。 */
  whaleDailyCap: number;
  /** 巨鲸 🚨 警报级抬头分档线($):单笔达到它换 🚨 图标,只影响文案。 */
  whaleSirenUsd: number;
  /**
   * 共识日上限;null = 不限。
   *
   * 出厂**有**上限(2026-08-31 起,见 xQuota.DAILY_CAP 的实测注释)——
   * 「共识天然稀有」这个首版假设被线上数据证伪。null 仍是合法存量值,
   * 运营者可以显式选择不限。
   */
  consensusDailyCap: number | null;
  /** 赛前聚合日上限(条/天)。 */
  pregameDailyCap: number;
  /** 赛前窗口下限(距结算小时数,含)。 */
  pregameMinH: number;
  /** 赛前窗口上限(距结算小时数,含)。必须严格大于下限。 */
  pregameMaxH: number;
  /** 结算战报日上限(条/天)。 */
  settledDailyCap: number;
  /** 周报发帖时刻(周一的 UTC 整点,0-23)。 */
  weeklyUtcHour: number;
  /** 市场脉搏日帖时刻(每日的 UTC 整点,0-23;日榜与分歧两类共用)。 */
  pulseUtcHour: number;
  /** 每日战报榜的发帖时刻(每日的 UTC 整点,0-23)。 */
  scorecardUtcHour: number;
}

/** env 派生的两个默认值(lib/config 解析后传入,本模块不碰 process.env)。 */
export interface XParamEnvDefaults {
  budgetUsd: number;
  whaleMinTradeUsd: number;
}

export function defaultXParams(env: XParamEnvDefaults): XBroadcastParams {
  return {
    budgetUsd: env.budgetUsd,
    dailySpendCapUsd: null,
    weeklySpendCapUsd: null,
    whaleMinTradeUsd: env.whaleMinTradeUsd,
    whaleDailyCap: DAILY_CAP.whale,
    whaleSirenUsd: WHALE_SIREN_USD,
    consensusDailyCap: DAILY_CAP.consensus,
    pregameDailyCap: DAILY_CAP.pregame,
    pregameMinH: PREGAME_MIN_H,
    pregameMaxH: PREGAME_MAX_H,
    settledDailyCap: DAILY_CAP.settled,
    weeklyUtcHour: WEEKLY_POST_UTC_HOUR,
    pulseUtcHour: PULSE_POST_UTC_HOUR,
    scorecardUtcHour: SCORECARD_POST_UTC_HOUR,
  };
}

const CONFIG_KEY = "x_broadcast_params";

// 校验与 route 的 zod 同一套规则(读写两侧同规,见设计文档)。
// 单键非法 → 只回落该键;绝不让一个坏键拖垮整份配置。
const isPosUsd = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
const isCap = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1;
const isUtcHour = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23;
const isWindowH = (v: unknown, minIncl: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= minIncl && v <= 168;

export function getXBroadcastParams(
  db: DB,
  env: XParamEnvDefaults,
): XBroadcastParams {
  const def = defaultXParams(env);
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(CONFIG_KEY) as { value: string | null } | undefined;
  if (!row || !row.value) return def;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    console.warn(`[xParams] corrupt JSON for '${CONFIG_KEY}', using defaults`);
    return def;
  }
  if (typeof parsed !== "object" || parsed === null) return def;
  const p = parsed as Record<string, unknown>;

  const out = { ...def };
  if (isPosUsd(p.budgetUsd)) out.budgetUsd = p.budgetUsd;
  // null 是合法存量(明确的「不限」),与「键缺失/键坏了」(回落默认)不同。
  if (p.dailySpendCapUsd === null || isPosUsd(p.dailySpendCapUsd)) {
    out.dailySpendCapUsd = p.dailySpendCapUsd;
  }
  if (p.weeklySpendCapUsd === null || isPosUsd(p.weeklySpendCapUsd)) {
    out.weeklySpendCapUsd = p.weeklySpendCapUsd;
  }
  if (isPosUsd(p.whaleMinTradeUsd)) out.whaleMinTradeUsd = p.whaleMinTradeUsd;
  if (isCap(p.whaleDailyCap)) out.whaleDailyCap = p.whaleDailyCap;
  if (isPosUsd(p.whaleSirenUsd)) out.whaleSirenUsd = p.whaleSirenUsd;
  // null 是合法存量(明确的「不限」),与「键缺失/键坏了」(回落默认)不同。
  if (p.consensusDailyCap === null || isCap(p.consensusDailyCap)) {
    out.consensusDailyCap = p.consensusDailyCap;
  }
  if (isCap(p.pregameDailyCap)) out.pregameDailyCap = p.pregameDailyCap;
  if (isWindowH(p.pregameMinH, 0)) out.pregameMinH = p.pregameMinH;
  // 上限必须为正:maxH=0 的窗口不存在。
  if (isWindowH(p.pregameMaxH, 0) && p.pregameMaxH > 0) {
    out.pregameMaxH = p.pregameMaxH;
  }
  if (isCap(p.settledDailyCap)) out.settledDailyCap = p.settledDailyCap;
  if (isUtcHour(p.weeklyUtcHour)) out.weeklyUtcHour = p.weeklyUtcHour;
  if (isUtcHour(p.pulseUtcHour)) out.pulseUtcHour = p.pulseUtcHour;
  if (isUtcHour(p.scorecardUtcHour)) {
    out.scorecardUtcHour = p.scorecardUtcHour;
  }

  // 窗口倒挂(手改库才可能出现):两端一起回落 —— 空窗口会让赛前线静默
  // 消失,比参数被重置更难察觉。
  if (!(out.pregameMinH < out.pregameMaxH)) {
    console.warn(
      `[xParams] pregame window inverted (${out.pregameMinH}-${out.pregameMaxH}h), falling back to ${def.pregameMinH}-${def.pregameMaxH}h`,
    );
    out.pregameMinH = def.pregameMinH;
    out.pregameMaxH = def.pregameMaxH;
  }
  return out;
}

export function setXBroadcastParams(db: DB, p: XBroadcastParams): void {
  const next = JSON.stringify(p);
  const prev = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(CONFIG_KEY) as { value: string | null } | undefined;
  if (prev?.value !== next) {
    db.prepare(
      "INSERT INTO config_history (key, value, changed_at) VALUES (?, ?, ?)",
    ).run(CONFIG_KEY, next, Math.floor(Date.now() / 1000));
  }
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    CONFIG_KEY,
    next,
  );
}
