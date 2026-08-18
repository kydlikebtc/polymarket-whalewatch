import { openDb } from "../../../lib/db";
import {
  DEFAULT_CONDITIONS,
  getAlertConditions,
  setAlertConditions,
  type AlertConditions,
} from "../../../lib/alertConditions";
import { checkWriteAccess, isPublicDeployment } from "../../../lib/apiGuard";

// Node runtime: better-sqlite3 is a native module (no Edge). force-dynamic so the
// engine and dashboard always see each other's writes without caching.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DB_PATH = process.env.DASH_DB || "data.sqlite";

export async function GET(req: Request) {
  // 2026-08-18:GET 改为与 POST 同一道 ADMIN_TOKEN 闸。
  //
  // 原先阈值明文公开,理由写的是「属于战绩透明度的一部分」。这条理由在
  // /alerts 还带配置面板时成立;条件编辑迁到 /manage(ebc5deb)之后,全站
  // 唯一的消费方就是运营页自己 —— 于是它实际提供的不是透明度,而是「任何
  // 人 curl 一下就知道这套监控盯多大的单、什么方向、什么价格区间、冷却多久」。
  // 这是可被规避的规则集,不是可被核验的战绩;真正的透明度在 /record 与每日
  // 存证链上,那些是**结果**,公开它们无法被人利用来绕开。
  //
  // 复用 checkWriteAccess 而不是另造一个只读闸:它就是这个部署的
  // 「ADMIN_TOKEN 认不认你」判据,名字里的 write 是历史,语义正是所需。
  // 本地开发照旧免令牌(isPublicDeployment=false 时恒放行)。
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  // `readonly` tells the panel whether saving needs an admin token.
  const readonly = isPublicDeployment();
  try {
    const db = openDb(DB_PATH);
    try {
      return Response.json({ ...getAlertConditions(db), readonly });
    } finally {
      db.close();
    }
  } catch (error) {
    console.error("[/api/alert-config] GET failed:", error);
    // Degrade to defaults plus an error string — never 500 the UI.
    return Response.json({
      ...DEFAULT_CONDITIONS,
      readonly,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Coerce a 0..1 price bound (or null). Out-of-range / NaN / non-number → null.
function clampPrice(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// Coerce a non-negative day cap (or null). NaN / negative / non-number → null.
function clampAge(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return v;
}

function clampSide(v: unknown): AlertConditions["side"] {
  return v === "BUY" || v === "SELL" ? v : "ALL";
}

// Coerce the per-(wallet, market) push cooldown (minutes). Non-number / NaN /
// negative all degrade to the default; 0 is a valid "disabled" value.
function clampCooldown(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : DEFAULT_CONDITIONS.cooldownMinutes;
}

function clampMinUsd(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : DEFAULT_CONDITIONS.minUsd;
}

// Validate an arbitrary body into a well-formed AlertConditions.
function validate(body: unknown): AlertConditions {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    enabled:
      typeof b.enabled === "boolean" ? b.enabled : DEFAULT_CONDITIONS.enabled,
    minUsd: clampMinUsd(b.minUsd),
    side: clampSide(b.side),
    minPrice: clampPrice(b.minPrice),
    maxPrice: clampPrice(b.maxPrice),
    maxAgeDays: clampAge(b.maxAgeDays),
    smartOnly:
      typeof b.smartOnly === "boolean"
        ? b.smartOnly
        : DEFAULT_CONDITIONS.smartOnly,
    // Same non-negative-or-null semantics as the age cap.
    maxHoursToEnd: clampAge(b.maxHoursToEnd),
    cooldownMinutes: clampCooldown(b.cooldownMinutes),
  };
}

export async function POST(req: Request) {
  // Auth BEFORE any parsing or db work: on the public deployment this route is
  // the alert-threshold tamper vector — reject unauthenticated writes with a
  // real status code (the panel surfaces `error` and keeps its local state).
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const conditions = validate(body);
    const db = openDb(DB_PATH);
    try {
      setAlertConditions(db, conditions);
      return Response.json(conditions);
    } finally {
      db.close();
    }
  } catch (error) {
    console.error("[/api/alert-config] POST failed:", error);
    // Never 500: return defaults + error string so the UI can show it.
    return Response.json({
      ...DEFAULT_CONDITIONS,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
