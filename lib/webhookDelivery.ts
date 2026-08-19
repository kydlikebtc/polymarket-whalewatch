// Bare specifier(next.config.mjs 约定):webpack dev fallback 不解析 node: scheme。
import { createHmac } from "crypto";
import { z } from "zod";
import type { DB } from "./db";
import type { PushSignalRow } from "./signalPush";
import { SIGNAL_DISCLAIMER } from "./signalPush";
import type { SignalRecord } from "./signalRecord";
import { busTypeAllowed, parseBusTypes } from "./apiKeys";

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

/**
 * 投递请求头。真实投递与「连通性测试」共用这一份 —— 分成两套组头逻辑的话,
 * 测试通过却与真信号走不同的路,那种测试比没有更糟。
 */
export function buildDeliveryHeaders(
  secret: string,
  body: string,
  // event 放宽为 string:bus 分流(lib/busWebhook.ts)复用同一份组头逻辑,
  // 事件名是 "bus" —— 头的组装纪律必须唯一,见上方注释。
  opts: { signalId: number; event: string; test?: boolean },
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-signature": `sha256=${signPayload(secret, body)}`,
    "x-signal-id": String(opts.signalId),
    "x-signal-event": opts.event,
    // 只在测试事件上出现:订户可据此丢弃,不必污染自己的信号台账。
    ...(opts.test ? { "x-signal-test": "1" } : {}),
  };
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

/**
 * 连通性测试事件。形状是真的 SignalEventV1(订户按真信号 schema 解析不会 4xx
 * 误报),内容是空的:
 *   - id = 0 作哨兵 —— 真信号 id 来自 AUTOINCREMENT,从 1 起,不可能撞上;
 *   - 价格/金额/钱包数全为 null —— 订户即使漏看 X-Signal-Test 头与 id,
 *     这条也没有任何可执行内容,跟不了单;
 *   - notice 覆盖掉免责尾行:那句话是给「模拟信号」用的,这条压根不是信号。
 */
export function buildTestEvent(
  nowSec: number = Math.floor(Date.now() / 1000),
): SignalEventV1 {
  const ev = buildSignalEvent(
    {
      id: 0,
      strategy_id: 0,
      condition_id: `0x${"0".repeat(64)}`,
      outcome: "Yes",
      outcome_index: null,
      asset: null,
      title: "WhaleWatch webhook 连通性测试",
      slug: "whalewatch-webhook-test",
      event_slug: "whalewatch-webhook-test",
      formation_ts: nowSec,
      reference_price: null,
      wallet_count: null,
      total_net_usd: null,
      entry_price: null,
      size_usd: null,
      emitted_at: nowSec,
      settled: 0,
      settled_ts: null,
      exit_price: null,
      won: null,
      realized_pnl: null,
    },
    "entry",
    { strategyName: "连通性测试", source: "test", record: null },
  );
  return {
    ...ev,
    notice:
      "这是 WhaleWatch 的 webhook 连通性测试事件(id=0),由运营者在后台手动触发 —— 不是交易信号,请勿跟单,也不必写入信号台账。收到它说明你的端点能正常接收真信号。",
  };
}

/**
 * 摊开网络错的真实原因。undici 把一切网络失败都包成 `TypeError: fetch failed`,
 * 原因埋在 cause 里 —— 而最常见的那种(端口不通)cause 是一个 **message 为空**
 * 的 AggregateError,每个地址族一条子错误:
 *
 *   TypeError: fetch failed
 *     └ cause: AggregateError(message="", code="ECONNREFUSED")
 *         └ errors: [connect ECONNREFUSED ::1:59999,
 *                    connect ECONNREFUSED 127.0.0.1:59999]
 *
 * 只读 cause.message 会拿到空串,运营者面对的还是光秃秃一句「fetch failed」。
 * 所以三级取值:cause.message → 子错误 → cause.code。
 */
function describeCause(err: unknown): string | null {
  const cause = err instanceof Error ? err.cause : null;
  if (!(cause instanceof Error)) return null;
  if (cause.message) return cause.message;
  const inner = (cause as AggregateError).errors;
  if (Array.isArray(inner)) {
    const msgs = [
      ...new Set(
        inner
          .map((x) => (x instanceof Error ? x.message : String(x)))
          .filter(Boolean),
      ),
    ];
    if (msgs.length > 0) return msgs.join(" / ");
  }
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export interface WebhookTestResult {
  ok: boolean;
  /** 拿到 HTTP 响应才有;连不上或超时是 null。 */
  status: number | null;
  ms: number;
  /** 给运营者看的人话诊断 —— 不同失败因的处置完全不同,不能糊成一句「失败」。 */
  detail: string;
}

/**
 * 向端点投一条测试事件。**只读探针**:不接 db,因此不可能改写
 * consecutive_failures/active —— 那本账是自动投递的健康度,手点的测试
 * 不该往里掺沙子(清零是「恢复启用」的职责)。
 */
export async function postTestEvent(
  endpoint: Pick<WebhookEndpoint, "url" | "secret">,
  deps: { fetchFn?: typeof fetch; nowSec?: number } = {},
): Promise<WebhookTestResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const body = JSON.stringify(buildTestEvent(deps.nowSec));
  const startedAt = Date.now();
  try {
    const res = await fetchFn(endpoint.url, {
      method: "POST",
      headers: buildDeliveryHeaders(endpoint.secret, body, {
        signalId: 0,
        event: "entry",
        test: true,
      }),
      body,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    const ms = Date.now() - startedAt;
    if (res.ok) {
      return {
        ok: true,
        status: res.status,
        ms,
        detail: `端点返回 HTTP ${res.status} —— 签名与 body 都被收下了,真信号走同一条路。`,
      };
    }
    if (res.status >= 400 && res.status < 500) {
      return {
        ok: false,
        status: res.status,
        ms,
        detail: `端点拒收(HTTP ${res.status})—— 真信号也会被判为永久失败、不再重试。常见原因:路径写错 / 鉴权把我们拦了 / 订户侧字段必填校验挡下了这条空值测试事件。`,
      };
    }
    return {
      ok: false,
      status: res.status,
      ms,
      detail: `端点内部错误(HTTP ${res.status})—— 自动投递会按 30s 节奏重试,连续失败 ${WEBHOOK_DISABLE_AFTER} 次熔断停用。`,
    };
  } catch (e) {
    const ms = Date.now() - startedAt;
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        ok: false,
        status: null,
        ms,
        detail: `${POST_TIMEOUT_MS / 1000}s 内没有响应(超时)—— 端点多半在同步处理完才回包。建议先返回 2xx 再异步处理,否则真信号也会被判为投递失败。`,
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    const cause = describeCause(e);
    return {
      ok: false,
      status: null,
      ms,
      detail: `连不上端点:${cause ? `${msg} —— ${cause}` : msg}(常见原因:DNS 解析不到 / 端口未开 / TLS 证书无效 / 防火墙拦截)`,
    };
  }
}

export interface WebhookEndpoint {
  id: number;
  apiKeyId: number;
  url: string;
  secret: string;
  active: number;
  consecutiveFailures: number;
  /** 该端点所属 key 的订阅范围;null = 不限。这是**授权**边界。 */
  busTypes: string[] | null;
  /**
   * 端点自己勾选的推送类型(2026-08-19);null = 仅策略信号(历史默认)。
   * 这是**路由**偏好 —— 与 key 范围的关系是交集:勾了 key 无权的类型也
   * 不会投(登记时校验拒绝,运行时再兜一层)。null 的语义与 key 的
   * 「null = 全部」刻意相反,理由见 lib/db.ts 该列的迁移注释。
   */
  selectedTypes: string[] | null;
  /** 登记时刻 —— bus 分流的不回灌基准:早于它的事件不投。 */
  createdAt: number;
}

/**
 * 该端点想不想要某类型:key 授权 ∧ 端点勾选。
 * 勾选 null → 仅 "strategy"(存量端点的既有行为原样保留)。
 */
export function webhookWantsType(
  ep: Pick<WebhookEndpoint, "busTypes" | "selectedTypes">,
  type: string,
): boolean {
  if (!busTypeAllowed(ep.busTypes, type)) return false;
  return ep.selectedTypes == null
    ? type === "strategy"
    : ep.selectedTypes.includes(type);
}

export function registerWebhook(
  db: DB,
  opts: {
    apiKeyId: number;
    url: string;
    secret: string;
    /** 端点勾选的推送类型;省略/null = 仅策略信号(历史默认)。 */
    busTypes?: string[] | null;
  },
  nowSec: number = Math.floor(Date.now() / 1000),
): number {
  const res = db
    .prepare(
      "INSERT INTO webhook_endpoints (api_key_id, url, secret, created_at, bus_types) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      opts.apiKeyId,
      opts.url,
      opts.secret,
      nowSec,
      opts.busTypes?.length ? JSON.stringify(opts.busTypes) : null,
    );
  return Number(res.lastInsertRowid);
}

/**
 * 停用(false)/ 恢复启用(true)。返回是否命中一行。
 *
 * 恢复时必须一并清零 consecutive_failures 与 last_error:熔断判定是
 * `>= WEBHOOK_DISABLE_AFTER` 而不是 `==`,计数熔断后停在阈值上,只置 active=1
 * 的话下一次失败就是「阈值+1」→ 立刻二次熔断,按钮等于没做事。
 * 停用则保留计数 —— 那是投递史,要能审计出「它当初是怎么坏的」。
 */
export function setWebhookActive(db: DB, id: number, active: boolean): boolean {
  const res = active
    ? db
        .prepare(
          "UPDATE webhook_endpoints SET active = 1, consecutive_failures = 0, last_error = NULL WHERE id = ?",
        )
        .run(id)
    : db
        .prepare("UPDATE webhook_endpoints SET active = 0 WHERE id = ?")
        .run(id);
  return res.changes === 1;
}

/** 硬删:secret 一并销毁,不可恢复(要留投递史请用停用)。 */
export function deleteWebhook(db: DB, id: number): boolean {
  return (
    db.prepare("DELETE FROM webhook_endpoints WHERE id = ?").run(id).changes ===
    1
  );
}

/** 可投递端点:active=1 ∧ api_key 未吊销 ∧ tier=realtime。 */
export function listActiveWebhooks(db: DB): WebhookEndpoint[] {
  return (
    db
      .prepare(
        `SELECT w.id, w.api_key_id, w.url, w.secret, w.active, w.consecutive_failures,
                w.bus_types AS ep_bus_types, w.created_at, k.bus_types
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
      ep_bus_types: string | null;
      created_at: number;
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
    selectedTypes: parseBusTypes(r.ep_bus_types),
    createdAt: r.created_at,
  }));
}

export type PostResult = "ok" | "transient" | "permanent";

/**
 * 投一份已编码的 body 并按失败模型分类。策略事件与 bus 事件
 * (lib/busWebhook.ts)共用这一份 —— 超时/4xx/网络错的语义只能有一处实现。
 */
export async function postWebhookBody(
  endpoint: Pick<WebhookEndpoint, "url" | "secret">,
  body: string,
  head: { signalId: number; event: string },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<PostResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const res = await fetchFn(endpoint.url, {
      method: "POST",
      headers: buildDeliveryHeaders(endpoint.secret, body, head),
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

export async function postSignalEvent(
  endpoint: WebhookEndpoint,
  event: SignalEventV1,
  deps: { fetchFn?: typeof fetch } = {},
): Promise<PostResult> {
  return postWebhookBody(
    endpoint,
    JSON.stringify(event),
    { signalId: event.id, event: event.event },
    deps,
  );
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
