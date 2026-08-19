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
  | "settled";

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
    hint: "结算前 1-6 小时的高热市场汇总,蹭事件峰值流量。每日至多 3 条",
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
