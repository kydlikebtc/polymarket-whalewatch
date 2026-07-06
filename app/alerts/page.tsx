"use client";

import { useEffect, useRef, useState } from "react";
import { Field, Icon, Segmented, SideTag, SoundToggle } from "../ui";
import { iconTip } from "../glossary";
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
  wilsonInterval,
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
function StatLine({ label, stat }: { label: string; stat: OutcomeStat }) {
  if (stat.total === 0) return null;
  const pct = Math.round((stat.hits / stat.total) * 100);
  const small = stat.total < 10;
  const { lo, hi } = wilsonInterval(stat.hits, stat.total);
  const parts = Object.entries(stat.byType).map(
    ([type, t]) => `${TYPE_LABEL[type] ?? type} ${t.hits}/${t.total}`,
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
          样本不足
        </span>
      ) : (
        <span className="muted mono" style={{ fontSize: "var(--t-sm)" }}>
          {" "}
          95%区间 {Math.round(lo * 100)}–{Math.round(hi * 100)}%
        </span>
      )}
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

// 告警条件 panel — edits the conditions stored in the `config` table that the
// embedded engine reads every poll. Telegram-optional: matches always land in the
// alerts table regardless of whether Telegram is configured.
function ConditionsPanel({
  pollSeconds,
  smartMeta,
}: {
  pollSeconds: number;
  smartMeta: SmartPoolMeta;
}) {
  const [c, setC] = useState<AlertConditions>(DEFAULT_CONDITIONS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string>("");
  const [err, setErr] = useState<string>("");
  // Local text state for price/age so intermediate typing isn't coerced eagerly.
  const [minPriceText, setMinPriceText] = useState<string>("");
  const [maxPriceText, setMaxPriceText] = useState<string>("");
  const [ageText, setAgeText] = useState<string>("");
  const [hoursToEndText, setHoursToEndText] = useState<string>("");

  function hydrate(next: AlertConditions) {
    setC(next);
    setMinPriceText(next.minPrice != null ? String(next.minPrice) : "");
    setMaxPriceText(next.maxPrice != null ? String(next.maxPrice) : "");
    setAgeText(next.maxAgeDays != null ? String(next.maxAgeDays) : "");
    setHoursToEndText(
      next.maxHoursToEnd != null ? String(next.maxHoursToEnd) : "",
    );
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/alert-config", { cache: "no-store" });
        const json = (await res.json()) as Partial<AlertConditions> & {
          error?: string;
        };
        if (!active) return;
        hydrate({ ...DEFAULT_CONDITIONS, ...json });
      } catch (e) {
        if (active) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function save() {
    setSaving(true);
    setErr("");
    const payload: AlertConditions = {
      enabled: c.enabled,
      minUsd: c.minUsd,
      side: c.side,
      minPrice: numOrNull(minPriceText),
      maxPrice: numOrNull(maxPriceText),
      maxAgeDays: numOrNull(ageText),
      smartOnly: c.smartOnly,
      maxHoursToEnd: numOrNull(hoursToEndText),
      cooldownMinutes: c.cooldownMinutes,
    };
    try {
      const res = await fetch("/api/alert-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as AlertConditions & { error?: string };
      if (json.error) throw new Error(json.error);
      hydrate(json);
      setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="ds-card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-3)",
        padding: "var(--s-4)",
        marginBottom: "var(--s-5)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <strong style={{ fontSize: "var(--t-md)", color: "var(--n-900)" }}>
          告警条件
        </strong>
        <label
          className="ds-hint"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--s-1)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={c.enabled}
            onChange={(e) => setC({ ...c, enabled: e.target.checked })}
          />
          启用
        </label>
      </div>

      <Field label="最低金额">
        <input
          type="number"
          min={0}
          value={c.minUsd}
          onChange={(e) =>
            setC({
              ...c,
              minUsd: Math.max(0, Math.floor(Number(e.target.value) || 0)),
            })
          }
          className="ds-input ds-input--mono"
          style={{ width: 120 }}
        />
        <span className="ds-hint">USD</span>
      </Field>

      <Field label="方向">
        <Segmented<Side>
          ariaLabel="方向"
          value={c.side}
          onChange={(s) => setC({ ...c, side: s })}
          options={[
            { label: "全部", value: "ALL" },
            { label: "买入 BUY", value: "BUY" },
            { label: "卖出 SELL", value: "SELL" },
          ]}
        />
      </Field>

      <Field label="价格区间">
        <input
          type="number"
          step={0.01}
          min={0}
          max={1}
          placeholder="0"
          value={minPriceText}
          onChange={(e) => setMinPriceText(e.target.value)}
          className="ds-input ds-input--mono"
          style={{ width: 80 }}
        />
        <span className="ds-hint">–</span>
        <input
          type="number"
          step={0.01}
          min={0}
          max={1}
          placeholder="1"
          value={maxPriceText}
          onChange={(e) => setMaxPriceText(e.target.value)}
          className="ds-input ds-input--mono"
          style={{ width: 80 }}
        />
        <span className="ds-hint">
          赔率 0–1（默认上限 0.95：排除 ≥0.95 的结算扫尾单，清空 = 不设上限）
        </span>
      </Field>

      <Field label="地址年龄">
        <span className="ds-hint">≤</span>
        <input
          type="number"
          min={0}
          placeholder="不限"
          value={ageText}
          onChange={(e) => setAgeText(e.target.value)}
          className="ds-input ds-input--mono"
          style={{ width: 70 }}
        />
        <span className="ds-hint">天（留空 = 不限）</span>
      </Field>

      <Field label="距结算">
        <span className="ds-hint">≤</span>
        <input
          type="number"
          min={0}
          placeholder="不限"
          value={hoursToEndText}
          onChange={(e) => setHoursToEndText(e.target.value)}
          className="ds-input ds-input--mono"
          style={{ width: 70 }}
        />
        <span className="ds-hint">小时（留空 = 不限；抓结算前突击买入）</span>
      </Field>

      <Field label="冷却窗口">
        <input
          type="number"
          min={0}
          value={c.cooldownMinutes}
          onChange={(e) =>
            setC({
              ...c,
              cooldownMinutes: Math.max(
                0,
                Math.floor(Number(e.target.value) || 0),
              ),
            })
          }
          className="ds-input ds-input--mono"
          style={{ width: 70 }}
        />
        <span className="ds-hint">
          分钟（同一钱包·同一市场冷却期内只推首笔，其余仅入库；0 = 关闭）
        </span>
      </Field>

      <Field label="聪明钱">
        <label
          className="ds-hint"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--s-1)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={c.smartOnly}
            onChange={(e) => setC({ ...c, smartOnly: e.target.checked })}
          />
          只推送聪明钱白名单钱包（🏆，每日自动从官方盈利榜播种）
        </label>
        {/* Hit-count feedback: with smartOnly a forever-silent feed is
            indistinguishable from a broken one — surface the pool size and
            how many 🏆 alerts the engine actually produced in the last 24h. */}
        {smartMeta.smartWalletCount != null ? (
          <span className="ds-hint mono">
            白名单 {smartMeta.smartWalletCount} 个
            {smartMeta.smartAlerts24h != null
              ? ` · 近24h 🏆 ${smartMeta.smartAlerts24h} 条`
              : ""}
          </span>
        ) : null}
      </Field>
      {c.smartOnly && smartMeta.smartWalletCount === 0 ? (
        // Same empty-pool copy as the consensus page — the two features share
        // the same whitelist and the same "seed hasn't run yet" failure mode.
        <div className="ds-callout ds-callout--warn">
          聪明钱白名单为空 — 开启后将不会推送任何告警。引擎启动后每日自动从
          官方盈利榜播种（首次约 1 分钟内完成），播种失败会自动重试
        </div>
      ) : null}
      {c.smartOnly ? (
        <span className="ds-hint">
          💡 开启后建议把最低金额降至 $2k–5k：聪明钱大单通常拆小，$10k
          单笔线与白名单的交集近零
        </span>
      ) : null}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-3)",
          flexWrap: "wrap",
        }}
      >
        <button
          className="ds-btn ds-btn--primary"
          onClick={save}
          disabled={saving || !loaded}
        >
          {saving ? "保存中…" : "保存"}
        </button>
        {savedAt ? (
          <span className="up" style={{ fontSize: "var(--t-sm)" }}>
            已保存 {savedAt}，引擎下一轮(~{pollSeconds}s)生效
          </span>
        ) : null}
        {err ? (
          <span className="down" style={{ fontSize: "var(--t-sm)" }}>
            保存失败: {err}
          </span>
        ) : null}
      </div>
    </section>
  );
}

export default function Page() {
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
            🐋 Polymarket 大额成交监控
          </h1>
          <div className="ds-hint">
            共 <span className="mono">{data.count}</span> 条告警
            {lastRefreshed ? ` · 最后刷新 ${lastRefreshed}` : ""}
            {error ? <span className="down"> · 刷新失败: {error}</span> : null}
            <span className="muted" style={{ marginLeft: "var(--s-2)" }}>
              · 每 5 秒自动刷新（后台标签页暂停）
            </span>
          </div>
        </div>
        <SoundToggle on={soundOn} onToggle={toggle} />
      </header>

      <ConditionsPanel
        pollSeconds={4}
        smartMeta={{
          smartWalletCount: data.smartWalletCount ?? null,
          smartAlerts24h: data.smartAlerts24h ?? null,
        }}
      />

      {/* Push-channel health callout — "no messages" must be tellable apart
          from "no large trades". Gated on `failing` (streak ≥ threshold), so
          a single transient blip never flashes red. */}
      {data.telegramHealth?.failing ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-4)" }}
        >
          ⚠️ Telegram 推送通道异常：已连续{" "}
          <strong className="mono">
            {data.telegramHealth.consecutiveSendFailures}
          </strong>{" "}
          次发送失败
          {data.telegramHealth.lastErrorAt
            ? `（最近失败 ${fmtTime(data.telegramHealth.lastErrorAt)}）`
            : ""}
          。新告警仍正常入库并显示在下方列表，仅推送受影响 — 请检查 bot token /
          频道权限 / 限流。
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
            <Icon s="📐" /> 信号验证（当前列表）
          </span>
          <StatLine label="1h 方向命中" stat={summary.dir1h} />
          <StatLine label="24h 方向命中" stat={summary.dir24h} />
          <StatLine label="已结算胜率" stat={summary.settled} />
        </div>
      ) : null}

      {data.count === 0 ? (
        <div className="ds-empty">暂无告警 — worker 抓到大单后会出现在这里</div>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th>市场</th>
                <th>结果</th>
                <th>方向</th>
                <th className="is-right">金额</th>
                <th className="is-right">价格</th>
                <th>钱包</th>
                <th title="信号后 1h/24h 价格变化（按方向着色）与结算结果">
                  验证
                </th>
                <th>时间</th>
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
                    <td>{a.outcome}</td>
                    <td>
                      <SideTag side={a.side} />
                    </td>
                    <td className="mono is-right">${fmtUsd(a.usd)}</td>
                    <td className="mono is-right">{a.price.toFixed(4)}</td>
                    <td>
                      {a.wallet ? (
                        <a
                          className="mono"
                          href={`/wallet/${a.wallet.toLowerCase()}`}
                          target="_blank"
                          rel="noreferrer"
                          title={`${a.wallet} · 新标签打开钱包档案`}
                        >
                          {shortWallet(a.wallet)}
                        </a>
                      ) : (
                        <span className="mono">—</span>
                      )}
                    </td>
                    <td>
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
                            title={`${iconTip(
                              o.won == null ? "➖" : o.won ? "✅" : "❌",
                            )} · 结算价 ${o.resolutionPrice} vs 成交价 ${a.price.toFixed(3)}`}
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
                    <td className="mono muted">{fmtTime(a.createdAt)}</td>
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
