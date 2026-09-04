"use client";

import { useEffect, useRef, useState } from "react";
import {
  Field,
  Icon,
  Segmented,
  SideTag,
  SoundToggle,
  StatCard,
  WalletLink,
} from "../ui";
import { iconTip, termDetail, firstSentence } from "../glossary";
import { useLang } from "../i18n";
import { playBubble } from "../sound";
import { useSoundToggle } from "../useSound";
import {
  OUTCOMES_MIN_INTERVAL_MS,
  alertsSnapshot,
  shouldFetchOutcomes,
} from "../alertsPolling";
import {
  directionVerdict,
  summarizeOutcomes,
  clusteredInterval,
  type OutcomeStat,
} from "../../lib/outcomeStats";

type AlertView = {
  id: number;
  type: string;
  title: string;
  outcome: string;
  side: string;
  usd: number;
  price: number;
  wallet: string;
  eventSlug: string;
  txHash: string;
  createdAt: number;
  // Set only on consensus rows — summarizeOutcomes folds a group's escalation
  // re-alerts into one so the 验证 strip counts a consensus once. Declared
  // here (not just server-side) so a refactor can't silently drop it and
  // quietly restore the double-count.
  foldKey: string | null;
  // Market id — the validation strip's effective sample size. Alerts sharing a
  // market share its one settlement, so the Wilson interval divides by markets
  // rather than rows (lib/outcomeStats.clusteredInterval). Declared here for
  // the same reason as foldKey: a refactor must not silently drop it and
  // quietly restore the over-confident interval.
  clusterKey: string | null;
};

// Push-channel health from /api/alerts (engine-written counters in the config
// table). null/absent = unknown (cold db / pre-upgrade API), NOT healthy.
type TelegramHealthView = {
  consecutiveSendFailures: number;
  lastErrorMessage: string | null;
  lastErrorAt: number | null;
  lastOkAt: number | null;
  failing: boolean;
};

type AlertsResponse = {
  count: number;
  alerts: AlertView[];
  // smartOnly feedback (see /api/alerts): whitelist pool size and the last-24h
  // 🏆 alert count. null/absent = unknown (missing table / pre-upgrade API).
  smartWalletCount?: number | null;
  smartAlerts24h?: number | null;
  telegramHealth?: TelegramHealthView | null;
};

// Pool-status props the ConditionsPanel shows beside the smartOnly checkbox.
type SmartPoolMeta = {
  smartWalletCount: number | null;
  smartAlerts24h: number | null;
};

// On-demand validation data per alert (computed lazily from public history).
type AlertOutcome = {
  price10m?: number | null;
  price1h: number | null;
  price24h: number | null;
  resolved: boolean;
  resolutionPrice: number | null;
  won: boolean | null;
};

const TYPE_ICON: Record<string, string> = {
  large: "💰",
  smart: "🏆",
  consensus: "🔥",
  cohort: "🐣",
};

// 信号类型的中文名 —— emoji 不裸放在正文里，收进行内灰底名称标签
// （`💰 大额成交`）。名称沿用五级信号强度阶梯的措辞，与词表一致，
// 译文由既有分片供给（大额成交/巨鲸单/聪明钱共识在 glossary·market 片）。
const TYPE_NAME: Record<string, string> = {
  large: "大额成交",
  smart: "聪明钱",
  consensus: "聪明钱共识",
  cohort: "同批新钱包",
};

// Per-type labels for the validation strip's grouped breakdown.
const TYPE_LABEL: Record<string, string> = {
  large: "💰大单",
  smart: "🏆聪明钱",
  consensus: "🔥共识",
  cohort: "🐣同批新钱包",
};

type Side = "ALL" | "BUY" | "SELL";

type AlertConditions = {
  enabled: boolean;
  minUsd: number;
  side: Side;
  minPrice: number | null;
  maxPrice: number | null;
  maxAgeDays: number | null;
  smartOnly: boolean;
  maxHoursToEnd: number | null;
  cooldownMinutes: number;
};

// Mirrors lib/alertConditions DEFAULT_CONDITIONS (pre-hydration placeholder).
const DEFAULT_CONDITIONS: AlertConditions = {
  enabled: true,
  minUsd: 10000,
  side: "ALL",
  minPrice: null,
  maxPrice: 0.95,
  maxAgeDays: null,
  smartOnly: false,
  maxHoursToEnd: null,
  cooldownMinutes: 30,
};

function fmtUsd(usd: number): string {
  return usd.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function shortWallet(w: string): string {
  if (!w) return "";
  return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

// 完整时间戳（年月日 + 时分秒）—— 推送通道的成功 / 失败时刻要能跨天核对，
// 也是流里两个简写时间的 title 兜底。
function fmtTime(sec: number): string {
  if (!sec) return "";
  return new Date(sec * 1000).toLocaleString("zh-CN", { hour12: false });
}

// 时钟式 `12:05:20` —— KPI「最近命中」说的是「刚刚」，日期收进 title。
function fmtClock(sec: number): string {
  if (!sec) return "";
  return new Date(sec * 1000).toLocaleTimeString("zh-CN", { hour12: false });
}

// 流里的时间列 `09-04 12:05:20` —— 设计系统的日期时间写法（不带年份）。
// 命中稀疏时列表会跨天，只留时分秒会让昨天的命中看着像刚发生。
function fmtStamp(sec: number): string {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

// Direction-aware follow-through badge: for a BUY, price moving UP after the
// signal is confirmation (green); for a SELL, DOWN is confirmation. `entry` is
// the alert's fill price, `later` the market price at the mark. Moves inside
// the shared ε deadband are muted — the SAME deadband the summary strip uses,
// so a badge never looks like a hit that the stats refuse to count.
function FollowBadge({
  label,
  entry,
  later,
  side,
}: {
  label: string;
  entry: number;
  later: number | null;
  side: string;
}) {
  if (later == null) return null;
  const cents = (later - entry) * 100;
  const v = directionVerdict(side, entry, later);
  // ±0.5¢ 死区内记平推 —— 用 --ww-text-faint（.faint），不是灰正文：
  // 「没走动」与「次要信息」是两件事。涨绿跌红只留给真正的价格方向。
  const cls = v === "push" ? "faint" : v === "hit" ? "up" : "down";
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
        {label}
      </span>{" "}
      <span className={cls}>
        {cents >= 0 ? "+" : ""}
        {cents.toFixed(1)}¢
      </span>
    </span>
  );
}

// One stat of the validation strip: overall hits/total, a Wilson 95% interval
// when the sample can support one (n ≥ 10; a lone 2/3 = "67%" is really
// ~21%–94%), and the per-type breakdown so 💰 large and 🏆 smart never hide
// behind a mixed-pool average.
//
// The interval is computed on the MARKET count, not the alert count: alerts on
// one market share its single settlement, so rows over-count independence. The
// small-sample gate follows the same measure — 40 alerts spread over 3 markets
// is a 3-sample estimate and must say so rather than flash a tight range.
function StatLine({ label, stat }: { label: string; stat: OutcomeStat }) {
  const { t } = useLang();
  if (stat.total === 0) return null;
  const pct = Math.round((stat.hits / stat.total) * 100);
  const small = stat.clusters < 10;
  const { lo, hi } = clusteredInterval(stat.hits, stat.total, stat.clusters);
  // Only worth showing when it differs from the row count — otherwise it is
  // noise on a strip that is already dense.
  const clustered = stat.clusters > 0 && stat.clusters < stat.total;
  const parts = Object.entries(stat.byType).map(
    ([type, v]) => `${t(TYPE_LABEL[type] ?? type)} ${v.hits}/${v.total}`,
  );
  // 层级来自 12px 小标 + 徽章，不来自字号跳档或加粗：命中数与正文同字号
  // 常规字重（数字不加粗、不放大），「样本不足」改成琥珀描边徽章 —— 它是
  // 「需留神的口径」，比把整行调暗更明确。徽章走 20px/11px 的 ds-tag--sm
  // （全站「样本不足」的统一档，见 follow / DeepAnalysis）：字阶里没有
  // 10px，最小是徽章内 11px。
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "var(--s-1)",
      }}
    >
      <span
        className="muted"
        style={{ fontSize: "var(--t-sm)", letterSpacing: "0.02em" }}
      >
        {label}
      </span>
      <span>
        {stat.hits}/{stat.total} ({pct}%)
      </span>
      {small ? (
        <span className="ds-tag ds-tag--warn ds-tag--sm">{t("样本不足")}</span>
      ) : (
        <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
          {t("95%区间 {lo}–{hi}%", {
            lo: Math.round(lo * 100),
            hi: Math.round(hi * 100),
          })}
        </span>
      )}
      {clustered ? (
        <span
          className="muted"
          style={{ fontSize: "var(--t-sm)" }}
          title={firstSentence(t(termDetail("有效样本量（市场聚类）")))}
        >
          · {t("{n} 个市场", { n: stat.clusters })}
        </span>
      ) : null}
      {parts.length > 1 ? (
        <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
          · {parts.join(" · ")}
        </span>
      ) : null}
    </span>
  );
}

// 表头的 (?) 提示图标 —— 这套皮的标志性细节（设计系统 §6）：每一个有口径
// 的列头后面跟一个 13px 的淡色问号圈，口径写在它的 title 里。这里用 <Icon>
// 包住而不是画一个 aria-hidden 的死圈：触屏没有 hover，只挂 title 等于把
// 口径对触屏隐藏，而 Icon 自带 tip-pop（tap 弹出同一段文字）。
function HeadTip({ tip }: { tip: string }) {
  return (
    <span
      style={{
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 13,
        height: 13,
        marginLeft: "var(--s-1)",
        verticalAlign: "middle",
        borderRadius: "var(--r-pill)",
        border: "1px solid var(--ww-text-faint)",
        color: "var(--ww-text-faint)",
        fontSize: 9,
        fontWeight: 400,
        lineHeight: 1,
      }}
    >
      <Icon s="?" title={tip} />
    </span>
  );
}

// Parse a number input into number|null (blank/NaN → null).
function numOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export default function Page() {
  const { t } = useLang();
  const [data, setData] = useState<AlertsResponse>({ count: 0, alerts: [] });
  const [lastRefreshed, setLastRefreshed] = useState<string>("");
  const [error, setError] = useState<string>("");
  // alertId -> validation outcome, filled lazily after the list renders.
  const [outcomes, setOutcomes] = useState<Record<number, AlertOutcome>>({});

  // Last-applied payload fingerprint (alerts + smart-pool counters): an
  // unchanged poll skips setData so `data` keeps its identity and the
  // [data]-effects below don't re-run every 5s over the same list.
  const lastSnapshot = useRef<string>("");

  useEffect(() => {
    let active = true;

    async function load() {
      // Background tabs sleep — no fetch, no re-render. The visibilitychange
      // listener below fires a catch-up load the moment we're foregrounded.
      if (document.hidden) return;
      try {
        const res = await fetch("/api/alerts", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as AlertsResponse;
        if (!active) return;
        setLastRefreshed(
          new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        );
        setError("");
        const snap =
          alertsSnapshot(json.alerts) +
          `|${json.smartWalletCount ?? "?"}|${json.smartAlerts24h ?? "?"}` +
          `|tg${json.telegramHealth?.consecutiveSendFailures ?? "?"}`;
        if (snap === lastSnapshot.current) return;
        lastSnapshot.current = snap;
        setData(json);
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    }

    load();
    const id = setInterval(load, 5000);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Lazily fetch validation outcomes for alerts we haven't resolved yet.
  // Unresolved alerts are re-queried (their settlement state can change);
  // resolved ones are final and skipped. Throttled: the 1h/24h marks move on
  // an hourly scale, so POSTs fire only for never-queried ids (fresh alerts)
  // or after OUTCOMES_MIN_INTERVAL_MS — the minute tick below re-arms the
  // effect between new-alert arrivals. The in-flight guard stops overlapping
  // POSTs while a cold batch (up to 200 upstream price lookups) is computing —
  // and a completed response is ALWAYS merged (idempotent by id), never
  // discarded by an effect re-run.
  const outcomesInFlight = useRef(false);
  const lastOutcomesAt = useRef(0);
  // Ids POSTed at least once — a new id bypasses the 60s throttle.
  const outcomesKnownIds = useRef<Set<number>>(new Set());
  const [outcomesTick, setOutcomesTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) setOutcomesTick((t) => t + 1);
    }, OUTCOMES_MIN_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    // Consensus alerts are tracked too (synthetic BUY at the group's
    // avgBuyPrice); pre-upgrade consensus payloads missing token fields are
    // skipped server-side — a cheap parse-and-drop, never an upstream call.
    const want = data.alerts
      .map((a) => a.id)
      .filter((id) => !(id in outcomes) || !outcomes[id].resolved);
    if (outcomesInFlight.current) return;
    if (
      !shouldFetchOutcomes({
        wantIds: want,
        knownIds: outcomesKnownIds.current,
        lastFetchAt: lastOutcomesAt.current,
        nowMs: Date.now(),
      })
    ) {
      return;
    }
    outcomesInFlight.current = true;
    lastOutcomesAt.current = Date.now();
    for (const id of want) outcomesKnownIds.current.add(id);
    (async () => {
      try {
        const res = await fetch("/api/alert-outcomes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: want.slice(0, 100) }),
        });
        const json = (await res.json()) as {
          outcomes?: Record<number, AlertOutcome>;
        };
        if (json.outcomes) {
          setOutcomes((prev) => ({ ...prev, ...json.outcomes }));
        }
      } catch {
        // Best-effort; retried on the next tick / data change.
      } finally {
        outcomesInFlight.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- outcomes is
    // intentionally omitted: including it would re-trigger on our own merge.
  }, [data, outcomesTick]);

  // Aggregate validation stats over whatever has been computed so far —
  // 1h + 24h direction hits and the settled win-rate, grouped by type, with
  // ε-deadband pushes excluded from both sides (see lib/outcomeStats).
  const summary = summarizeOutcomes(data.alerts, outcomes);
  const hasStats =
    summary.dir10m.total > 0 ||
    summary.dir1h.total > 0 ||
    summary.dir24h.total > 0 ||
    summary.settled.total > 0;

  // --- New-alert sound notification -------------------------------------
  // Toggle state + persistence + chime-on-enable live in useSoundToggle; this
  // page owns only the "what counts as a new record" detection below.
  const { soundOn, toggle } = useSoundToggle();
  const seenKeys = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  // Detect newly-arrived alerts across polls and chime once per batch. The first
  // load seeds the baseline silently so existing history doesn't blast on open.
  useEffect(() => {
    const keys = data.alerts.map(
      (a) => a.txHash || `${a.wallet}-${a.createdAt}`,
    );
    if (!primed.current) {
      seenKeys.current = new Set(keys);
      primed.current = true;
      return;
    }
    let hasNew = false;
    for (const k of keys) {
      if (!seenKeys.current.has(k)) {
        seenKeys.current.add(k);
        hasNew = true;
      }
    }
    if (hasNew && soundOn) playBubble();
  }, [data, soundOn]);

  // 页头右侧动作钮之外的展示派生值（不改任何取数 / 状态 / 事件逻辑）：
  // 最新一条命中的时间 —— /api/alerts 已按 created_at DESC 返回，取首行。
  const latestAt = data.alerts[0]?.createdAt ?? 0;
  const tg = data.telegramHealth ?? null;
  // 「验证」列的口径 —— 表头 title（桌面悬停）与 (?) 圆点的 tip-pop（触屏
  // tap）同一份文案，两条路径不会漂移。这一列的完整定义都收在这里：三个
  // horizon、±0.5¢ 平推死区、「…」的补算节奏。页面正文只留「不读就会把
  // 数字读错」的那一句，方法论进 (?)。
  const verifyTip = t(
    "信号后 10m / 1h / 24h 的公开市价变化，按方向着色，±0.5¢ 内记平推；已结算的给命中 / 未中判定。「…」= 仍在补算，每分钟重试一批（一次最多 100 条）。",
  );
  // 时区声明（设计系统 §1：注明一次）—— 它只改变「时间」这一列怎么读，
  // 因此挂在该列的 (?) 上，不占页头正文。全站显示走浏览器本地时区。
  const timeTip = t("显示为浏览器本地时区");

  return (
    <main className="ds-main">
      {/* 页头区 —— 12px 小标（emoji 前缀）+ 24/600 标题 + 14px 说明，
          右侧动作钮。层级来自小标与底边线，不来自字号跳档。 */}
      <header className="page-head">
        <div>
          <div className="page-head__eyebrow">
            {t("📣 每 5 秒轮询 · 后台标签页暂停")}
          </div>
          <h1 className="page-head__title">{t("实时告警")}</h1>
          {/* 一句话：这页是什么。口径去处 —— 时区进「时间」列的 (?)，
              条件在哪配置进流尾的一行提示（那里正好是「下一步做什么」）。 */}
          <p className="page-head__desc">
            {t("命中告警条件的大额成交逐条出现在下方，最新一条在最上面。")}
          </p>
        </div>
        <div className="page-head__actions">
          <SoundToggle on={soundOn} onToggle={toggle} />
        </div>
      </header>

      {/* Push-channel health callout — "no messages" must be tellable apart
          from "no large trades". Gated on `failing` (streak ≥ threshold), so
          a single transient blip never flashes red. */}
      {data.telegramHealth?.failing ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-5)" }}
        >
          {t("⚠️ Telegram 推送通道异常：已连续")}{" "}
          {data.telegramHealth.consecutiveSendFailures} {t("次发送失败")}
          {data.telegramHealth.lastErrorAt
            ? t("（最近失败 {at}）", {
                at: fmtTime(data.telegramHealth.lastErrorAt),
              })
            : ""}
          {t(
            "。新告警仍正常入库，仅推送受影响 — 检查 bot token / 频道权限 / 限流。",
          )}
          {data.telegramHealth.lastErrorMessage ? (
            <div
              className="muted"
              style={{ fontSize: "var(--t-sm)", marginTop: "var(--s-1)" }}
            >
              {data.telegramHealth.lastErrorMessage}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 全页唯一一条琥珀口径条 —— 紧跟页头，放在数据「前面」，不做脚注。
          只留两句「不读就会把数字读错」的统计声明：这批数不是你的成交，
          区间按市场数算。10m/1h/24h 的定义与平推死区是方法论，进「验证」列
          的 (?)；降级态的读法在表下方那一条。 */}
      <div
        className="ds-callout ds-callout--warn"
        style={{ marginBottom: "var(--s-5)" }}
      >
        <div className="ds-label">
          <Icon s="📐" /> {t("口径 · 信号验证")}
        </div>
        <div style={{ marginTop: "var(--s-1)" }}>
          {t(
            "验证列是公开市价变化，不等于你的实际成交；95% 区间与「样本不足」按市场数计算，不按行数。",
          )}
        </div>
        {hasStats ? (
          <div
            style={{
              marginTop: "var(--s-2)",
              display: "flex",
              flexWrap: "wrap",
              gap: "var(--s-2) var(--s-5)",
              alignItems: "center",
            }}
          >
            <StatLine label={t("10m 方向命中")} stat={summary.dir10m} />
            <StatLine label={t("1h 方向命中")} stat={summary.dir1h} />
            <StatLine label={t("24h 方向命中")} stat={summary.dir24h} />
            <StatLine label={t("已结算胜率")} stat={summary.settled} />
          </div>
        ) : null}
      </div>

      {/* KPI 3 格 —— 一张白卡内 3 等分，格间 1px 竖线；值 18px 常规字重，
          与正文同字体（数字不用等宽、不加粗、不放大）。 */}
      <section className="kpi" style={{ marginBottom: "var(--s-4)" }}>
        <StatCard label={t("命中条数")} icon="💰">
          <div
            className="kpi-value"
            style={{ display: "flex", alignItems: "center", gap: "var(--s-2)" }}
          >
            {data.count.toLocaleString("en-US")}
            <span
              className="ds-dot"
              style={{ background: error ? "var(--ww-down)" : "var(--ww-up)" }}
            />
          </div>
          <div className="kpi-sub">
            {error ? (
              <span className="down">
                {t("刷新失败: {err}", { err: error })}
              </span>
            ) : (
              t("轮询中 · 每 5 秒（列表上限 100 条）")
            )}
          </div>
        </StatCard>

        <StatCard label={t("最近命中")} icon="⏱️">
          <div
            className="kpi-value"
            style={{
              color: latestAt ? "var(--ww-link)" : "var(--ww-text-faint)",
            }}
            title={latestAt ? fmtTime(latestAt) : undefined}
          >
            {latestAt ? fmtClock(latestAt) : "—"}
          </div>
          <div className="kpi-sub">
            {latestAt
              ? lastRefreshed
                ? t("最后刷新 {at}", { at: lastRefreshed })
                : t("等待首次刷新")
              : t("等待首条命中")}
          </div>
        </StatCard>

        <StatCard label={t("推送通道")} icon="📣">
          <div
            className="kpi-value"
            style={{
              color: tg
                ? tg.failing
                  ? "var(--ww-down)"
                  : "var(--ww-up)"
                : "var(--ww-text-faint)",
            }}
          >
            {tg
              ? tg.failing
                ? t("连续失败 {n} 次", { n: tg.consecutiveSendFailures })
                : t("推送正常")
              : "—"}
          </div>
          <div className="kpi-sub">
            {!tg
              ? t("接口未提供推送计数（旧版本或冷库）")
              : tg.failing
                ? t("仅推送受影响，新告警仍正常入库")
                : tg.lastOkAt
                  ? t("最近成功推送 {at}", { at: fmtTime(tg.lastOkAt) })
                  : t("暂无成功推送记录")}
          </div>
        </StatCard>
      </section>

      {/* 主卡 —— 卡内：标题条 → 表头 → 行 → 灰底等待态。
          等待态永远在场：没有命中时它就是空态（给内容也给出路），
          有命中时它是流的尾巴，绝不返回 null。 */}
      <section className="ds-card" style={{ overflow: "hidden" }}>
        <div className="card-bar">
          <span style={{ fontWeight: 600 }}>{t("命中流")}</span>
          {data.count > 0 ? (
            <span
              className="muted"
              style={{ marginLeft: "auto", fontSize: "var(--t-base)" }}
            >
              {t("最近 {n} 条 · 最新在上", { n: data.count })}
            </span>
          ) : null}
        </div>

        {data.count === 0 ? null : (
          <div
            className="ds-table-wrap"
            style={{ border: 0, borderRadius: 0, boxShadow: "none" }}
          >
            <table className="ds-table">
              <thead>
                <tr>
                  <th>{t("市场")}</th>
                  <th>{t("结果")}</th>
                  <th>{t("方向")}</th>
                  <th className="is-right">{t("金额")}</th>
                  <th className="is-right">{t("价格")}</th>
                  <th>{t("钱包")}</th>
                  <th title={verifyTip}>
                    {t("验证")}
                    <HeadTip tip={verifyTip} />
                  </th>
                  <th title={timeTip}>
                    {t("时间")}
                    <HeadTip tip={timeTip} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.alerts.map((a, i) => {
                  const whale = a.usd >= 50000 && a.type === "large";
                  const o = outcomes[a.id];
                  // 结算判定（resolved 才有）：绿=命中 / 红=未中 /
                  // ➖=判不了。提示文案与词表同源，逻辑原样保留。
                  const settled = o?.resolved ? o : null;
                  const verdictSymbol = settled
                    ? settled.won == null
                      ? "➖"
                      : settled.won
                        ? "✅"
                        : "❌"
                    : null;
                  const verdictTip =
                    settled && verdictSymbol
                      ? `${t(iconTip(verdictSymbol))}${t(
                          " · 结算价 {res} vs 成交价 {fill}",
                          {
                            res: String(settled.resolutionPrice),
                            fill: a.price.toFixed(3),
                          },
                        )}`
                      : "";
                  return (
                    <tr key={`${a.id}-${a.txHash}-${i}`}>
                      {/* 市场名永不截断 —— 换行（.cell-wrap），顶对齐；
                          信号类型的 emoji 收进灰底名称标签，不裸放在句中。 */}
                      <td className="cell-wrap" style={{ maxWidth: 360 }}>
                        {a.eventSlug ? (
                          <a
                            href={`https://polymarket.com/event/${a.eventSlug}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {a.title}
                          </a>
                        ) : (
                          a.title
                        )}
                        <div style={{ marginTop: "var(--s-1)" }}>
                          <span className="ds-tag ds-tag--sm">
                            <Icon
                              s={whale ? "🐳" : (TYPE_ICON[a.type] ?? "💰")}
                            />
                            {t(
                              whale
                                ? "巨鲸单"
                                : (TYPE_NAME[a.type] ?? "大额成交"),
                            )}
                          </span>
                        </div>
                      </td>
                      <td data-label={t("结果")}>
                        {a.outcome ? (
                          // 灰底名称标签（不表示状态）。结果名同样不截断：
                          // 长名换行，标签随之长高。
                          <span
                            className="ds-tag"
                            style={{
                              height: "auto",
                              minHeight: "var(--h-tag)",
                              padding: "2px var(--s-2)",
                              whiteSpace: "normal",
                              lineHeight: "var(--lh-snug)",
                              overflowWrap: "anywhere",
                            }}
                          >
                            {a.outcome}
                          </span>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td data-label={t("方向")}>
                        <SideTag side={a.side} />
                      </td>
                      <td className="is-right" data-label={t("金额")}>
                        ${fmtUsd(a.usd)}
                      </td>
                      <td className="is-right" data-label={t("价格")}>
                        {a.price.toFixed(4)}
                      </td>
                      <td data-label={t("钱包")}>
                        {a.wallet ? (
                          <WalletLink
                            address={a.wallet}
                            title={t("{address} · 新标签打开钱包档案", {
                              address: a.wallet,
                            })}
                          >
                            {shortWallet(a.wallet)}
                          </WalletLink>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td data-label={t("验证")}>
                        {/* Consensus rows validate too: entry = the group's
                            avgBuyPrice, timed at the last member fill. */}
                        <span
                          style={{
                            display: "flex",
                            gap: "var(--s-2)",
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          <FollowBadge
                            label="10m"
                            entry={a.price}
                            later={o?.price10m ?? null}
                            side={a.side}
                          />
                          <FollowBadge
                            label="1h"
                            entry={a.price}
                            later={o?.price1h ?? null}
                            side={a.side}
                          />
                          <FollowBadge
                            label="24h"
                            entry={a.price}
                            later={o?.price24h ?? null}
                            side={a.side}
                          />
                          {settled ? (
                            settled.won == null ? (
                              // 判不了用「—」而不是 ➖：emoji 只出现在名称
                              // 标签 / KPI 图标位 / 12px 小标前缀三处，不进
                              // 表体；提示文案仍与词表同源。
                              <span className="faint">
                                <Icon s="—" title={verdictTip} />
                              </span>
                            ) : (
                              <span
                                className={`ds-tag ds-tag--sm ds-tag--${
                                  settled.won ? "up" : "down"
                                }`}
                              >
                                <Icon
                                  s={settled.won ? "✅" : "❌"}
                                  title={verdictTip}
                                />
                                {settled.won ? t("命中") : t("未中")}
                              </span>
                            )
                          ) : null}
                          {!o ||
                          (o.price1h == null &&
                            o.price24h == null &&
                            !o.resolved) ? (
                            <span className="faint">…</span>
                          ) : null}
                        </span>
                      </td>
                      <td data-label={t("时间")} title={fmtTime(a.createdAt)}>
                        {fmtStamp(a.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* 灰底等待态 —— 流的尾巴 / 空态二合一，两行：什么状态，以及下一步
            能做什么。第二行同时是「条件在哪配置」的去处（原在页头描述里）。 */}
        <div
          className="ds-empty"
          style={{
            border: 0,
            borderTop: data.count === 0 ? "0" : "1px solid var(--ww-border)",
            borderRadius: 0,
          }}
        >
          <div>
            {data.count === 0
              ? t("暂无告警 — worker 抓到大单后会出现在这里")
              : t("等待下一条命中")}
          </div>
          <div style={{ marginTop: "var(--s-1)", fontSize: "var(--t-base)" }}>
            {t("条件在运营页配置；放宽金额门槛（如 ≥$5,000）可提高命中频率。")}
          </div>
        </div>

        {/* 卡底说明条 —— 本卡唯一一条，压到一行。三处「—」必须列全（设计
            系统 §1.2 与 guidelines/degraded.html：穷举一半会让读者以为只有
            两种成因），所以用最短句式并列，不写成一段。平局的判定式、「…」
            的重试节奏是方法论，收进「验证」列的 (?)。 */}
        {data.count > 0 ? (
          <div className="note-strip note-strip--warn">
            {t(
              "⚠️「—」是判不了、不是 0：结果列 = 没带结果名 · 钱包列 = 没带地址 · 验证列 = 已结算但平局（不计入胜率）。验证列的「…」= 仍在补算。",
            )}
          </div>
        ) : null}
      </section>
    </main>
  );
}
