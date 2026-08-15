import type { DB } from "./db";
import {
  formatStrategyEntryTg,
  formatStrategySettleTg,
  type PushSignalRow,
} from "./signalPush";
import type { SignalRecord } from "./signalRecord";
import { sourceOf } from "./strategyFeed";
import { strategyRecord30d } from "./strategySignals";
import { isPermanentSendError } from "./telegram";

// 对外信号批次 1:投递总线(第七个 worker 循环的循环体)。
// 消费 strategy_signals 台账、按通道扇出,信号侧(detector/开仓)对通道零感知。
//
// 幂等骨架照抄 alerts 表的 claim-then-send:
//   - signal_deliveries 主键 (signal_id, event, channel) 即跨进程抢占锁;
//   - claim(INSERT OR IGNORE, status='sent')→ 发送 → transient 失败 DELETE
//     回滚(下轮至少一次重发)、permanent 失败保留 claim 标 failed_permanent
//     (毒消息不卡队头,与 alertEngine 同语义);
//   - crash-between-claim-and-send 的窗口与 alertEngine 一致地接受(丢一条,
//     绝不重复)。
//
// 三道产品闸门:
//   - 延迟闸门:通道的 minEmitAgeSec(公开频道晚 N 分钟)—— 免费/付费分层的
//     唯一杠杆;未到点的行不写任何记录,下轮再看。
//   - 新鲜度:到点后仍超过 ENTRY_MAX_AGE_SEC 未投出的(长停机/后开推送开关)
//     落 skipped_stale —— 旧 entry 推出去是误导,不是迟到的服务。
//   - 健康冻结:引擎有循环停跳时本轮零动作 —— docs/signals-api.md「安静和
//     死了不长得一样」铁律在推送侧的对应物。

/** entry 到点后仍未投出的最大补发窗口;更旧 = skipped_stale。 */
export const ENTRY_MAX_AGE_SEC = 6 * 3600;
/** settle(认账)的最大补发窗口 —— 认账晚点无妨,7 天后的旧账是噪音。 */
export const SETTLE_MAX_AGE_SEC = 7 * 86_400;
/** 组间发送最小间隔,与 alertEngine 的 SEND_MIN_GAP_MS 同量级(TG ~20条/分)。 */
const SEND_GAP_MS = 3200;
/** 每通道每轮消息上限;超额顺延下轮(30s 后),不折叠不丢失。 */
const DEFAULT_MAX_SENDS_PER_CYCLE = 6;

export interface DeliveryChannel {
  /** 'tg_paid' | 'tg_public' | 'webhook:<id>'。 */
  key: string;
  /** entry 必须至少这么旧才可从本通道发出(延迟分层)。 */
  minEmitAgeSec: number;
  /** 文本通道(TG):收合并后的 HTML 消息。 */
  send?: (html: string) => Promise<void>;
  /**
   * 结构化通道(webhook):直接收整组行,自行编码/逐行投递。与 send 二选一,
   * 都缺 = 配置错误,该通道被跳过并告警。失败语义同 send:permanent 标记
   * 错误(isPermanentSendError)= 保留 claim,其余 = 回滚重试。
   */
  sendEvent?: (
    rows: PushSignalRow[],
    event: "entry" | "settle",
    ctx: DeliveryEventCtx,
  ) => Promise<void>;
}

/** 结构化通道的取值上下文(函数式,按需取,不复制全量 Map)。 */
export interface DeliveryEventCtx {
  strategyName: (strategyId: number) => string;
  source: (strategyId: number) => string;
  record: (strategyId: number) => SignalRecord | null;
  category: (eventSlug: string | null) => {
    category: string | null;
    subcategory: string | null;
  };
}

export interface DeliveryCycleDeps {
  db: DB;
  channels: DeliveryChannel[];
  nowSec?: number;
  /** 引擎健康探针;返回 !ok 时本轮冻结。缺省 = 不冻结(测试/嵌入方自决)。 */
  checkHealth?: () => { ok: boolean };
  publicUrl?: string;
  maxSendsPerCycle?: number;
  /** 注入以便测试消除真实延时。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface DeliveryCycleResult {
  /** 实际发出的消息数(合并后按组计)。 */
  sent: number;
  skippedStale: number;
  failedPermanent: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/** 同市场同方向的多档触发合并为一组 —— 一条消息说清楚,不刷屏。 */
const groupKey = (r: PushSignalRow): string => `${r.condition_id}|${r.outcome}`;

function groupRows(rows: PushSignalRow[]): PushSignalRow[][] {
  const byKey = new Map<string, PushSignalRow[]>();
  for (const r of rows) {
    const k = groupKey(r);
    const list = byKey.get(k) ?? [];
    list.push(r);
    byKey.set(k, list);
  }
  return [...byKey.values()];
}

export async function runDeliveryCycle(
  deps: DeliveryCycleDeps,
): Promise<DeliveryCycleResult> {
  const {
    db,
    channels,
    checkHealth,
    publicUrl,
    maxSendsPerCycle = DEFAULT_MAX_SENDS_PER_CYCLE,
  } = deps;
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000);
  const sleep = deps.sleep ?? defaultSleep;
  const result: DeliveryCycleResult = {
    sent: 0,
    skippedStale: 0,
    failedPermanent: 0,
  };
  if (channels.length === 0) return result;
  if (checkHealth && !checkHealth().ok) {
    console.warn("[delivery] 引擎有循环停跳 — 本轮冻结投递(宁静默不误导)");
    return result;
  }

  const strategyRows = db
    .prepare("SELECT id, name, params_json FROM follow_strategies")
    .all() as { id: number; name: string; params_json: string | null }[];
  const strategyNames = new Map<number, string>(
    strategyRows.map((r) => [r.id, r.name]),
  );
  const strategySources = new Map<number, string>(
    strategyRows.map((r) => [r.id, sourceOf(r.params_json)]),
  );
  // 30d 战绩按档缓存一轮 —— 同一档多组命中时不重复算。
  const recordCache = new Map<number, SignalRecord>();
  const recordOf = (strategyId: number): SignalRecord => {
    let r = recordCache.get(strategyId);
    if (!r) {
      r = strategyRecord30d(db, strategyId, nowSec);
      recordCache.set(strategyId, r);
    }
    return r;
  };
  const categoryOf = (
    eventSlug: string | null,
  ): { category: string | null; subcategory: string | null } => {
    if (!eventSlug) return { category: null, subcategory: null };
    const row = db
      .prepare(
        "SELECT category, subcategory FROM event_category WHERE event_slug = ?",
      )
      .get(eventSlug) as
      { category: string | null; subcategory: string | null } | undefined;
    return {
      category: row?.category || null,
      subcategory: row?.subcategory || null,
    };
  };

  const eventCtx: DeliveryEventCtx = {
    strategyName: (id) => strategyNames.get(id) ?? `#${id}`,
    source: (id) => strategySources.get(id) ?? "consensus",
    record: (id) => recordOf(id),
    category: (eventSlug) => categoryOf(eventSlug),
  };
  // 通道分派:结构化通道优先 sendEvent,文本通道用 send(html)。两个都缺是
  // 配置错误 —— 跳过该通道并告警,绝不静默吞投递。
  const dispatch = async (
    ch: DeliveryChannel,
    rows: PushSignalRow[],
    event: "entry" | "settle",
    buildHtml: () => string,
  ): Promise<void> => {
    if (ch.sendEvent) return ch.sendEvent(rows, event, eventCtx);
    if (ch.send) return ch.send(buildHtml());
    throw new Error(`channel ${ch.key} 缺 send/sendEvent 实现(配置错误)`);
  };

  const claim = db.prepare(
    "INSERT OR IGNORE INTO signal_deliveries (signal_id, event, channel, delivered_at, status) VALUES (?, ?, ?, ?, 'sent')",
  );
  const unclaim = db.prepare(
    "DELETE FROM signal_deliveries WHERE signal_id = ? AND event = ? AND channel = ?",
  );
  const markPermanent = db.prepare(
    "UPDATE signal_deliveries SET status = 'failed_permanent' WHERE signal_id = ? AND event = ? AND channel = ?",
  );
  const markStale = db.prepare(
    "INSERT OR IGNORE INTO signal_deliveries (signal_id, event, channel, delivered_at, status) VALUES (?, ?, ?, NULL, 'skipped_stale')",
  );

  for (const ch of channels) {
    let budget = maxSendsPerCycle;

    // ---- entry ---------------------------------------------------------
    const entryRows = db
      .prepare(
        `SELECT s.* FROM strategy_signals s
         JOIN follow_strategies st ON st.id = s.strategy_id
         WHERE st.push_enabled = 1
           AND NOT EXISTS (SELECT 1 FROM signal_deliveries d
                           WHERE d.signal_id = s.id AND d.event = 'entry' AND d.channel = ?)
         ORDER BY s.emitted_at ASC`,
      )
      .all(ch.key) as PushSignalRow[];
    const dueBefore = nowSec - ch.minEmitAgeSec;
    const staleBefore = dueBefore - ENTRY_MAX_AGE_SEC;
    const due: PushSignalRow[] = [];
    for (const r of entryRows) {
      if (r.emitted_at > dueBefore) continue; // 未到点:不写记录,下轮再看
      if (r.emitted_at <= staleBefore) {
        if (markStale.run(r.id, "entry", ch.key).changes === 1) {
          result.skippedStale++;
        }
        continue;
      }
      due.push(r);
    }

    let channelAborted = false;
    for (const group of groupRows(due)) {
      if (budget <= 0) break;
      const claimed = group.filter(
        (r) => claim.run(r.id, "entry", ch.key, nowSec).changes === 1,
      );
      if (claimed.length === 0) continue; // 全组被并行引擎抢走
      try {
        await dispatch(ch, claimed, "entry", () => {
          const lead = [...claimed].sort(
            (a, b) => a.emitted_at - b.emitted_at,
          )[0];
          const cat = categoryOf(lead.event_slug);
          const recs = new Map<number, SignalRecord>();
          for (const r of claimed) {
            recs.set(r.strategy_id, recordOf(r.strategy_id));
          }
          return formatStrategyEntryTg(claimed, {
            strategyNames,
            recordByStrategy: recs,
            category: cat.category,
            subcategory: cat.subcategory,
            publicUrl,
            nowSec,
          });
        });
        result.sent++;
        budget--;
      } catch (e) {
        if (isPermanentSendError(e)) {
          for (const r of claimed) markPermanent.run(r.id, "entry", ch.key);
          result.failedPermanent += claimed.length;
          console.error(
            `[delivery] ${ch.key} entry 永久失败(保留 claim,不再重试):`,
            e,
          );
          budget--;
          continue;
        }
        // transient:回滚本组 claim,并放弃本通道剩余组(多半是网络/限流,
        // 继续硬发只会连环失败);别的通道照常。
        for (const r of claimed) unclaim.run(r.id, "entry", ch.key);
        console.warn(
          `[delivery] ${ch.key} entry 瞬态失败(claim 已回滚,下轮重发):`,
          e,
        );
        channelAborted = true;
        break;
      }
      if (budget > 0) await sleep(SEND_GAP_MS);
    }
    if (channelAborted) continue;

    // ---- settle(认账)------------------------------------------------
    // 只对「本通道发布过 entry」的信号认账 —— 没发布过开仓就没有认账义务,
    // skipped_stale/未到点的信号都不会产生孤儿结算消息。
    const settleRows = db
      .prepare(
        `SELECT s.* FROM strategy_signals s
         JOIN follow_strategies st ON st.id = s.strategy_id
         JOIN signal_deliveries de ON de.signal_id = s.id
              AND de.event = 'entry' AND de.channel = ? AND de.status = 'sent'
         WHERE st.push_enabled = 1 AND s.settled = 1
           AND NOT EXISTS (SELECT 1 FROM signal_deliveries d
                           WHERE d.signal_id = s.id AND d.event = 'settle' AND d.channel = ?)
         ORDER BY s.settled_ts ASC`,
      )
      .all(ch.key, ch.key) as PushSignalRow[];
    const settleDue: PushSignalRow[] = [];
    for (const r of settleRows) {
      if ((r.settled_ts ?? 0) <= nowSec - SETTLE_MAX_AGE_SEC) {
        if (markStale.run(r.id, "settle", ch.key).changes === 1) {
          result.skippedStale++;
        }
        continue;
      }
      settleDue.push(r);
    }
    for (const group of groupRows(settleDue)) {
      if (budget <= 0) break;
      const claimed = group.filter(
        (r) => claim.run(r.id, "settle", ch.key, nowSec).changes === 1,
      );
      if (claimed.length === 0) continue;
      try {
        await dispatch(ch, claimed, "settle", () =>
          formatStrategySettleTg(claimed, {
            strategyNames,
            publicUrl,
            nowSec,
          }),
        );
        result.sent++;
        budget--;
      } catch (e) {
        if (isPermanentSendError(e)) {
          for (const r of claimed) markPermanent.run(r.id, "settle", ch.key);
          result.failedPermanent += claimed.length;
          console.error(`[delivery] ${ch.key} settle 永久失败(保留 claim):`, e);
          budget--;
          continue;
        }
        for (const r of claimed) unclaim.run(r.id, "settle", ch.key);
        console.warn(
          `[delivery] ${ch.key} settle 瞬态失败(claim 已回滚,下轮重发):`,
          e,
        );
        break;
      }
      if (budget > 0) await sleep(SEND_GAP_MS);
    }
  }

  return result;
}
