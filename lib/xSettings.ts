// 𝕏 播报的内容类型开关 + 发帖历史读取。
//
// 开关存 config 表(与 alertConditions 同款:JSON 一行、坏值降级默认、
// 真实变更才写 config_history)。引擎每轮读一次,所以 /manage 上改完
// 下一轮(≤60s)生效,无需重启 —— 与账号切换同一套即时性承诺。
//
// 为什么要能关:四类内容的性价比差别很大(共识稀有且独家、大单量大易刷屏),
// 预算又是硬上限 $15/月。运营者需要能只留高价值的那几类,而不是改代码。
import type { DB } from "./db";

export type XPostKind =
  | "whale"
  | "consensus"
  | "pregame"
  | "weekly"
  | "settled"
  | "scorecard"
  | "pulse"
  | "divergence";

export const X_KINDS: { kind: XPostKind; label: string; hint: string }[] = [
  {
    kind: "whale",
    label: "① 巨鲸大单(事件)",
    hint: "单笔成交额超过阈值即发。量最大,也最容易吃满日配额",
  },
  {
    kind: "consensus",
    label: "① 聪明钱共识(事件)",
    hint: "多个白名单钱包同向买入同一结果。稀有且独家,优先级最高",
  },
  {
    kind: "pregame",
    label: "赛前聚合(市场汇总,非信号线)",
    hint: "结算窗口内的高热市场汇总,蹭事件峰值流量。窗口与日上限在 /manage 可配",
  },
  {
    kind: "weekly",
    label: "周报成绩单(非信号线)",
    hint: "每周一图卡 + 站点链接。全家桶里唯一带链接的帖($0.20)",
  },
  {
    kind: "settled",
    label: "② 结算战报(策略事件)",
    hint: "对已发过的信号帖回复战果(赢输都发),形成「说了什么 → 后来怎样」的 thread。只回自己的帖",
  },
  {
    kind: "scorecard",
    label: "📋 每日战报榜(非信号线)",
    hint: "每日一帖:把昨天所有结算战果聚成一条主帖(几战几胜 + 代表行)。战报自回复没有独立分发,这条才是给时间线看的",
  },
  {
    kind: "pulse",
    label: "📊 异常市场日榜(市场汇总,非信号线)",
    hint: "每日一帖:昨日最异常市场 + 四分量拆解(/pulse 同源)。数据就绪后在设定时刻发",
  },
  {
    kind: "divergence",
    label: "⚔️ 小单vs鲸鱼分歧(市场汇总,非信号线)",
    hint: "每日至多一帖:小单与鲸鱼站在对立面的市场(双边材料性达标才有)。无分歧的日子静默",
  },
];

export type XKindSwitches = Record<XPostKind, boolean>;

// 既有四类默认全开:首版行为即四类都发,升级不该因为多了开关而静默变哑。
// settled 是后加的新能力,**默认关** —— 新能力不该在运营者不知情时就开始
// 往时间线上发东西(与信号总线 DEFAULT_BUS_SETTINGS 同一纪律)。
export const DEFAULT_X_KINDS: XKindSwitches = {
  whale: true,
  consensus: true,
  pregame: true,
  weekly: true,
  settled: false,
  // 每日战报榜(2026-08-31)同 settled 纪律:新能力默认关。
  scorecard: false,
  // 内容引擎两类(2026-08-27)同 settled 纪律:新能力默认关,运营者显式
  // 打开才开始往时间线上发东西。
  pulse: false,
  divergence: false,
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

export function setXKindSwitches(db: DB, s: XKindSwitches): void {
  const next = JSON.stringify(s);
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

// --- 发帖历史 --------------------------------------------------------------

export interface XPostRow {
  id: number;
  kind: string;
  text: string;
  status: string;
  xPostId: string | null;
  costUsd: number;
  createdAt: number;
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
        `SELECT id, kind, text, status, x_post_id, est_cost_usd, created_at
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
    }[]
  ).map((r) => ({
    id: r.id,
    kind: r.kind,
    text: r.text,
    status: r.status,
    xPostId: r.x_post_id,
    costUsd: r.est_cost_usd,
    createdAt: r.created_at,
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

// --- 时间分布(天 × 小时 × 类型) ------------------------------------------
//
// 运营者要回答的问题是「什么时段在发什么」:日上限吃满在几点、赛前聚合
// 是否押中了赛事时段、周报是否准点。只统计 status='posted'(真发出去的)
// —— skipped/failed 是闸门与故障的问题,在状态计数里看,混进分布只会糊图。

export interface XPostHistogramDay {
  /** UTC 日期标签,如 "08-25"。 */
  day: string;
  /** 当日 posted 总数。 */
  total: number;
  /** hours[0..23]:该 UTC 小时各 kind 的 posted 数;空对象 = 该小时无帖。 */
  hours: Record<string, number>[];
}

export const HISTOGRAM_DAYS = 14;

export function getXPostHistogram(
  db: DB,
  nowSec: number,
  days = HISTOGRAM_DAYS,
): XPostHistogramDay[] {
  const todayIdx = Math.floor(nowSec / 86400);
  const fromSec = (todayIdx - (days - 1)) * 86400;
  // SQLite 整数除法即向下取整(created_at 恒为正),天/小时桶一步到位。
  const rows = db
    .prepare(
      `SELECT created_at / 86400 AS d,
              (created_at % 86400) / 3600 AS h,
              kind,
              COUNT(*) AS n
         FROM x_posts
        WHERE status = 'posted' AND created_at >= ? AND created_at < ?
        GROUP BY d, h, kind`,
    )
    .all(fromSec, (todayIdx + 1) * 86400) as {
    d: number;
    h: number;
    kind: string;
    n: number;
  }[];

  const byDay = new Map<number, XPostHistogramDay>();
  for (let idx = todayIdx; idx > todayIdx - days; idx--) {
    const dt = new Date(idx * 86400 * 1000);
    byDay.set(idx, {
      day: `${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`,
      total: 0,
      hours: Array.from({ length: 24 }, () => ({})),
    });
  }
  for (const r of rows) {
    const day = byDay.get(r.d);
    if (!day) continue; // from/to 已界定,防御性跳过
    day.hours[r.h][r.kind] = (day.hours[r.h][r.kind] ?? 0) + r.n;
    day.total += r.n;
  }
  // 新在前(与发帖历史列表同序)。
  return [...byDay.values()];
}
