import type { Trade } from "./types";
import { dedupKey } from "./trades";
import type { DeepWindowResult, TradesSinceResult } from "./polymarket";

// 增量窗口维护(2026-09-08,设计见 docs/plans/2026-09-08-incremental-window-
// design.md):把「抓取窗口」与「分析窗口」解耦。
//
// 动机:共识循环此前每轮全量重拉 6h 窗口(实测 ~1030 行,98.6% 与上轮重复),
// 这个成本结构把节奏钉死在 5 分钟,直接构成 formation→emitted 中位 ~329s 的
// 信号延迟主项。本模块维护一个常驻 6h 缓冲,每轮只抓水位线之后的增量
// (getTradesSince),抓取量与窗口长度、市场密度双解耦 —— 节奏得以提到 90s。
//
// 分析窗口保持 6h **不可动**:共识的腿跨小时累积(lib/consensus.ts
// ConsensusGroup.formationTs 的语义依赖窗口完整覆盖各腿),缩分析窗口 =
// 改信号定义,不是优化。
//
// 唯一的硬不变量:**净买账完整性**。检测按窗口内 BUY−SELL 净敞口算
// (lib/consensus.ts exposureUsd),缓冲里漏一笔 SELL 会虚增钱包净买,可能
// 凭空造出共识与错误 formationTs —— 且是静默失败。所有设计都为这条服务:
//   - 增量抓取只信 connected=true(边界可见,无缺口);不衔接的前缀整体
//     丢弃,绝不合并;
//   - 任何完整性疑点 → 当轮退回全量重扫(getTradesWindowDeep,启动种子走
//     同一条路);重扫也失败则供给「陈旧但完整」的既有缓冲;
//   - 陈旧超限(staleLimitSec)仍拿不到数据 → tick 抛错,让 engine 的
//     catch 跳过本轮 beat —— 对齐「安静和死了不长得一样」纪律,上游死掉
//     不能被一个永远"成功"返回旧缓冲的 keeper 掩盖;
//   - 行数上限封顶内存最坏情况(全量扫有 offset 3000 的天然顶,缓冲没有,
//     不能把上限交给行情);超限淘汰最旧并如实上移 effectiveSinceSec ——
//     与全量扫截断时「完整但更短的窗口」同一套对外语义;
//   - 每小时定时全量重扫:上游迟到入索引的成交会落在增量扫停步的水位线
//     之下而被错过,定时重扫是有界自愈 —— 把旧设计「每 5 分钟全量自愈」
//     的属性以每小时的形式保留。
//
// 返回形状与 getTradesWindowDeep 逐字段一致,四个窗口消费者(共识告警/
// firehose/跟单/cohort)零感知。getMode() 返回 "full" 时每轮全量重扫 ——
// config 表运行时回滚开关,不必重启。

/**
 * 安全边距:增量抓取回退到水位线之前这么多秒,重叠部分由 dedupKey 吸收。
 * 600s(评审修正,2026-09-09,原 180s):这条边距防的是两件事 ——
 * ① 上游迟到入索引的成交(迟到超边距的 SELL 要等定时重扫才补上,期间净买
 *   账不完整且静默,600s 把这个窗口压到「迟到 >10 分钟才踩」);
 * ② feed 偶发乱序(同域 /activity 有排序失效被 CDN 缓存的前科)造成的单轮
 *   提前止页 —— 边距让下一轮重新覆盖被跳过的段,单次乱序自愈。
 * 成本几乎为零:常态重叠 ~36 行、热点日 ~180 行,仍在 1–2 页之内。
 */
export const WINDOW_MARGIN_SEC = 600;
/** 缓冲行数上限(≈40 MB 最坏);常态实测 ~1k 行。 */
export const MAX_BUFFER_ROWS = 30_000;
/** 定时全量重扫间隔(迟到数据的有界自愈)。 */
export const RESWEEP_INTERVAL_SEC = 3600;
/**
 * 陈旧限度:超过这么久拿不到任何新数据,缓冲不再当作可用窗口。取旧设计的
 * 5 分钟节奏 —— 旧世界里数据本来就可能这么旧,这是已被接受过的陈旧度。
 */
export const STALE_LIMIT_SEC = 300;

export interface WindowKeeperDeps {
  /** 全量重扫(种子/自愈/回滚模式共用),即 getTradesWindowDeep 的绑定。 */
  fullSweep: (sinceSec: number) => Promise<DeepWindowResult>;
  /** 增量抓取,即 getTradesSince 的绑定。 */
  fetchSince: (sinceSec: number) => Promise<TradesSinceResult>;
  /** 分析窗口长度(秒)。生产 = CONSENSUS_WINDOW_SEC。 */
  windowSec: number;
  marginSec?: number;
  maxBufferRows?: number;
  resweepIntervalSec?: number;
  staleLimitSec?: number;
  /** "full" = 每轮全量重扫(运行时回滚开关);缺省/异常 = "incremental"。 */
  getMode?: () => "incremental" | "full";
  /** 测试注入时钟。 */
  nowSec?: () => number;
}

export interface WindowKeeper {
  /**
   * 产出本轮窗口。永不静默造假:能给的要么是新鲜完整窗口,要么是陈旧限度
   * 内的「陈旧但完整」窗口(照常返回,truncated 不因此置位 —— 陈旧≠残缺);
   * 陈旧超限且本轮也拿不到数据时抛错,调用方按既有 catch 语义跳过本轮。
   */
  tick(): Promise<DeepWindowResult>;
  /** 观测:当前缓冲行数(运营日志/测试用)。 */
  size(): number;
}

export function createWindowKeeper(deps: WindowKeeperDeps): WindowKeeper {
  const {
    fullSweep,
    fetchSince,
    windowSec,
    marginSec = WINDOW_MARGIN_SEC,
    maxBufferRows = MAX_BUFFER_ROWS,
    resweepIntervalSec = RESWEEP_INTERVAL_SEC,
    staleLimitSec = STALE_LIMIT_SEC,
    getMode,
    nowSec = () => Math.floor(Date.now() / 1000),
  } = deps;

  const buffer = new Map<string, Trade>();
  let seeded = false;
  let needResweep = false;
  /** 完整覆盖的诚实起点(≙ getTradesWindowDeep 的 effectiveSinceSec)。 */
  let coverageStartSec = 0;
  /** 缓冲中最新一行的 ts;增量抓取的停步基准。 */
  let watermarkTs = 0;
  let lastGoodFetchSec = 0;
  let lastResweepSec = 0;

  async function resweep(now: number, sinceReq: number): Promise<void> {
    const r = await fullSweep(sinceReq);
    buffer.clear();
    for (const t of r.trades) buffer.set(dedupKey(t), t);
    coverageStartSec = r.effectiveSinceSec;
    // 空窗口(安静市场)也要有水位线:此刻 feed 上没有更新的行,now 即水位。
    watermarkTs = r.trades.length > 0 ? r.trades[0].timestamp : now;
    lastGoodFetchSec = now;
    lastResweepSec = now;
    needResweep = false;
    seeded = true;
    console.log(
      `[windowKeeper] full resweep: ${buffer.size} rows · coverage from ${coverageStartSec}` +
        ` (requested ${sinceReq}) · truncated=${r.truncated}`,
    );
  }

  function merge(rows: Trade[], sinceReq: number): void {
    for (const t of rows) {
      if (t.timestamp < sinceReq) continue; // 已在淘汰区,不进账
      const k = dedupKey(t);
      if (!buffer.has(k)) buffer.set(k, t);
      if (t.timestamp > watermarkTs) watermarkTs = t.timestamp;
    }
  }

  /** 时间淘汰:滚出 6h 的行出账;覆盖起点随窗口下界推进(种子截断随之愈合)。 */
  function evict(sinceReq: number): void {
    if (coverageStartSec < sinceReq) coverageStartSec = sinceReq;
    for (const [k, t] of buffer) {
      if (t.timestamp < sinceReq) buffer.delete(k);
    }
  }

  /**
   * 行数上限。同秒的行要么全留要么全走 —— 留一半会让边界秒的净买账残缺,
   * 恰好违反本模块的核心不变量;故按「最新被淘汰行的 ts」整秒切,覆盖起点
   * 上移到 cutTs+1。
   */
  function enforceCap(): void {
    if (buffer.size <= maxBufferRows) return;
    const rows = [...buffer.values()].sort((a, b) => a.timestamp - b.timestamp);
    const cutTs = rows[buffer.size - maxBufferRows - 1].timestamp;
    let evicted = 0;
    for (const [k, t] of buffer) {
      if (t.timestamp <= cutTs) {
        buffer.delete(k);
        evicted++;
      }
    }
    coverageStartSec = Math.max(coverageStartSec, cutTs + 1);
    console.warn(
      `[windowKeeper] buffer cap ${maxBufferRows} hit — evicted ${evicted} oldest row(s), coverage now from ${coverageStartSec}`,
    );
  }

  async function tick(): Promise<DeepWindowResult> {
    const now = nowSec();
    const sinceReq = now - windowSec;
    let mode: "incremental" | "full" = "incremental";
    try {
      mode = getMode?.() ?? "incremental";
    } catch {
      // 开关读取失败不改变行为:默认增量。
    }

    let fetchOk = false;
    let lastErr: unknown = null;

    const resweepDue =
      !seeded ||
      needResweep ||
      mode === "full" ||
      now - lastResweepSec >= resweepIntervalSec;

    if (resweepDue) {
      try {
        await resweep(now, sinceReq);
        fetchOk = true;
      } catch (e) {
        lastErr = e;
        needResweep = true;
        console.warn(
          "[windowKeeper] full resweep failed (serving buffered window if any; retry next tick):",
          e,
        );
      }
    } else {
      // 边界钳到覆盖起点之内:种子刚截断过时,水位线−边距可能落在覆盖区
      // 之外,往外抓回来的行接不进完整账。
      const boundary = Math.max(watermarkTs - marginSec, coverageStartSec, sinceReq);
      try {
        const r = await fetchSince(boundary);
        if (r.connected) {
          merge(r.trades, sinceReq);
          fetchOk = true;
          lastGoodFetchSec = now;
        } else {
          // 不衔接 = 前缀底下可能有洞,整体丢弃,当轮退回全量重扫。
          console.warn(
            `[windowKeeper] incremental fetch disconnected (boundary=${boundary}, ${r.trades.length} row(s) discarded) — falling back to full resweep`,
          );
          try {
            await resweep(now, sinceReq);
            fetchOk = true;
          } catch (e) {
            lastErr = e;
            needResweep = true;
          }
        }
      } catch (e) {
        // 瞬态失败:不动缓冲,下轮重试。陈旧账单在下方统一结。
        lastErr = e;
        console.warn(
          "[windowKeeper] incremental fetch failed (serving buffered window; retry next tick):",
          e,
        );
      }
    }

    evict(sinceReq);
    enforceCap();

    const stale = now - lastGoodFetchSec > staleLimitSec;
    if (!fetchOk && (!seeded || stale)) {
      // 没种子,或陈旧超限还拿不到数据:不再假装有窗口。抛给调用方,让
      // engine 的 catch 跳过本轮 beat,健康监控才看得见停跳。
      throw lastErr instanceof Error
        ? lastErr
        : new Error(String(lastErr ?? "windowKeeper: no usable window"));
    }

    const trades = [...buffer.values()].sort(
      (a, b) => b.timestamp - a.timestamp,
    );
    return {
      trades,
      // 陈旧限度内的旧缓冲不算 truncated:它是完整的,只是旧 —— 旧设计里
      // 数据本来就可能有一整轮的岁数,消费方对此已有语义。
      truncated: coverageStartSec > sinceReq,
      effectiveSinceSec: coverageStartSec,
    };
  }

  return { tick, size: () => buffer.size };
}
