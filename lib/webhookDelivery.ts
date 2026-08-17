// Bare specifier(next.config.mjs 约定):webpack dev fallback 不解析 node: scheme。
import { createHmac } from "crypto";
import { z } from "zod";
import type { DB } from "./db";
import type { PushSignalRow } from "./signalPush";
import { SIGNAL_DISCLAIMER } from "./signalPush";
import type { SignalRecord } from "./signalRecord";
import { parseBusTypes } from "./apiKeys";

// 对外信号批次 3:webhook 通道(结构化 SignalEvent 直投订户后端)。
// 安全模型:
//   - 端点由运营者经 ADMIN_TOKEN 登记(不是订户自助),SSRF 面被信任边界收窄;
//   - 每次 POST 带 X-Signature: sha256=<hmac-sha256(secret, body)> —— 订户侧
//     复算即可验真,伪造投递不可能;
//   - 只对 tier=realtime 且未吊销的 api_key 挂端点投递(延迟分层不适用于
//     webhook:要延迟数据用拉取 API 即可,推送通道只服务实时档)。
// 失败模型:
//   - 4xx = permanent(端点拒收这个 payload,重发不会变):抛 permanent 标记
//     错误 → 投递循环保留 claim 标 failed_permanent,毒事件不卡队;
//   - 网络/超时/5xx = transient:普通抛错 → claim 回滚,30s 后的下一轮就是
//     重试节奏(不做环内退避 —— 串行循环里睡退避会拖住其它通道);
//   - 连续失败 WEBHOOK_DISABLE_AFTER 次自动 active=0(熔断),一次成功清零。
//     消费方必须按 (id, event) 幂等去重 —— at-least-once 语义与 TG 通道一致。

export const WEBHOOK_DISABLE_AFTER = 10;
const POST_TIMEOUT_MS = 5_000;

export const SignalEventV1Schema = z.object({
  v: z.literal(1),
  /** strategy_signals.id —— 消费方幂等去重键(配合 event)。 */
  id: z.number(),
  event: z.enum(["entry", "settle"]),
  emittedAt: z.number(),
  strategy: z.object({
    id: z.number(),
    name: z.string(),
    source: z.string(),
  }),
  market: z.object({
    conditionId: z.string(),
    title: z.string(),
    slug: z.string(),
    eventSlug: z.string(),
    category: z.string().nullable(),
    subcategory: z.string().nullable(),
    outcome: z.string(),
    outcomeIndex: z.number().nullable(),
    asset: z.string().nullable(),
  }),
  signal: z.object({
    formationTs: z.number(),
    referencePrice: z.number().nullable(),
    walletCount: z.number().nullable(),
    totalNetUsd: z.number().nullable(),
  }),
  paper: z.object({
    entryPrice: z.number().nullable(),
    sizeUsd: z.number().nullable(),
    /** entry − reference,单位 ¢(正 = 我们比聪明钱买贵)。 */
    chaseCents: z.number().nullable(),
    /** emittedAt − formationTs:检测 + 决策延迟。 */
    latencySec: z.number(),
  }),
  record: z
    .object({
      settled: z.number(),
      wins: z.number(),
      implied: z.number(),
      excess: z.number(),
      sd: z.number(),
    })
    .nullable(),
  settle: z
    .object({
      settledTs: z.number(),
      exitPrice: z.number().nullable(),
      won: z.boolean().nullable(),
      realizedPnl: z.number().nullable(),
    })
    .nullable(),
  notice: z.string(),
});
export type SignalEventV1 = z.infer<typeof SignalEventV1Schema>;

export function signPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export interface EventBuildCtx {
  strategyName: string;
  source: string;
  record: SignalRecord | null;
  category?: string | null;
  subcategory?: string | null;
}

export function buildSignalEvent(
  row: PushSignalRow,
  event: "entry" | "settle",
  ctx: EventBuildCtx,
): SignalEventV1 {
  const chaseCents =
    row.entry_price != null && row.reference_price != null
      ? (row.entry_price - row.reference_price) * 100
      : null;
  return {
    v: 1,
    id: row.id,
    event,
    emittedAt: row.emitted_at,
    strategy: {
      id: row.strategy_id,
      name: ctx.strategyName,
      source: ctx.source,
    },
    market: {
      conditionId: row.condition_id,
      title: row.title ?? "",
      slug: row.slug ?? "",
      eventSlug: row.event_slug ?? "",
      category: ctx.category ?? null,
      subcategory: ctx.subcategory ?? null,
      outcome: row.outcome,
      outcomeIndex: row.outcome_index,
      asset: row.asset,
    },
    signal: {
      formationTs: row.formation_ts,
      referencePrice: row.reference_price,
      walletCount: row.wallet_count,
      totalNetUsd: row.total_net_usd,
    },
    paper: {
      entryPrice: row.entry_price,
      sizeUsd: row.size_usd,
      chaseCents,
      latencySec: Math.max(0, row.emitted_at - row.formation_ts),
    },
    record: ctx.record,
    settle:
      event === "settle"
        ? {
            settledTs: row.settled_ts ?? 0,
            exitPrice: row.exit_price,
            won: row.won === 1 ? true : row.won === 0 ? false : null,
            realizedPnl: row.realized_pnl,
          }
        : null,
    notice: SIGNAL_DISCLAIMER,
  };
}

export interface WebhookEndpoint {
  id: number;
  apiKeyId: number;
  url: string;
  secret: string;
  active: number;
  consecutiveFailures: number;
  /** 该端点所属 key 的订阅范围;null = 不限。 */
  busTypes: string[] | null;
}

export function registerWebhook(
  db: DB,
  opts: { apiKeyId: number; url: string; secret: string },
  nowSec: number = Math.floor(Date.now() / 1000),
): number {
  const res = db
    .prepare(
      "INSERT INTO webhook_endpoints (api_key_id, url, secret, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(opts.apiKeyId, opts.url, opts.secret, nowSec);
  return Number(res.lastInsertRowid);
}

/** 可投递端点:active=1 ∧ api_key 未吊销 ∧ tier=realtime。 */
export function listActiveWebhooks(db: DB): WebhookEndpoint[] {
  return (
    db
      .prepare(
        `SELECT w.id, w.api_key_id, w.url, w.secret, w.active, w.consecutive_failures, k.bus_types
         FROM webhook_endpoints w
         JOIN api_keys k ON k.id = w.api_key_id
         WHERE w.active = 1 AND k.revoked_at IS NULL AND k.tier = 'realtime'
         ORDER BY w.id`,
      )
      .all() as {
      id: number;
      api_key_id: number;
      url: string;
      secret: string;
      active: number;
      consecutive_failures: number;
      bus_types: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    apiKeyId: r.api_key_id,
    url: r.url,
    secret: r.secret,
    active: r.active,
    consecutiveFailures: r.consecutive_failures,
    busTypes: parseBusTypes(r.bus_types),
  }));
}

export type PostResult = "ok" | "transient" | "permanent";

export async function postSignalEvent(
  endpoint: WebhookEndpoint,
  event: SignalEventV1,
  deps: { fetchFn?: typeof fetch } = {},
): Promise<PostResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const body = JSON.stringify(event);
  try {
    const res = await fetchFn(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature": `sha256=${signPayload(endpoint.secret, body)}`,
        "x-signal-id": String(event.id),
        "x-signal-event": event.event,
      },
      body,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (res.ok) return "ok";
    if (res.status >= 400 && res.status < 500) return "permanent";
    return "transient";
  } catch {
    // 网络错/超时:transient(下一轮投递循环即重试)。
    return "transient";
  }
}

/** 成功清零计数;失败 +1,达阈值熔断 active=0(返回 disabled 供调用方通报)。 */
export function recordWebhookResult(
  db: DB,
  endpointId: number,
  ok: boolean,
  opts: { error?: string } = {},
): { disabled: boolean } {
  if (ok) {
    db.prepare(
      "UPDATE webhook_endpoints SET consecutive_failures = 0, last_error = NULL WHERE id = ?",
    ).run(endpointId);
    return { disabled: false };
  }
  db.prepare(
    "UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1, last_error = ? WHERE id = ?",
  ).run(opts.error ?? null, endpointId);
  const row = db
    .prepare("SELECT consecutive_failures FROM webhook_endpoints WHERE id = ?")
    .get(endpointId) as { consecutive_failures: number } | undefined;
  if ((row?.consecutive_failures ?? 0) >= WEBHOOK_DISABLE_AFTER) {
    db.prepare("UPDATE webhook_endpoints SET active = 0 WHERE id = ?").run(
      endpointId,
    );
    return { disabled: true };
  }
  return { disabled: false };
}

/** 投递循环的 EventCtx(函数式取值,通道不持有全量 Map)。 */
export interface WebhookEventCtx {
  strategyName: (strategyId: number) => string;
  source: (strategyId: number) => string;
  record: (strategyId: number) => SignalRecord | null;
  category: (eventSlug: string | null) => {
    category: string | null;
    subcategory: string | null;
  };
}

class WebhookPermanentError extends Error {
  readonly permanent = true;
}

/**
 * 把一个端点适配成投递通道:每行一个 SignalEvent(机器消费要归因粒度,不做
 * 多档合并)。组内任一 transient → 抛普通错(整组 claim 回滚重试,消费方按
 * id 去重);permanent → 记失败后抛 permanent 标记错误(循环保留 claim)。
 */
export function makeWebhookChannel(
  db: DB,
  endpoint: WebhookEndpoint,
  deps: {
    fetchFn?: typeof fetch;
    onDisabled?: (endpoint: WebhookEndpoint, error: string) => void;
  } = {},
): {
  key: string;
  minEmitAgeSec: number;
  sendEvent: (
    rows: PushSignalRow[],
    event: "entry" | "settle",
    ctx: WebhookEventCtx,
  ) => Promise<void>;
} {
  return {
    key: `webhook:${endpoint.id}`,
    minEmitAgeSec: 0,
    sendEvent: async (rows, event, ctx) => {
      for (const r of rows) {
        const cat = ctx.category(r.event_slug);
        const ev = buildSignalEvent(r, event, {
          strategyName: ctx.strategyName(r.strategy_id),
          source: ctx.source(r.strategy_id),
          record: ctx.record(r.strategy_id),
          category: cat.category,
          subcategory: cat.subcategory,
        });
        const result = await postSignalEvent(endpoint, ev, {
          fetchFn: deps.fetchFn,
        });
        if (result === "ok") {
          recordWebhookResult(db, endpoint.id, true);
          continue;
        }
        const label = result === "permanent" ? "4xx" : "transient";
        const { disabled } = recordWebhookResult(db, endpoint.id, false, {
          error: label,
        });
        if (disabled) {
          console.error(
            `[webhook] endpoint #${endpoint.id} 连续失败 ${WEBHOOK_DISABLE_AFTER} 次,已熔断停用`,
          );
          deps.onDisabled?.(endpoint, label);
        }
        if (result === "permanent") {
          throw new WebhookPermanentError(`webhook #${endpoint.id} 拒收(4xx)`);
        }
        throw new Error(`webhook #${endpoint.id} 瞬态失败(${label})`);
      }
    },
  };
}
