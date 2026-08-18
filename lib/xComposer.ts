// X (Twitter) 帖文模板 —— 全部纯函数,无 I/O。
//
// 两条硬不变量(都有测试钉住):
//  1. ≤280 **加权**字符(X 的 twitter-text 口径,emoji/制表符号算 2 个):
//     超长一律截 title 补 "…",绝不让 publisher 吃 API 400。
//  2. 除 weekly 外输出不得含 URL:X 按量付费对带链接帖收 $0.20/条(无链接
//     $0.015 的 13 倍),市场标题里混入的链接也要剥掉 —— 成本口子在模板层
//     就焊死,而不是指望上游数据干净。
// 语言:纯英文(设计定稿:X 面向全球用户,TG 频道继续服务中文用户)。

export const X_POST_MAX_CHARS = 280;

// X 的字符计数不是码点数,是 twitter-text 的**加权长度**:defaultWeight=200、
// scale=100、maxWeightedTweetLength=280 —— 只有下面这几段码位权重 100(算 1 个
// 字符),其余一律 200(算 2 个)。emoji、制表符号(└)、省略号(…)全在后者。
//
// 为什么必须较真:模板里固定有 🐳/📊/💧/⏳/└ 五个双宽字符,截断时还会补一个
// …,所以按码点截到 280 的帖子在 X 眼里是 286 —— 直接 403 被拒。危险带比
// 截断更宽:非截断帖只要码点数 ≥276 就已经超了。
const LIGHT_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
  [0x2043, 0x2043],
];

/** 一段文本在 X 眼里占几个字符。遍历码点(不是 UTF-16 单元)。 */
export function weightedLength(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    w += LIGHT_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return w;
}

// 大单帖的告警级前缀分档:🚨 是"停下来看"级别,与 TG 的 🐳/💰 分层同思路。
export const WHALE_SIREN_USD = 250_000;

/** $184K / $1.25M / $900 —— X 上寸字寸金,K/M 压缩 + 去尾零。 */
export function usdCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 1000) return `${sign}$${Math.round(abs)}`;
  if (abs < 1_000_000) {
    const k = abs / 1000;
    const s = k >= 100 ? k.toFixed(0) : (Math.round(k * 10) / 10).toString();
    return `${sign}$${s}K`;
  }
  const m = Math.round((abs / 1_000_000) * 100) / 100;
  return `${sign}$${m}M`;
}

// Yes/No 大写成 YES/NO 是行业惯例(读者扫一眼就知道方向);球队/人名等长
// outcome 保持原样 —— 全大写长词是喊叫不是强调。
function outcomeDisplay(outcome: string): string {
  return outcome.length <= 3 ? outcome.toUpperCase() : outcome;
}

// ---- 话题标签 ----------------------------------------------------------
//
// 标签是 X 上的可发现性入口:不带标签的帖子只有关注者看得到,带了就能进
// 话题流。但标签也吃字符(280 硬上限),所以规则是「少而准」:
//   · #Polymarket 恒定 —— 这是账号赖以被找到的根标签;
//   · 赛道标签取二级优先(#NFL 比 #Sports 精准得多,受众也更集中),
//     没有二级才退到一级;
//   · 类型标签只给独家能力(#SmartMoney),大单这种人人都有的不加。
// 未知/脏值一律丢弃 —— 宁可少一个标签,也不要 #undefined 这种废标签。
const ROOT_TAG = "#Polymarket";

// 一级类别到标签的映射。gamma 给的是英文原文,多数可直接当标签;这里只
// 修正少数不适合做标签的写法,其余透传。
const CATEGORY_TAG: Record<string, string> = {
  Politics: "Politics",
  Elections: "Elections",
  Sports: "Sports",
  Esports: "Esports",
  Crypto: "Crypto",
  Economy: "Economy",
  Finance: "Finance",
  Business: "Business",
  Tech: "Tech",
  Science: "Science",
  Culture: "Culture",
  World: "World",
  Weather: "Weather",
  Games: "Gaming",
  Geopolitics: "Geopolitics",
};

/** 合法标签体:只留字母数字,首字符非数字。产不出就返回 null。 */
function toTag(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const body = raw.replace(/[^A-Za-z0-9]/g, "");
  if (!body || /^[0-9]/.test(body)) return null;
  return `#${body}`;
}

export interface TagInput {
  category?: string | null;
  subcategory?: string | null;
  /** 独家信号类型(共识/发现)加 #SmartMoney;大单不加。 */
  smartMoney?: boolean;
}

/** 组装标签行。恒有 #Polymarket;赛道二级优先;去重且保持稳定顺序。 */
export function buildTags(i: TagInput): string {
  const out: string[] = [ROOT_TAG];
  const track =
    toTag(i.subcategory) ??
    toTag(i.category ? (CATEGORY_TAG[i.category] ?? i.category) : null);
  if (track && !out.includes(track)) out.push(track);
  if (i.smartMoney) out.push("#SmartMoney");
  return out.join(" ");
}

// 剥掉标题里的 URL(见文件头不变量 2)并收敛空白。
function sanitizeTitle(title: string): string {
  return title
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// 紧凑形态,给结构化布局的佐证段用(那里已有 ⏳ 图标点题)。
function settleShort(hoursToEnd: number): string {
  if (hoursToEnd < 1) return "<1h to settle";
  if (hoursToEnd < 48) return `${Math.round(hoursToEnd)}h to settle`;
  return `${Math.round(hoursToEnd / 24)}d to settle`;
}

function settlesIn(hoursToEnd: number): string {
  if (hoursToEnd < 1) return "settles in <1h";
  if (hoursToEnd < 48) return `settles in ${Math.round(hoursToEnd)}h`;
  return `settles in ${Math.round(hoursToEnd / 24)}d`;
}

// 280 限长的唯一实现:超长部分全部从 title 上截。title 是模板里唯一的
// 变长自由文本,数字段截断会造成误读,title 截断只损失可读性。
//
// 为什么是二分而不是「算出超了几个字符就砍几个」:加权长度对码点数**不是
// 线性的** —— 砍掉的可能是权重 1 的 ASCII,也可能是权重 2 的 emoji,而补上的
// "…" 本身又占 2。旧实现按码点做减法,结果恒定截到「码点 280」,在 X 眼里是
// 286,一律 403。二分只依赖唯一可靠的性质:标题前缀越短,帖子越短。
function fitByTruncatingTitle(
  build: (title: string) => string,
  title: string,
): string {
  const full = build(title);
  if (weightedLength(full) <= X_POST_MAX_CHARS) return full;
  const chars = [...title];
  let lo = 0; // 已知能塞下的最长标题前缀长度
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = build(chars.slice(0, mid).join("") + "…");
    if (weightedLength(candidate) <= X_POST_MAX_CHARS) lo = mid;
    else hi = mid - 1;
  }
  return build(chars.slice(0, lo).join("") + "…");
}

export interface WhalePostInput {
  usd: number;
  side: "BUY" | "SELL";
  outcome: string;
  title: string;
  priceCents: number;
  pct24h?: number | null;
  liquidityUsd?: number | null;
  hoursToEnd?: number | null;
  category?: string | null;
  subcategory?: string | null;
}

/**
 * 结构化布局(读者在时间线上是「扫」不是「读」):
 *
 *   🐳 WHALE BUY · $184K
 *
 *   Chiefs win Super Bowl LX?
 *   └ YES @ 67¢
 *
 *   📊 12% of 24h vol · 💧 $229K liq · ⏳ 5h to settle
 *
 *   #Polymarket #NFL
 *
 * 首行给结论(什么事+多大),中段给标的与方向,再给佐证,末行给标签。
 * 佐证段哪项缺就省哪项,整段都没有就整行不要 —— 绝不用 0/N-A 占位。
 */
export function composeWhalePost(i: WhalePostInput): string {
  const siren = i.usd >= WHALE_SIREN_USD;
  const head = `${siren ? "🚨" : "🐳"} WHALE ${i.side === "SELL" ? "SELL" : "BUY"} · ${usdCompact(i.usd)}`;
  const facts: string[] = [];
  if (i.pct24h != null) facts.push(`📊 ${Math.round(i.pct24h)}% of 24h vol`);
  if (i.liquidityUsd != null)
    facts.push(`💧 ${usdCompact(i.liquidityUsd)} liq`);
  if (i.hoursToEnd != null) facts.push(`⏳ ${settleShort(i.hoursToEnd)}`);
  const factLine = facts.length > 0 ? `\n\n${facts.join(" · ")}` : "";
  const tags = buildTags({ category: i.category, subcategory: i.subcategory });
  return fitByTruncatingTitle(
    (title) =>
      `${head}\n\n${title}\n└ ${outcomeDisplay(i.outcome)} @ ${i.priceCents}¢${factLine}\n\n${tags}`,
    sanitizeTitle(i.title),
  );
}

export interface ConsensusPostInput {
  walletCount: number;
  outcome: string;
  title: string;
  totalUsd: number;
  category?: string | null;
  subcategory?: string | null;
}

/**
 *   🔥 SMART-MONEY CONSENSUS
 *
 *   Fed cut in Sept?
 *   └ 3 top-PnL wallets → YES · $92K combined
 *
 *   #Polymarket #Economy #SmartMoney
 */
export function composeConsensusPost(i: ConsensusPostInput): string {
  const tags = buildTags({
    category: i.category,
    subcategory: i.subcategory,
    smartMoney: true,
  });
  return fitByTruncatingTitle(
    (title) =>
      `🔥 SMART-MONEY CONSENSUS\n\n${title}\n└ ${i.walletCount} top-PnL wallets → ${outcomeDisplay(i.outcome)} · ${usdCompact(i.totalUsd)} combined\n\n${tags}`,
    sanitizeTitle(i.title),
  );
}

export interface PregamePostInput {
  title: string;
  hoursToEnd: number;
  alertCount: number;
  totalUsd: number;
  topSide?: string | null;
  topSidePriceCents?: number | null;
  category?: string | null;
  subcategory?: string | null;
}

/**
 *   ⏰ SETTLING IN 3H
 *
 *   Lakers vs Celtics
 *   └ Leaning YES @ 61¢
 *
 *   📡 7 smart-money signals · $310K in 24h
 *
 *   #Polymarket #NBA #SmartMoney
 */
export function composePregamePost(i: PregamePostInput): string {
  const head = `⏰ SETTLING IN ${settleShort(i.hoursToEnd).replace(" to settle", "").toUpperCase()}`;
  const lean =
    i.topSide != null
      ? `\n└ Leaning ${outcomeDisplay(i.topSide)}` +
        (i.topSidePriceCents != null ? ` @ ${i.topSidePriceCents}¢` : "")
      : "";
  const tags = buildTags({
    category: i.category,
    subcategory: i.subcategory,
    smartMoney: true,
  });
  return fitByTruncatingTitle(
    (title) =>
      `${head}\n\n${title}${lean}\n\n📡 ${i.alertCount} smart-money signals · ${usdCompact(i.totalUsd)} in 24h\n\n${tags}`,
    sanitizeTitle(i.title),
  );
}

export interface WeeklyPostInput {
  weekLabel: string;
  settled: number;
  winRatePct: number | null;
  pnlUsd: number;
  bestName: string;
  bestRoiPct: number;
  url: string;
}

/**
 * 周报是唯一允许带 URL 的模板(唯一的 $0.20 帖,导流入口)。
 *
 *   📊 WEEKLY REPORT · Aug 10–16
 *
 *   19 paper strategies tracking Polymarket smart money
 *
 *   ✅ 42 settled · 55% win rate
 *   💰 PnL +$1.2K
 *   🏆 Best: Mega Whale +12.3% ROI
 *
 *   Full verified record: https://…
 *
 *   #Polymarket #PredictionMarkets #SmartMoney
 */
export function composeWeeklyPost(i: WeeklyPostInput): string {
  const pnl = `${i.pnlUsd >= 0 ? "+" : ""}${usdCompact(i.pnlUsd)}`;
  const settledLine =
    i.winRatePct != null
      ? `✅ ${i.settled} settled · ${Math.round(i.winRatePct)}% win rate`
      : `✅ ${i.settled} settled`;
  const roi = `${i.bestRoiPct >= 0 ? "+" : ""}${Math.round(i.bestRoiPct * 10) / 10}%`;
  return (
    `📊 WEEKLY REPORT · ${i.weekLabel}\n\n` +
    `19 paper strategies tracking Polymarket smart money\n\n` +
    `${settledLine}\n` +
    `💰 PnL ${pnl}\n` +
    `🏆 Best: ${strategyEn(i.bestName)} ${roi} ROI\n\n` +
    `Full verified record: ${i.url}\n\n` +
    `#Polymarket #PredictionMarkets #SmartMoney`
  );
}

// 19 档种子名 → 英文(与 lib/db.ts seeds v4 一一对应;新档缺映射时回退原名,
// 宁可中文名出现在英文帖里也不显示错误翻译)。
export const STRATEGY_EN: Record<string, string> = {
  保守: "Conservative Consensus",
  激进: "Aggressive Consensus",
  精英共识: "Elite Consensus",
  重仓共识: "Heavy Consensus",
  首发共识: "First-Mover Consensus",
  巨鲸: "Whale Follow",
  超级巨鲸: "Mega Whale",
  巨鲸精英: "Elite Whale",
  一边倒分歧: "Lopsided Majority",
  分歧解除: "Standoff Resolved",
  高分独狼: "Lone Wolf",
  早期赢家跟投: "Early Winner",
  逆势少数边: "Contrarian Minority",
  反巨鲸: "Inverse Whale",
  反超级巨鲸: "Inverse Mega Whale",
  反巨鲸精英: "Inverse Elite Whale",
  反分歧解除: "Inverse Standoff Resolved",
  反高分独狼: "Inverse Lone Wolf",
  反早期赢家: "Inverse Early Winner",
};

export function strategyEn(name: string): string {
  return STRATEGY_EN[name] ?? name;
}
