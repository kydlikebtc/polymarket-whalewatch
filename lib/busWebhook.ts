import { z } from "zod";
import type { DB } from "./db";
import {
  BusSignalSchema,
  getBusSignals,
  type BusSignalRow,
} from "./signalBus";
import { SIGNAL_DISCLAIMER } from "./signalPush";
import { listBusDefs, matchedDefs } from "./busDefs";
import {
  postWebhookBody,
  recordWebhookResult,
  listActiveWebhooks,
  webhookWantsBusRow,
  webhookWantsType,
  type WebhookEndpoint,
} from "./webhookDelivery";

// bus 类型的 webhook 分流(2026-08-19)—— embeddedEngine 那句「后续批次」的
// 兑现。策略信号走 signal_deliveries 台账,bus 事件在此之前没有对应物,这
// 也是它只进拉取 API 的全部原因;本文件补上那本账(bus_deliveries),投递
// 纪律照抄 lib/signalDelivery.ts 的 claim-then-send:
//   - (bus_signal_id, channel) 主键即跨进程抢占锁;
//   - claim(INSERT OR IGNORE)→ 发送 → transient 失败 DELETE 回滚(下轮
//     至少一次重发)、permanent 保留 claim 标 failed_permanent(毒事件不卡队);
//   - 熔断计数与策略投递共用同一个 consecutive_failures —— 它量的是端点
//     健康,不是某类事件的健康。
//
// 与策略投递的三处刻意不同:
//   - **不回灌**:只投端点登记之后产生的事件。新登记的端点没有任何 claim,
//     不加这条会把整个窗口的存量事件一次性冲过去;
//   - **transient 即中断本端点本轮**:端点连不上时每行都要吃满 5s 超时,
//     串行循环里 10 行就是 50s —— 第一条瞬态失败后直接等下轮(30s);
//   - **每端点每轮上限**:总线可以比策略信号密得多,上限外的顺延下轮,
//     不折叠不丢失。

/** 事件新鲜窗,与总线投影窗(signalBus.PROJECT_WINDOW_SEC)对齐。 */
export const BUS_WEBHOOK_MAX_AGE_SEC = 3600;
/** 每端点每轮投递上限;超出顺延下轮(30s)。 */
export const BUS_MAX_SENDS_PER_CYCLE = 10;

/** 端点可勾选的 bus 类型(strategy 走既有策略投递,不在此列)。 */
export const BUS_WEBHOOK_TYPES = ["large", "consensus", "discovery"] as const;

export const BusEventV1Schema = z.object({
  v: z.literal(1),
  event: z.literal("bus"),
  /** bus_signals.id —— 与 event 组成消费方幂等去重键。 */
  id: z.number(),
  /**
   * 与拉取 API `bus[]` 单条完全同形 —— 推与拉是同一份事实的两条到达路径。
   * 直接嵌 signalBus 的 BusSignalSchema,不再手抄一份字段表:抄的那份漏一个
   * 字段就是静默分叉,而两条路径的差异恰恰是消费方最难自查的一类问题。
   */
  bus: BusSignalSchema,
  notice: z.string(),
});
export type BusEventV1 = z.infer<typeof BusEventV1Schema>;

export function buildBusEvent(row: BusSignalRow): BusEventV1 {
  return {
    v: 1,
    event: "bus",
    id: row.id,
    // 整条透传:逐字段列举等于第三份字段表,加字段时又是一处要记得改。
    bus: row,
    notice: SIGNAL_DISCLAIMER,
  };
}

export interface BusWebhookCycleResult {
  sent: number;
  failed: number;
  /** true = 引擎不健康,本轮零动作(与策略投递同一条冻结纪律)。 */
  frozen: boolean;
}

export interface BusWebhookCycleDeps {
  nowSec?: number;
  fetchFn?: typeof fetch;
  /** 引擎健康探针;不给 = 不冻结(测试用)。 */
  checkHealth?: () => { ok: boolean };
  onDisabled?: (endpoint: WebhookEndpoint, error: string) => void;
}

/**
 * bus 事件 → 已勾选类型的 webhook 端点。每 30s 由投递循环调用一次。
 * 永不抛错:所有失败路径都落在返回值与端点连败计数里。
 */
export async function runBusWebhookCycle(
  db: DB,
  deps: BusWebhookCycleDeps = {},
): Promise<BusWebhookCycleResult> {
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000);
  if (deps.checkHealth && !deps.checkHealth().ok) {
    return { sent: 0, failed: 0, frozen: true };
  }
  // 可能收 bus 事件的端点:订了任一类型,或订了任一 def:<id>(定义级)。
  const endpoints = listActiveWebhooks(db).filter(
    (ep) =>
      BUS_WEBHOOK_TYPES.some((t) => webhookWantsType(ep, t)) ||
      (ep.selectedTypes?.some((x) => x.startsWith("def:")) ?? false),
  );
  if (endpoints.length === 0) return { sent: 0, failed: 0, frozen: false };
  const defs = listBusDefs(db);

  // getBusSignals 是新在前;投递按时间正序 —— 消费方先收到先发生的。
  const rows = getBusSignals(db, {
    nowSec,
    windowSec: BUS_WEBHOOK_MAX_AGE_SEC,
  }).reverse();
  if (rows.length === 0) return { sent: 0, failed: 0, frozen: false };

  const claim = db.prepare(
    "INSERT OR IGNORE INTO bus_deliveries (bus_signal_id, channel, status, created_at) VALUES (?, ?, 'sent', ?)",
  );
  const markPermanent = db.prepare(
    "UPDATE bus_deliveries SET status = 'failed_permanent' WHERE bus_signal_id = ? AND channel = ?",
  );
  const rollback = db.prepare(
    "DELETE FROM bus_deliveries WHERE bus_signal_id = ? AND channel = ?",
  );

  let sent = 0;
  let failed = 0;
  for (const ep of endpoints) {
    const channel = `webhook:${ep.id}`;
    let n = 0;
    for (const row of rows) {
      if (n >= BUS_MAX_SENDS_PER_CYCLE) break;
      const defIds = matchedDefs(defs, row.sourceType, row.payload).map(
        (d) => d.id,
      );
      if (!webhookWantsBusRow(ep, row, defIds)) continue;
      if (row.emittedAt < ep.createdAt) continue; // 不回灌
      if (claim.run(row.id, channel, nowSec).changes !== 1) continue;

      const ev = buildBusEvent(row);
      const result = await postWebhookBody(
        ep,
        JSON.stringify(ev),
        { signalId: ev.id, event: "bus" },
        { fetchFn: deps.fetchFn },
      );
      if (result === "ok") {
        recordWebhookResult(db, ep.id, true);
        sent++;
        n++;
        continue;
      }
      failed++;
      const label = result === "permanent" ? "4xx" : "transient";
      const { disabled } = recordWebhookResult(db, ep.id, false, {
        error: label,
      });
      if (result === "permanent") {
        markPermanent.run(row.id, channel); // 毒事件不卡队,继续下一行
      } else {
        rollback.run(row.id, channel); // 下轮重试
      }
      if (disabled) {
        console.error(
          `[busWebhook] endpoint #${ep.id} 连续失败已熔断停用(${label})`,
        );
        deps.onDisabled?.(ep, label);
        break;
      }
      if (result === "transient") break; // 端点多半整个不可达,别逐行吃超时
    }
  }
  return { sent, failed, frozen: false };
}
