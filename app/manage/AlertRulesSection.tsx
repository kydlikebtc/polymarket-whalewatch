"use client";

import { useCallback, useEffect, useState } from "react";
import { Segmented } from "../ui";
import { SectionHead } from "./bits";
import { authHeaders } from "./shared";

// 区块:TG 提醒规则(大额/聪明钱告警引擎的触发条件)。
// 数据面完全复用既有 /api/alert-config(GET 公开读、POST 需令牌)——
// 与 /alerts 页配置面板是同一份 config,两处保存互相可见(引擎每轮热读)。
// 枚举选择(方向/开关)用站内 Segmented 控件,与告警页同一交互语言。

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

const ON_OFF = [
  { value: 1, label: "开" },
  { value: 0, label: "关" },
] as const;

const SIDES = [
  { value: "ALL", label: "全部" },
  { value: "BUY", label: "只看买入" },
  { value: "SELL", label: "只看卖出" },
] as const;

export default function AlertRulesSection({ token }: { token: string }) {
  const [form, setForm] = useState<ConditionsForm | null>(null);
  const [readonly, setReadonly] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      // GET 也要令牌(2026-08-18):阈值不再公开读,读写同一道闸。
      const res = await fetch("/api/alert-config", {
        headers: authHeaders(token),
      });
      const j = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        setMsg(
          `加载失败:${typeof j.error === "string" ? j.error : `HTTP ${res.status}`}`,
        );
        return;
      }
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
  }, [token]);

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

  const numField = (
    label: string,
    key: keyof ConditionsForm,
    placeholder: string,
  ) => (
    <div>
      <div className="ds-label" style={{ marginBottom: "var(--s-1)" }}>
        {label}
      </div>
      <input
        className="ds-input ds-input--mono"
        value={String(form?.[key] ?? "")}
        placeholder={placeholder}
        onChange={(e) => upd({ [key]: e.target.value } as never)}
      />
    </div>
  );

  return (
    <section
      id="rules"
      className="ds-card"
      style={{
        padding: "var(--s-5)",
        marginBottom: "var(--s-5)",
        scrollMarginTop: "var(--s-6)",
      }}
    >
      <SectionHead
        title="TG 告警频道 · 触发条件（alerts 进料闸）"
        // 只留会改变操作的两件事:改这里同时改了 ① 的进料(不止 TG),以及
        // 保存要不要令牌。「同时是信号线 ① 与总线 large 的共同进料闸」的
        // 来龙去脉由 ① 区块的 hint 承担。
        hint={
          <>
            这套条件同时决定「进 alerts 台账」与「推 TG 告警」;总开关与冷却只
            管推送,不管入库。保存
            {readonly ? "需要上方管理令牌" : "(本地部署免令牌)"}。
          </>
        }
      />
      {!form ? (
        <>
          {/* 服务端的原话必须露出来 —— 此前它只在表单渲染出来之后才有位置显示,
              加载失败时整块永远停在「正在读取…」,把故障说成了慢。 */}
          {msg && (
            <div
              className="ds-callout ds-callout--error"
              style={{ marginBottom: "var(--s-3)" }}
            >
              {msg}
            </div>
          )}
          <div className="ds-empty">
            {msg ? "读不到当前触发条件。" : "正在读取当前触发条件…"}
            {msg && (
              <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
                {"通常是管理令牌失效;这套规则在 /alerts 配置面板也能改。"}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
              gap: "var(--s-4)",
              marginBottom: "var(--s-4)",
            }}
          >
            <div>
              <div className="ds-label" style={{ marginBottom: "var(--s-1)" }}>
                推送总开关
              </div>
              <Segmented
                ariaLabel="推送总开关"
                options={ON_OFF}
                value={form.enabled ? 1 : 0}
                onChange={(v) => upd({ enabled: v === 1 })}
              />
            </div>
            {numField("金额下限 $", "minUsd", "10000")}
            <div>
              <div className="ds-label" style={{ marginBottom: "var(--s-1)" }}>
                方向
              </div>
              <Segmented
                ariaLabel="方向"
                options={SIDES}
                value={form.side}
                onChange={(v) => upd({ side: v })}
              />
            </div>
            {numField("价格下限 0-1(空=不限)", "minPrice", "0.5")}
            {numField("价格上限 0-1(空=不限)", "maxPrice", "0.95")}
            {numField("地址年龄 ≤ 天(空=不限)", "maxAgeDays", "7")}
            <div>
              <div className="ds-label" style={{ marginBottom: "var(--s-1)" }}>
                只推聪明钱(🏆)
              </div>
              <Segmented
                ariaLabel="只推聪明钱"
                options={ON_OFF}
                value={form.smartOnly ? 1 : 0}
                onChange={(v) => upd({ smartOnly: v === 1 })}
              />
            </div>
            {numField("距结算 ≤ 小时(空=不限)", "maxHoursToEnd", "24")}
            {numField("同钱包同市场冷却 分钟", "cooldownMinutes", "30")}
          </div>
          {/* 描边白底 —— 本屏的主按钮留给上方 TG 目标的「添加」,每屏至多一个。 */}
          <div className="filter-row">
            <button className="ds-btn" disabled={saving} onClick={save}>
              {saving ? "保存中…" : "保存规则"}
            </button>
            {msg && <span className="ds-hint">{msg}</span>}
          </div>
          {/* 四个字段的标签里已各写了「空=不限」,这里只补那半句会被读错的。 */}
          <div className="ds-hint" style={{ marginTop: "var(--s-3)" }}>
            空 = 不限,不是 0。
          </div>
        </>
      )}
    </section>
  );
}
