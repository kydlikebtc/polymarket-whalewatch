import type { DB } from "./db";
import { buildPulse } from "./marketPulse";
import { buildWeeklyReport } from "./xWeekly";
import { utcWeekStart } from "./followAnalysis";
import { cents, esc, usd, usdCompact } from "./tgFormat";

// 内容引擎产物的 **Telegram 出口**(2026-09-07)。
//
// 为什么必须有:日榜 / 每日战报榜 / 周报是这个项目每天最值得读的三样东西,
// 而它们此前**只发 X**。2026-08-31 的实测把这条错配钉死了 —— 那个账号
// 4,820 粉丝、每帖 8.3 次浏览、0 点赞,触达 0.17%;而 Telegram 频道是本项目
// 唯一一条自己说了算的分发管道,没有算法闸、没有 280 字限制、可以带链接、
// 每条 $0。最好的内容一直只进了最差的渠道。
//
// 与 X 侧的四条差异,每条都是因为渠道不同而不是随手改的:
//
//  1. **日榜与分歧合成一条**。X 上它们是两帖,因为 280 字装不下;TG 没有这个
//     约束,而频道里的条数才是读者的成本 —— 一天一条比两条好。
//  2. **带链接**。X 的模板层焊死了非 weekly 禁 URL($0.20/条的链接帖),
//     TG 没有这个经济账,每一行都可以点进去看。
//  3. **战报榜的分母不同,且必须写在消息里**。X 版数的是「我们发过帖的信号
//     昨天结算了几条」(x_posts × alert_outcomes);TG 版数的是**告警台账**
//     昨天结算了几条 —— 因为 X 没开的部署里 x_posts 是空的,照抄那个口径会
//     让 TG 战报永远沉默。两个分母都诚实,但绝不能混着说,所以消息里直接
//     写明「口径:告警台账」。
//  4. **零配额概念**。没有 xQuota、没有花费保险丝、没有 claim/settle 三态
//     台账 —— 日门标记走 config(与 maybeDailySelfCheck / 每日存证同一套
//     claim-first),失败最多丢一条,绝不重复轰炸。
//
// 三类默认全关(与「同批出生」上线时同一条纪律:新能力一律默认关,运营者在
// 投递目标里显式勾选才推)。

/** 日门/周门标记的 config 键前缀。 */
const DAY_KEY = (kind: string) => `tg_content_last_day:${kind}`;

const utcDayStr = (sec: number): string =>
  new Date(sec * 1000).toISOString().slice(0, 10);

/**
 * 与 X 侧同一条受众高峰哲学(14:00 UTC ≈ 美东早 10 点)。
 * TG 不烧钱,但频道消息的时刻仍然影响有多少人看见。
 */
export const TG_CONTENT_POST_UTC_HOUR = 14;
/** 周报:周一。与 xWeekly 的 13:00 UTC 对齐。 */
export const TG_WEEKLY_POST_UTC_HOUR = 13;

/** 榜上取前几名进消息。TG 没有字数压力,但一屏读得完才有人读。 */
export const PULSE_TOP_N = 5;
export const DIVERGENCE_TOP_N = 3;
export const SCORECARD_ROWS_N = 6;

export interface TgContentDeps {
  db: DB;
  /** 三类各自的发送函数(makeKindSender 的产物);undefined = 该类无人订阅。 */
  senders: {
    pulse?: (html: string) => Promise<void>;
    scorecard?: (html: string) => Promise<void>;
    weekly?: (html: string) => Promise<void>;
  };
  publicUrl: string;
  postUtcHour?: number;
  weeklyUtcHour?: number;
  nowSec?: number;
}

const marketLink = (
  publicUrl: string,
  conditionId: string,
  title: string | null,
): string =>
  `<a href="${publicUrl}/market/${encodeURIComponent(conditionId)}">${esc(title ?? conditionId.slice(0, 10))}</a>`;

// --- ① 市场脉搏日榜(含分歧线)-------------------------------------------

export function composePulseMessage(opts: {
  day: string;
  top: {
    conditionId: string;
    title: string | null;
    score: number;
    volumeUsd: number;
    volRatio: number | null;
    oneSidedPct: number;
  }[];
  divergences: {
    conditionId: string;
    title: string | null;
    smallTopOutcome: string;
    smallNetUsd: number;
    whaleTopOutcome: string;
    whaleNetUsd: number;
  }[];
  publicUrl: string;
}): string {
  const lines: string[] = [
    `📊 <b>市场脉搏 ${opts.day}</b>(UTC 日)`,
    "",
    "<b>异常市场日榜</b>",
  ];
  opts.top.forEach((m, i) => {
    const vol = m.volRatio != null ? ` · 量能 ×${m.volRatio.toFixed(1)}` : "";
    lines.push(
      `${i + 1}. ${marketLink(opts.publicUrl, m.conditionId, m.title)}\n` +
        `    怪异度 ${Math.round(m.score)} · ${usd(m.volumeUsd)}${vol} · 单边 ${Math.round(m.oneSidedPct)}%`,
    );
  });
  if (opts.divergences.length > 0) {
    lines.push("", "<b>小单 vs 鲸鱼分歧</b>");
    for (const d of opts.divergences) {
      lines.push(
        `· ${marketLink(opts.publicUrl, d.conditionId, d.title)}\n` +
          `    小单 → ${esc(d.smallTopOutcome)} ${usdCompact(d.smallNetUsd)} · 鲸鱼 → ${esc(d.whaleTopOutcome)} ${usdCompact(d.whaleNetUsd)}`,
      );
    }
  }
  lines.push(
    "",
    `口径:小单 $2k–10k · 鲸鱼 ≥$50k · 全部为已收盘 UTC 日的市场汇总,不是信号`,
    `<a href="${opts.publicUrl}/pulse">完整五榜 →</a>`,
  );
  return lines.join("\n");
}

// --- ② 每日战报(告警台账口径)-------------------------------------------

export interface TgScorecardRow {
  title: string;
  won: boolean;
  entryPrice: number | null;
}

/**
 * 代表行选取:与 X 侧 pickScorecardRows 同一条纪律 —— **先保证有输有赢**。
 * 只列赢单的成绩单正是「只放记录」当场破产的样子。这里不 import 那个函数
 * 是因为行的形状不同(TG 版带入场价、不预先算回报率),纪律照抄、实现独立,
 * 且各自有测试钉着。
 */
export function pickTgScorecardRows(
  rows: TgScorecardRow[],
  limit = SCORECARD_ROWS_N,
): TgScorecardRow[] {
  const wins = rows.filter((r) => r.won);
  const losses = rows.filter((r) => !r.won);
  const out: TgScorecardRow[] = [];
  for (let i = 0; i < Math.max(wins.length, losses.length); i++) {
    if (wins[i]) out.push(wins[i]);
    if (losses[i]) out.push(losses[i]);
  }
  return out.slice(0, limit);
}

export function composeScorecardMessage(opts: {
  day: string;
  settled: number;
  wins: number;
  rows: TgScorecardRow[];
}): string {
  const pct = opts.settled > 0 ? Math.round((opts.wins / opts.settled) * 100) : 0;
  const lines: string[] = [
    `📋 <b>每日战报 ${opts.day}</b>(UTC 日)`,
    `${opts.settled} 条结算 · ${opts.wins} 条命中 · ${pct}%`,
    "",
  ];
  for (const r of opts.rows) {
    const at = r.entryPrice != null ? ` @ ${cents(r.entryPrice)}` : "";
    lines.push(`${r.won ? "✅" : "❌"} ${esc(r.title)}${at}`);
  }
  lines.push(
    "",
    // 分母写在消息里,不写在别处 —— 与 X 版的分母不同,混着读会得出错的结论。
    "口径:本站告警台账(大额/共识)中昨日回填到结算的部分,不是策略档纸面战绩",
  );
  return lines.join("\n");
}

// --- ③ 周报成绩单 ---------------------------------------------------------

export function composeWeeklyMessage(opts: {
  weekLabel: string;
  settled: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  pnlUsd: number;
  rows: { name: string; settled: number; pnlUsd: number; roiPct: number | null }[];
  publicUrl: string;
}): string {
  const lines: string[] = [
    `📊 <b>周报成绩单 ${opts.weekLabel}</b>`,
    `${opts.settled} 笔结算 · 胜率 ${opts.winRatePct == null ? "—" : `${opts.winRatePct.toFixed(0)}%`} · 纸面盈亏 ${usdCompact(opts.pnlUsd)}`,
    "",
  ];
  for (const r of opts.rows.slice(0, 8)) {
    const roi = r.roiPct == null ? "—" : `${r.roiPct >= 0 ? "+" : "−"}${Math.abs(r.roiPct).toFixed(1)}%`;
    lines.push(`· ${esc(r.name)} ${r.settled} 笔 · ${usdCompact(r.pnlUsd)} · ${roi}`);
  }
  lines.push(
    "",
    "口径:纸面模拟,零真实资金;含协议 taker 费与订单簿滑点建模",
    `<a href="${opts.publicUrl}/follow">策略中心 →</a> · <a href="${opts.publicUrl}/record">公开战绩 →</a>`,
  );
  return lines.join("\n");
}

// --- 循环 -----------------------------------------------------------------

/** claim-first 日门:先记标记再发送,瞬态失败最多丢一条,绝不重复轰炸。 */
function claimDay(db: DB, kind: string, day: string): boolean {
  const cur = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(DAY_KEY(kind)) as { value: string | null } | undefined;
  if (cur?.value === day) return false;
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    DAY_KEY(kind),
    day,
  );
  return true;
}

interface SettledAlertRow {
  payload: string;
  type: string;
  won: number;
}

/**
 * 三类内容各自到点后发一次。返回本轮发出的条数。
 *
 * 发送失败**不抛**:内容帖失败不该扰动它搭车的投递循环(与 X 播报对
 * Telegram 路径的隔离同一条)。日门已经 claim,所以失败等于跳过这一天 ——
 * 一条日榜的价值不值得为它冒重复轰炸频道的风险。
 */
export async function runTgContentCycle(d: TgContentDeps): Promise<number> {
  const nowSec = d.nowSec ?? Math.floor(Date.now() / 1000);
  const now = new Date(nowSec * 1000);
  const yesterday = utcDayStr(nowSec - 86_400);
  const today = utcDayStr(nowSec);
  let sent = 0;

  const hour = now.getUTCHours();
  const postHour = d.postUtcHour ?? TG_CONTENT_POST_UTC_HOUR;
  const weeklyHour = d.weeklyUtcHour ?? TG_WEEKLY_POST_UTC_HOUR;

  // ① 日榜(含分歧)
  if (d.senders.pulse && hour >= postHour) {
    const report = buildPulse(d.db);
    // 数据就绪闸(照抄 xPulse):只发昨天。聚合迟到就等下一 tick;漏了一天
    // 则永不补发旧闻 —— 一条过期的「异常日榜」比没有更糟。
    if (report.latestDay === yesterday && report.top.length > 0) {
      if (claimDay(d.db, "pulse", today)) {
        const html = composePulseMessage({
          day: yesterday,
          top: report.top.slice(0, PULSE_TOP_N).map((m) => ({
            conditionId: m.conditionId,
            title: m.title,
            score: m.score,
            volumeUsd: m.volumeUsd,
            volRatio: m.volRatio,
            oneSidedPct: m.components.oneSided * 100,
          })),
          divergences: report.divergences.slice(0, DIVERGENCE_TOP_N),
          publicUrl: d.publicUrl,
        });
        try {
          await d.senders.pulse(html);
          sent++;
        } catch (e) {
          console.error("[tgContent] 日榜发送失败(本日跳过)", e);
        }
      }
    }
  }

  // ② 每日战报
  if (d.senders.scorecard && hour >= postHour) {
    const dayStart = Math.floor(nowSec / 86_400) * 86_400 - 86_400;
    const rows = d.db
      .prepare(
        `SELECT a.payload, a.type, o.won
           FROM alerts a
           JOIN alert_outcomes o ON o.alert_id = a.id
          WHERE a.type IN ('smart','consensus')
            AND o.resolved = 1 AND o.won IS NOT NULL
            AND o.checked_at >= ? AND o.checked_at < ?
          ORDER BY o.checked_at ASC`,
      )
      .all(dayStart, dayStart + 86_400) as SettledAlertRow[];
    // 0 结算的日子静默(与 X 侧同一条):「0 settled」的成绩单比沉默更伤。
    if (rows.length > 0 && claimDay(d.db, "scorecard", today)) {
      const parsed: TgScorecardRow[] = [];
      for (const r of rows) {
        let p: Record<string, unknown>;
        try {
          p = JSON.parse(r.payload) as Record<string, unknown>;
        } catch {
          // 坏载荷只丢这一行的**展示**;它仍计入 settled/wins 统计,否则
          // 「12 条结算」会因为一条脏行悄悄变成 11(与 xScorecard 同一处理)。
          continue;
        }
        const title = typeof p.title === "string" ? p.title : null;
        if (!title) continue;
        const raw = r.type === "consensus" ? p.avgBuyPrice : p.price;
        parsed.push({
          title,
          won: r.won === 1,
          entryPrice:
            typeof raw === "number" && raw > 0 && raw < 1 ? raw : null,
        });
      }
      const html = composeScorecardMessage({
        day: utcDayStr(dayStart),
        settled: rows.length,
        wins: rows.filter((r) => r.won === 1).length,
        rows: pickTgScorecardRows(parsed),
      });
      try {
        await d.senders.scorecard(html);
        sent++;
      } catch (e) {
        console.error("[tgContent] 战报发送失败(本日跳过)", e);
      }
    }
  }

  // ③ 周报(周一)
  if (d.senders.weekly && now.getUTCDay() === 1 && hour >= weeklyHour) {
    const weekKey = String(utcWeekStart(nowSec));
    const report = buildWeeklyReport(d.db, nowSec);
    // 空周不发(与 xWeekly 同一条):「Settled 0」的成绩单比沉默更伤可信度。
    if (report.settled > 0 && report.rows.length > 0) {
      if (claimDay(d.db, "weekly", weekKey)) {
        const html = composeWeeklyMessage({
          weekLabel: report.weekLabel,
          settled: report.settled,
          wins: report.wins,
          losses: report.losses,
          winRatePct: report.winRatePct,
          pnlUsd: report.pnlUsd,
          rows: report.rows,
          publicUrl: d.publicUrl,
        });
        try {
          await d.senders.weekly(html);
          sent++;
        } catch (e) {
          console.error("[tgContent] 周报发送失败(本周跳过)", e);
        }
      }
    }
  }

  return sent;
}
