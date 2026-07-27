import type { DB } from "./db";
import { cents, esc, usd, urlSeg } from "./tgFormat";
import type { MarketCard } from "./marketCard";
import type { ResolveResult } from "./marketCard";

// Telegram bot 🎯 market-card queries: DM the bot a Polymarket link / market
// slug / conditionId and get the signal card back as a message. The card
// composition is lib/marketCard (shared with /api/market — the two surfaces
// cannot drift); this module owns update polling, command classification and
// the compact TG rendering.
//
// Single-poller constraint: Telegram allows ONE getUpdates consumer per bot
// token — a second engine polling the same token gets 409s. Same caveat as
// the documented dual-engine deployment: run the bot loop in one process.

export interface BotUpdate {
  update_id: number;
  message?: {
    chat?: { id: number; type?: string };
    text?: string;
  };
}

export const BOT_HELP_HTML =
  "🎯 <b>市场信号卡</b>\n" +
  "发送任意一种即可查询：\n" +
  "· Polymarket 市场链接（https://polymarket.com/event/…）\n" +
  "· market slug（如 fed-september-2026）\n" +
  "· conditionId（0x…64 位）\n" +
  "返回该市场的共识/分歧状态、聪明钱留存敞口、拆单累计、新钱包异常流与本工具告警战绩。";

// The 🎯 menu command's reply: a prompt, not a state machine — ANY next text
// message is already treated as a query, so the prompt is the whole flow.
export const BOT_CARD_PROMPT_HTML =
  "🎯 把 Polymarket <b>市场链接</b> / <b>market slug</b> / <b>conditionId</b> 发给我，立刻返回该市场的信号卡。";

// ---------------------------------------------------------------------------
// Sectioned TG rendering of a MarketCard. Layout principles (born from a live
// readability complaint — everything used to pile into one undifferentiated
// stack of lines):
//  1. BLANK LINES between sections — Telegram's only real grouping primitive.
//  2. Bold section headers (聪明钱动向 / 本工具战绩) so the eye can jump.
//  3. Prices/amounts in bold as scan anchors; names stay plain.
//  4. One fact per line — no more gluing amount+count+price into one string.
//  5. Honest degradation: an empty section disappears whole (no orphan
//     headers), missing data says so — never invented numbers.
// ---------------------------------------------------------------------------

export function formatMarketCardTg(
  card: MarketCard,
  opts: { publicUrl?: string } = {},
): string {
  const blocks: string[] = [];

  // -- Header: title / bold prices / volume ------------------------------
  const head: string[] = [
    `🎯 <b>${esc(card.identity?.title ?? card.conditionId)}</b>`,
  ];
  if (card.meta && card.meta.outcomes.length > 0) {
    const prices = card.meta.outcomes
      .slice(0, 4)
      .map((o, i) => {
        const p = card.meta?.outcomePrices[i];
        return p != null ? `${esc(o)} <b>${cents(p)}</b>` : null;
      })
      .filter(Boolean)
      .join(" · ");
    head.push(`${prices}${card.meta.closed ? " · 已结算" : ""}`);
    if (card.meta.volume24hr != null) {
      head.push(`24h 量 ${usd(card.meta.volume24hr)}`);
    }
  }
  blocks.push(head.join("\n"));

  // -- Signal state -------------------------------------------------------
  const cls = card.brief.classification;
  if (cls.kind === "consensus") {
    blocks.push(
      `🔥 <b>共识</b> · ${cls.group.walletCount} 钱包买入 <b>${esc(cls.group.outcome)}</b>\n` +
        `净买 ${usd(cls.group.totalNetUsd)} @${cents(cls.group.avgBuyPrice)}`,
    );
  } else if (cls.kind === "disagreement") {
    const sides = cls.market.sides
      .map((s) => `${esc(s.outcome)} ${s.walletCount} 钱包 ${usd(s.netUsd)}`)
      .join(" vs ");
    blocks.push(`⚖️ <b>分歧</b>\n${sides}`);
  } else {
    blocks.push(`⚪️ 近 ${card.window.hours}h 无共识/分歧`);
  }

  // -- Smart-money activity (one fact per line; whole block omitted when
  //    the window carried nothing) ---------------------------------------
  const activity: string[] = [];
  for (const f of card.brief.smartFlow.slice(0, 2)) {
    // Outcome-level entry price = exposure-weighted mean of wallet averages.
    const totalExposure = f.wallets.reduce((s, w) => s + w.exposureUsd, 0);
    const wavg =
      totalExposure > 0
        ? f.wallets.reduce((s, w) => s + w.avgBuyPrice * w.exposureUsd, 0) /
          totalExposure
        : 0;
    activity.push(
      `🏆 ${esc(f.outcome)} 留仓 <b>${usd(f.totalExposureUsd)}</b>（${f.wallets.length} 钱包 · 均价 ${cents(wavg)}）`,
    );
  }
  if (card.brief.accum.length > 0) {
    const top = card.brief.accum[0];
    activity.push(
      `🧩 拆单 ${card.brief.accum.length} 人 · 最大 ${usd(top.exposureUsd)} @${cents(top.avgBuyPrice)}`,
    );
  }
  if (card.freshFlow.length > 0) {
    const top = card.freshFlow[0];
    const age =
      top.ageDays < 1
        ? `${Math.round(top.ageDays * 24)}小时`
        : `${Math.round(top.ageDays)}天`;
    activity.push(
      `🆕 新钱包 ${card.freshFlow.length} 笔 · 最大 ${usd(top.usd)} @${cents(top.price)}（账龄 ${age}）`,
    );
  }
  if (activity.length > 0) {
    blocks.push(`<b>聪明钱动向</b>\n${activity.join("\n")}`);
  }

  // -- The tool's own record ---------------------------------------------
  let record: string;
  if (card.history.length === 0) {
    record = "📐 90d 暂无告警";
  } else {
    const judged = card.history.filter((h) => h.won != null);
    const wins = judged.filter((h) => h.won === 1).length;
    record =
      `📐 90d ${card.history.length} 条告警` +
      (judged.length > 0
        ? ` · 已判定 ${wins}/${judged.length} 中`
        : " · 尚未判定");
  }
  blocks.push(`<b>本工具战绩</b>\n${record}`);

  // -- Links + honesty footer --------------------------------------------
  const links: string[] = [];
  if (opts.publicUrl) {
    links.push(
      `<a href="${opts.publicUrl}/market/${urlSeg(card.conditionId)}">完整信号卡</a>`,
    );
  }
  if (card.identity) {
    links.push(
      `<a href="https://polymarket.com/event/${urlSeg(card.identity.eventSlug)}">Polymarket</a>`,
    );
  }
  const tail: string[] = [];
  if (links.length > 0) tail.push(`🔗 ${links.join(" · ")}`);
  if (card.window.truncated) tail.push("⚠️ 窗口触顶截断,以上指标为下界");
  if (tail.length > 0) blocks.push(tail.join("\n"));

  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// One poll-and-reply cycle. Injected deps everywhere (poller / sender / card
// builder / resolver) — the engine wires the real ones.
// ---------------------------------------------------------------------------

const OFFSET_KEY = "bot_updates_offset";
const DEFAULT_MAX_CARDS = 3;

export interface BotCycleDeps {
  getUpdatesFn: (offset: number) => Promise<BotUpdate[]>;
  send: (chatId: number, html: string) => Promise<void>;
  buildCard: (conditionId: string) => Promise<MarketCard>;
  resolve: (input: string) => Promise<ResolveResult>;
  // Per-cycle ceiling on card builds (each costs a market-window fetch).
  // Excess queries are NOT dropped: the offset stops before them, so the next
  // cycle picks them up.
  maxCards?: number;
  // Deployed dashboard base URL → the reply's 完整信号卡 deep link.
  publicUrl?: string;
}

export async function runBotCycle(
  db: DB,
  deps: BotCycleDeps,
): Promise<{ processed: number; cards: number }> {
  const { getUpdatesFn, send, buildCard, resolve } = deps;
  const maxCards = deps.maxCards ?? DEFAULT_MAX_CARDS;
  const stored = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(OFFSET_KEY) as { value: string | null } | undefined;
  const offset = stored?.value ? Number(stored.value) : 0;
  const updates = await getUpdatesFn(offset);
  if (updates.length === 0) return { processed: 0, cards: 0 };

  let nextOffset: number | null = null;
  let processed = 0;
  let cards = 0;
  for (const u of updates) {
    const text = u.message?.text?.trim();
    const chatId = u.message?.chat?.id;
    // Non-message updates (channel posts, membership changes) and empty
    // texts are consumed silently — the offset must advance past them or the
    // loop replays them forever.
    if (!text || typeof chatId !== "number") {
      nextOffset = u.update_id + 1;
      processed++;
      continue;
    }
    const isCommand = /^\/(start|help|card)\b/.test(text);
    if (!isCommand && cards >= maxCards) {
      // Budget spent: leave THIS update (and everything after) for the next
      // cycle by pointing the offset at it.
      nextOffset = u.update_id;
      break;
    }
    // Replies are best-effort (unlike alert pushes there is no claim to roll
    // back): a send failure logs, the offset still advances — the user can
    // simply re-ask.
    try {
      if (isCommand) {
        await send(
          chatId,
          /^\/card\b/.test(text) ? BOT_CARD_PROMPT_HTML : BOT_HELP_HTML,
        );
      } else {
        const r = await resolve(text);
        if (r.kind === "cid") {
          cards++;
          await send(
            chatId,
            formatMarketCardTg(await buildCard(r.conditionId), {
              publicUrl: deps.publicUrl,
            }),
          );
        } else if (r.kind === "candidates") {
          const list = r.candidates
            .slice(0, 10)
            .map(
              (c) =>
                `· ${esc(c.question)}\n  <code>${esc(c.conditionId)}</code>`,
            )
            .join("\n");
          await send(
            chatId,
            `该事件包含 ${r.candidates.length} 个市场,点按复制 conditionId 后发我:\n${list}`,
          );
        } else {
          await send(chatId, `❓ ${esc(r.message)}\n\n${BOT_HELP_HTML}`);
        }
      }
    } catch (e) {
      console.error("[bot] reply failed:", e);
    }
    nextOffset = u.update_id + 1;
    processed++;
  }
  if (nextOffset != null) {
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
      OFFSET_KEY,
      String(nextOffset),
    );
  }
  return { processed, cards };
}
