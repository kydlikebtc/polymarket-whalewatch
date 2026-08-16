// X (Twitter) 帖文模板 —— 全部纯函数,无 I/O。
//
// 两条硬不变量(都有测试钉住):
//  1. ≤280 字符:超长一律截 title 补 "…",绝不让 publisher 吃 API 400。
//  2. 除 weekly 外输出不得含 URL:X 按量付费对带链接帖收 $0.20/条(无链接
//     $0.015 的 13 倍),市场标题里混入的链接也要剥掉 —— 成本口子在模板层
//     就焊死,而不是指望上游数据干净。
// 语言:纯英文(设计定稿:X 面向全球用户,TG 频道继续服务中文用户)。

export const X_POST_MAX_CHARS = 280;

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

// 剥掉标题里的 URL(见文件头不变量 2)并收敛空白。
function sanitizeTitle(title: string): string {
  return title
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function settlesIn(hoursToEnd: number): string {
  if (hoursToEnd < 1) return "settles in <1h";
  if (hoursToEnd < 48) return `settles in ${Math.round(hoursToEnd)}h`;
  return `settles in ${Math.round(hoursToEnd / 24)}d`;
}

// 280 限长的唯一实现:超长部分全部从 title 上截。title 是模板里唯一的
// 变长自由文本,数字段截断会造成误读,title 截断只损失可读性。
function fitByTruncatingTitle(
  build: (title: string) => string,
  title: string,
): string {
  const full = build(title);
  const over = [...full].length - X_POST_MAX_CHARS;
  if (over <= 0) return full;
  const keep = Math.max(0, [...title].length - over - 1);
  return build([...title].slice(0, keep).join("") + "…");
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
}

/**
 * 🐳 $184K YES on "Chiefs win Super Bowl LX?" @ 67¢
 * 12% of 24h vol · liquidity $229K · settles in 5h
 *
 * 第二行是 Gamma 富化段:哪段缺哪段整段省略(未富化的告警只发第一行),
 * 绝不用 0/N-A 占位 —— 假数字比没数字更伤可信度。
 */
export function composeWhalePost(i: WhalePostInput): string {
  const emoji = i.usd >= WHALE_SIREN_USD ? "🚨" : "🐳";
  const sold = i.side === "SELL" ? " SOLD" : "";
  const ctx: string[] = [];
  if (i.pct24h != null) ctx.push(`${Math.round(i.pct24h)}% of 24h vol`);
  if (i.liquidityUsd != null)
    ctx.push(`liquidity ${usdCompact(i.liquidityUsd)}`);
  if (i.hoursToEnd != null) ctx.push(settlesIn(i.hoursToEnd));
  const ctxLine = ctx.length > 0 ? `\n${ctx.join(" · ")}` : "";
  return fitByTruncatingTitle(
    (title) =>
      `${emoji} ${usdCompact(i.usd)}${sold} ${outcomeDisplay(i.outcome)} on "${title}" @ ${i.priceCents}¢${ctxLine}`,
    sanitizeTitle(i.title),
  );
}

export interface ConsensusPostInput {
  walletCount: number;
  outcome: string;
  title: string;
  totalUsd: number;
}

/** 🔥 CONSENSUS: 3 top-PnL wallets bought the SAME side of "…" · combined $92K on YES */
export function composeConsensusPost(i: ConsensusPostInput): string {
  return fitByTruncatingTitle(
    (title) =>
      `🔥 CONSENSUS: ${i.walletCount} top-PnL wallets bought the SAME side of "${title}" · combined ${usdCompact(i.totalUsd)} on ${outcomeDisplay(i.outcome)}`,
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
}

/**
 * ⏰ Settles in 3h: "Lakers vs Celtics"
 * Smart money fired 7 alerts totaling $310K in the last 24h · leaning YES @ 61¢
 */
export function composePregamePost(i: PregamePostInput): string {
  const leaning =
    i.topSide != null
      ? ` · leaning ${outcomeDisplay(i.topSide)}` +
        (i.topSidePriceCents != null ? ` @ ${i.topSidePriceCents}¢` : "")
      : "";
  const settle = settlesIn(i.hoursToEnd).replace(/^settles/, "Settles");
  return fitByTruncatingTitle(
    (title) =>
      `⏰ ${settle}: "${title}"\nSmart money fired ${i.alertCount} alerts totaling ${usdCompact(i.totalUsd)} in the last 24h${leaning}`,
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

/** 周报是唯一允许带 URL 的模板(唯一的 $0.20 帖,导流入口)。 */
export function composeWeeklyPost(i: WeeklyPostInput): string {
  const pnl = `${i.pnlUsd >= 0 ? "+" : ""}${usdCompact(i.pnlUsd)}`;
  const mid = [
    `Settled ${i.settled} positions`,
    ...(i.winRatePct != null ? [`win rate ${Math.round(i.winRatePct)}%`] : []),
    `PnL ${pnl}`,
  ].join(" · ");
  const roi = `${i.bestRoiPct >= 0 ? "+" : ""}${Math.round(i.bestRoiPct * 10) / 10}%`;
  return (
    `📊 Weekly report (${i.weekLabel}) — 19 paper strategies tracking Polymarket smart money\n` +
    `${mid}\n` +
    `Best: ${strategyEn(i.bestName)} ${roi} ROI\n` +
    `Full verified track record: ${i.url}`
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
