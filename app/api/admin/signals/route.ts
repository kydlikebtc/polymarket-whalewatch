import { z } from "zod";
import {
  buildAdminSignalOverview,
  setStrategyPush,
} from "../../../../lib/adminOverview";
import { checkWriteAccess, guardExpensive } from "../../../../lib/apiGuard";
import { parseConfig } from "../../../../lib/config";
import { openDb, type DB } from "../../../../lib/db";
import { listActiveWebhooks } from "../../../../lib/webhookDelivery";
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

// 总线类型设置:逐类型部分更新(UI 只提交被改动的那个开关/阈值)。
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
    const recent = getBusSignals(db, { nowSec, windowSec: 86_400, limit: 1000 });
    const busCounts: Record<string, number> = {};
    for (const r of recent) {
      busCounts[r.sourceType] = (busCounts[r.sourceType] ?? 0) + 1;
    }
    return Response.json({
      ...buildAdminSignalOverview(db, { channels: deliveryChannels(db) }),
      // 统一信号总线:类型注册表 + 当前开关/阈值 + 近 24h 各类产出量。
      busTypes: BUS_TYPES,
      busSettings: getBusSettings(db),
      busCounts24h: busCounts,
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
  // 总线类型设置与既有档位开关共用这个端点,按请求体形状分派 —— 前者带
  // busType,后者带 strategyId,两者互斥。
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
          { error: `「${meta.label}」尚未接入总线(该类信号目前仅在页面实时计算)` },
          { status: 400 },
        );
      }
      const next: BusSettings = getBusSettings(db);
      if (typeof bus.data.enabled === "boolean") {
        next[type].enabled = bus.data.enabled;
      }
      if (typeof bus.data.threshold === "number" && meta?.threshold) {
        next[type][meta.threshold.key] = bus.data.threshold;
      }
      setBusSettings(db, next);
      return Response.json({ ok: true, busSettings: next });
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
