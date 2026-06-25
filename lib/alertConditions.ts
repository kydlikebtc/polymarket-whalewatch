import type { DB } from "./db";

// User-editable alert match conditions, persisted in the `config` table under
// the key `alert_conditions`. The engine reads these every cycle, so edits made
// in the dashboard take effect on the next poll.
export interface AlertConditions {
  enabled: boolean;
  minUsd: number;
  side: "ALL" | "BUY" | "SELL";
  minPrice: number | null; // 0..1, null = no lower bound
  maxPrice: number | null; // 0..1, null = no upper bound
  maxAgeDays: number | null; // address-age cap in days, null = no cap
}

export const DEFAULT_CONDITIONS: AlertConditions = {
  enabled: true,
  minUsd: 10000,
  side: "ALL",
  minPrice: null,
  maxPrice: null,
  maxAgeDays: null,
};

const CONFIG_KEY = "alert_conditions";

// Read the stored conditions, JSON-parsed and merged over the defaults. Any
// missing keys, a missing row, or corrupt JSON all degrade to DEFAULT_CONDITIONS
// (the engine must never crash because the config row is malformed).
export function getAlertConditions(db: DB): AlertConditions {
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(CONFIG_KEY) as { value: string | null } | undefined;
  if (!row || !row.value) return { ...DEFAULT_CONDITIONS };
  try {
    const parsed = JSON.parse(row.value) as Partial<AlertConditions>;
    if (typeof parsed !== "object" || parsed === null) {
      return { ...DEFAULT_CONDITIONS };
    }
    return { ...DEFAULT_CONDITIONS, ...parsed };
  } catch {
    console.warn(
      `[alertConditions] corrupt JSON for '${CONFIG_KEY}', using defaults`,
    );
    return { ...DEFAULT_CONDITIONS };
  }
}

export function setAlertConditions(db: DB, c: AlertConditions): void {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    CONFIG_KEY,
    JSON.stringify(c),
  );
}
