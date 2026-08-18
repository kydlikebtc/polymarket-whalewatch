// 𝕏 播报的内容类型开关 + 发帖历史读取。
//
// 开关存 config 表(与 alertConditions 同款:JSON 一行、坏值降级默认、
// 真实变更才写 config_history)。引擎每轮读一次,所以 /manage 上改完
// 下一轮(≤60s)生效,无需重启 —— 与账号切换同一套即时性承诺。
//
// 为什么要能关:四类内容的性价比差别很大(共识稀有且独家、大单量大易刷屏),
// 预算又是硬上限 $15/月。运营者需要能只留高价值的那几类,而不是改代码。
import type { DB } from "./db";

export type XPostKind = "whale" | "consensus" | "pregame" | "weekly";

export const X_KINDS: { kind: XPostKind; label: string; hint: string }[] = [
  {
    kind: "whale",
    label: "巨鲸大单",
    hint: "单笔成交额超过阈值即发。量最大,也最容易吃满日配额",
  },
  {
    kind: "consensus",
    label: "聪明钱共识",
    hint: "多个白名单钱包同向买入同一结果。稀有且独家,优先级最高",
  },
  {
    kind: "pregame",
    label: "赛前聚合",
    hint: "结算前 1-6 小时的高热市场汇总,蹭事件峰值流量。每日至多 3 条",
  },
  {
    kind: "weekly",
    label: "周报成绩单",
    hint: "每周一图卡 + 站点链接。全家桶里唯一带链接的帖($0.20)",
  },
];

export type XKindSwitches = Record<XPostKind, boolean>;

// 默认全开:首版行为即四类都发,升级到本版本的部署不该因为多了开关而静默变哑。
export const DEFAULT_X_KINDS: XKindSwitches = {
  whale: true,
  consensus: true,
  pregame: true,
  weekly: true,
};

const CONFIG_KEY = "x_broadcast_kinds";

export function getXKindSwitches(db: DB): XKindSwitches {
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(CONFIG_KEY) as { value: string | null } | undefined;
  if (!row || !row.value) return { ...DEFAULT_X_KINDS };
  try {
    const parsed = JSON.parse(row.value) as Partial<XKindSwitches>;
    if (typeof parsed !== "object" || parsed === null) {
      return { ...DEFAULT_X_KINDS };
    }
    // 逐键校验:只接受真正的布尔值,其余(字符串 "false"、null、缺失)一律
    // 回落默认 —— 坏配置绝不能变成"意外静默"。
    const out = { ...DEFAULT_X_KINDS };
    for (const k of Object.keys(DEFAULT_X_KINDS) as XPostKind[]) {
      if (typeof parsed[k] === "boolean") out[k] = parsed[k];
    }
    return out;
  } catch {
    console.warn(
      `[xSettings] corrupt JSON for '${CONFIG_KEY}', using defaults`,
    );
    return { ...DEFAULT_X_KINDS };
  }
}

/**
 * config 写入的共用路径:只有值**真的变了**才补一条 config_history。
 * 重复保存(运营者点两次保存、UI 重渲染回写)不该污染变更日志 —— 变更日志
 * 是复盘「那天为什么突然不发了」的唯一线索,进噪声等于失去它。
 */
function writeConfig(db: DB, key: string, value: string): void {
  const prev = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as
    { value: string | null } | undefined;
  if (prev?.value !== value) {
    db.prepare(
      "INSERT INTO config_history (key, value, changed_at) VALUES (?, ?, ?)",
    ).run(key, value, Math.floor(Date.now() / 1000));
  }
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    key,
    value,
  );
}

export function setXKindSwitches(db: DB, s: XKindSwitches): void {
  writeConfig(db, CONFIG_KEY, JSON.stringify(s));
}

// --- 发帖通道 -------------------------------------------------------------
//
// 'api'       —— worker 用 X API 直发(首版行为)。按量付费,预算是硬上限。
// 'extension' —— 落队列,由运营者本机 Chrome 插件用已登录会话代发。边际成本零。
//
// 默认 'api' 是纪律不是偏好:升级到本版本的部署不该因为多了一个开关而改变
// 行为(与 DEFAULT_X_KINDS 全开同源)。引擎每轮读一次,所以 /manage 上切换后
// 下一轮 ≤60s 生效,无需重启 —— 与账号切换同一套即时性承诺。

export type XDeliveryChannel = "api" | "extension";

const CHANNEL_KEY = "x_delivery_channel";
const DEFAULT_CHANNEL: XDeliveryChannel = "api";

export function getXDeliveryChannel(db: DB): XDeliveryChannel {
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(CHANNEL_KEY) as { value: string | null } | undefined;
  const v = row?.value;
  if (v === "api" || v === "extension") return v;
  if (v) {
    console.warn(
      `[xSettings] 未知发帖通道 '${v}',回落 ${DEFAULT_CHANNEL}(坏配置不该让播报静默停摆)`,
    );
  }
  return DEFAULT_CHANNEL;
}

export function setXDeliveryChannel(db: DB, c: XDeliveryChannel): void {
  writeConfig(db, CHANNEL_KEY, c);
}

// --- 插件通道日上限 -------------------------------------------------------
//
// api 通道继续用 xQuota 的 DAILY_CAP 常量({whale:20, pregame:3})—— 那是
// **预算**约束($15/月 摊到每天)。插件通道边际成本为零,上限的意义整个变了:
// 防封号 + 防刷屏。所以是另一套数值,且必须运营者可调 —— 不同账号权重、
// 不同运营阶段的容忍度不一样,这是运营决策不是代码常量。

// 刻意用 type alias 而不是 interface:只有前者带隐式索引签名,才能直接传给
// quotaDecision 的 `caps?: Record<string, number>`(interface 会报
// "Index signature for type 'string' is missing")。
export type XDailyCaps = {
  whale: number;
  pregame: number;
};

const CAPS_KEY = "x_daily_caps";
export const DEFAULT_X_DAILY_CAPS: XDailyCaps = { whale: 100, pregame: 6 };

export function getXDailyCaps(db: DB): XDailyCaps {
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(CAPS_KEY) as { value: string | null } | undefined;
  const out = { ...DEFAULT_X_DAILY_CAPS };
  if (!row?.value) return out;
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return out;
    // 逐键校验:只接受正整数。0/负数/小数/字符串一律回落该键的默认值 ——
    // 一个坏键不该连累好键,更不该把整条通道变哑(同 getXKindSwitches)。
    for (const k of Object.keys(DEFAULT_X_DAILY_CAPS) as (keyof XDailyCaps)[]) {
      const v = parsed[k];
      if (typeof v === "number" && Number.isInteger(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    console.warn(`[xSettings] corrupt JSON for '${CAPS_KEY}', using defaults`);
    return out;
  }
}

export function setXDailyCaps(db: DB, caps: XDailyCaps): void {
  writeConfig(db, CAPS_KEY, JSON.stringify(caps));
}

// --- 发帖历史 --------------------------------------------------------------

export interface XPostRow {
  id: number;
  kind: string;
  text: string;
  status: string;
  xPostId: string | null;
  costUsd: number;
  createdAt: number;
  /** 'api' | 'extension' —— 这条是走哪条通道发的(通道级归因)。 */
  channel: string;
}

export interface XPostHistory {
  posts: XPostRow[];
  /** 本 UTC 月已花费(与 xQuota 熔断同口径:claimed+posted 都算)。 */
  spentThisMonthUsd: number;
  /** 各状态计数(近 window 内),让"发了多少 / 拒了多少"一眼可见。 */
  counts: Record<string, number>;
}

export const HISTORY_LIMIT = 50;

export function getXPostHistory(
  db: DB,
  nowSec: number,
  limit = HISTORY_LIMIT,
): XPostHistory {
  const posts = (
    db
      .prepare(
        `SELECT id, kind, text, status, x_post_id, est_cost_usd, created_at, channel
           FROM x_posts ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(limit) as {
      id: number;
      kind: string;
      text: string;
      status: string;
      x_post_id: string | null;
      est_cost_usd: number;
      created_at: number;
      channel: string;
    }[]
  ).map((r) => ({
    id: r.id,
    kind: r.kind,
    text: r.text,
    status: r.status,
    xPostId: r.x_post_id,
    costUsd: r.est_cost_usd,
    createdAt: r.created_at,
    channel: r.channel,
  }));

  const d = new Date(nowSec * 1000);
  const monthFrom = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  const spent = db
    .prepare(
      `SELECT COALESCE(SUM(est_cost_usd), 0) AS s FROM x_posts
        WHERE status IN ('claimed','posted') AND created_at >= ?`,
    )
    .get(monthFrom) as { s: number };

  const counts: Record<string, number> = {};
  for (const r of db
    .prepare("SELECT status, COUNT(*) AS n FROM x_posts GROUP BY status")
    .all() as { status: string; n: number }[]) {
    counts[r.status] = r.n;
  }

  return { posts, spentThisMonthUsd: spent.s, counts };
}
