"use client";

import { useEffect, useRef, useState } from "react";
import {
  Field,
  Icon,
  Segmented,
  SideTag,
  SoundToggle,
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
};

// Per-type labels for the validation strip's grouped breakdown.
const TYPE_LABEL: Record<string, string> = {
  large: "💰大单",
  smart: "🏆聪明钱",
  consensus: "🔥共识",
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

function fmtTime(sec: number): string {
  if (!sec) return "";
  return new Date(sec * 1000).toLocaleString("zh-CN", { hour12: false });
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
  const cls = v === "push" ? "muted" : v === "hit" ? "up" : "down";
  return (
    <span className={`mono ${cls}`} style={{ whiteSpace: "nowrap" }}>
      {label} {cents >= 0 ? "+" : ""}
      {cents.toFixed(1)}¢
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
  return (
    <span className={small ? "muted" : undefined}>
      {label}{" "}
      <strong className="mono">
        {stat.hits}/{stat.total}
      </strong>{" "}
      ({pct}%)
      {small ? (
        <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
          {" "}
          {t("样本不足")}
        </span>
      ) : (
        <span className="muted mono" style={{ fontSize: "var(--t-sm)" }}>
          {" "}
          {t("95%区间 {lo}–{hi}%", {
            lo: Math.round(lo * 100),
            hi: Math.round(hi * 100),
          })}
        </span>
      )}
      {clustered ? (
        <span
          className="muted mono"
          style={{ fontSize: "var(--t-sm)" }}
          title={firstSentence(t(termDetail("有效样本量（市场聚类）")))}
        >
          {" "}
          · {t("{n} 个市场", { n: stat.clusters })}
        </span>
      ) : null}
      {parts.length > 1 ? (
        <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
          {" "}
          · {parts.join(" · ")}
        </span>
      ) : null}
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

  return (
    <main className="ds-main">
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "var(--s-4)",
          marginBottom: "var(--s-5)",
        }}
      >
        <div>
          <h1 style={{ fontSize: "var(--t-2xl)", marginBottom: "var(--s-1)" }}>
            {t("🐋 Polymarket 大额成交监控")}
          </h1>
          <div className="ds-hint">
            {t("共")} <span className="mono">{data.count}</span> {t("条告警")}
            {lastRefreshed ? t(" · 最后刷新 {at}", { at: lastRefreshed }) : ""}
            {error ? (
              <span className="down">
                {t(" · 刷新失败: {err}", { err: error })}
              </span>
            ) : null}
            <span className="muted" style={{ marginLeft: "var(--s-2)" }}>
              {t("· 每 5 秒自动刷新（后台标签页暂停）")}
            </span>
          </div>
        </div>
        <SoundToggle on={soundOn} onToggle={toggle} />
      </header>

      {/* Push-channel health callout — "no messages" must be tellable apart
          from "no large trades". Gated on `failing` (streak ≥ threshold), so
          a single transient blip never flashes red. */}
      {data.telegramHealth?.failing ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-4)" }}
        >
          {t("⚠️ Telegram 推送通道异常：已连续")}{" "}
          <strong className="mono">
            {data.telegramHealth.consecutiveSendFailures}
          </strong>{" "}
          {t("次发送失败")}
          {data.telegramHealth.lastErrorAt
            ? t("（最近失败 {at}）", {
                at: fmtTime(data.telegramHealth.lastErrorAt),
              })
            : ""}
          {t(
            "。新告警仍正常入库并显示在下方列表，仅推送受影响 — 请检查 bot token / 频道权限 / 限流。",
          )}
          {data.telegramHealth.lastErrorMessage ? (
            <div
              className="muted mono"
              style={{ fontSize: "var(--t-sm)", marginTop: "var(--s-1)" }}
            >
              {data.telegramHealth.lastErrorMessage}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Validation summary — the "was this signal any good" strip. */}
      {hasStats ? (
        <div
          className="ds-callout"
          style={{
            marginBottom: "var(--s-4)",
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--s-4)",
            alignItems: "center",
          }}
        >
          <span>
            <Icon s="📐" /> {t("信号验证（当前列表）")}
          </span>
          <StatLine label={t("1h 方向命中")} stat={summary.dir1h} />
          <StatLine label={t("24h 方向命中")} stat={summary.dir24h} />
          <StatLine label={t("已结算胜率")} stat={summary.settled} />
        </div>
      ) : null}

      {data.count === 0 ? (
        <div className="ds-empty">
          {t("暂无告警 — worker 抓到大单后会出现在这里")}
        </div>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th>{t("市场")}</th>
                <th>{t("结果")}</th>
                <th>{t("方向")}</th>
                <th className="is-right">{t("金额")}</th>
                <th className="is-right">{t("价格")}</th>
                <th>{t("钱包")}</th>
                <th title={t("信号后 1h/24h 价格变化（按方向着色）与结算结果")}>
                  {t("验证")}
                </th>
                <th>{t("时间")}</th>
              </tr>
            </thead>
            <tbody>
              {data.alerts.map((a, i) => {
                const whale = a.usd >= 50000;
                const o = outcomes[a.id];
                return (
                  <tr key={`${a.id}-${a.txHash}-${i}`}>
                    <td style={{ whiteSpace: "normal", maxWidth: 360 }}>
                      <Icon
                        s={
                          whale && a.type === "large"
                            ? "🐳"
                            : (TYPE_ICON[a.type] ?? "💰")
                        }
                      />{" "}
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
                    </td>
                    <td data-label={t("结果")}>{a.outcome}</td>
                    <td data-label={t("方向")}>
                      <SideTag side={a.side} />
                    </td>
                    <td className="mono is-right" data-label={t("金额")}>
                      ${fmtUsd(a.usd)}
                    </td>
                    <td className="mono is-right" data-label={t("价格")}>
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
                        <span className="mono">—</span>
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
                        {o?.resolved ? (
                          <Icon
                            s={o.won == null ? "➖" : o.won ? "✅" : "❌"}
                            title={`${t(
                              iconTip(
                                o.won == null ? "➖" : o.won ? "✅" : "❌",
                              ),
                            )}${t(" · 结算价 {res} vs 成交价 {fill}", {
                              res: String(o.resolutionPrice),
                              fill: a.price.toFixed(3),
                            })}`}
                          />
                        ) : null}
                        {!o ||
                        (o.price1h == null &&
                          o.price24h == null &&
                          !o.resolved) ? (
                          <span className="muted">…</span>
                        ) : null}
                      </span>
                    </td>
                    <td className="mono muted" data-label={t("时间")}>
                      {fmtTime(a.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
