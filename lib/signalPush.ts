import { formatRecordLine, type SignalRecord } from "./signalRecord";
import { cents, durText, esc, urlSeg, usd } from "./tgFormat";

// 对外信号批次 1:策略信号的 TG 消息格式化(纯函数,无 db 依赖)。
// 版式约定沿用 lib/botCommands.ts:空行分块、粗体小标题、一行一个事实。
//
// 三条格式化铁律(与推送尾行/信号 feed 同源):
//   1. 战绩行只能出自 formatRecordLine —— implied 必印、excess 不脱离 ±2σ、
//      小样本明示,任何第二实现都是口径漂移的起点。
//   2. 免责尾行每条必带(SIGNAL_DISCLAIMER),这是对外信号与站内展示的
//      本质区别 —— 站内有页头三声明兜底,频道消息是孤立传播单元。
//   3. 所有动态文本经 esc、URL 片段经 urlSeg —— 一个裸引号就是一条毒消息
//      (Telegram 400 can't parse entities),lib/telegram.ts 的降级重发只是
//      最后防线,不是许可。

/** 每条对外信号消息必带的免责尾行。 */
export const SIGNAL_DISCLAIMER = "研究用途模拟信号 · 非投资建议 · 只读非托管";

/** 一条消息里最多打印几档的战绩行(多档共振时防消息过长)。 */
const MAX_RECORD_LINES = 2;

/** strategy_signals 表行(snake_case 直读,与 SQLite 列名一致)。 */
export interface PushSignalRow {
  id: number;
  strategy_id: number;
  condition_id: string;
  outcome: string;
  outcome_index: number | null;
  asset: string | null;
  title: string | null;
  slug: string | null;
  event_slug: string | null;
  formation_ts: number;
  reference_price: number | null;
  wallet_count: number | null;
  total_net_usd: number | null;
  entry_price: number | null;
  size_usd: number | null;
  emitted_at: number;
  settled: number;
  settled_ts: number | null;
  exit_price: number | null;
  won: number | null;
  realized_pnl: number | null;
}

export interface EntryPushOpts {
  /** strategy_id → 档位名(follow_strategies.name)。缺名回退 `#<id>`。 */
  strategyNames: Map<number, string>;
  /** strategy_id → 该档 30d 战绩(strategyRecord30d);settled=0 整行省略。 */
  recordByStrategy?: Map<number, SignalRecord>;
  category?: string | null;
  subcategory?: string | null;
  publicUrl?: string;
  nowSec: number;
}

const nameOf = (names: Map<number, string>, id: number): string =>
  names.get(id) ?? `#${id}`;

/** 带符号的 ¢ 差(追价成本):+2.0¢ / −1.5¢ / 0¢。 */
const signedCents = (delta: number): string => {
  const c = delta * 100;
  const abs = Math.abs(c).toFixed(1).replace(/\.0$/, "");
  if (c > 0) return `+${abs}¢`;
  if (c < 0) return `−${abs}¢`;
  return "0¢";
};

/**
 * entry 事件:同一 (市场, 方向) 的多档触发合并为一条消息(投递侧按此分组)。
 * 头部数字取 emitted_at 最早的那一行 —— 与 foldEscalations「按读者真正能
 * 行动的那个价格计」同一哲学:后触发的档位引用的是市场已经走过去的价格。
 */
export function formatStrategyEntryTg(
  rows: PushSignalRow[],
  opts: EntryPushOpts,
): string {
  const sorted = [...rows].sort((a, b) => a.emitted_at - b.emitted_at);
  const lead = sorted[0];
  const names = sorted.map((r) => nameOf(opts.strategyNames, r.strategy_id));
  const title = lead.title ?? lead.condition_id;
  const titleHtml = opts.publicUrl
    ? `<a href="${opts.publicUrl}/market/${urlSeg(lead.condition_id)}">${esc(title)}</a>`
    : esc(title);

  const lines: string[] = [];
  lines.push(`📡 策略信号 · <b>${names.map(esc).join(" + ")}</b>`);
  lines.push(titleHtml);
  const entry = lead.entry_price ?? 0;
  const size = lead.size_usd ?? 0;
  lines.push(
    `🟢 买入 <b>${esc(lead.outcome)}</b> @ ${cents(entry)} · 模拟 ${usd(size)}/档`,
  );
  const ref = lead.reference_price;
  if (ref != null && ref > 0) {
    lines.push(
      `聪明钱成本 ${cents(ref)} · 追价 ${signedCents(entry - ref)} · 信号延迟 ${durText(
        Math.max(0, lead.emitted_at - lead.formation_ts),
      )}`,
    );
  }
  if (opts.category) {
    lines.push(
      `分类 ${esc(opts.category)}${opts.subcategory ? ` · ${esc(opts.subcategory)}` : ""}`,
    );
  }
  // 战绩行:每档一行,settled=0 省略(没有可说的就不说),最多 MAX_RECORD_LINES。
  const recs = opts.recordByStrategy;
  if (recs) {
    let printed = 0;
    for (const r of sorted) {
      if (printed >= MAX_RECORD_LINES) break;
      const rec = recs.get(r.strategy_id);
      if (!rec || rec.settled === 0) continue;
      const line = formatRecordLine(
        nameOf(opts.strategyNames, r.strategy_id),
        rec,
      );
      if (line) {
        lines.push(line);
        printed++;
      }
    }
  }
  lines.push("");
  lines.push(SIGNAL_DISCLAIMER);
  return lines.join("\n");
}

export interface SettlePushOpts {
  strategyNames: Map<number, string>;
  publicUrl?: string;
  nowSec: number;
}

const wonEmoji = (won: number | null): string =>
  won === 1 ? "✅" : won === 0 ? "❌" : "➖";

/**
 * 带符号美元:+$294 / -$500 / $0。usd() 对负数产出 "$-500"(符号在 $ 后),
 * 消息里读起来像笔误 —— 这里统一为符号在前。
 */
const signedUsd = (n: number): string => {
  if (n > 0) return `+${usd(n)}`;
  if (n < 0) return `-${usd(Math.abs(n))}`;
  return usd(0);
};

/**
 * settle 事件(认账):同一 (市场, 方向) 的多档结算合并为一条。结算价对全组
 * 相同(同一市场事实),每档各自的入场价与盈亏逐行列出 —— 赢了亏了都在
 * 同一格式里,这是「先发布后结算」承诺的兑现面。
 */
export function formatStrategySettleTg(
  rows: PushSignalRow[],
  opts: SettlePushOpts,
): string {
  const sorted = [...rows].sort((a, b) => a.emitted_at - b.emitted_at);
  const lead = sorted[0];
  const anyWon = sorted.some((r) => r.won === 1);
  const allPush = sorted.every((r) => r.won === null);
  const head = allPush ? "➖" : anyWon ? "✅" : "❌";
  const title = lead.title ?? lead.condition_id;
  const titleHtml = opts.publicUrl
    ? `<a href="${opts.publicUrl}/market/${urlSeg(lead.condition_id)}">${esc(title)}</a>`
    : esc(title);

  const lines: string[] = [];
  lines.push(`${head} 策略信号结算 · ${titleHtml}`);
  lines.push(
    `<b>${esc(lead.outcome)}</b> → 结算 ${cents(lead.exit_price ?? 0)}`,
  );
  for (const r of sorted) {
    lines.push(
      `${esc(nameOf(opts.strategyNames, r.strategy_id))}:${cents(
        r.entry_price ?? 0,
      )} 进 · ${signedUsd(r.realized_pnl ?? 0)} ${wonEmoji(r.won)}`,
    );
  }
  lines.push("");
  lines.push(SIGNAL_DISCLAIMER);
  return lines.join("\n");
}
