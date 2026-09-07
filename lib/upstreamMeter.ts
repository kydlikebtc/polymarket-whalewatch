import type { DB } from "./db";

// 上游调用计量表 —— 全站最稀缺资源的第一块仪表盘。
//
// 为什么必须有:限流层(lib/apiGuard)保护的单位从一开始就是**上游请求**而
// 不是 HTTP 请求数,它的注释里写着「30 requests × 200 wallets is 6000 upstream
// calls」;市场深度卡的设计确立了「预算从属引擎健康度」;每一次「这条要不要
// 带闸上线」的裁决都引用同一个数字 ——「一次钱包画像 ≈42 次上游调用」。
// 那个 42 从 2026-07 起一直是**估算**:fetchWithRetry 有 label 参数(为了让
// 重试日志可归因)却从不计数,于是没有任何地方能回答「我们现在每分钟打多少
// 次上游、其中多少被 429」。预算决策全靠推断,而推断在这个项目里已经被
// edge 审计打脸过一次。
//
// 三条设计纪律:
//
//  1. **记录侧零 I/O**。fetchWithRetry 在热路径上,每次尝试只做一次 Map 累加;
//     落盘由引擎循环节流调用 flush 完成。记录函数永不抛 —— 计量出问题绝不
//     允许影响它在计量的那次请求。
//  2. **内存有界**。标签全部来自源码字面量(无用户输入流入),基数天然有限;
//     仍设上限并在触顶时丢弃 + 告警一次,与限流器 MAX_BUCKETS「宁可拒绝新键
//     也不随攻击增长」同一条纪律。
//  3. **累加式 upsert**。落盘走 ON CONFLICT DO UPDATE 加法,所以同一分钟桶
//     被 flush 多次、被两个进程同时写,读数都是对的(嵌入式部署里 Next 与
//     引擎同进程,独立 worker 部署则各写各的桶)。
//
// 已知边界(如实写在这里,别在 /manage 上假装全局):**只有引擎进程会 flush**。
// `npm run worker` 独立部署时,看板那个 Next 进程的上游调用不进这张表 ——
// 它没有循环去调 flush。嵌入式(docker 默认)部署两者同进程,读数即全量。

/** 分钟桶。比这更细没有决策价值,更粗看不出突发。 */
export const BUCKET_SEC = 60;
/** 保留期。再长应该做日汇总,而不是留更多分钟行(存储纪律见第三轮成本表)。 */
export const RETENTION_SEC = 24 * 3600;
/** 内存里最多同时挂多少 (桶,标签) 组合。正常部署远够不到。 */
export const MAX_PENDING = 2000;
/** 标签长度上限 —— 截断而不是拒绝,计量不该因为一个长名字丢数据。 */
export const MAX_LABEL_LEN = 40;

export interface UpstreamCounters {
  calls: number;
  transient: number;
  rateLimited: number;
  errors: number;
  ms: number;
}

interface PendingRow extends UpstreamCounters {
  bucket: number;
  label: string;
}

const pending = new Map<string, PendingRow>();
let overflowWarned = false;

const bucketOf = (nowSec: number): number =>
  Math.floor(nowSec / BUCKET_SEC) * BUCKET_SEC;

/**
 * 记一次上游**尝试**(不是一次逻辑请求)—— 重试三次就是三次尝试,因为
 * 消耗上游预算的正是尝试次数。
 *
 * `status` 为 null 表示抛出(超时/网络错误),它与「拿到 5xx」是两种不同的
 * 失败:前者可能根本没到对端,后者一定消耗了对端配额。
 */
export function recordUpstreamCall(s: {
  label: string;
  ms: number;
  status: number | null;
  transient: boolean;
  nowSec?: number;
}): void {
  try {
    const nowSec = s.nowSec ?? Math.floor(Date.now() / 1000);
    const bucket = bucketOf(nowSec);
    const label = (s.label || "unlabeled").slice(0, MAX_LABEL_LEN);
    const key = `${bucket}|${label}`;
    let row = pending.get(key);
    if (!row) {
      if (pending.size >= MAX_PENDING) {
        if (!overflowWarned) {
          overflowWarned = true;
          console.warn(
            `[upstreamMeter] pending map hit ${MAX_PENDING} entries — dropping new buckets until the next flush (是不是没有循环在调 flush?)`,
          );
        }
        return;
      }
      row = {
        bucket,
        label,
        calls: 0,
        transient: 0,
        rateLimited: 0,
        errors: 0,
        ms: 0,
      };
      pending.set(key, row);
    }
    row.calls++;
    row.ms += Math.max(0, Math.round(s.ms));
    if (s.status == null) row.errors++;
    if (s.status === 429) row.rateLimited++;
    if (s.transient) row.transient++;
  } catch {
    // 计量永不影响被计量的请求。这里连日志都不打 —— 热路径上的日志本身
    // 就是新的失败面。
  }
}

/** 测试与进程收尾用:清空内存累加器(不落盘)。 */
export function resetUpstreamMeter(): void {
  pending.clear();
  overflowWarned = false;
}

/** 当前挂在内存里、尚未落盘的行数 —— 供测试与诊断。 */
export function pendingUpstreamRows(): number {
  return pending.size;
}

const PRUNE_KEY = "upstream_meter_last_prune";

/**
 * 把内存累加器落盘并清空。写入是**加法**,所以重复 flush 同一分钟桶安全。
 *
 * 返回写入的行数。任何异常都被吞掉并返回 0:一张计量表不值得让调用它的
 * 引擎循环中断(那会连带丢掉这一轮的心跳)。
 */
export function flushUpstreamMeter(
  db: DB,
  nowSec: number = Math.floor(Date.now() / 1000),
): number {
  if (pending.size === 0) return 0;
  const rows = [...pending.values()];
  pending.clear();
  overflowWarned = false;
  try {
    const ins = db.prepare(
      `INSERT INTO upstream_calls (bucket, label, calls, transient, rate_limited, errors, ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bucket, label) DO UPDATE SET
         calls        = calls + excluded.calls,
         transient    = transient + excluded.transient,
         rate_limited = rate_limited + excluded.rate_limited,
         errors       = errors + excluded.errors,
         ms           = ms + excluded.ms`,
    );
    const writeAll = db.transaction((list: PendingRow[]) => {
      for (const r of list) {
        ins.run(
          r.bucket,
          r.label,
          r.calls,
          r.transient,
          r.rateLimited,
          r.errors,
          r.ms,
        );
      }
    });
    writeAll(rows);
    maybePrune(db, nowSec);
    return rows.length;
  } catch (e) {
    // 落盘失败:这一批读数丢了(已从内存清出,不重排队 —— 重排队会让一个
    // 持续写失败的库把内存累到上限)。
    console.error("[upstreamMeter] flush failed", e);
    return 0;
  }
}

/** 每小时至多一次的保留期清理。 */
function maybePrune(db: DB, nowSec: number): void {
  const last = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(PRUNE_KEY) as { value: string | null } | undefined;
  const lastSec = Number(last?.value);
  if (Number.isFinite(lastSec) && nowSec - lastSec < 3600) return;
  db.prepare("DELETE FROM upstream_calls WHERE bucket < ?").run(
    nowSec - RETENTION_SEC,
  );
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    PRUNE_KEY,
    String(nowSec),
  );
}

let lastFlushAt = 0;
/** 引擎热循环的入口:节流到最多每 `minGapSec` 秒落一次盘。 */
export function maybeFlushUpstreamMeter(
  db: DB,
  nowSec: number = Math.floor(Date.now() / 1000),
  minGapSec = 30,
): number {
  if (nowSec - lastFlushAt < minGapSec) return 0;
  lastFlushAt = nowSec;
  return flushUpstreamMeter(db, nowSec);
}

/** 测试用:重置节流时钟。 */
export function resetUpstreamFlushClock(): void {
  lastFlushAt = 0;
}

export interface UpstreamLabelStat extends UpstreamCounters {
  label: string;
}

export interface UpstreamStats {
  /** 近端窗口(分钟)—— 速率读数的口径。 */
  windowMin: number;
  /** 窗口内合计。 */
  window: UpstreamCounters;
  /** 窗口内每分钟调用数(窗口长度为分母,不是「有数据的分钟数」)。 */
  callsPerMin: number;
  /** 近 24h 合计 —— 预算类决策看这个。 */
  day: UpstreamCounters;
  /** 窗口内按调用数降序的标签(最多 TOP_LABELS 个)。 */
  topLabels: UpstreamLabelStat[];
  /** 表里最新一行的桶时刻;null = 一行都没有(引擎没跑过 / 刚清过)。 */
  latestBucket: number | null;
}

const TOP_LABELS = 5;
const EMPTY: UpstreamCounters = {
  calls: 0,
  transient: 0,
  rateLimited: 0,
  errors: 0,
  ms: 0,
};

function sumSince(db: DB, sinceSec: number): UpstreamCounters {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(calls),0) AS calls,
              COALESCE(SUM(transient),0) AS transient,
              COALESCE(SUM(rate_limited),0) AS rate_limited,
              COALESCE(SUM(errors),0) AS errors,
              COALESCE(SUM(ms),0) AS ms
         FROM upstream_calls WHERE bucket >= ?`,
    )
    .get(sinceSec) as {
    calls: number;
    transient: number;
    rate_limited: number;
    errors: number;
    ms: number;
  };
  return {
    calls: r.calls,
    transient: r.transient,
    rateLimited: r.rate_limited,
    errors: r.errors,
    ms: r.ms,
  };
}

/**
 * /manage 健康度用的读数。零上游、纯本地表。
 *
 * 注意 `callsPerMin` 的分母刻意是**整个窗口**而不是「有行的分钟数」:
 * 后者会在引擎停摆时把速率算得跟正常时一样(只剩几个繁忙分钟),而这块表
 * 的第一用途正是发现「上游调用异常地多/异常地少」。
 */
export function readUpstreamStats(
  db: DB,
  opts: { nowSec?: number; windowMin?: number } = {},
): UpstreamStats {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const windowMin = Math.max(1, Math.round(opts.windowMin ?? 60));
  const since = bucketOf(nowSec) - (windowMin - 1) * BUCKET_SEC;
  const window = sumSince(db, since);
  const day = sumSince(db, nowSec - RETENTION_SEC);
  const topLabels = (
    db
      .prepare(
        `SELECT label,
                SUM(calls) AS calls, SUM(transient) AS transient,
                SUM(rate_limited) AS rate_limited, SUM(errors) AS errors,
                SUM(ms) AS ms
           FROM upstream_calls WHERE bucket >= ?
          GROUP BY label ORDER BY calls DESC, label ASC LIMIT ${TOP_LABELS}`,
      )
      .all(since) as {
      label: string;
      calls: number;
      transient: number;
      rate_limited: number;
      errors: number;
      ms: number;
    }[]
  ).map((r) => ({
    label: r.label,
    calls: r.calls,
    transient: r.transient,
    rateLimited: r.rate_limited,
    errors: r.errors,
    ms: r.ms,
  }));
  const latest = db
    .prepare("SELECT MAX(bucket) AS b FROM upstream_calls")
    .get() as { b: number | null };
  return {
    windowMin,
    window: window.calls > 0 ? window : { ...EMPTY },
    callsPerMin: window.calls / windowMin,
    day,
    topLabels,
    latestBucket: latest.b ?? null,
  };
}
