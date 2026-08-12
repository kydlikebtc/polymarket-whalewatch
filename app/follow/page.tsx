"use client";

// 共识跟单 · 纸面模拟看板。只读消费 /api/follow —— 现价进场、持有到结算、固定
// $/信号、仅结算盈亏(不做浮盈)。设计系统组件/类全部复用 app/ui.tsx + globals.css,
// 净值曲线用内联 SVG 阶梯折线(无图表依赖),多策略靠"线型 × 颜色"组合区分
// (12 档同屏叠画,仅线型不够用,颜色也要真正承担区分职责,见 STRATEGY_STROKES)。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Modal, Segmented, Tag } from "../ui";
import {
  classifyCardState,
  sparklineAreaPath,
  sparklinePath,
} from "../../lib/followCardView";

/* ------------------------------------------------------------- API types */
// 客户端本地类型:镜像 lib/follow 的视图结构,但独立声明,避免把 server 侧
// (better-sqlite3 依赖链)拖进浏览器 bundle。title/event_slug 为 route 直选列,
// 运行时存在、类型上设为可选以保持宽容。

type FollowPositionRow = {
  strategy_id: number;
  condition_id: string;
  outcome: string;
  title?: string;
  event_slug?: string;
  size_usd: number;
  entry_price: number;
  smart_avg_price: number;
  shares: number;
  status: "open" | "settled";
  entry_ts: number;
  exit_ts: number | null;
  exit_price: number | null;
  realized_pnl: number | null;
  // P1 三段成本分解归因列(route 直选,老仓位/取价失败为 null;类型上设可选以对
  // 旧响应宽容):formation_ts/price = 共识形成时刻与彼时市价,markout_30m/2h =
  // 形成后 30min/2h 的回填市价。只用于归因展示,绝不参与盈亏计算。
  formation_ts?: number | null;
  formation_price?: number | null;
  markout_30m?: number | null;
  markout_2h?: number | null;
  // 执行层归因:开仓瞬间盘口快照模拟吃单(仅新仓有值,老仓 null)。
  exec_price?: number | null;
  exec_best_ask?: number | null;
  exec_filled_usd?: number | null;
};

type StrategyMetrics = {
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
  // 已结算仓口径的追价成本(与全量 slippageCost 区分)。
  slippageCostSettled: number;
  // 「含追价+协议费」净额,只覆盖协议费已知的那批已结算仓(见 lib/follow)。
  netAfterCostsCovered: number;
  // 协议 taker 费(2026-08 起采集)。feeSamples 是覆盖率分子 —— 上线前的
  // 老仓 fee_usd 为 null,「含协议费」一档必须带着 n= 一起读。
  feeCost: number;
  feeSamples: number;
  feeUnknown: number;
  equityCurve: { ts: number; cum: number }[];
  byCategory: Record<string, { realized: number; settledCount: number }>;
};

// 基金式档案(镜像 lib/follow 的 FundMetrics):成立/运行/峰值占用/年化。
type FundMetrics = {
  startTs: number | null;
  runDays: number | null;
  maxConcurrentUsd: number;
  annualizedRoi: number | null;
};

// 账户推演(镜像 lib/follow 的 AccountSimRow/AccountPlan):备多少钱→接住多少。
type AccountSimRow = {
  accountUsd: number;
  taken: number;
  missed: number;
  realizedPnl: number;
  missedPnl: number;
  annualizedRoi: number | null;
  utilization: number | null;
};

type AccountPlan = {
  rows: AccountSimRow[];
  recommendedUsd: number | null;
  suggestedUsd: number | null;
  avgOccupiedUsd: number;
  utilization: number | null;
  annualizedOnRecommended: number | null;
};

type FollowStrategyView = {
  id: number;
  name: string;
  enabled: boolean;
  params: {
    minWallets: number;
    minPerWalletUsd: number;
    sizeUsd: number;
    exitRule: string;
    // 进场价偏离护栏(¢)。server 侧 parseParamsView 恒有值(默认 10);类型上留
    // 可选以对旧响应宽容,展示时按 10 兜底。
    maxEntryDeviationCents?: number;
    // 12 档扩充(Task 13):source 决定这一档属于哪个信号族(见 familyOf);
    // maxPrice/freshSec 是全局护栏,server 侧 parseParamsView 恒有值,可选只
    // 为兼容旧响应。其余五个是各信号族的专属阈值——只有对应 source 的策略
    // 才会有值,其它策略里恒为 undefined(不是"阈值 0","缺失"与"阈值为 0"
    // 含义完全不同,见 sourceCoreHint 的 != null 判断)。
    source?: string;
    maxPrice?: number;
    freshSec?: number;
    minWalletScore?: number;
    minTotalNetUsd?: number;
    minSingleFillUsd?: number;
    minTiltPct?: number;
    minNetUsd?: number;
  };
  metrics: StrategyMetrics;
  // 基金式档案与账户推演:新响应恒有;类型可选以对旧响应宽容,缺失时不渲染/显示「—」。
  fund?: FundMetrics;
  account?: AccountPlan;
  open: FollowPositionRow[];
  settled: FollowPositionRow[];
};

type FollowResponse = {
  strategies: FollowStrategyView[];
  error?: string;
};

// 合并各策略仓位到一张表时,给每行贴上来源策略名(表内可标注归属)。
type LabeledRow = FollowPositionRow & { strategyName: string };

// 仓位明细的两个 tab:已结算 / 持有中(替代旧版上下两段排列)。
type PosTab = "settled" | "open";

// 策略筛选的「全部」哨兵值。策略 id 从 1 起(AUTOINCREMENT),0 不会撞真实 id。
const FILTER_ALL = 0;

// 卡片/列表视图切换,记住用户选择。key 沿用 app/useSound.ts 的 ww_ 前缀
// 约定(该文件是本仓库目前唯一在用 localStorage 的先例)。
type ViewMode = "card" | "list";
const VIEW_MODE_KEY = "ww_follow_view";

/* --------------------------------------------------------------- format */

const MINUS = "−"; // U+2212,与 ui.tsx fmtSignedUsdCompact 一致(不用 ASCII 连字符)

function fmtUsd0(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// 带符号美元:+$1,234 / −$1,234。0 记为 +$0。
function fmtSignedUsd(n: number): string {
  const sign = n < 0 ? MINUS : "+";
  return `${sign}$${fmtUsd0(Math.abs(n))}`;
}

// 概率价(0–1)转美分标签:0.62 → 62.0¢。
function cents(p: number): string {
  return `${(p * 100).toFixed(1)}¢`;
}

// 持有时长:<1 天用小时,否则一位小数的天。
function fmtHold(sec: number): string {
  const days = sec / 86400;
  if (days < 1) return `${Math.max(0, Math.round(days * 24))} 小时`;
  return `${days.toFixed(1)} 天`;
}

// 成立日期:秒时间戳 → YYYY-MM-DD(本地时区,基金档案用)。
function fmtDate(ts: number): string {
  const d = new Date(ts * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// 年化收益率:±X%。|值|≥100% 取整(±1825% 不需要小数),否则一位小数。
function fmtAnnualized(r: number): string {
  const pct = Math.abs(r * 100);
  return `${r >= 0 ? "+" : MINUS}${pct.toFixed(pct >= 100 ? 0 : 1)}%`;
}

// 动作时间:M/D HH:mm(本地时区,操作历史用);完整时间放 title 悬停。
function fmtDateTime(ts: number): string {
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mi}`;
}

function pnlTone(n: number): "up" | "down" {
  return n >= 0 ? "up" : "down";
}

// 单仓追价成本(旧称跟单滑点,美元)= 份额 ×(自己入场价 − 聪明钱建仓均价)。
// 与 lib/follow 的 positionSlippage 同口径,此处就地计算,避免把 server lib 引入客户端。
function rowSlippage(p: FollowPositionRow): number {
  return p.shares * (p.entry_price - p.smart_avg_price);
}

// 单仓追价 ¢ 差 =(自己入场价 − 聪明钱建仓均价)× 100 —— 看板主显示口径。
// 美元口径受份额膨胀影响(入场价越低份额越大,绝对值可超本金),¢ 差才可跨仓横比。
function rowSlipCents(p: FollowPositionRow): number {
  return (p.entry_price - p.smart_avg_price) * 100;
}

// 买入成本三段分解:聪明钱均价 →(信息租金,拿不到别追)→ 形成价 →(延迟成本,
// 系统可优化)→ 进场价。下面两个函数是后两段的展示口径。

// 单仓延迟成本 ¢ =(进场价 − 形成价)× 100。正=共识形成后我们追贵了(检测+执行
// 延迟);formation_price 缺失(老仓位/取价失败)返回 null,由调用方显示「—」。
function rowDelayCents(p: FollowPositionRow): number | null {
  return p.formation_price != null
    ? (p.entry_price - p.formation_price) * 100
    : null;
}

// 形成后 2h 走势 ¢ =(markout_2h − 形成价)× 100,衡量"共识形成后还有没有肉"。
// 两值任一缺失(未到期/回填失败/老仓位)返回 null。
function rowMarkout2hCents(p: FollowPositionRow): number | null {
  return p.markout_2h != null && p.formation_price != null
    ? (p.markout_2h - p.formation_price) * 100
    : null;
}

// 形成后走势着色:这是价格方向(不是成本),沿用全站涨绿跌红语义,与信号验证
// 1h/24h 口径一致 —— ±0.5¢ 死区内记平推(muted)。
function markoutToneClass(c: number): string {
  if (Math.abs(c) <= 0.5) return "muted";
  return c > 0 ? "up" : "down";
}

// 执行滑点 ¢ =(盘口模拟成交均价 − 报价入场价)× 100 —— 买入成本分解的最后一段
// (价差 + 深度)。开仓瞬间盘口快照;盘口无历史,老仓恒 null。
function rowExecCents(p: FollowPositionRow): number | null {
  return p.exec_price != null ? (p.exec_price - p.entry_price) * 100 : null;
}

// 执行滑点单元格:中性色(是成本不是盈亏);盘口深度吃不满本仓名义金额时转琥珀
// 并标「薄」,悬停给出实际可成交额 —— 薄盘警示与部分成交事实一体呈现。
function ExecCell({ p }: { p: FollowPositionRow }) {
  const c = rowExecCents(p);
  if (c == null) return <span className="muted">—</span>;
  const partial =
    p.exec_filled_usd != null && p.exec_filled_usd < p.size_usd * 0.999;
  return (
    <span
      className="mono"
      style={partial ? { color: "var(--warn-700)" } : undefined}
      title={
        partial
          ? `盘口深度不足:$${fmtUsd0(p.size_usd)} 名义只能成交 $${fmtUsd0(
              p.exec_filled_usd ?? 0,
            )},均价按已成交部分计`
          : undefined
      }
    >
      {fmtSignedCents(c)}
      {partial ? <span className="muted">(薄)</span> : null}
    </span>
  );
}

// 带符号 ¢ 差:+5.9¢ / −19.9¢(0 记 +0.0¢)。
function fmtSignedCents(c: number): string {
  const sign = c < 0 ? MINUS : "+";
  return `${sign}${Math.abs(c).toFixed(1)}¢`;
}

// 追价成本着色原则:一律中性 —— 负值绝不标绿(它常意味着「价格已反向/接飞刀」,
// 不是捡便宜);正值也不标红(不是亏损,是成本)。仅 |¢差| 超过警示线时用琥珀
// (全站琥珀=警示语义),与开仓侧默认护栏 10¢ 同一分界。
const SLIP_WARN_CENTS = 10;
function slipWarnStyle(cents: number): CSSProperties | undefined {
  return Math.abs(cents) > SLIP_WARN_CENTS
    ? { color: "var(--warn-700)" }
    : undefined;
}

// 结算胜率 + Wilson 95% 区间,如「83% · 95%CI 44–97%」。无判定样本时置「—」。
function winRateLabel(m: StrategyMetrics): string {
  if (m.winRate == null) return "—";
  const pct = Math.round(m.winRate * 100);
  const lo = Math.round(m.winRateCI.lo * 100);
  const hi = Math.round(m.winRateCI.hi * 100);
  return `${pct}% · 95%CI ${lo}–${hi}%`;
}

/* ------------------------------------------------------- 12 档 · 信号族分类 */
// source → 信号族的分组呈现(Task 13)。四族按"信息强度递减"排序,也是各族
// 内部实现的顺序:共识(多人独立同向)→ 异常大额(单笔巨量本身即信号)→
// 分歧(聪明钱不合但有主导边)→ 钱包画像(单钱包的历史身份撑腰)。每族一句
// 话回答"这一族在验证什么假设",与 docs/plans/2026-08-11-follow-strategy-
// tiers-design.md §9.1(战绩不可跨档相加)是同一处设计决策的两个呈现面。
type FamilyKey = "consensus" | "heavy" | "disagreement" | "wallet" | "other";

const FAMILY_META: Record<FamilyKey, { title: string; blurb: string }> = {
  consensus: {
    title: "共识",
    blurb: "N 个聪明钱同时看多同一边,值不值得跟。",
  },
  heavy: {
    title: "异常大额",
    blurb: "一笔巨额单本身算不算信号(不等第 N 人到位)。",
  },
  disagreement: {
    title: "分歧",
    blurb: "聪明钱意见不一致时,能不能跟主导边。",
  },
  wallet: {
    title: "钱包画像",
    blurb: "一个足够好的钱包,一个人说了算吗。",
  },
  // 兜底组:未来新增 source 但还没来得及接进上面四族时,不能让那张策略卡从
  // 页面上消失——消失比归类不准更危险(会被误读成"这条策略被停用/没生效"),
  // 卡片本身的指标/仓位渲染跟 source 无关,照样能完整展示。命中这一组本身
  // 就是一个待办信号,提醒开发者回来给新 source 在 familyOf 里分类。
  other: {
    title: "其它",
    blurb: "尚未归入以上四族的信号源。",
  },
};

const FAMILY_ORDER: FamilyKey[] = [
  "consensus",
  "heavy",
  "disagreement",
  "wallet",
  "other",
];

// 按族分组后的一组(FollowPage 的 groups 就是这个形状)。FamilyToggles 与
// 新增的 StrategyListView(卡片/列表切换)都要接这份数据,提成一个类型
// 别名,不在两处各写一遍相同的内联对象类型。
type FamilyGroup = {
  key: FamilyKey;
  meta: { title: string; blurb: string };
  items: FollowStrategyView[];
};

// source → 信号族。与 lib/followCandidate.ts 的 FOLLOW_SOURCE_KINDS 六个值
// 一一对应;任何不在这六种里的字符串(含 undefined,调用处已兜到 "consensus")
// 都归入 "other",绝不抛错或让卡片消失。
function familyOf(source: string): FamilyKey {
  switch (source) {
    case "consensus":
      return "consensus";
    case "heavy":
      return "heavy";
    case "lopsided":
    case "resolved":
      return "disagreement";
    case "lone_wolf":
    case "early_winner":
      return "wallet";
    default:
      return "other";
  }
}

// 每档一个 emoji(卡片标题行、列表策略列都用同一份,单一映射源)。核实过
// 项目里已经在用的 emoji 语义,避免撞车:
//   🐳 = 大额成交"巨鲸"档位(lib/alert.ts WHALE_TIER_USD、page.tsx/
//       accumulation.tsx/alerts.tsx 全站一致)——「巨鲸」这一档复用它,读者
//       不用学新符号。
//   💰 = "大单"(次于巨鲸的成交量级),🏆 = 聪明钱白名单(钱包身份,不是
//       策略维度的东西)——两个都已被占满,不会再拿来标某个策略档。
//   🔥 = 共识,⚖️ = 分歧(app/consensus/page.tsx「🔥 共识 · ⚖️ 分歧」、
//       市场信号卡「⚖️ 聪明钱分歧」、Telegram 播报同一对):「分歧解除」
//       所在的分歧族用 ⚖️ 是同一语义的延伸,不是新造。
//   🎯 表面看合适(app/discovery/page.tsx 与 lib/walletTags.ts 都把
//       early_winner 标成 🎯「早期赢家」,与「早期赢家跟投」这档同源),但
//       它在全站的主要角色是 app/ui.tsx 的 MarketSlugActions 里"点开这个
//       市场的信号卡"这个可点击动作(几乎每张列表/表格的市场列旁边都有)。
//       在这里把它摆成纯装饰、不可点击的策略图标,容易让人以为点了会跳转。
//       改用 🌱(早期/新生)避开这个"看着像按钮"的风险。
//   🐋 是 app/ui.tsx TopNav 的站点品牌图标("🐋 Polymarket 监控",每页顶栏
//       常驻),「超级巨鲸」原计划沿用 🐋 会和站点 logo 撞在同一屏——改用
//       🌊,仍在"海洋"的视觉家族里,但不会被读成"这是另一个 logo"。
// 其余 8 个此前未被占用,按"同族内视觉关联、跨族能区分"选定。
const STRATEGY_EMOJI: Record<string, string> = {
  保守: "🛡️",
  激进: "⚡",
  精英共识: "💎",
  重仓共识: "🏋️",
  首发共识: "🚀",
  巨鲸: "🐳",
  超级巨鲸: "🌊",
  巨鲸精英: "🦈",
  一边倒分歧: "⚖️",
  分歧解除: "🏳️",
  高分独狼: "🐺",
  早期赢家跟投: "🌱",
};
// 兜底:未来加新档、来不及补映射时不能让页面报 undefined 或崩掉——退回
// 空字符串(不显示图标,而不是显示一个可能撞语义的占位符号)。
function strategyEmoji(name: string): string {
  return STRATEGY_EMOJI[name] ?? "";
}

/* --------------------------------------------------------- params 展示口径 */
// 与 lib/follow.ts(DEFAULT_FRESH_SEC/DEFAULT_MAX_PRICE,均未导出)、
// lib/disagreement.ts(DEFAULT_DISAGREEMENT.lopsidedTiltPct)同步的展示侧
// 默认值。客户端刻意不 import 这些 server 侧模块(见文件顶部注释:避免把
// better-sqlite3 依赖链拖进浏览器 bundle),故在此镜像字面量——与既有的
// `maxEntryDeviationCents ?? 10` 同一约定,三侧改动需要同步维护。
const DEFAULT_FRESH_SEC_DISPLAY = 900;
const DEFAULT_MAX_PRICE_DISPLAY = 0.95;
const DEFAULT_LOPSIDED_TILT_PCT_DISPLAY = 0.7;

// 家族专属半句:不同 source 读的是完全不同的门槛字段,硬套「≥N 钱包」的共识
// 话术会把 7/12 档显示成「≥0 钱包 · 每钱包 ≥$0」——这几个字段在非 consensus
// 策略的 params_json 里压根不存在,是 parseParamsView 的展示占位,不是"这一
// 档真的门槛是 0"。minWalletScore/minTotalNetUsd/minSingleFillUsd/
// minTiltPct/minNetUsd 这五个新参数也是在这里第一次被渲染出来(复审发现此前
// 完全没有 UI 消费它们)。
function sourceCoreHint(p: FollowStrategyView["params"]): string {
  const source = p.source ?? "consensus";
  switch (source) {
    case "consensus": {
      const parts = [
        `≥${p.minWallets} 钱包`,
        `每钱包 ≥$${fmtUsd0(p.minPerWalletUsd)}`,
      ];
      if (p.minWalletScore != null) parts.push(`钱包评分≥${p.minWalletScore}`);
      // 重仓共识(A4)最容易被望文生义的地方:"重仓"说的是触发信号的那批
      // 聪明钱自己的总净买规模,不是我们自己的仓位——我们的仓位统一是下面
      // 「$X/信号」那一句(12 档 sizeUsd 全是 $500)。两句故意分开写、用词
      // 也刻意不同("总投入" vs "/信号"),不让读者把两个数字看成同一件事。
      if (p.minTotalNetUsd != null)
        parts.push(`聪明钱总投入 ≥$${fmtUsd0(p.minTotalNetUsd)}`);
      return parts.join(" · ");
    }
    case "heavy": {
      const parts = [`单笔 ≥$${fmtUsd0(p.minSingleFillUsd ?? 0)}`];
      if (p.minWalletScore != null) parts.push(`钱包评分≥${p.minWalletScore}`);
      return parts.join(" · ");
    }
    case "lopsided": {
      // minTiltPct 是 C1(detectLopsidedCandidates)真会读的开关——
      // `params.minTiltPct ?? DEFAULT_DISAGREEMENT.lopsidedTiltPct`,不是像
      // minPerSideUsd 那样的纯文档字段。缺省时展示侧按同一个默认值(0.7)
      // 兜底,与实际生效值保持一致(见 DEFAULT_LOPSIDED_TILT_PCT_DISPLAY)。
      const pct = Math.round(
        (p.minTiltPct ?? DEFAULT_LOPSIDED_TILT_PCT_DISPLAY) * 100,
      );
      return `一边倒分歧 · 主导边占比≥${pct}%`;
    }
    case "resolved":
      // C2 没有任何逐策略可调阈值——detectResolvedCandidates 只看上一轮
      // 分歧快照 + 本轮现金流是否"认输"(isCapitulating),不读 params 的
      // 任何字段(minPerSideUsd 与 C1 一样是纯文档字段,两个 detector 都不
      // 读它)。如实描述触发条件,不假装存在一个可调数字。
      return "分歧解除 · 少数边由净买转净卖";
    case "lone_wolf": {
      const parts = ["单钱包信号"];
      if (p.minWalletScore != null) parts.push(`钱包评分≥${p.minWalletScore}`);
      if (p.minNetUsd != null) parts.push(`净买≥$${fmtUsd0(p.minNetUsd)}`);
      return parts.join(" · ");
    }
    case "early_winner": {
      const parts = ["早期赢家渠道钱包"];
      if (p.minNetUsd != null) parts.push(`净买≥$${fmtUsd0(p.minNetUsd)}`);
      return parts.join(" · ");
    }
    default:
      // 未知 source:不假装认识它的专属字段,只把原始值报出来——提醒这张卡
      // 需要有人回来给 sourceCoreHint/familyOf 补一支,而不是编造一句看似
      // 正常、实则杜撰的门槛描述。
      return `source=${source}(未接入展示层)`;
  }
}

function paramsHint(p: FollowStrategyView["params"]): string {
  const exit = p.exitRule === "settlement" ? "持有到结算" : p.exitRule;
  // 偏离护栏:字段缺失(旧响应)按 10 兜底,与 lib/follow 开仓侧默认一致。
  const maxDev = p.maxEntryDeviationCents ?? 10;
  const freshSec = p.freshSec ?? DEFAULT_FRESH_SEC_DISPLAY;
  const maxPrice = p.maxPrice ?? DEFAULT_MAX_PRICE_DISPLAY;
  const parts = [
    sourceCoreHint(p),
    `$${fmtUsd0(p.sizeUsd)}/信号`,
    `偏离≤${maxDev}¢`,
  ];
  // 新鲜度/价格上限是全局护栏,12 档目前只有「首发共识」把新鲜度收紧到 5
  // 分钟——只在偏离默认值时才画出来,避免其余 11 张卡都重复同一句无差别
  // 信息(价格上限当前没有任何一档覆盖默认值,但未来若加专项价格带档位,
  // 这里已经能正确画出来)。
  if (freshSec !== DEFAULT_FRESH_SEC_DISPLAY) {
    parts.push(`新鲜度≤${Math.round(freshSec / 60)}分`);
  }
  if (maxPrice !== DEFAULT_MAX_PRICE_DISPLAY) {
    parts.push(`价格≤${Math.round(maxPrice * 100)}¢`);
  }
  parts.push(exit);
  return parts.join(" · ");
}

// 卡片用的精简参数提示:只留跨档差异化的门槛(sourceCoreHint)+ 偏离默认值
// 的护栏覆盖(新鲜度/价格上限,与 paramsHint 同一套判断,重复写一遍是因为
// 只有两个廉价的 !== 比较,不值得为此把 paramsHint 拆成"核心部分+统一部分"
// 两段——那样反而会改变 paramsHint 现有的拼接顺序,给一个已经在跑的函数
// 引入不必要的风险)。丢掉的是 12 档全都一样的三项:$/信号、偏离护栏本身
// 的数值、持有到结算——那三项要么已经在页面顶部说过一次("固定 $/信号 ·
// 持有到结算"),要么完整版 paramsHint 原样搬进了详情弹窗(见
// StrategyDetailDialog),不是丢了,只是卡片不重复。目标 1 行,而不是原来
// 320px 卡宽下常见的 3 行。
function cardParamsHint(p: FollowStrategyView["params"]): string {
  const freshSec = p.freshSec ?? DEFAULT_FRESH_SEC_DISPLAY;
  const maxPrice = p.maxPrice ?? DEFAULT_MAX_PRICE_DISPLAY;
  const parts = [sourceCoreHint(p)];
  if (freshSec !== DEFAULT_FRESH_SEC_DISPLAY) {
    parts.push(`新鲜度≤${Math.round(freshSec / 60)}分`);
  }
  if (maxPrice !== DEFAULT_MAX_PRICE_DISPLAY) {
    parts.push(`价格≤${Math.round(maxPrice * 100)}¢`);
  }
  return parts.join(" · ");
}

// 市场展示名:优先 title,回退到 event_slug / condition_id。
function marketLabel(p: FollowPositionRow): string {
  return p.title || p.event_slug || p.condition_id;
}

/* ---------------------------------------------------- equity curve (SVG) */

// 多策略叠加(最多 12 档同屏):4 色 × 3 线型 = 12 种两两不重复的组合,颜色
// 刻意避开 up/down(绿/红是盈亏语义,图例里紧挨着的净值数字就用这两色,撞了
// 会让读者误以为线条颜色代表盈亏)。全部取设计系统 token,不写死 hex ——
// globals.css 是色值单一真相源。
//
// 只有 3 种线型,4 条一组共享同一线型,所以颜色不再只是"辅助":同线型的 4 条
// 之间,颜色是唯一的区分依据。为了不让色盲用户在"相邻"两档之间只能靠色相
// 判断,下面按"颜色外层、线型内层"的顺序展开(COLORS.flatMap(color =>
// DASHES.map(dash => ...))),这样任意相邻下标(i, i+1)之间线型必然不同
// (同色的 3 条内部靠线型区分;跨色边界处线型和颜色一起变)——线型差异始终
// 能独立承担"这是两条不同的线"这件事,颜色只在跨过 3 条之外时才成为唯一
// 依据。
const STRATEGY_DASHES: (string | undefined)[] = [
  undefined, // 实线
  "7 4", // 长虚线
  "10 4 2 4", // 虚点相间(点状"2 4"在阶梯图的短线段上容易视觉消失,弃用)
];
const STRATEGY_COLORS = [
  "var(--brand-500)", // 电蓝 · 品牌主色
  "var(--n-900)", // 近黑 · 最强中性色
  "var(--warn-700)", // 深琥珀 · 与蓝/黑拉开色相,兼容色觉差异
  "var(--n-500)", // 中灰 · 弱中性色,与近黑靠明度而非色相区分
];
const STRATEGY_STROKES = STRATEGY_COLORS.flatMap((color) =>
  STRATEGY_DASHES.map((dash) => ({ dash, color })),
);
const strokeFor = (i: number) => STRATEGY_STROKES[i % STRATEGY_STROKES.length];

type CurveSeries = {
  id: number;
  name: string;
  strokeIdx: number;
  // 族开关(改版 Task 4)按这个字段过滤要不要画这条线;strokeIdx 仍按
  // shown 的原始顺序分配、不受族过滤影响,保证同一策略的线型+颜色不会
  // 因为切换族开关而改变(见 FollowPage 里 series 的构造注释)。
  family: FamilyKey;
  curve: { ts: number; cum: number }[];
};

// 阶梯折线(step-after):每个结算点之前维持前一水平,到该点垂直跳变到新累计值。
function stepPath(
  curve: { ts: number; cum: number }[],
  sx: (t: number) => number,
  sy: (v: number) => number,
): string {
  if (curve.length === 0) return "";
  const pts = [...curve].sort((a, b) => a.ts - b.ts);
  let d = `M ${sx(pts[0].ts).toFixed(1)} ${sy(pts[0].cum).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const x = sx(pts[i].ts).toFixed(1);
    d += ` L ${x} ${sy(pts[i - 1].cum).toFixed(1)}`;
    d += ` L ${x} ${sy(pts[i].cum).toFixed(1)}`;
  }
  return d;
}

const axisFmt = (v: number) => `${v < 0 ? MINUS : ""}$${fmtUsd0(Math.abs(v))}`;

function EquityCurve({ series }: { series: CurveSeries[] }) {
  // hover 高亮(改版 Task 4):悬停/聚焦某条图例时,该线加粗、其余线连同
  // 结算点一起降到 20% 透明度,帮读者从 12 档同屏叠画里挑出一条线看。放在
  // 最前面、任何 early return 之前——Hooks 规则要求每次渲染都无条件调用,
  // 不能被下面「暂无已结算仓位」的提前 return 跳过。
  const [hoverId, setHoverId] = useState<number | null>(null);
  const withData = series.filter((s) => s.curve.length > 0);
  if (withData.length === 0) {
    return (
      <div className="ds-empty">
        暂无已结算仓位 — 有策略平仓后这里会画出结算净值阶梯曲线
      </div>
    );
  }

  const W = 720;
  const H = 220;
  const padL = 48;
  const padR = 12;
  const padT = 14;
  const padB = 26;
  const x0 = padL;
  const x1 = W - padR;
  const y0 = padT;
  const y1 = H - padB;

  // x 域:所有策略的结算时间戳;y 域:累计已实现盈亏,始终含 0 基线。
  let tMin = Infinity;
  let tMax = -Infinity;
  let cMin = 0;
  let cMax = 0;
  for (const s of withData) {
    for (const pt of s.curve) {
      if (pt.ts < tMin) tMin = pt.ts;
      if (pt.ts > tMax) tMax = pt.ts;
      if (pt.cum < cMin) cMin = pt.cum;
      if (pt.cum > cMax) cMax = pt.cum;
    }
  }
  const padY = (cMax - cMin) * 0.08 || 1; // 峰谷各留一点头部空间;全平时给 1
  const yMax = cMax + padY;
  const yMin = cMin - padY;

  const tSpan = tMax - tMin;
  const sx = (t: number) =>
    tSpan === 0 ? (x0 + x1) / 2 : x0 + ((t - tMin) / tSpan) * (x1 - x0);
  const ySpan = yMax - yMin;
  const sy = (v: number) =>
    ySpan === 0 ? (y0 + y1) / 2 : y1 - ((v - yMin) / ySpan) * (y1 - y0);

  const yZero = sy(0);

  // x 轴时间刻度:端点 + 两个三分点(等距,不追求整点对齐——结算是离散事件,
  // 完整覆盖首尾比整点更重要)。跨度 ≥3 天只标日期,更短带时分;相邻重复标签
  // 去重(极短窗口下四个刻度会格式化成同一串)。
  const fmtTick = (ts: number) => {
    const d = new Date(ts * 1000);
    const md = `${d.getMonth() + 1}/${d.getDate()}`;
    if (tSpan >= 3 * 86400) return md;
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${md} ${hh}:${mi}`;
  };
  const tickTs =
    tSpan === 0 ? [tMin] : [0, 1 / 3, 2 / 3, 1].map((f) => tMin + f * tSpan);
  const ticks: {
    x: number;
    label: string;
    anchor: "start" | "middle" | "end";
  }[] = [];
  for (let i = 0; i < tickTs.length; i++) {
    const label = fmtTick(tickTs[i]);
    if (ticks.length > 0 && ticks[ticks.length - 1].label === label) continue;
    ticks.push({
      x: sx(tickTs[i]),
      label,
      // 端点标签朝内锚定,避免溢出绘图区(左端撞 y 轴刻度、右端出画布)。
      anchor:
        tSpan === 0
          ? "middle"
          : i === 0
            ? "start"
            : i === tickTs.length - 1
              ? "end"
              : "middle",
    });
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ height: "auto", display: "block" }}
        role="img"
        aria-label="各策略结算净值(累计已实现盈亏)阶梯曲线"
      >
        {/* 0 基线 */}
        <line
          x1={x0}
          y1={yZero}
          x2={x1}
          y2={yZero}
          stroke="var(--n-300)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        {/* y 轴刻度:峰值 / 0 / 谷底 */}
        <text
          x={x0 - 6}
          y={sy(cMax)}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={10}
          fill="var(--n-500)"
          className="mono"
        >
          {axisFmt(cMax)}
        </text>
        <text
          x={x0 - 6}
          y={yZero}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={10}
          fill="var(--n-400)"
          className="mono"
        >
          $0
        </text>
        <text
          x={x0 - 6}
          y={sy(cMin)}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={10}
          fill="var(--n-500)"
          className="mono"
        >
          {axisFmt(cMin)}
        </text>
        {/* x 轴时间刻度:浅色竖网格线 + 底部时间标签 */}
        {ticks.map((t) => (
          <g key={t.x}>
            <line
              x1={t.x}
              y1={y0}
              x2={t.x}
              y2={y1}
              stroke="var(--n-200)"
              strokeWidth={1}
              strokeDasharray="2 4"
            />
            <text
              x={t.x}
              y={y1 + 15}
              textAnchor={t.anchor}
              fontSize={10}
              fill="var(--n-500)"
              className="mono"
            >
              {t.label}
            </text>
          </g>
        ))}
        {/* 各策略阶梯线 + 结算点。用 <g> 整组设 opacity——同一组里的线和它
            的结算点一起淡化,不必在 path 和每个 circle 上分别算一遍(也不
            会出现"线淡了、点还是实心"这种半淡化的观感,这正是圆点会浮在
            淡化线上的问题的根)。 */}
        {withData.map((s) => {
          const st = strokeFor(s.strokeIdx);
          const isHovered = hoverId === s.id;
          const dimmed = hoverId != null && !isHovered;
          return (
            <g key={s.id} opacity={dimmed ? 0.2 : 1}>
              <path
                d={stepPath(s.curve, sx, sy)}
                fill="none"
                stroke={st.color}
                strokeWidth={isHovered ? 2.6 : 1.8}
                strokeDasharray={st.dash}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {s.curve.map((pt, i) => (
                <circle
                  key={i}
                  cx={sx(pt.ts)}
                  cy={sy(pt.cum)}
                  r={2.5}
                  fill={st.color}
                />
              ))}
            </g>
          );
        })}
      </svg>
      {/* 图例:虚实样条 + 策略名 + 净值。每项可 hover 也可键盘 Tab 到再用
          onFocus/onBlur 触发——onMouseEnter/onMouseLeave 只覆盖鼠标用户,
          纯键盘用户等于没有这个功能。tabIndex=0(不是 ui.tsx tip-pop 那种
          -1)是特意的:-1 只能点击聚焦、永远不进 Tab 顺序,这里恰恰需要
          Tab 能到达。 */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--s-4)",
          marginTop: "var(--s-2)",
        }}
      >
        {withData.map((s) => {
          const st = strokeFor(s.strokeIdx);
          const net = s.curve[s.curve.length - 1]?.cum ?? 0;
          return (
            <span
              key={s.id}
              tabIndex={0}
              onMouseEnter={() => setHoverId(s.id)}
              onMouseLeave={() => setHoverId(null)}
              onFocus={() => setHoverId(s.id)}
              onBlur={() => setHoverId(null)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--s-2)",
              }}
            >
              <svg width={26} height={8} aria-hidden>
                <line
                  x1={1}
                  y1={4}
                  x2={25}
                  y2={4}
                  stroke={st.color}
                  strokeWidth={2}
                  strokeDasharray={st.dash}
                />
              </svg>
              <span className="ds-hint">{s.name}</span>
              <span className={`mono ${pnlTone(net)}`}>
                {fmtSignedUsd(net)}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

// 族开关(改版 Task 4):默认全开,点击独立切换某族的可见性。用一排独立
// 切换按钮而不是 Segmented——Segmented 是单选语义(同一时刻只有一个
// value),但读者的真实需求是任意子集:可能只想看共识族,也可能想把共识族
// 和异常大额族放在一起比。样式复用 ui.tsx SoundToggle 同一套写法
// (ds-btn + ds-btn--subtle/ds-btn--ghost + aria-pressed),不新造 CSS。
// groups 直接复用页面已经算好的按族分组结果(卡片分组用的同一份),只给
// 「确实有策略」的族一个按钮——族数 <2 时开关没有意义(无从比较),不渲染。
function FamilyToggles({
  groups,
  active,
  onToggle,
}: {
  groups: FamilyGroup[];
  active: Set<FamilyKey>;
  onToggle: (key: FamilyKey) => void;
}) {
  if (groups.length < 2) return null;
  return (
    <div
      role="group"
      aria-label="按信号族筛选净值曲线"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "var(--s-2)",
        marginBottom: "var(--s-3)",
      }}
    >
      {groups.map((g) => {
        const on = active.has(g.key);
        return (
          <button
            key={g.key}
            type="button"
            className={`ds-btn ${on ? "ds-btn--subtle" : "ds-btn--ghost"}`}
            aria-pressed={on}
            onClick={() => onToggle(g.key)}
            title={g.meta.blurb}
          >
            {g.meta.title} · {g.items.length}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------- metric / cards */

// 单个指标块:eyebrow 标签 + 值节点(值节点自带 up/down/mono 类,不套 kpi-value
// 以免颜色被覆盖)。
function Metric({
  label,
  value,
  title,
}: {
  label: string;
  value: ReactNode;
  title?: string;
}) {
  return (
    <div title={title}>
      <div className="ds-label">{label}</div>
      <div style={{ marginTop: "var(--s-1)" }}>{value}</div>
    </div>
  );
}

/**
 * 净值走势图(原「卡片 sparkline」,U6 从卡片移入详情弹窗「区 1」并放大)。
 *
 * U6 的起点:240×52 的卡片尺寸画不出可读坐标轴,形状又因各自缩放不可横比,
 * 只回答得了"大致涨还是跌"——这件事结算净值的正负号已经答过了,占卡片上
 * 最大一块视觉面积不值当。放大到详情弹窗(接近 1200px 宽)后这两个限制都
 * 不存在了,遂加上坐标轴,让它真正回答"这档的盈亏是怎么走出来的"。
 *
 * width/height 现在是入参(不再是函数内部写死的 240×52),调用方按场地大小
 * 传。sparklinePath/sparklineAreaPath(lib/followCardView.ts)本身的签名与
 * "各自定域缩放"的逻辑都不动——这里把 padL/padTB 这部分留白从传给它们的
 * width/height 里预先扣掉,再用 <g transform="translate(...)"> 整体平移,
 * 腾出坐标轴文字的位置,不需要为了加坐标轴去改那两个纯函数。
 *
 * 颜色按终值正负取 up/down 语义色,与「结算净值」的着色一致。
 */
function Sparkline({
  curve,
  width,
  height,
}: {
  curve: { ts: number; cum: number }[];
  width: number;
  height: number;
}) {
  if (curve.length === 0) return null;
  const net = curve[curve.length - 1]?.cum ?? 0;
  const tone = net >= 0 ? "var(--up-500)" : "var(--down-500)";
  // 左侧留白放 y 轴文字(峰值/0/谷底,美元额可能到 5 位数);上下留白放
  // 峰值/谷底标签本身的字高,避免 dominantBaseline="middle" 的文字被顶部/
  // 底部边缘裁掉一半。数值取自 EquityCurve 同类留白(padL=48)的量级,
  // 这里字号更小、但金额可能更长,稍微放宽到 56/12。
  const padL = 56;
  const padTB = 12;
  const plotW = width - padL;
  const plotH = height - padTB * 2;

  // 单点特判(逻辑不变,W/H 换成入参):sparklinePath 对唯一点只产出
  // "M x y"(无 L 段),SVG 不会画出任何可见线段;sparklineAreaPath 仍会把
  // 这个孤点和两个底角连成一个与曲线形状无关的楔形色块(见
  // lib/followCardView.ts 顶部注释)。画一条贯穿绘图区的虚线 + 这一个值
  // 本身——只有一个样本点,谈不上走势,虚线明确传达"数据不足以连线"。
  if (curve.length === 1) {
    const y = height / 2;
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        role="img"
        aria-label={`唯一一笔已结算:${fmtSignedUsd(net)}`}
      >
        <line
          x1={padL}
          y1={y}
          x2={width}
          y2={y}
          stroke={tone}
          strokeWidth={1.6}
          strokeDasharray="3 3"
        />
        <text
          x={padL - 6}
          y={y}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={11}
          fill={tone}
          className="mono"
        >
          {axisFmt(net)}
        </text>
      </svg>
    );
  }

  const line = sparklinePath(curve, plotW, plotH);
  if (!line) return null;

  // y 轴标签复用与 sparklinePath 内部完全相同的定域公式(该函数只返回一条
  // path 字符串,不导出 lo/hi/sy;签名按要求不能改,这里只能就地重算同一份
  // min/max——两行 Math.min/max,不是什么值得抽公共函数的重计算)。
  // AXIS_PAD 常量与 lib/followCardView.ts 的 PAD 保持一致,否则标签位置会
  // 和实际画出来的折线端点对不上。
  const AXIS_PAD = 4;
  const vals = curve.map((p) => p.cum);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo;
  const sy = (v: number) =>
    padTB +
    (span > 0
      ? AXIS_PAD + (1 - (v - lo) / span) * (plotH - AXIS_PAD * 2)
      : plotH / 2);
  const showZero = lo <= 0 && 0 <= hi;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", height: "auto", display: "block" }}
      role="img"
      aria-label={`结算净值走势,当前 ${fmtSignedUsd(net)}`}
    >
      {/* 0 基线:只在 0 真的落在这条曲线的取值范围内才画,否则会在可视区
          之外画一条不对应任何东西的线,比不画更误导。 */}
      {showZero ? (
        <line
          x1={padL}
          y1={sy(0)}
          x2={width}
          y2={sy(0)}
          stroke="var(--n-300)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      ) : null}
      <text
        x={padL - 6}
        y={sy(hi)}
        textAnchor="end"
        dominantBaseline="middle"
        fontSize={11}
        fill="var(--n-500)"
        className="mono"
      >
        {axisFmt(hi)}
      </text>
      {showZero ? (
        <text
          x={padL - 6}
          y={sy(0)}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={11}
          fill="var(--n-400)"
          className="mono"
        >
          $0
        </text>
      ) : null}
      {/* span===0(全部结算点累计值相同)时峰值=谷底,不重复画同一个标签。 */}
      {span > 0 ? (
        <text
          x={padL - 6}
          y={sy(lo)}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={11}
          fill="var(--n-500)"
          className="mono"
        >
          {axisFmt(lo)}
        </text>
      ) : null}
      <g transform={`translate(${padL}, ${padTB})`}>
        <path
          d={sparklineAreaPath(line, plotW, plotH)}
          fill={tone}
          opacity={0.1}
        />
        <path d={line} fill="none" stroke={tone} strokeWidth={1.6} />
      </g>
    </svg>
  );
}

// 策略卡标准尺寸(不自适应)。宽度固定值(见下方网格 `repeat(auto-fit,
// ${CARD_WIDTH}px)`,不用 minmax(…, 1fr)——1fr 会把列宽拉伸到随容器变化,
// 380px 容器和 900px 容器下同样 3 列但卡宽能差 100px,三种卡态高度又参差,
// 整片卡片区显得凌乱。
//
// 紧凑化那轮考虑过把 320 缩窄到 280 左右换 1180px 容器下 4 列——算过账发现
// 不划算:6 指标 2×3 网格靠 `minmax(130px, 1fr)` 撑开,2 列需要内容区
// ≥130+16+130=276px;卡宽缩到 280、内边距按下面收紧到 12px 后,内容区只剩
// 280-24=256px,不够 276,网格会从 2 列塌成 1 列,指标区从 3 行变 6 行——
// 宽度省的那点空间,换来的是高度反涨,与"更紧凑"的目标正好相反。保持
// 320 不动,把紧凑化全部压在高度上(见下方 CARD_MIN_HEIGHT)。
const CARD_WIDTH = 320;
// 高度取 normal/low_sample 态(两者结构相同,是三态里内容最多的)的估算自然
// 高度,按紧凑化后的新结构逐块加总(均取 320px 卡宽、真实种子数据里最长的
// 名字/参数提示串为准):
//   卡内 padding(--s-4→--s-3,上下各 12px)          ≈ 24px
//   标题行(emoji+名字+可能的标签)                   1 行 ≈ 36px
//   参数提示(cardParamsHint 只剩差异化门槛,压到 1 行,
//     不再是 paramsHint 全量版本那 3 行)             ≈ 18px
//   6 个核心指标 2×3 网格(结算胜率的 Wilson CI 文本
//     较长,保守按换行 2 行估;行间距收紧到 --s-2=8px,
//     3 行 + 2 道行间距)                             ≈162px
//   元信息行(已结算·持有·运行,含上边框/内边距)       ≈ 39px
//   CardActions(含上边框/内边距,单行按钮)             ≈ 57px
// 合计 ≈336px,取整加一点余量 → 350(比上一轮的 420 少 70,主要来自参数
// 提示 3 行→1 行省下的 ~52px、padding 收紧省的 8px、网格行距收紧省的
// 8px)。minHeight 仍然只是地板:偏高一点不会裁内容,偏低才会让长文案挤出
// 这个"标准尺寸"的假象。
const CARD_MIN_HEIGHT = 350;

function StrategyCard({
  s,
  leading,
}: {
  s: FollowStrategyView;
  leading: boolean;
}) {
  const m = s.metrics;
  const fund = s.fund; // 旧响应可能缺失 → 档案各项显示「—」
  const state = classifyCardState(m);
  // 建议跟单额度(U6 从 CardActions 收进指标网格)所需。
  const acct = s.account;
  const hasPlan = !!acct && acct.rows.length > 0 && acct.suggestedUsd != null;
  return (
    <div
      className="ds-card"
      style={{
        // 紧凑化:内边距从 --s-4(16px)收一档到 --s-3(12px)——仍是设计系统
        // 里的标准间距值,不是压到 0,目标是紧凑不是拥挤。
        padding: "var(--s-3)",
        // 标准尺寸:宽由外层网格的固定列宽拉伸决定(grid 默认 stretch,这里
        // 不必再显式写 width),高用 minHeight(非 height)兜底到 normal 态
        // 的自然高度——策略名极端情况下换行,minHeight 只设下限,卡会自然
        // 长高而不是裁内容,同行的 grid 会跟着等高,不会出现内容被切掉的卡。
        minHeight: CARD_MIN_HEIGHT,
        display: "flex",
        flexDirection: "column",
        // 领先卡用品牌色描边 + 抬升阴影强调,全部走 token,不硬编码色。
        ...(leading
          ? {
              borderColor: "var(--brand-500)",
              boxShadow: "var(--shadow-md)",
            }
          : null),
        // 空档(尚无已结算仓位):虚线边框 + 浅灰底,把「还没轮到它」和「跑了
        // 但没赚到钱」在视觉上分开 —— 见下方 empty 分支注释。
        ...(state === "empty"
          ? { borderStyle: "dashed", background: "var(--n-50)" }
          : null),
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-2)",
          flexWrap: "wrap",
          marginBottom: "var(--s-3)",
        }}
      >
        {/* emoji 与列表视图共用同一份 STRATEGY_EMOJI 映射,同一档在两种视图
            下永远是同一个符号。aria-hidden:纯装饰,策略名本身已经是可读的
            文字标识,emoji 不承载屏幕阅读器需要的额外信息。 */}
        <span aria-hidden>{strategyEmoji(s.name)}</span>
        <strong style={{ fontSize: "var(--t-lg)", color: "var(--n-900)" }}>
          {s.name}
        </strong>
        {leading ? <Tag variant="brand">本窗口领先</Tag> : null}
        {!s.enabled ? <Tag variant="warn">已停用</Tag> : null}
      </div>
      {/* 精简参数提示(见 cardParamsHint 注释):只留跨档差异化门槛,压到
          1 行——12 档统一的三项(单价/偏离护栏/退出规则)挪进了详情弹窗,
          不是丢了。 */}
      <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
        {cardParamsHint(s.params)}
      </div>
      {/* 中段:固定高度后 empty 态内容最少,原样顶对齐会在卡底留一整块空白、
          说明文字贴在顶部很难看。用 flex:1 让这段吃掉 minHeight 撑出来的
          富余空间,再按状态选 justifyContent——empty 态居中,其余状态维持
          原来的顶对齐(sparkline/指标网格本来就接近撑满,居中与顶对齐视觉
          上没有区别,不必分叉判断)。 */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: state === "empty" ? "center" : "flex-start",
        }}
      >
        {state === "empty" ? (
          // 空档:10 条新档刚上线时全是这个状态。虚线边框 + 说明把「还没轮到
          // 它」和「跑了但没赚到钱」在视觉上分开 —— 沿用正常卡样式会显示 12
          // 张写满「—」的同样大小的卡,容易被误判成「新档都不工作」。
          <div
            className="ds-hint"
            style={{
              textAlign: "center",
              padding: "var(--s-4) 0",
              lineHeight: 1.7,
            }}
          >
            {m.openCount > 0 ? (
              <>
                尚无已结算仓位
                <br />
                持有 {m.openCount} 仓 · 等待首次结算
              </>
            ) : (
              <>
                尚无仓位
                <br />
                等待信号命中
              </>
            )}
          </div>
        ) : (
          // U6:sparkline 移出卡片(详情弹窗区 1 放大展示),原地换成两个
          // 从下沉区收回来的指标——平均年化(战绩全景同款,详情里仍保留
          // 一份,全景本就该有重复)、建议跟单额度(原来在 CardActions 的
          // 按钮行,现在按钮行只留「查看详情」)。4→6 个,320px 卡宽下
          // minmax(130px,1fr) 自然出 2 列 3 行,不用改网格写法。行间距从
          // --s-3(12px)收紧到 --s-2(8px)——紧凑化的一部分,列间距不动
          // (列间距不影响卡高)。
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
              gap: "var(--s-2) var(--s-4)",
            }}
          >
            <Metric
              label="结算净值"
              title="已结算仓位累计已实现盈亏(不含持仓浮盈)"
              value={
                <span
                  className={`mono ${pnlTone(m.totalRealized)}`}
                  style={{ fontSize: 20, fontWeight: 700 }}
                >
                  {fmtSignedUsd(m.totalRealized)}
                </span>
              }
            />
            <Metric
              label="ROI"
              title="结算净值 ÷ 已投入本金(仅已结算仓)"
              value={
                m.roi == null ? (
                  <span className="muted">—</span>
                ) : (
                  <span
                    className={`mono ${pnlTone(m.roi)}`}
                    style={{ fontSize: 18, fontWeight: 600 }}
                  >
                    {m.roi >= 0 ? "+" : MINUS}
                    {Math.abs(m.roi * 100).toFixed(1)}%
                  </span>
                )
              }
            />
            {/* 平均年化:小样本外推极不可靠(真实数据出现过 2.6 天窗口
                外推 +20205% 的先例)。这条进了首屏就不再是可选装饰,下面
                元信息行的 ⚠ 已结算仅 N 仓警示紧跟在这个网格之后(sparkline
                拿掉后两者之间不再隔着 64px 的曲线区),title 里也把"短窗口
                外推不可靠"这句话原样带上——与战绩全景的同一个 Metric 完全
                同源,不是另写一份可能措辞不一致的说明。 */}
            <Metric
              label="平均年化"
              title="结算净值 ÷ 峰值占用资金 × 365 ÷ 运行天数。把策略当一只小基金:按历史峰值备足本金、自成立日起折算年化。短窗口/小样本外推极不可靠,仅供横向对比;无结算仓或运行不足 1 天显示 —"
              value={
                fund?.annualizedRoi == null ? (
                  <span className="muted">—</span>
                ) : (
                  <span
                    className={`mono ${pnlTone(fund.annualizedRoi)}`}
                    style={{ fontSize: 18, fontWeight: 600 }}
                  >
                    {fmtAnnualized(fund.annualizedRoi)}
                  </span>
                )
              }
            />
            <Metric
              label="结算胜率"
              title="盈利仓 ÷(盈利+亏损)仓 · Wilson 95% 置信区间;平局不计入分母"
              value={<span className="mono">{winRateLabel(m)}</span>}
            />
            <Metric
              label="最大回撤"
              title="净值曲线从峰值到后续谷底的最大跌幅(美元)"
              value={
                <span
                  className={`mono ${m.maxDrawdown > 0 ? "down" : "muted"}`}
                >
                  {m.maxDrawdown > 0
                    ? `${MINUS}$${fmtUsd0(m.maxDrawdown)}`
                    : "$0"}
                </span>
              }
            />
            <Metric
              label="建议跟单额度"
              title="= 历史峰值占用 × 1.25(按单仓金额向上取整),即恰好接住全部历史信号的最小资金 + ~25% 冗余;历史窗口口径,未来峰值可能更高。推导细节与五档精确回放见「查看详情 → 账户推演」"
              value={
                hasPlan ? (
                  <span className="mono" style={{ fontWeight: 600 }}>
                    ${fmtUsd0(acct!.suggestedUsd!)}
                  </span>
                ) : (
                  <span className="muted">—</span>
                )
              }
            />
          </div>
        )}
      </div>
      {/* 元信息行:取代被下沉的「已结算 · 持有」指标。low_sample 档在这里加
          警示色,提醒读者上面的 ROI/胜率是小样本(<10 仓)读数,而不是隐藏
          它们——藏起来会让读者误以为这档没数据,标警示才是诚实的做法。 */}
      <div
        className="ds-hint"
        style={{
          display: "flex",
          gap: "var(--s-3)",
          flexWrap: "wrap",
          borderTop: "1px solid var(--n-100)",
          paddingTop: "var(--s-2)",
          marginTop: "var(--s-3)",
        }}
      >
        {state === "low_sample" ? (
          <span style={{ color: "var(--warn-700)" }}>
            ⚠ 已结算仅 {m.settledCount} 仓
          </span>
        ) : (
          <span>已结算 {m.settledCount} 仓</span>
        )}
        <span>持有 {m.openCount}</span>
        {fund?.runDays != null ? (
          <span>运行 {Math.floor(fund.runDays)} 天</span>
        ) : null}
      </div>
      <CardActions s={s} />
    </div>
  );
}

// 均延迟成本 / 均执行滑点的派生计算。策略详情弹窗(Task 3)里战绩全景
// (StrategyFullMetrics)与成本四段分解(CostChain)两区都要展示这两个数——
// 在 StrategyDetailDialog 层级算一次、两区传参复用,避免同一个 reduce 在
// 同一次弹窗渲染里跑两遍(两区口径一致,分别再算一遍也不会得到不同数字,
// 纯粹是浪费)。
type DelayExecAverages = {
  avgDelayCents: number | null;
  delaySamples: number;
  avgExecCents: number | null;
  execSamples: number;
};

function computeDelayExecAverages(
  positions: FollowPositionRow[],
): DelayExecAverages {
  // 均延迟成本:仅统计有 formation_price 的仓位(老仓位/取价失败不进样本),
  // 每仓等权算术平均;样本数以 n=N 标注,提醒读者小样本不可过度解读。
  const delayVals = positions
    .map(rowDelayCents)
    .filter((c): c is number => c != null);
  const avgDelayCents =
    delayVals.length > 0
      ? delayVals.reduce((sum, c) => sum + c, 0) / delayVals.length
      : null;
  // 均执行滑点:仅统计有盘口快照的仓位(执行层上线后的新仓),每仓等权平均。
  const execVals = positions
    .map(rowExecCents)
    .filter((c): c is number => c != null);
  const avgExecCents =
    execVals.length > 0
      ? execVals.reduce((sum, c) => sum + c, 0) / execVals.length
      : null;
  return {
    avgDelayCents,
    delaySamples: delayVals.length,
    avgExecCents,
    execSamples: execVals.length,
  };
}

/**
 * 卡片瘦身(改版 Task 2)后被下沉的 10 个指标,从原 StrategyCard 原样搬迁
 * 而来,Task 3 挂进策略详情弹窗「区 2 战绩全景」(StrategyDetailDialog;
 * U6 在前面加了一个「区 1 净值走势」,原来的区 1 顺移成区 2)。
 * 用「整体搬迁函数体」而不是删掉重写,是为了保证这些 Metric 的 title
 * (例如「平均年化」那条解释了短窗外推不可靠)不经过人手转录、零丢失风险。
 * U6 之后「平均年化」这一条在卡片正文里也有一份同源渲染(见 StrategyCard),
 * 是有意的重复——详情本就该有全景,不是漏删。
 *
 * delayExec 由调用方算好传入(见上面 computeDelayExecAverages 的注释),
 * 不在本函数内部重算;avgSlipCents 只在本区使用,仍然就地算。
 */
function StrategyFullMetrics({
  s,
  delayExec,
}: {
  s: FollowStrategyView;
  delayExec: DelayExecAverages;
}) {
  const m = s.metrics;
  const fund = s.fund; // 旧响应可能缺失 → 档案各项显示「—」
  const slip = m.slippageCost;
  // 均 ¢ 差/仓:所有仓位(open+settled,追价成本在进场即产生)的单仓 ¢ 差算术平均。
  // 简单口径 —— 每仓等权、不按 usd 加权;目的只是把美元合计还原成可横比的偏离度。
  const allPos = [...s.open, ...s.settled];
  const avgSlipCents =
    allPos.length > 0
      ? allPos.reduce((sum, p) => sum + rowSlipCents(p), 0) / allPos.length
      : null;
  const { avgDelayCents, delaySamples, avgExecCents, execSamples } = delayExec;
  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: "var(--s-3) var(--s-4)",
        }}
      >
        <Metric
          label="平均年化"
          title="结算净值 ÷ 峰值占用资金 × 365 ÷ 运行天数。把策略当一只小基金:按历史峰值备足本金、自成立日起折算年化。短窗口/小样本外推极不可靠,仅供横向对比;无结算仓或运行不足 1 天显示 —"
          value={
            fund?.annualizedRoi == null ? (
              <span className="muted">—</span>
            ) : (
              <span
                className={`mono ${pnlTone(fund.annualizedRoi)}`}
                style={{ fontSize: 18, fontWeight: 600 }}
              >
                {fmtAnnualized(fund.annualizedRoi)}
              </span>
            )
          }
        />
        <Metric
          label="已结算 · 持有"
          title="已结算平仓数 · 当前持仓待结算数"
          value={
            <span className="mono">
              {m.settledCount}
              <span className="muted"> · </span>
              {m.openCount}
            </span>
          }
        />
        <Metric
          label="累计追价成本"
          title="旧称「累计滑点」。份额 ×(自己入场价 − 聪明钱建仓均价)之和(美元)。正=追高多付的成本;负≠捡便宜(常是行情已反向/接飞刀)。注意:这不是盘口执行滑点——纸面按报价快照成交,价差/深度等执行成本未计入。中性展示,请结合单仓 ¢ 差与已实现盈亏一起看"
          value={
            <>
              {/* 配色中性:追价成本不是盈亏,不用涨绿跌红。 */}
              <span className="mono">
                {slip >= 0 ? `$${fmtUsd0(slip)}` : `${MINUS}$${fmtUsd0(-slip)}`}
              </span>
              {avgSlipCents != null ? (
                <div className="kpi-sub mono">
                  均 {fmtSignedCents(avgSlipCents)}/仓
                </div>
              ) : null}
            </>
          }
        />
        <Metric
          label="协议费(taker)"
          title="开仓瞬间按 gamma feeSchedule 算的协议 taker 费之和(仅已结算仓)。公式 fee = 份额 × rate × p ×(1−p);对定额买单等价于 金额 × rate ×(1−p) —— 随成交价单调递减,冷门票才是相对最贵的($500 @0.2 约 4%、@0.5 约 2.5%、@0.9 约 0.5%)。「Polymarket 零手续费」已于 2026-08-04 实测作废:头部 100 市场 72 个收费、占 24h 量 57.8%,横跨 7 个品类。这一项通常远大于盘口执行滑点。费率表是当前值,老仓不回填,故带 n= 覆盖率"
          value={
            m.feeSamples === 0 ? (
              <>
                <span className="muted">—</span>
                <div className="kpi-sub mono">n=0</div>
              </>
            ) : (
              <>
                {/* 配色中性:费用是成本不是盈亏。 */}
                <span className="mono">
                  {MINUS}${fmtUsd0(m.feeCost)}
                </span>
                <div className="kpi-sub mono">
                  n={m.feeSamples}
                  {m.feeUnknown > 0 ? ` · ${m.feeUnknown} 仓未知` : null}
                </div>
              </>
            )
          }
        />
        <Metric
          label="净盈亏(含追价+协议费)"
          title="三档口径里最接近实盘的一档:已实现盈亏 − 追价成本 − 协议费。上面的「已实现盈亏」是纸面档,不含任何执行成本。⚠️ 口径范围:三项都只在【协议费已知】的那批已结算仓上计算,而不是拿部分覆盖的费用去减全量盈亏(那会得到一个介于两档之间、无法解释的数)。协议费自 2026-08 起才采集、老仓不回填,所以这一档目前只覆盖一个子集;随着老仓陆续结算完毕会自然收敛到全量"
          value={
            m.feeSamples === 0 ? (
              <>
                <span className="muted">—</span>
                <div className="kpi-sub mono">n=0</div>
              </>
            ) : (
              <>
                <span className={`mono ${pnlTone(m.netAfterCostsCovered)}`}>
                  {fmtSignedUsd(m.netAfterCostsCovered)}
                </span>
                <div className="kpi-sub mono">
                  覆盖 {m.feeSamples}/{m.settledCount} 仓
                </div>
              </>
            )
          }
        />
        <Metric
          label="均延迟成本"
          title="有形成价的仓位的(进场价 − 形成价)¢ 算术平均。正=共识形成后我们追贵了 —— 检测+执行延迟造成的可优化成本;与「累计追价成本」(vs 聪明钱均价、含拿不到的信息租金)口径不同。老仓位无形成价,不进样本"
          value={
            avgDelayCents == null ? (
              <span className="muted">—</span>
            ) : (
              <>
                {/* 配色中性:延迟成本不是盈亏;|¢|>10 琥珀,与进场偏离护栏阈一致。 */}
                <span className="mono" style={slipWarnStyle(avgDelayCents)}>
                  {fmtSignedCents(avgDelayCents)}
                </span>
                <div className="kpi-sub mono">n={delaySamples}</div>
              </>
            )
          }
        />
        <Metric
          label="均执行滑点"
          title="有盘口快照的仓位的(模拟成交均价 − 报价入场价)¢ 算术平均 —— 真实执行成本(跨价差+吃深度)的实测估计。开仓瞬间抓 CLOB 订单簿、按本仓名义金额模拟市价吃单;盘口无历史,执行层上线前的老仓不进样本"
          value={
            avgExecCents == null ? (
              <span className="muted">—</span>
            ) : (
              <>
                {/* 配色中性:执行滑点是成本不是盈亏。 */}
                <span className="mono">{fmtSignedCents(avgExecCents)}</span>
                <div className="kpi-sub mono">n={execSamples}</div>
              </>
            )
          }
        />
        <Metric
          label="开始时间"
          title="策略上线(成立)日期;运行时间与年化都以此为锚。老库缺创建时间时回退首仓开仓日"
          value={
            fund?.startTs != null ? (
              <span className="mono">{fmtDate(fund.startTs)}</span>
            ) : (
              <span className="muted">—</span>
            )
          }
        />
        <Metric
          label="运行时间"
          title="自开始时间至今的时长(策略持续在跑,含无信号的空窗期)"
          value={
            fund?.runDays != null ? (
              <span className="mono">{fmtHold(fund.runDays * 86400)}</span>
            ) : (
              <span className="muted">—</span>
            )
          }
        />
        <Metric
          label="最大占用资金"
          title="历史上任一时刻同时持有仓位的本金峰值(扫描线口径,open 仓占用至结算才释放)。即照此策略实盘需准备的本金,也是「平均年化」的分母"
          value={
            fund ? (
              <span className="mono">${fmtUsd0(fund.maxConcurrentUsd)}</span>
            ) : (
              <span className="muted">—</span>
            )
          }
        />
      </div>
      {m.avgHoldingDays != null ? (
        <div className="ds-hint" style={{ marginTop: "var(--s-3)" }}>
          平均持有 {m.avgHoldingDays.toFixed(1)} 天
        </div>
      ) : null}
    </>
  );
}

const fmtPct = (u: number | null) =>
  u == null ? "—" : `${(u * 100).toFixed(0)}%`;

/**
 * 成本四段分解(策略详情弹窗「区 3」,改版 Task 3 唯一新增的信息组织;
 * U6 在前面加了「区 1 净值走势」后,原来的区 2 顺移成区 3)。
 * 追价成本→延迟成本→执行滑点→协议费四项此前是四个并列的 Metric(见
 * StrategyFullMetrics),读者看不出它们是一条链——串起来才回答「纸面盈亏
 * 和实盘差在哪」。呈现选横向流程条(auto-fit 网格 + label 前缀箭头)而不是
 * 纵向列表:详情弹窗够宽(见 DETAIL_DIALOG_WIDTH),横向能让"链式推进"的
 * 阅读顺序一眼可见;窄窗口下网格自动换行到单列,退化成事实上的纵向列表,
 * 不会溢出(与 StrategyFullMetrics 的指标网格同一套机制,已验证不溢出)。
 *
 * ⚠️ 这条链不是严格可加总的:四项口径互不相同(追价成本 vs 聪明钱均价、
 * 延迟成本 vs 信号形成价、执行滑点 vs 报价入场、协议费是协议抽成),链尾
 * 「净盈亏(含成本)」目前只把追价成本 + 协议费两项实际计入净额(与
 * lib/follow.ts netAfterCostsCovered 的定义一致),延迟成本/执行滑点是
 * 归因诊断读数,不重复计入——不能因为摆成一条链就暗示四项相减得到链尾数字。
 */
function CostChain({
  s,
  delayExec,
}: {
  s: FollowStrategyView;
  delayExec: DelayExecAverages;
}) {
  const m = s.metrics;
  const { avgDelayCents, delaySamples, avgExecCents, execSamples } = delayExec;
  // 追价成本用「已结算仓」口径(slippageCostSettled),不是战绩全景那个
  // open+settled 全量的 slippageCost —— 这条链最终要和协议费、净盈亏在
  // 同一批已结算仓上对得上,持有中仓位还没有已实现盈亏,没有"实盘差多少"
  // 这回事。
  const slip = m.slippageCostSettled;
  return (
    <div>
      <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
        只看已结算仓(持有中仓位尚未产生已实现盈亏)。四项口径不同,不是同
        口径数字的简单相加——链尾净盈亏目前只把追价成本、协议费两项计入净额,
        延迟成本/执行滑点是归因诊断读数,悬停各项查看具体口径。
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: "var(--s-3) var(--s-4)",
        }}
      >
        <Metric
          label="追价成本"
          title="已结算仓的追价成本合计:份额 ×(自己入场价 − 聪明钱建仓均价)之和(美元)。链的起点——我们比聪明钱买贵了多少,含拿不到的信息租金。口径与战绩全景「累计追价成本」相同但只算已结算仓,为了能与下面的协议费、净盈亏在同一批仓上相减。中性色:是成本不是盈亏"
          value={
            <span className="mono">
              {slip >= 0 ? `$${fmtUsd0(slip)}` : `${MINUS}$${fmtUsd0(-slip)}`}
            </span>
          }
        />
        <Metric
          label="→ 延迟成本"
          title="有形成价的仓位的(进场价 − 形成价)¢ 算术平均。正=共识形成后我们追贵了 —— 检测+执行延迟造成的可优化成本;与「追价成本」(vs 聪明钱均价、含拿不到的信息租金)口径不同。老仓位无形成价,不进样本"
          value={
            avgDelayCents == null ? (
              <span className="muted">—</span>
            ) : (
              <>
                <span className="mono" style={slipWarnStyle(avgDelayCents)}>
                  {fmtSignedCents(avgDelayCents)}
                </span>
                <div className="kpi-sub mono">n={delaySamples}</div>
              </>
            )
          }
        />
        <Metric
          label="→ 执行滑点"
          title="有盘口快照的仓位的(模拟成交均价 − 报价入场价)¢ 算术平均 —— 真实执行成本(跨价差+吃深度)的实测估计。开仓瞬间抓 CLOB 订单簿、按本仓名义金额模拟市价吃单;盘口无历史,执行层上线前的老仓不进样本"
          value={
            avgExecCents == null ? (
              <span className="muted">—</span>
            ) : (
              <>
                <span className="mono">{fmtSignedCents(avgExecCents)}</span>
                <div className="kpi-sub mono">n={execSamples}</div>
              </>
            )
          }
        />
        <Metric
          label="→ 协议费"
          title="开仓瞬间按 gamma feeSchedule 算的协议 taker 费之和(仅已结算仓)。公式 fee = 份额 × rate × p ×(1−p);对定额买单等价于 金额 × rate ×(1−p) —— 随成交价单调递减,冷门票才是相对最贵的($500 @0.2 约 4%、@0.5 约 2.5%、@0.9 约 0.5%)。「Polymarket 零手续费」已于 2026-08-04 实测作废:头部 100 市场 72 个收费、占 24h 量 57.8%,横跨 7 个品类。费率表是当前值,老仓不回填,故带 n= 覆盖率"
          value={
            m.feeSamples === 0 ? (
              <>
                <span className="muted">—</span>
                <div className="kpi-sub mono">n=0</div>
              </>
            ) : (
              <>
                <span className="mono">
                  {MINUS}${fmtUsd0(m.feeCost)}
                </span>
                <div className="kpi-sub mono">
                  n={m.feeSamples}
                  {m.feeUnknown > 0 ? ` · ${m.feeUnknown} 仓未知` : null}
                </div>
              </>
            )
          }
        />
      </div>
      {/* 链尾:净盈亏(含成本)。加底色框与上面四项拉开视觉层级——它是链的
          结论,不是并列的第五项。覆盖率标注(feeSamples/settledCount)必须
          跟着数字一起出现,否则读者会把"费用已知"的子集误读成全量,这正是
          lib/follow.ts netAfterCostsCovered 注释警告过的坑。 */}
      <div
        style={{
          marginTop: "var(--s-4)",
          padding: "var(--s-3) var(--s-4)",
          background: "var(--n-100)",
          borderRadius: "var(--r-md)",
        }}
      >
        <Metric
          label="⇒ 净盈亏(含追价成本+协议费)"
          title="三档口径里最接近实盘的一档:已实现盈亏 − 追价成本 − 协议费。上面的「已实现盈亏」是纸面档,不含任何执行成本。⚠️ 口径范围:三项都只在【协议费已知】的那批已结算仓上计算,而不是拿部分覆盖的费用去减全量盈亏(那会得到一个介于两档之间、无法解释的数)。协议费自 2026-08 起才采集、老仓不回填,所以这一档目前只覆盖一个子集;随着老仓陆续结算完毕会自然收敛到全量"
          value={
            m.feeSamples === 0 ? (
              <>
                <span className="muted">—</span>
                <div className="kpi-sub mono">n=0</div>
              </>
            ) : (
              <>
                <span
                  className={`mono ${pnlTone(m.netAfterCostsCovered)}`}
                  style={{ fontSize: 18, fontWeight: 700 }}
                >
                  {fmtSignedUsd(m.netAfterCostsCovered)}
                </span>
                <div className="kpi-sub mono">
                  覆盖 {m.feeSamples}/{m.settledCount} 仓
                </div>
              </>
            )
          }
        />
      </div>
    </div>
  );
}

// 卡片底部动作行:一个「查看详情」弹窗入口(合并原「账户推演」「操作历史」
// 两个按钮——内容没丢,并进同一个弹窗的两个区,见下方 StrategyDetailDialog)。
// 细节全部收进弹窗,卡片保持紧凑。仅展示,不参与任何决策。
//
// U6:「建议跟单额度」从这一行收进了卡片正文的指标网格(见 StrategyCard),
// 这里不再重复渲染,按钮行只剩「查看详情」一个。
//
// 与更早版本的一处行为差异:更早版本在 !hasPlan && !hasHistory 时整行
// 隐藏(两个弹窗各自都没数据可看,按钮就没有意义)。合并后「查看详情」还
// 解锁了恒有内容的「区 2 战绩全景」——哪怕 0 仓位,策略的创建日期/运行
// 天数依然有值(见 lib/follow.ts computeFundMetrics 的 startTs ??
// firstEntryTs),所以这里不整行隐藏。
function CardActions({ s }: { s: FollowStrategyView }) {
  const [detailOpen, setDetailOpen] = useState(false);
  return (
    <div
      style={{
        marginTop: "var(--s-3)",
        borderTop: "1px solid var(--n-200)",
        paddingTop: "var(--s-3)",
        display: "flex",
        alignItems: "center",
        gap: "var(--s-2)",
        flexWrap: "wrap",
      }}
    >
      <button
        type="button"
        className="ds-btn"
        onClick={() => setDetailOpen(true)}
        title="净值走势 · 战绩全景 · 成本四段分解 · 账户推演 · 操作历史"
      >
        查看详情
      </button>
      <StrategyDetailDialog
        s={s}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      />
    </div>
  );
}

// 弹窗内容:建议跟单额度(含推导)+ 平均占用/效率 + 五档推演表 + 口径说明。
// 反事实精确回放:固定 $/仓 + 仓位独立 ⇒「若账户只备 $X」按开仓顺序重演是
// 精确值(资金不够即错过、结算即释放),不是估计。
function AccountPlanDialog({ acct }: { acct: AccountPlan }) {
  const suggestedRow =
    acct.rows.find((r) => r.accountUsd === acct.suggestedUsd) ?? null;
  return (
    <div>
      <div className="ds-hint">
        建议跟单额度(账户备付现金 · Polymarket 无杠杆)
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "var(--s-3)",
          flexWrap: "wrap",
          margin: "4px 0 var(--s-1)",
        }}
      >
        <span className="mono" style={{ fontSize: 24, fontWeight: 700 }}>
          ${fmtUsd0(acct.suggestedUsd!)}
        </span>
        {suggestedRow?.annualizedRoi != null ? (
          <span className="ds-hint">
            按此额度年化{" "}
            <span className={`mono ${pnlTone(suggestedRow.annualizedRoi)}`}>
              {fmtAnnualized(suggestedRow.annualizedRoi)}
            </span>
            {suggestedRow.utilization != null
              ? ` · 使用效率 ${fmtPct(suggestedRow.utilization)}`
              : ""}
          </span>
        ) : null}
      </div>
      <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
        = 历史峰值占用 ${fmtUsd0(acct.recommendedUsd ?? 0)}
        (恰好接住全部历史信号的最小资金)+ ~25% 冗余,按单仓金额向上取整。
        历史窗口口径,未来峰值可能更高。
      </div>
      <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
        账户推演 · 该备多少钱
      </div>
      <div className="ds-hint" style={{ marginBottom: "var(--s-2)" }}>
        {`平均占用 $${fmtUsd0(acct.avgOccupiedUsd)}`}
        {acct.utilization != null
          ? ` · 峰值额度下使用效率 ${fmtPct(acct.utilization)}`
          : ""}
      </div>
      <div className="ds-table-wrap">
        <table className="ds-table">
          <thead>
            <tr>
              <th title="若账户只备这么多钱(0.25/0.5/0.75/1/1.25 × 峰值占用)">
                若账户
              </th>
              <th title="按开仓顺序回放:资金不足即错过该信号">接住 · 错过</th>
              <th title="接住且已结算仓位的已实现盈亏合计(不含浮盈)">落袋</th>
              <th title="落袋 ÷ 账户额 × 365 ÷ 运行天数;无结算仓或运行不足 1 天为 —">
                年化
              </th>
              <th title="时间加权平均占用 ÷ 账户额(含零仓闲置期)">效率</th>
            </tr>
          </thead>
          <tbody>
            {acct.rows.map((r) => (
              <tr
                key={r.accountUsd}
                style={
                  r.accountUsd === acct.suggestedUsd ||
                  r.accountUsd === acct.recommendedUsd
                    ? { background: "var(--n-100)" }
                    : undefined
                }
              >
                <td className="mono">
                  ${fmtUsd0(r.accountUsd)}
                  {r.accountUsd === acct.suggestedUsd ? (
                    <>
                      {" "}
                      <Tag variant="brand">建议</Tag>
                    </>
                  ) : r.accountUsd === acct.recommendedUsd ? (
                    <>
                      {" "}
                      <span className="ds-tag">恰接住</span>
                    </>
                  ) : null}
                </td>
                <td className="mono">
                  {r.taken} ·{" "}
                  {r.missed > 0 ? (
                    <span style={{ color: "var(--warn-700)" }}>{r.missed}</span>
                  ) : (
                    "0"
                  )}
                </td>
                <td>
                  <span className={`mono ${pnlTone(r.realizedPnl)}`}>
                    {fmtSignedUsd(r.realizedPnl)}
                  </span>
                </td>
                <td>
                  {r.annualizedRoi == null ? (
                    <span className="muted">—</span>
                  ) : (
                    <span className={`mono ${pnlTone(r.annualizedRoi)}`}>
                      {fmtAnnualized(r.annualizedRoi)}
                    </span>
                  )}
                </td>
                <td className="mono">{fmtPct(r.utilization)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
        回放口径:把历史仓位按开仓顺序重演——账户资金不够就错过该信号、市场结算
        即释放资金。每仓固定 $/信号且互相独立,因此错过哪几仓、少赚/少亏多少是
        精确值而非估计。效率 = 时间加权平均占用 ÷ 账户额(含零仓闲置期)。
      </div>
    </div>
  );
}

/* ------------------------------------------------------ action history */

// 操作历史事件:每仓一条「买入」(entry_ts,附信号形成时间),已结算再加一条
// 「兑现」(exit_ts)。仅记录已执行的纸面动作——被新鲜度闸门/偏离护栏拦下、
// 或(推演意义上)资金外的信号不产生仓位行,自然不在此表。
type HistoryEvent = {
  ts: number;
  kind: "open" | "settle";
  p: FollowPositionRow;
};

// 倒序(最新在前);同一时刻「兑现」排在「买入」上方——同刻时兑现在时间线上
// 是更靠后的动作(entry==exit 的零时长异常仓也因此顺序自然)。
function buildHistory(positions: FollowPositionRow[]): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  for (const p of positions) {
    events.push({ ts: p.entry_ts, kind: "open", p });
    if (p.status === "settled" && p.exit_ts != null) {
      events.push({ ts: p.exit_ts, kind: "settle", p });
    }
  }
  return events.sort(
    (a, b) =>
      b.ts - a.ts || (a.kind === b.kind ? 0 : a.kind === "settle" ? -1 : 1),
  );
}

// 兑现动作的结果着色:赢绿 / 输红 / 平中性(与 SideTag 同一 up/down 语义)。
function settleTagVariant(pnl: number | null): "up" | "down" | "default" {
  if (pnl == null || pnl === 0) return "default";
  return pnl > 0 ? "up" : "down";
}

function HistoryDialog({ positions }: { positions: FollowPositionRow[] }) {
  const events = buildHistory(positions);
  const buys = events.filter((e) => e.kind === "open").length;
  return (
    <div>
      <div className="ds-hint" style={{ marginBottom: "var(--s-2)" }}>
        {buys} 次买入 · {events.length - buys} 次兑现 · 倒序(最新在前)·
        纸面模拟,无真实成交;仅记录已执行动作,被护栏/新鲜度闸门拦下的信号不在此列
      </div>
      <div className="ds-table-wrap">
        <table className="ds-table">
          <thead>
            <tr>
              <th title="动作发生时刻(本地时区),悬停看完整时间">时间</th>
              <th title="买入 = 信号触发后现价开仓;兑现 = 市场结算平仓(赢绿/输红/平灰)">
                动作
              </th>
              <th>市场 · 结果</th>
              <th
                className="is-right"
                title="买入行 = 进场价,下附信号形成时间与检测延迟;兑现行 = 结算价,下附持有时长"
              >
                价格
              </th>
              <th
                className="is-right"
                title="买入行 = 投入本金;兑现行 = 已实现盈亏"
              >
                金额 / 盈亏
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((e, i) => (
              <tr key={`${e.p.condition_id}-${e.p.outcome}-${e.kind}-${i}`}>
                <td
                  className="mono"
                  title={new Date(e.ts * 1000).toLocaleString("zh-CN")}
                >
                  {fmtDateTime(e.ts)}
                </td>
                <td>
                  {e.kind === "open" ? (
                    <span className="ds-tag">买入</span>
                  ) : (
                    <Tag variant={settleTagVariant(e.p.realized_pnl)}>兑现</Tag>
                  )}
                </td>
                {/* 市场列放开全局 nowrap:长标题换行而不是把表撑出横向滚动 */}
                <td style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                  <MarketCell p={e.p} />
                </td>
                <td className="is-right">
                  {e.kind === "open" ? (
                    <>
                      <span className="mono">{cents(e.p.entry_price)}</span>
                      {e.p.formation_ts != null ? (
                        <div className="kpi-sub">
                          信号 {fmtDateTime(e.p.formation_ts)} · 延迟{" "}
                          {Math.max(
                            0,
                            Math.round((e.p.entry_ts - e.p.formation_ts) / 60),
                          )}{" "}
                          分
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <span className="mono">
                        {e.p.exit_price != null ? cents(e.p.exit_price) : "—"}
                      </span>
                      <div className="kpi-sub">
                        持有{" "}
                        {fmtHold((e.p.exit_ts ?? e.p.entry_ts) - e.p.entry_ts)}
                      </div>
                    </>
                  )}
                </td>
                <td className="is-right">
                  {e.kind === "open" ? (
                    <span className="mono muted">${fmtUsd0(e.p.size_usd)}</span>
                  ) : (
                    <span className={`mono ${pnlTone(e.p.realized_pnl ?? 0)}`}>
                      {fmtSignedUsd(e.p.realized_pnl ?? 0)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ detail dialog */

// 尽量占满视口宽(Modal 内部按 min(width, 100%) 收敛):五区共存,取原两个
// 独立弹窗里较宽的那个——操作历史表格原本就是 1200(见上面 HistoryDialog
// 曾经的调用点);账户推演原本是 680,共用 1200 只是给它的表格多一点留白,
// 不会挤压或产生新的换行。
const DETAIL_DIALOG_WIDTH = 1200;
// 净值走势图(U6 从卡片移入的 Sparkline)尺寸:宽度按弹窗内容区域的量级取
// (1200 减掉 Modal/section 的内边距后大致这个数量级,SVG 本身靠 viewBox +
// width:100% 响应式伸缩,数字不用精确到像素);高度取协调方给的 160-200px
// 区间中段。
const DETAIL_SPARK_WIDTH = 1120;
const DETAIL_SPARK_HEIGHT = 180;

/**
 * 策略详情弹窗(改版 Task 3,U6 追加区 1):合并原「账户推演」「操作历史」
 * 两个独立弹窗,加上下沉的指标,分五区呈现:
 *   区 1 净值走势     U6 从卡片移入的 Sparkline,放大 + 加坐标轴,作为
 *                     整个弹窗的视觉引导
 *   区 2 战绩全景     StrategyFullMetrics 原样挂载
 *   区 3 成本四段分解 本任务唯一新增的信息组织,见 CostChain
 *   区 4 账户推演     AccountPlanDialog 内容原样搬入(只换容器,内容一字不改)
 *   区 5 操作历史     HistoryDialog 内容原样搬入(只换容器,内容一字不改)
 * avgDelayCents/avgExecCents 在本层算一次(computeDelayExecAverages),
 * 通过 delayExec 传给区 2、区 3 两处消费者,不重复 reduce。
 * 设计见 docs/plans/2026-08-12-follow-page-card-redesign-design.md §3.2。
 */
function StrategyDetailDialog({
  s,
  open,
  onClose,
}: {
  s: FollowStrategyView;
  open: boolean;
  onClose: () => void;
}) {
  // Modal 自己在 !open 时也会返回 null;这里提前短路,避免弹窗关闭期间
  // 每次父组件重渲染(如 30s 自动刷新)都要为页面上 12 张卡各算一遍
  // delayExec、拼一遍 allPos。
  if (!open) return null;

  const m = s.metrics;
  const allPos = [...s.open, ...s.settled];
  const delayExec = computeDelayExecAverages(allPos);
  const acct = s.account;
  const hasPlan = !!acct && acct.rows.length > 0 && acct.suggestedUsd != null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${s.name} · 策略详情`}
      width={DETAIL_DIALOG_WIDTH}
    >
      {/* 完整参数提示(paramsHint 全量版本,一字不改):卡片紧凑化那轮把
          12 档统一的三项(单价/偏离护栏/退出规则)从卡上拿掉了,不是丢掉——
          详情弹窗承接完整版,读者想看这档的确切规则,点开详情就有。 */}
      <div className="ds-hint" style={{ marginBottom: "var(--s-4)" }}>
        {paramsHint(s.params)}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-6)",
        }}
      >
        <section>
          <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
            净值走势
          </div>
          {m.equityCurve.length > 0 ? (
            <Sparkline
              curve={m.equityCurve}
              width={DETAIL_SPARK_WIDTH}
              height={DETAIL_SPARK_HEIGHT}
            />
          ) : (
            <div className="ds-empty">
              暂无已结算仓位 — 有仓位结算后这里会画出净值走势
            </div>
          )}
        </section>

        <section
          style={{
            borderTop: "1px solid var(--n-150)",
            paddingTop: "var(--s-4)",
          }}
        >
          <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
            战绩全景
          </div>
          <StrategyFullMetrics s={s} delayExec={delayExec} />
        </section>

        <section
          style={{
            borderTop: "1px solid var(--n-150)",
            paddingTop: "var(--s-4)",
          }}
        >
          <div className="ds-label" style={{ marginBottom: "var(--s-1)" }}>
            成本四段分解
          </div>
          <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
            追价成本 → 延迟成本 → 执行滑点 → 协议费,回答「纸面盈亏和实盘差在哪」
          </div>
          <CostChain s={s} delayExec={delayExec} />
        </section>

        <section
          style={{
            borderTop: "1px solid var(--n-150)",
            paddingTop: "var(--s-4)",
          }}
        >
          <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
            账户推演
          </div>
          {hasPlan ? (
            <AccountPlanDialog acct={acct!} />
          ) : (
            <div className="ds-empty">
              该档暂无账户推演数据(尚无仓位,或建议额度不可用)
            </div>
          )}
        </section>

        <section
          style={{
            borderTop: "1px solid var(--n-150)",
            paddingTop: "var(--s-4)",
          }}
        >
          <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
            操作历史
          </div>
          <HistoryDialog positions={allPos} />
        </section>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------- list view */

// 列表视图(卡片/列表切换新增):12 档一张整表。行序按信号族分组
// (FAMILY_ORDER)+ 族内原有顺序,复用 groups——与卡片视图同一份分组结果,
// 保证两种视图的策略顺序看起来是"同一件事的两种画法",不是两套互相对不上
// 的排序。**不提供点列头排序**:小样本下按 ROI/结算净值排序,会让"3 仓刚好
// 赢 2 仓"的运气档窜到第一名,排序动作本身就在撒谎——这与卡片"不做排序,
// 固定按信号族分组"是同一条已裁决的口径,列表不重新开一次这个讨论。
function StrategyListView({
  groups,
  leaderId,
}: {
  groups: FamilyGroup[];
  leaderId: number | null;
}) {
  const rows = groups.flatMap((g) =>
    g.items.map((s) => ({ s, familyTitle: g.meta.title })),
  );
  if (rows.length === 0) {
    return <div className="ds-empty">暂无启用中的跟单策略</div>;
  }
  return (
    <div className="ds-table-wrap">
      <table className="ds-table">
        <thead>
          <tr>
            {/* emoji + 名字 + 族标签 + 状态标签全部横排进一格,不单独开一列
                放族——实测过两种排法:族独立成列会额外占一份列内边距
                (.ds-table td 左右各 --s-3),合并成一格更省宽度,且每项本身
                都很短(族名最多 4 字、emoji 一个字宽),合并后仍然一行放得
                下,不需要族列单独对齐。 */}
            <th>策略</th>
            <th
              className="is-right"
              title="已结算仓位累计已实现盈亏(不含持仓浮盈)"
            >
              结算净值
            </th>
            <th className="is-right" title="结算净值 ÷ 已投入本金(仅已结算仓)">
              ROI
            </th>
            <th
              className="is-right"
              title="结算净值 ÷ 峰值占用资金 × 365 ÷ 运行天数。短窗口/小样本外推极不可靠,仅供横向对比"
            >
              平均年化
            </th>
            <th
              className="is-right"
              title="盈利仓 ÷(盈利+亏损)仓,括号内为已结算样本数(<10 仓前面加 ⚠,与卡片同一个警示阈值)。Wilson 95% 置信区间不在这张表里——留在「详情」,表格容不下那么长的区间文本"
            >
              胜率
            </th>
            <th
              className="is-right"
              title="净值曲线从峰值到后续谷底的最大跌幅(美元)"
            >
              最大回撤
            </th>
            <th
              className="is-right"
              title="= 历史峰值占用 × 1.25(按单仓金额向上取整);推导细节与五档精确回放见「详情 → 账户推演」"
            >
              建议额度
            </th>
            <th className="is-right" title="当前持仓待结算数 / 策略运行天数">
              持有 / 运行
            </th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ s, familyTitle }) => (
            <StrategyListRow
              key={s.id}
              s={s}
              familyTitle={familyTitle}
              leading={s.id === leaderId}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 单行:三态判定复用 classifyCardState(lib/followCardView.ts)——与卡片
// 用的是同一个函数、同一个 LOW_SAMPLE_THRESHOLD,不重写一份判定逻辑,不然
// 两种视图迟早会因为各自维护阈值而对同一档给出不同的"这是小样本吗"结论。
//
// empty 态的呈现手法与卡片不同:卡片用虚线边框把"还没轮到它"和"跑了但没
// 赚到钱"在视觉上分开;表格行没有边框可虚化,强行给单行加虚线边框会破坏
// 列与列之间的横向对齐(边框只框住这一行,相邻行的同一列看起来就不再对齐
// 了)。改用整行文字降 muted + 六个战绩列一律显示"—"(不满足读者去读一个
// 没有意义的 $0/null 值)。区分「持仓待结算」和「还没有仓位」的两句文案
// (沿用卡片同一处语义,措辞缩短成标签形态)现在跟着策略名一起放进第一列
// 的小标签里,不再独占末列一行——那是这一轮"每档一行"改造的一部分,见
// 上面「策略」单元格与下方 CardState 判定。末列现在只留「详情」按钮。
//
// 「持有 / 运行」不算在"数值列显示 —"这条规则里——它是运行状态(当前持仓
// 数、上线多久),不是战绩指标,哪怕 0 结算也是真实、有意义的数字,卡片的
// 元信息行同样在 empty 态照常显示这两个数(见 StrategyCard),这里保持
// 同一个口径,只是整行文字仍然是 muted 灰。
//
// 详情弹窗状态挂在每一行自己身上(与 CardActions 同一个模式:每张卡/每行
// 各自持有自己的 open/close,不是页面级"当前打开哪一条"的单一状态)。
function StrategyListRow({
  s,
  familyTitle,
  leading,
}: {
  s: FollowStrategyView;
  familyTitle: string;
  leading: boolean;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const m = s.metrics;
  const fund = s.fund;
  const acct = s.account;
  const hasPlan = !!acct && acct.rows.length > 0 && acct.suggestedUsd != null;
  const state = classifyCardState(m);
  const empty = state === "empty";
  const dash = <span className="muted">—</span>;
  return (
    <tr className={empty ? "muted" : undefined}>
      {/* 每档一行:emoji + 名字 + 族标签(+ 领先/等待状态)全部横向并排在
          同一个单元格里,不再有「族在上、名字在下」的纵向堆叠。族标签沿用
          Tag 组件默认样式,与领先/等待标签同一套视觉语言,靠 flexWrap:
          "wrap" 兜底——桌面宽度下内容够放,不会真的触发换行;窄到必须换行
          时(理论上只有极端窗口宽度)才回退成两行,不会把内容裁掉或撑出
          横向溢出。 */}
      <td data-label="策略">
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--s-2)",
            flexWrap: "wrap",
          }}
        >
          <span aria-hidden>{strategyEmoji(s.name)}</span>
          <span style={{ fontWeight: 600 }}>{s.name}</span>
          <Tag>{familyTitle}</Tag>
          {leading ? <Tag variant="brand">领先</Tag> : null}
          {empty ? (
            <Tag>{m.openCount > 0 ? "等待结算" : "等待命中"}</Tag>
          ) : null}
        </span>
      </td>
      <td className="is-right" data-label="结算净值">
        {empty ? (
          dash
        ) : (
          <span className={`mono ${pnlTone(m.totalRealized)}`}>
            {fmtSignedUsd(m.totalRealized)}
          </span>
        )}
      </td>
      <td className="is-right" data-label="ROI">
        {!empty && m.roi != null ? (
          <span className={`mono ${pnlTone(m.roi)}`}>
            {m.roi >= 0 ? "+" : MINUS}
            {Math.abs(m.roi * 100).toFixed(1)}%
          </span>
        ) : (
          dash
        )}
      </td>
      <td className="is-right" data-label="平均年化">
        {!empty && fund?.annualizedRoi != null ? (
          <span className={`mono ${pnlTone(fund.annualizedRoi)}`}>
            {fmtAnnualized(fund.annualizedRoi)}
          </span>
        ) : (
          dash
        )}
      </td>
      <td className="is-right" data-label="胜率">
        {!empty && m.winRate != null ? (
          <span className="mono">
            {Math.round(m.winRate * 100)}%{" "}
            <span className="muted">
              ({state === "low_sample" ? `⚠ ${m.settledCount}` : m.settledCount}
              )
            </span>
          </span>
        ) : (
          dash
        )}
      </td>
      <td className="is-right" data-label="最大回撤">
        {empty ? (
          dash
        ) : m.maxDrawdown > 0 ? (
          <span className="mono down">
            {MINUS}${fmtUsd0(m.maxDrawdown)}
          </span>
        ) : (
          <span className="mono muted">$0</span>
        )}
      </td>
      <td className="is-right" data-label="建议额度">
        {!empty && hasPlan ? (
          <span className="mono">${fmtUsd0(acct!.suggestedUsd!)}</span>
        ) : (
          dash
        )}
      </td>
      <td className="is-right" data-label="持有 / 运行">
        <span className="mono">
          {m.openCount} /{" "}
          {fund?.runDays != null ? `${Math.floor(fund.runDays)}天` : "—"}
        </span>
      </td>
      <td className="is-right" data-label="操作">
        <button
          type="button"
          className="ds-btn ds-btn--sm"
          onClick={() => setDetailOpen(true)}
        >
          详情
        </button>
        <StrategyDetailDialog
          s={s}
          open={detailOpen}
          onClose={() => setDetailOpen(false)}
        />
      </td>
    </tr>
  );
}

/* --------------------------------------------------------------- tables */

// 策略归属小标签(合并表里标注该行来自哪条策略)。
function StratChip({ name }: { name: string }) {
  return <span className="ds-tag">{name}</span>;
}

function MarketCell({ p }: { p: FollowPositionRow }) {
  const label = marketLabel(p);
  return (
    <>
      {p.event_slug ? (
        <a
          href={`https://polymarket.com/event/${p.event_slug}`}
          target="_blank"
          rel="noreferrer"
        >
          {label}
        </a>
      ) : (
        label
      )}
      <div className="kpi-sub">{p.outcome}</div>
    </>
  );
}

function SettledTable({
  rows,
  emptyText = "尚无已结算的纸面仓位",
}: {
  rows: LabeledRow[];
  emptyText?: string;
}) {
  if (rows.length === 0) {
    return <div className="ds-empty">{emptyText}</div>;
  }
  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="ds-table-wrap">
      <table className="ds-table">
        <thead>
          <tr>
            <th>策略</th>
            <th>市场 · 结果</th>
            <th className="is-right" title="现价进场 → 结算价(美分)">
              进价→结算价
            </th>
            <th
              className="is-right"
              title="旧称「滑点」。入场价 − 聪明钱建仓均价(¢ 差,括号内为美元口径)。正=追高;负≠捡便宜(常是行情已反向);|¢差|>10 琥珀警示。口径含聪明钱的信息租金(他们买得早/便宜,拿不到别追)—— 与「延迟成本」(vs 形成价)不同;也不是盘口执行滑点(纸面按报价快照成交,不吃盘口)"
            >
              追价成本
            </th>
            <th
              className="is-right"
              title="进场价 − 形成价(¢)。形成价=第 N 个白名单钱包到位那一刻的市价;正=共识形成后追贵了,是系统检测+执行延迟造成的可优化成本(不含信息租金,与「追价成本」口径不同)。老仓位/取价失败显示 —;|¢|>10 琥珀,与进场偏离护栏阈一致"
            >
              延迟成本
            </th>
            <th
              className="is-right"
              title="开仓瞬间抓 CLOB 盘口快照,按本仓名义金额模拟市价吃单:模拟成交均价 − 报价入场价(¢)。真实执行成本(跨价差+吃深度)的实测估计;琥珀(薄)=盘口深度不足只能部分成交。盘口无历史,仅新开仓有值,老仓显示 —"
            >
              执行滑点
            </th>
            <th
              className="is-right"
              title="markout:形成后 2 小时市价 − 形成价(¢),衡量共识形成后还有没有肉。涨绿跌红(±0.5¢ 死区记平推);形成价或 2h 回填价缺失显示 —"
            >
              形成后2h
            </th>
            <th className="is-right">持有期</th>
            <th className="is-right">已实现</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const slip = rowSlippage(p);
            const slipC = rowSlipCents(p);
            const delayC = rowDelayCents(p);
            const mo2 = rowMarkout2hCents(p);
            const held = (p.exit_ts ?? now) - p.entry_ts;
            const realized = p.realized_pnl ?? 0;
            return (
              <tr key={`${p.strategy_id}:${p.condition_id}:${p.outcome}`}>
                <td data-label="策略">
                  <StratChip name={p.strategyName} />
                </td>
                <td
                  data-label="市场 · 结果"
                  style={{ whiteSpace: "normal", maxWidth: 360 }}
                >
                  <MarketCell p={p} />
                </td>
                <td className="mono is-right" data-label="进价→结算价">
                  {cents(p.entry_price)}
                  <span className="muted"> → </span>
                  {p.exit_price != null ? cents(p.exit_price) : "—"}
                </td>
                {/* 主显示 ¢ 差(可跨仓横比),美元退居括号小字;中性色,超警示线转琥珀。 */}
                <td
                  className="mono is-right"
                  data-label="追价成本"
                  style={slipWarnStyle(slipC)}
                >
                  {fmtSignedCents(slipC)}
                  <span className="muted"> ({fmtSignedUsd(slip)})</span>
                </td>
                {/* 延迟成本:中性色(是成本不是盈亏),超护栏阈转琥珀;无形成价显示 —。 */}
                <td
                  className="mono is-right"
                  data-label="延迟成本"
                  style={delayC != null ? slipWarnStyle(delayC) : undefined}
                >
                  {delayC != null ? (
                    fmtSignedCents(delayC)
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                {/* 执行滑点:盘口快照模拟吃单 vs 报价入场;仅新仓有值。 */}
                <td className="is-right" data-label="执行滑点">
                  <ExecCell p={p} />
                </td>
                {/* 形成后 2h:价格方向,涨绿跌红(±0.5¢ 死区平推);缺值显示 —。 */}
                <td className="mono is-right" data-label="形成后2h">
                  {mo2 != null ? (
                    <span className={markoutToneClass(mo2)}>
                      {fmtSignedCents(mo2)}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="mono muted is-right" data-label="持有期">
                  {fmtHold(held)}
                </td>
                <td
                  className={`mono is-right ${pnlTone(realized)}`}
                  data-label="已实现"
                  style={{ fontWeight: 700 }}
                >
                  {fmtSignedUsd(realized)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OpenTable({
  rows,
  emptyText = "当前没有持仓中的纸面仓位",
}: {
  rows: LabeledRow[];
  emptyText?: string;
}) {
  if (rows.length === 0) {
    return <div className="ds-empty">{emptyText}</div>;
  }
  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="ds-table-wrap">
      <table className="ds-table">
        <thead>
          <tr>
            <th>策略</th>
            <th>市场 · 结果</th>
            <th className="is-right" title="现价进场价(美分)">
              进价
            </th>
            <th
              className="is-right"
              title="旧称「滑点」。入场价 − 聪明钱建仓均价(¢ 差,括号内为美元口径)。正=追高;负≠捡便宜(常是行情已反向);|¢差|>10 琥珀警示。口径含聪明钱的信息租金(他们买得早/便宜,拿不到别追)—— 与「延迟成本」(vs 形成价)不同;也不是盘口执行滑点(纸面按报价快照成交,不吃盘口)"
            >
              追价成本
            </th>
            <th
              className="is-right"
              title="进场价 − 形成价(¢)。形成价=第 N 个白名单钱包到位那一刻的市价;正=共识形成后追贵了,是系统检测+执行延迟造成的可优化成本(不含信息租金,与「追价成本」口径不同)。老仓位/取价失败显示 —;|¢|>10 琥珀,与进场偏离护栏阈一致"
            >
              延迟成本
            </th>
            <th
              className="is-right"
              title="开仓瞬间抓 CLOB 盘口快照,按本仓名义金额模拟市价吃单:模拟成交均价 − 报价入场价(¢)。真实执行成本(跨价差+吃深度)的实测估计;琥珀(薄)=盘口深度不足只能部分成交。盘口无历史,仅新开仓有值,老仓显示 —"
            >
              执行滑点
            </th>
            <th className="is-right">已持有</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const slip = rowSlippage(p);
            const slipC = rowSlipCents(p);
            const delayC = rowDelayCents(p);
            const held = now - p.entry_ts;
            return (
              <tr key={`${p.strategy_id}:${p.condition_id}:${p.outcome}`}>
                <td data-label="策略">
                  <StratChip name={p.strategyName} />
                </td>
                <td
                  data-label="市场 · 结果"
                  style={{ whiteSpace: "normal", maxWidth: 360 }}
                >
                  <MarketCell p={p} />
                </td>
                <td className="mono is-right" data-label="进价">
                  {cents(p.entry_price)}
                </td>
                {/* 主显示 ¢ 差(可跨仓横比),美元退居括号小字;中性色,超警示线转琥珀。 */}
                <td
                  className="mono is-right"
                  data-label="追价成本"
                  style={slipWarnStyle(slipC)}
                >
                  {fmtSignedCents(slipC)}
                  <span className="muted"> ({fmtSignedUsd(slip)})</span>
                </td>
                {/* 延迟成本:中性色(是成本不是盈亏),超护栏阈转琥珀;无形成价显示 —。 */}
                <td
                  className="mono is-right"
                  data-label="延迟成本"
                  style={delayC != null ? slipWarnStyle(delayC) : undefined}
                >
                  {delayC != null ? (
                    fmtSignedCents(delayC)
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                {/* 执行滑点:盘口快照模拟吃单 vs 报价入场;仅新仓有值。 */}
                <td className="is-right" data-label="执行滑点">
                  <ExecCell p={p} />
                </td>
                <td className="mono muted is-right" data-label="已持有">
                  {fmtHold(held)}
                </td>
                <td data-label="状态">
                  <Tag variant="warn">待结算</Tag>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------------- page */

export default function FollowPage() {
  const [data, setData] = useState<FollowResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
  // 仓位明细:tab(已结算/持有中)+ 策略筛选(FILTER_ALL=全部,否则策略 id)。
  const [posTab, setPosTab] = useState<PosTab>("settled");
  const [stratFilter, setStratFilter] = useState<number>(FILTER_ALL);
  // 结算净值曲线的族开关(改版 Task 4):默认全开。FamilyKey 是固定的小
  // 枚举,不像 stratFilter 那样需要在渲染期核对"选中的还存在吗"——某族
  // 当前没有策略只是不渲染对应按钮,Set 里留着那个 key 不会造成任何问题。
  const [activeFamilies, setActiveFamilies] = useState<Set<FamilyKey>>(
    () => new Set(FAMILY_ORDER),
  );
  // 卡片/列表视图切换。初值必须是与服务端渲染一致的固定默认值("card"),
  // 不能在这里直接读 localStorage——服务端渲染时没有 window,读不到;客户端
  // 首次渲染如果读到了非默认值,两次渲染的 DOM 对不上就是 hydration
  // mismatch。正确做法(与 app/useSound.ts 的 useSoundToggle 同一套写法):
  // 首屏先出默认值,挂载后在 useEffect 里读 localStorage 再切换。
  const [viewMode, setViewMode] = useState<ViewMode>("card");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(VIEW_MODE_KEY);
      if (saved === "card" || saved === "list") setViewMode(saved);
    } catch {
      // localStorage 不可用(隐私模式等)——保持默认的卡片视图。
    }
  }, []);
  const changeViewMode = (v: ViewMode) => {
    setViewMode(v);
    try {
      localStorage.setItem(VIEW_MODE_KEY, v);
    } catch {
      // 忽略持久化失败,不影响本次切换本身。
    }
  };
  const activeReq = useRef<number>(0);

  const load = useCallback(async () => {
    const reqId = ++activeReq.current;
    setLoading(true);
    try {
      const res = await fetch("/api/follow", { cache: "no-store" });
      const json = (await res.json()) as FollowResponse;
      if (reqId !== activeReq.current) return;
      setData(json);
      setLastRefreshed(
        new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      );
    } catch (e) {
      if (reqId !== activeReq.current) return;
      setData({
        strategies: [],
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (reqId === activeReq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  // 只展示启用中的策略;整页(卡片/曲线/表)都从这份集合派生,保持一致。
  const shown = (data?.strategies ?? []).filter((s) => s.enabled);

  // 领先策略:净值最高者,仅在有 ≥2 张卡且严格领先(不并列)时高亮,避免任意高亮。
  const ranked = [...shown].sort(
    (a, b) => b.metrics.totalRealized - a.metrics.totalRealized,
  );
  const leaderId =
    shown.length >= 2 &&
    ranked[0].metrics.totalRealized > ranked[1].metrics.totalRealized
      ? ranked[0].id
      : null;

  // strokeIdx 按 shown 的原始顺序分配(与族过滤无关)——这样切换族开关时
  // 剩下的线不会因为「前面几条被隐藏了」而重新编号、变成另一种颜色/线型,
  // 同一策略在任何开关组合下都是同一条视觉表示。
  const series: CurveSeries[] = shown.map((s, i) => ({
    id: s.id,
    name: s.name,
    strokeIdx: i,
    family: familyOf(s.params.source ?? "consensus"),
    curve: s.metrics.equityCurve,
  }));
  const visibleSeries = series.filter((s) => activeFamilies.has(s.family));
  const toggleFamily = (key: FamilyKey) => {
    setActiveFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const settledRows: LabeledRow[] = shown
    .flatMap((s) => s.settled.map((p) => ({ ...p, strategyName: s.name })))
    .sort((a, b) => (b.exit_ts ?? 0) - (a.exit_ts ?? 0));
  const openRows: LabeledRow[] = shown.flatMap((s) =>
    s.open.map((p) => ({ ...p, strategyName: s.name })),
  );

  // 策略筛选:渲染期派生「有效筛选值」而非 setState —— 选中的策略可能在下一次
  // 刷新后消失(被停用),此时静默回退「全部」,不在 render 里改状态。
  const effFilter = shown.some((s) => s.id === stratFilter)
    ? stratFilter
    : FILTER_ALL;
  const byFilter = (rows: LabeledRow[]) =>
    effFilter === FILTER_ALL
      ? rows
      : rows.filter((r) => r.strategy_id === effFilter);
  const shownSettled = byFilter(settledRows);
  const shownOpen = byFilter(openRows);
  const filterName =
    effFilter === FILTER_ALL
      ? null
      : (shown.find((s) => s.id === effFilter)?.name ?? null);

  // 12 档扩充(Task 13):按 source 分成信号族分组呈现(未知/缺失 source 落
  // 「其它」兜底组,见 FAMILY_ORDER/familyOf),每族内部顺序沿用 shown 的原有
  // 顺序(即 API 返回的 id 升序)。空族被 filter 掉不占页面——已上线的六种
  // source 目前恰好落进四族,不会出现「其它」组,直到未来有新 source 上线还
  // 没接进 familyOf 的窗口期。
  const groups = FAMILY_ORDER.map((key) => ({
    key,
    meta: FAMILY_META[key],
    items: shown.filter(
      (s) => familyOf(s.params.source ?? "consensus") === key,
    ),
  })).filter((g) => g.items.length > 0);

  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-4)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", marginBottom: "var(--s-1)" }}>
          🧾 共识跟单 · 纸面模拟
        </h1>
        <div className="ds-hint">
          现价进场 ·
          跟随共识/异常大额/分歧/钱包画像四类信号,新鲜度窗口因档而异(默认 15
          分钟,详见各卡片) · 持有到结算 · 固定 $/信号 · 仅结算盈亏(不做浮盈)·
          按报价快照纸面成交,不含盘口执行成本(价差/深度),盈亏偏乐观;「执行滑点」列为该成本的实测估计
          {lastRefreshed ? ` · 最后刷新 ${lastRefreshed}` : ""}
          {loading ? (
            <span style={{ color: "var(--warn-700)" }}> · 加载中…</span>
          ) : null}
        </div>
      </header>

      {/* Controls — 无筛选参数,仅刷新 / 自动刷新 */}
      <section
        className="ds-card"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-3)",
          padding: "var(--s-3) var(--s-4)",
          marginBottom: "var(--s-5)",
        }}
      >
        <button className="ds-btn ds-btn--ghost" onClick={() => load()}>
          刷新
        </button>
        <label
          className="ds-hint"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--s-1)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          自动刷新 30s
        </label>
      </section>

      {data?.error ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-4)" }}
        >
          加载失败: {data.error}
        </div>
      ) : null}

      {!data ? (
        <div className="ds-empty">⏳ 正在加载纸面跟单战绩…</div>
      ) : shown.length === 0 ? (
        <div className="ds-empty">
          暂无启用中的跟单策略 —
          引擎播种聪明钱白名单并跑通一轮跟单后,这里会按信号族出现各档的纸面战绩
        </div>
      ) : (
        <>
          {/* 口径声明:12 档同屏平铺时,读者的本能是把战绩加总——但持仓存在
              大面积重叠(「激进」的持仓是「保守」的超集、「巨鲸精英」是
              「巨鲸」的子集、A3/A4 与 A1/A2 大面积重叠),加出来的数字会被
              严重放大。放在全部卡片之前、用醒目的 warn 语义呈现,复用既有
              ds-callout 组件(单一真相源在 app/globals.css,不写内联硬编码
              色值)。仅在 ≥2 张卡时渲染——只有一档时不存在"跨档相加"这回事,
              与下方"仓位明细"的策略筛选 Segmented 同一条既有约定。 */}
          {shown.length >= 2 ? (
            <div
              className="ds-callout ds-callout--warn"
              style={{ marginBottom: "var(--s-5)" }}
            >
              ⚠️
              各档持仓存在重叠(同一市场可能同时命中多个信号源——例如「激进」的持仓是「保守」的超集、「巨鲸精英」是「巨鲸」的子集)。
              <strong>
                每一档的战绩都是「只跟这一档」的独立假设下算出的,不可跨档相加
              </strong>
              ;同理,每张卡的「建议跟单额度」也是单档口径——12
              档一起跟所需的总资金,不是 12 个峰值之和。
            </div>
          ) : null}

          {/* 卡片/列表视图切换:默认卡片,选择记进 localStorage(见
              changeViewMode)。放在口径声明 banner 下方、内容区上方——两种
              视图消费同一份 shown/groups,口径声明对两边同样适用,不用
              为列表再放一条。 */}
          <div style={{ marginBottom: "var(--s-4)" }}>
            <Segmented<ViewMode>
              ariaLabel="展示方式"
              options={[
                { label: "卡片", value: "card" },
                { label: "列表", value: "list" },
              ]}
              value={viewMode}
              onChange={changeViewMode}
            />
          </div>

          {viewMode === "card" ? (
            // 策略卡:按信号族分组(共识 → 异常大额 → 分歧 → 钱包画像,按
            // 信息强度递减排列,也是 FAMILY_ORDER 的实现顺序),每组一个小
            // 标题 + 一句"这一族在回答什么"。
            groups.map((g) => (
              <section key={g.key} style={{ marginBottom: "var(--s-5)" }}>
                <div style={{ marginBottom: "var(--s-2)" }}>
                  <div className="ds-label">{g.meta.title}</div>
                  <div className="ds-hint">{g.meta.blurb}</div>
                </div>
                <div
                  style={{
                    display: "grid",
                    // 固定列宽(不用 minmax(…, 1fr)):1fr 会把列宽拉伸到随容器
                    // 宽度变化,同样 3 列在 1180px/900px 容器下卡宽能差出
                    // 100px。auto-fit 在某一族卡片数量不足以填满一整行时会
                    // 折叠多余的空轨道,配合下面的 justify-content 让实际卡片
                    // 整体居中;若改用 auto-fill,折叠不会发生,空轨道仍占位,
                    // justify-content 反而会把可见卡片推向一侧、右边露出一块
                    // 不对称的空白(该行为已用具体尺寸推演验证过)。
                    gridTemplateColumns: `repeat(auto-fit, ${CARD_WIDTH}px)`,
                    justifyContent: "center",
                    gap: "var(--s-4)",
                  }}
                >
                  {g.items.map((s) => (
                    <StrategyCard
                      key={s.id}
                      s={s}
                      leading={s.id === leaderId}
                    />
                  ))}
                </div>
              </section>
            ))
          ) : (
            // 列表:12 档一张整表,不按族分小节——见 StrategyListView 顶部
            // 注释,行序仍按信号族分组(与卡片视图共用同一份 groups)。
            <section style={{ marginBottom: "var(--s-5)" }}>
              <StrategyListView groups={groups} leaderId={leaderId} />
            </section>
          )}

          {/* 结算净值阶梯曲线:族开关放卡片外(与"仓位明细"节的 Segmented
              筛选行同一位置约定),曲线卡片本身只管画图。 */}
          <section style={{ marginBottom: "var(--s-5)" }}>
            <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
              结算净值曲线(累计已实现盈亏 · 实线/虚线区分策略)
            </div>
            <FamilyToggles
              groups={groups}
              active={activeFamilies}
              onToggle={toggleFamily}
            />
            <div className="ds-card" style={{ padding: "var(--s-4)" }}>
              <EquityCurve series={visibleSeries} />
            </div>
          </section>

          {/* 仓位明细:已结算/持有中 tab 切换 + 按策略筛选(计数随筛选联动) */}
          <section>
            <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
              仓位明细
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--s-3)",
                flexWrap: "wrap",
                marginBottom: "var(--s-2)",
              }}
            >
              <Segmented<PosTab>
                ariaLabel="仓位状态"
                options={[
                  {
                    label: `已结算 · 落袋(${shownSettled.length})`,
                    value: "settled",
                  },
                  {
                    label: `持有中 · 待结算(${shownOpen.length})`,
                    value: "open",
                  },
                ]}
                value={posTab}
                onChange={setPosTab}
              />
              {/* 只有一条策略时筛选没有意义,不渲染。12 档上限时这里最多
                  13 个胶囊(全部策略 + 12 档,含「早期赢家跟投」这种 6 字
                  策略名),桌面宽度下会超出页面 max-width:1180px 的容器——
                  用 ds-segmented--wrap 修饰类换行,不改共享基类(见
                  globals.css 该类注释)。 */}
              {shown.length >= 2 ? (
                <Segmented<number>
                  ariaLabel="按策略筛选仓位"
                  className="ds-segmented--wrap"
                  options={[
                    { label: "全部策略", value: FILTER_ALL },
                    ...shown.map((s) => ({ label: s.name, value: s.id })),
                  ]}
                  value={effFilter}
                  onChange={setStratFilter}
                />
              ) : null}
              {posTab === "open" ? (
                <span className="ds-hint">不显示浮盈</span>
              ) : null}
            </div>
            {posTab === "settled" ? (
              <SettledTable
                rows={shownSettled}
                emptyText={
                  filterName
                    ? `「${filterName}」策略尚无已结算的纸面仓位`
                    : undefined
                }
              />
            ) : (
              <OpenTable
                rows={shownOpen}
                emptyText={
                  filterName
                    ? `「${filterName}」策略当前没有持仓中的纸面仓位`
                    : undefined
                }
              />
            )}
          </section>
        </>
      )}
    </main>
  );
}
