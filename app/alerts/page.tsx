"use client";

import { useEffect, useRef, useState } from "react";
import { Field, Segmented, SideTag, SoundToggle } from "../ui";
import { playBubble } from "../sound";
import { useSoundToggle } from "../useSound";

type AlertView = {
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

type AlertsResponse = {
  count: number;
  alerts: AlertView[];
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
};

const DEFAULT_CONDITIONS: AlertConditions = {
  enabled: true,
  minUsd: 10000,
  side: "ALL",
  minPrice: null,
  maxPrice: null,
  maxAgeDays: null,
  smartOnly: false,
  maxHoursToEnd: null,
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
function ConditionsPanel({ pollSeconds }: { pollSeconds: number }) {
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
        <span className="ds-hint">赔率 0–1</span>
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
      </Field>

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

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const res = await fetch("/api/alerts", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as AlertsResponse;
        if (!active) return;
        setData(json);
        setLastRefreshed(
          new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        );
        setError("");
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    }

    load();
    const id = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

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
              · 每 5 秒自动刷新
            </span>
          </div>
        </div>
        <SoundToggle on={soundOn} onToggle={toggle} />
      </header>

      <ConditionsPanel pollSeconds={4} />

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
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {data.alerts.map((a, i) => {
                const whale = a.usd >= 50000;
                return (
                  <tr key={`${a.txHash}-${i}`}>
                    <td style={{ whiteSpace: "normal", maxWidth: 360 }}>
                      {whale ? "🐳" : "💰"}{" "}
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
                          title={`${a.wallet} · 点击查看钱包档案`}
                        >
                          {shortWallet(a.wallet)}
                        </a>
                      ) : (
                        <span className="mono">—</span>
                      )}
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
