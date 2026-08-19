import { z } from "zod";
import {
  buildAdminSignalOverview,
  buildBusLedger,
  buildEventLedger,
  buildSmartLedger,
  setStrategyPush,
} from "../../../../lib/adminOverview";
import { getAlertConditions } from "../../../../lib/alertConditions";
import {
  createBusDef,
  deleteBusDef,
  listBusDefs,
  updateBusDef,
} from "../../../../lib/busDefs";
import { getXKindSwitches } from "../../../../lib/xSettings";
import { listTargets, type TgKind } from "../../../../lib/tgTargets";
import {
  listActiveWebhooks,
  webhookWantsType,
} from "../../../../lib/webhookDelivery";
import { checkWriteAccess, guardExpensive } from "../../../../lib/apiGuard";
import { parseConfig } from "../../../../lib/config";
import { openDb, type DB } from "../../../../lib/db";
import {
  BUS_TYPES,
  DEFAULT_BUS_SETTINGS,
  getBusSettings,
  getBusSignals,
  setBusSettings,
  type BusSettings,
  type BusSourceType,
} from "../../../../lib/signalBus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /manage 运营页的数据接口。GET 也走 ADMIN_TOKEN —— 这是运营视角的数据
// (各档投递统计/TG 故障串/未放开档的表现),不属于公开面;公开面在 /record。
// 本地开发照旧免令牌(checkWriteAccess 的既有姿态)。

// 信号定义 CRUD(2026-08-19)。
const DefBody = z.discriminatedUnion("defAction", [
  z.object({
    defAction: z.literal("create"),
    sourceType: z.string().min(1),
    label: z.string().min(1).max(32),
    threshold: z.number().nonnegative(),
  }),
  z.object({
    defAction: z.literal("update"),
    id: z.number().int().positive(),
    label: z.string().min(1).max(32).optional(),
    threshold: z.number().nonnegative().optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({
    defAction: z.literal("delete"),
    id: z.number().int().positive(),
  }),
]);

// 总线类型设置(legacy):逐类型部分更新 —— 现映射到该类型的信号定义。
const BusBody = z.object({
  busType: z.string().min(1),
  enabled: z.boolean().optional(),
  threshold: z.number().nonnegative().optional(),
});

const ToggleBody = z.object({
  strategyId: z.number().int().positive(),
  pushEnabled: z.boolean(),
});

const LIMITS = { perIp: 60, global: 120 };

function openDash() {
  return openDb(process.env.DASH_DB ?? "data.sqlite");
}

// 与 worker/embeddedEngine.ts 的通道装配同一判据(env 凭证 + 活跃 webhook)
// —— 积压读数必须对准投递循环真正在跑的通道,不多不少。
function deliveryChannels(db: DB): { key: string; minEmitAgeSec: number }[] {
  const cfg = parseConfig(process.env);
  const out: { key: string; minEmitAgeSec: number }[] = [];
  if (cfg.telegramBotToken && cfg.telegramSignalChannelId) {
    out.push({ key: "tg_paid", minEmitAgeSec: 0 });
  }
  if (cfg.telegramEnabled) {
    out.push({
      key: "tg_public",
      minEmitAgeSec: cfg.signalPublicDelayMin * 60,
    });
  }
  for (const ep of listActiveWebhooks(db)) {
    out.push({ key: `webhook:${ep.id}`, minEmitAgeSec: 0 });
  }
  return out;
}

/** 路由矩阵数据:各(信号线 × 管线)格的当前状态,全部取自属主开关。 */
function buildRouting(db: ReturnType<typeof openDash>) {
  const tgKindCount: Record<string, number> = {};
  for (const t of listTargets(db)) {
    if (t.paused) continue;
    for (const k of Object.keys(t.kinds) as TgKind[]) {
      if (t.kinds[k]) tgKindCount[k] = (tgKindCount[k] ?? 0) + 1;
    }
  }
  const webhookTypeCount: Record<string, number> = {};
  for (const ep of listActiveWebhooks(db)) {
    for (const ty of ["strategy", "large", "consensus", "discovery"]) {
      if (webhookWantsType(ep, ty)) {
        webhookTypeCount[ty] = (webhookTypeCount[ty] ?? 0) + 1;
      }
    }
  }
  return {
    /** ①→TG 告警频道的总开关(alert-config.enabled)。 */
    alertPush: getAlertConditions(db).enabled,
    /** 𝕏 各内容类型开关(whale/consensus/pregame/weekly/settled)。 */
    xKinds: getXKindSwitches(db),
    /** 未暂停 tg_targets 里勾了各 kind 的目标数。 */
    tgTargetKinds: tgKindCount,
    /** 活跃 webhook 端点里想要各类型的端点数(key 授权 ∧ 端点勾选)。 */
    webhookTypes: webhookTypeCount,
  };
}

export async function GET(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const limited = guardExpensive(req, "admin-signals", LIMITS, {});
  if (limited) return limited;
  const db = openDash();
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const recent = getBusSignals(db, {
      nowSec,
      windowSec: 86_400,
      limit: 1000,
    });
    const busCounts: Record<string, number> = {};
    for (const r of recent) {
      busCounts[r.sourceType] = (busCounts[r.sourceType] ?? 0) + 1;
    }
    return Response.json({
      ...buildAdminSignalOverview(db, { channels: deliveryChannels(db) }),
      // 统一信号总线:类型注册表 + 当前开关/阈值 + 近 24h 各类产出量。
      busTypes: BUS_TYPES,
      // 信号定义(2026-08-19,唯一真相):同一类型可多档,各自阈值/启停。
      busDefs: listBusDefs(db),
      // legacy 设置仅供旧 UI 兼容读,不再参与任何判定。
      busSettings: getBusSettings(db),
      busCounts24h: busCounts,
      // ① 原始事件线统一台账(大额/共识来自 alerts + 发现来自 bus)× 去向。
      eventLedger: buildEventLedger(db),
      // 兼容旧键(2026-08-19 当日的 UI 中间态用过;下轮可删)。
      smartLedger: buildSmartLedger(db),
      // 路由矩阵的真实开关态(线 × 管线,每格都指回属主开关,不造第二套配置)。
      routing: buildRouting(db),
      // 总线台账最近 20 条 + 逐通道投递状态(bus_deliveries)—— 与策略台账
      // (recent × signal_deliveries)同一套「发了没有」的运营视图。
      busLedger: buildBusLedger(db),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/admin/signals] GET failed:", message);
    return Response.json({ error: message }, { status: 200 });
  } finally {
    db.close();
  }
}

export async function POST(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const limited = guardExpensive(req, "admin-signals", LIMITS, {});
  if (limited) return limited;
  const raw: unknown = await req.json().catch(() => null);

  // 信号定义 CRUD(2026-08-19):{defAction: create|update|delete, ...}。
  const defBody = DefBody.safeParse(raw);
  if (defBody.success) {
    const db = openDash();
    try {
      const d = defBody.data;
      if (d.defAction === "create") {
        if (!(d.sourceType in DEFAULT_BUS_SETTINGS)) {
          return Response.json(
            { error: `未知信号类型:${d.sourceType}` },
            { status: 400 },
          );
        }
        const meta = BUS_TYPES.find((t) => t.type === d.sourceType);
        if (meta && !meta.available) {
          return Response.json(
            { error: `「${meta.label}」尚未接入总线,不能建信号定义` },
            { status: 400 },
          );
        }
        const id = createBusDef(db, {
          sourceType: d.sourceType as BusSourceType,
          label: d.label,
          threshold: d.threshold,
        });
        return Response.json({ id, busDefs: listBusDefs(db) });
      }
      if (d.defAction === "update") {
        if (!updateBusDef(db, d.id, d)) {
          return Response.json(
            { error: `信号定义 #${d.id} 不存在` },
            { status: 404 },
          );
        }
        return Response.json({ ok: true, busDefs: listBusDefs(db) });
      }
      // delete:同时提醒 —— 订了 def:<id> 的端点从此收不到(不级联改端点,
      // 端点配置是运营者的显式意图,静默改写比失效更糟)。
      if (!deleteBusDef(db, d.id)) {
        return Response.json(
          { error: `信号定义 #${d.id} 不存在` },
          { status: 404 },
        );
      }
      return Response.json({ ok: true, busDefs: listBusDefs(db) });
    } finally {
      db.close();
    }
  }

  // legacy busType 路径(兼容旧脚本):映射到该类型的定义 —— 0 个则创建
  // 「默认」,恰 1 个则更新,多个则拒绝(必须逐定义操作,不猜哪个)。
  const bus = BusBody.safeParse(raw);
  if (bus.success) {
    const db = openDash();
    try {
      const type = bus.data.busType as BusSourceType;
      if (!(type in DEFAULT_BUS_SETTINGS)) {
        return Response.json(
          { error: `未知信号类型:${bus.data.busType}` },
          { status: 400 },
        );
      }
      const meta = BUS_TYPES.find((t) => t.type === type);
      if (bus.data.enabled === true && meta && !meta.available) {
        // 未落库的类型开了也不会有数据,不如直接拒绝并说明原因。
        return Response.json(
          {
            error: `「${meta.label}」尚未接入总线(该类信号目前仅在页面实时计算)`,
          },
          { status: 400 },
        );
      }
      const defs = listBusDefs(db).filter((d) => d.sourceType === type);
      if (defs.length > 1) {
        return Response.json(
          {
            error: `「${meta?.label ?? type}」已有 ${defs.length} 个信号定义,请用 defAction 逐个操作`,
          },
          { status: 400 },
        );
      }
      if (defs.length === 0) {
        // 只在「开启」时创建;对不存在的定义发「关闭」是 no-op。
        if (bus.data.enabled === true || bus.data.threshold != null) {
          createBusDef(db, {
            sourceType: type,
            label: "默认",
            threshold:
              bus.data.threshold ??
              (meta?.threshold
                ? Number(DEFAULT_BUS_SETTINGS[type][meta.threshold.key])
                : 0),
          });
          if (bus.data.enabled === false) {
            // threshold-only 调用不该顺手开启
            const created = listBusDefs(db).find(
              (d) => d.sourceType === type,
            );
            if (created) updateBusDef(db, created.id, { enabled: false });
          }
        }
      } else {
        updateBusDef(db, defs[0].id, {
          enabled: bus.data.enabled,
          threshold: bus.data.threshold,
        });
      }
      // legacy 设置同步写一份,免得旧读方(仅展示)漂移。
      const next: BusSettings = getBusSettings(db);
      if (typeof bus.data.enabled === "boolean") {
        next[type].enabled = bus.data.enabled;
      }
      if (typeof bus.data.threshold === "number" && meta?.threshold) {
        next[type][meta.threshold.key] = bus.data.threshold;
      }
      setBusSettings(db, next);
      return Response.json({
        ok: true,
        busSettings: next,
        busDefs: listBusDefs(db),
      });
    } finally {
      db.close();
    }
  }

  let body: z.infer<typeof ToggleBody>;
  try {
    body = ToggleBody.parse(raw);
  } catch (e) {
    return Response.json(
      { error: `请求体不合法:${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    );
  }
  const db = openDash();
  try {
    const updated = setStrategyPush(db, body.strategyId, body.pushEnabled);
    if (!updated) {
      return Response.json(
        { error: `strategyId ${body.strategyId} 不存在` },
        { status: 400 },
      );
    }
    return Response.json({
      strategyId: body.strategyId,
      pushEnabled: body.pushEnabled,
    });
  } finally {
    db.close();
  }
}
