"use client";

import { useCallback, useEffect, useState } from "react";
import { authHeaders } from "./shared";

// 区块 1:TG 提醒规则(大额/聪明钱告警引擎的触发条件)。
// 数据面完全复用既有 /api/alert-config(GET 公开读、POST 需令牌)——
// 与 /alerts 页配置面板是同一份 config,两处保存互相可见(引擎每轮热读)。

interface ConditionsForm {
  enabled: boolean;
  minUsd: string;
  side: "ALL" | "BUY" | "SELL";
  minPrice: string;
  maxPrice: string;
  maxAgeDays: string;
  smartOnly: boolean;
  maxHoursToEnd: string;
  cooldownMinutes: string;
}

const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export default function AlertRulesSection({ token }: { token: string }) {
  const [form, setForm] = useState<ConditionsForm | null>(null);
  const [readonly, setReadonly] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/alert-config");
      const j = (await res.json()) as Record<string, unknown>;
      setReadonly(j.readonly === true);
      setForm({
        enabled: j.enabled === true,
        minUsd: String(j.minUsd ?? ""),
        side: j.side === "BUY" || j.side === "SELL" ? j.side : "ALL",
        minPrice: j.minPrice == null ? "" : String(j.minPrice),
        maxPrice: j.maxPrice == null ? "" : String(j.maxPrice),
        maxAgeDays: j.maxAgeDays == null ? "" : String(j.maxAgeDays),
        smartOnly: j.smartOnly === true,
        maxHoursToEnd: j.maxHoursToEnd == null ? "" : String(j.maxHoursToEnd),
        cooldownMinutes: String(j.cooldownMinutes ?? ""),
      });
    } catch (e) {
      setMsg(`加载失败:${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/alert-config", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({
          enabled: form.enabled,
          minUsd: numOrNull(form.minUsd) ?? 0,
          side: form.side,
          minPrice: numOrNull(form.minPrice),
          maxPrice: numOrNull(form.maxPrice),
          maxAgeDays: numOrNull(form.maxAgeDays),
          smartOnly: form.smartOnly,
          maxHoursToEnd: numOrNull(form.maxHoursToEnd),
          cooldownMinutes: numOrNull(form.cooldownMinutes) ?? 30,
        }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok || j.error) {
        setMsg(`保存失败:${j.error ?? `HTTP ${res.status}`}`);
      } else {
        setMsg("✅ 已保存 — 引擎下一轮(≤4s)生效");
        await load();
      }
    } catch (e) {
      setMsg(`保存失败:${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const upd = (patch: Partial<ConditionsForm>) =>
    setForm((f) => (f ? { ...f, ...patch } : f));

  const field = (
    label: string,
    key: keyof ConditionsForm,
    placeholder: string,
  ) => (
    <div>
      <label className="ds-label">{label}</label>
      <input
        className="ds-input"
        value={String(form?.[key] ?? "")}
        placeholder={placeholder}
        onChange={(e) => upd({ [key]: e.target.value } as never)}
      />
    </div>
  );

  return (
    <section className="ds-card" style={{ marginBottom: "var(--s-5)" }}>
      <h2 style={{ fontSize: "var(--t-lg)", marginBottom: "var(--s-1)" }}>
        🔔 TG 提醒规则(大额/聪明钱告警)
      </h2>
      <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
        与 /alerts 页配置面板同一份规则;保存
        {readonly ? "需要上方管理令牌" : "(本地部署免令牌)"}
        。策略信号推送的开关在上方「可推送信号管理」区。
      </div>
      {!form ? (
        <div className="ds-hint">加载中…</div>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
              gap: "var(--s-3)",
              marginBottom: "var(--s-3)",
            }}
          >
            <div>
              <label className="ds-label">推送总开关</label>
              <button
                className="ds-btn"
                aria-pressed={form.enabled}
                onClick={() => upd({ enabled: !form.enabled })}
              >
                {form.enabled ? "🟢 开" : "⚪ 关"}
              </button>
            </div>
            {field("金额下限 $", "minUsd", "10000")}
            <div>
              <label className="ds-label">方向</label>
              <select
                className="ds-input"
                value={form.side}
                onChange={(e) =>
                  upd({ side: e.target.value as ConditionsForm["side"] })
                }
              >
                <option value="ALL">全部</option>
                <option value="BUY">只看买入</option>
                <option value="SELL">只看卖出</option>
              </select>
            </div>
            {field("价格下限 0-1(空=不限)", "minPrice", "0.5")}
            {field("价格上限 0-1(空=不限)", "maxPrice", "0.95")}
            {field("地址年龄 ≤ 天(空=不限)", "maxAgeDays", "7")}
            <div>
              <label className="ds-label">只推聪明钱(🏆)</label>
              <button
                className="ds-btn"
                aria-pressed={form.smartOnly}
                onClick={() => upd({ smartOnly: !form.smartOnly })}
              >
                {form.smartOnly ? "🟢 开" : "⚪ 关"}
              </button>
            </div>
            {field("距结算 ≤ 小时(空=不限)", "maxHoursToEnd", "24")}
            {field("同钱包同市场冷却 分钟", "cooldownMinutes", "30")}
          </div>
          <button className="ds-btn" disabled={saving} onClick={save}>
            {saving ? "保存中…" : "保存规则"}
          </button>
          {msg && (
            <span className="ds-hint" style={{ marginLeft: "var(--s-3)" }}>
              {msg}
            </span>
          )}
        </>
      )}
    </section>
  );
}
