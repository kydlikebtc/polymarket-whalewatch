import type { DB } from "./db";

// 市场深度卡的四个可调参数。走 config 表而非环境变量:这些数**需要在观察到
// 真实流量后调**(工作集够不够大、refused 是不是持续非零),而每次调都要重新
// 部署会让运营者干脆不调 —— 一个调不动的旋钮等于没有旋钮。
//
// 与 bus_signal_settings 同一姿态:逐字段校验类型,坏值回默认并 warn,
// 「坏配置不该变成意外行为」。

export interface CardSettings {
  /** 每分钟允许的上游请求数(令牌桶容量)。0 = 暂时关掉这个端点。 */
  budgetPerMin: number;
  /** 窗口新鲜期,也是卡片的年龄上限。 */
  windowTtlSec: number;
  /** 硬陈旧闸:超过它宁可 429 也不发卡。 */
  staleGateSec: number;
  /** 内存工作集上限(市场数)。 */
  lruMax: number;
}

export const DEFAULT_CARD_SETTINGS: CardSettings = {
  budgetPerMin: 100,
  windowTtlSec: 30,
  staleGateSec: 90,
  lruMax: 200,
};

const CONFIG_KEY = "market_card_settings";

// 夹取区间。运营手抖不该让这个端点变成一颗上游炸弹,也不该让它悄悄失效。
const BOUNDS = {
  budgetPerMin: [0, 2000],
  windowTtlSec: [5, 300],
  staleGateSec: [10, 900],
  lruMax: [10, 2000],
} as const;

const clamp = (v: number, [lo, hi]: readonly [number, number]) =>
  Math.max(lo, Math.min(hi, Math.floor(v)));

/**
 * 夹取 + 一条跨字段不变式。
 *
 * `staleGateSec > windowTtlSec` 不是审美问题:窗口要到 ttl 秒才触发续抓,届时
 * staleSec 已经 >= ttl。闸门若比 ttl 还小,每一次降级都会立刻撞闸变成 429 ——
 * 「预算耗尽时发一张标注年龄的旧卡」这条路就从来没被走过,是一段死代码。
 */
function normalize(raw: CardSettings): CardSettings {
  const out: CardSettings = {
    budgetPerMin: clamp(raw.budgetPerMin, BOUNDS.budgetPerMin),
    windowTtlSec: clamp(raw.windowTtlSec, BOUNDS.windowTtlSec),
    staleGateSec: clamp(raw.staleGateSec, BOUNDS.staleGateSec),
    lruMax: clamp(raw.lruMax, BOUNDS.lruMax),
  };
  if (out.staleGateSec <= out.windowTtlSec) {
    out.staleGateSec = clamp(out.windowTtlSec * 3, BOUNDS.staleGateSec);
  }
  return out;
}

export function getCardSettings(db: DB): CardSettings {
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(CONFIG_KEY) as { value: string | null } | undefined;
  if (!row?.value) return { ...DEFAULT_CARD_SETTINGS };
  try {
    const parsed = JSON.parse(row.value) as Partial<CardSettings>;
    if (typeof parsed !== "object" || parsed === null) {
      return { ...DEFAULT_CARD_SETTINGS };
    }
    const merged = { ...DEFAULT_CARD_SETTINGS };
    for (const k of Object.keys(
      DEFAULT_CARD_SETTINGS,
    ) as (keyof CardSettings)[]) {
      const v = parsed[k];
      if (typeof v === "number" && Number.isFinite(v)) merged[k] = v;
    }
    return normalize(merged);
  } catch {
    console.warn(
      `[cardSettings] corrupt JSON for '${CONFIG_KEY}', using defaults`,
    );
    return { ...DEFAULT_CARD_SETTINGS };
  }
}

export function setCardSettings(db: DB, s: CardSettings): void {
  const next = JSON.stringify(normalize(s));
  const prev = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(CONFIG_KEY) as { value: string | null } | undefined;
  if (prev?.value !== next) {
    db.prepare(
      "INSERT INTO config_history (key, value, changed_at) VALUES (?, ?, ?)",
    ).run(CONFIG_KEY, next, Math.floor(Date.now() / 1000));
  }
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    CONFIG_KEY,
    next,
  );
}
