import { openDb } from "../../../lib/db";
import {
  DEFAULT_CONDITIONS,
  getAlertConditions,
  setAlertConditions,
  type AlertConditions,
} from "../../../lib/alertConditions";

// Node runtime: better-sqlite3 is a native module (no Edge). force-dynamic so the
// engine and dashboard always see each other's writes without caching.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DB_PATH = process.env.DASH_DB || "data.sqlite";

export async function GET() {
  try {
    const db = openDb(DB_PATH);
    try {
      return Response.json(getAlertConditions(db));
    } finally {
      db.close();
    }
  } catch (error) {
    console.error("[/api/alert-config] GET failed:", error);
    // Degrade to defaults plus an error string — never 500 the UI.
    return Response.json({
      ...DEFAULT_CONDITIONS,
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
  };
}

export async function POST(req: Request) {
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
