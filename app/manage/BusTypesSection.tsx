"use client";

import { useCallback, useEffect, useState } from "react";
import { Tag } from "../ui";
import { SectionHead } from "./bits";
import { authHeaders, timeText } from "./shared";

// 区块:统一信号总线的类型管理。
//
// 与下方「可推送信号管理」的分工:那里管的是 19 档**策略**信号的推送开关,
// 这里管的是**全站其它类型**的信号(大额成交/聪明钱共识/聪明钱发现…)。
// 两者最终汇入同一批订阅方(webhook + /api/signals),但来源与口径不同,
// 所以分开呈现而不是混成一张表。
//
// 尚未落库的类型(分歧/拆单/赛前聚合)在注册表里标 available=false,这里
// 渲染成禁用 + 「待接入」标签 —— 让运营者看见"有这些类型,但还没通",
// 好过假装它们不存在。

interface BusTypeMeta {
  type: string;
  label: string;
  hint: string;
  available: boolean;
  threshold?: { key: string; label: string; unit: string };
}

type BusSetting = { enabled: boolean } & Record<string, boolean | number>;

interface BusLedgerRow {
  id: number;
  sourceType: string;
  title: string | null;
  emittedAt: number;
  summary: string;
  channels: { channel: string; status: string }[];
}

export default function BusTypesSection({ token }: { token: string }) {
  const [types, setTypes] = useState<BusTypeMeta[] | null>(null);
  const [settings, setSettings] = useState<Record<string, BusSetting>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [ledger, setLedger] = useState<BusLedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // 阈值输入的本地草稿:输入中不该每敲一个字符就打一次接口。
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      const res = await fetch("/api/admin/signals", {
        headers: authHeaders(token),
      });
      const j = (await res.json()) as {
        busTypes?: BusTypeMeta[];
        busSettings?: Record<string, BusSetting>;
        busCounts24h?: Record<string, number>;
        busLedger?: BusLedgerRow[];
        error?: string;
      };
      if (j.error) {
        setError(j.error);
        return;
      }
      setTypes(j.busTypes ?? []);
      setSettings(j.busSettings ?? {});
      setCounts(j.busCounts24h ?? {});
      setLedger(j.busLedger ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/admin/signals", {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as {
        busSettings?: Record<string, BusSetting>;
        error?: string;
      };
      if (j.error) {
        setError(j.error);
        return;
      }
      if (j.busSettings) setSettings(j.busSettings);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="ds-card"
      style={{ padding: "var(--s-5)", marginBottom: "var(--s-5)" }}
    >
      <SectionHead
        title="③ 原始信号总线（bus 类型）"
        hint="全站各类原始事件统一进入 bus_signals 台账，经 webhook（端点勾选）与 /api/signals 的 bus[] 投递给订阅方。默认全关 —— 开启前请确认订阅方能接住这类事件。不影响 Telegram 告警频道。"
      />

      {error ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-3)" }}
        >
          {error}
        </div>
      ) : null}

      {!token ? (
        <div className="ds-empty">填入管理令牌后可管理信号类型</div>
      ) : !types ? (
        <div className="ds-empty">加载中…</div>
      ) : (
        <table className="ds-table ds-table--compact">
          <thead>
            <tr>
              <th>类型</th>
              <th>状态</th>
              <th>阈值</th>
              <th className="is-right">近 24h</th>
            </tr>
          </thead>
          <tbody>
            {types.map((t) => {
              const st = settings[t.type];
              const on = st?.enabled === true;
              const thrKey = t.threshold?.key;
              const cur =
                thrKey && st && typeof st[thrKey] === "number"
                  ? String(st[thrKey])
                  : "";
              return (
                <tr
                  key={t.type}
                  style={on ? { background: "var(--up-50)" } : undefined}
                >
                  <td data-label="类型">
                    <div style={{ display: "grid", gap: 2 }}>
                      <span style={{ fontWeight: 500 }}>
                        {t.label}{" "}
                        {!t.available ? <Tag variant="warn">待接入</Tag> : null}
                      </span>
                      <span className="ds-hint">{t.hint}</span>
                    </div>
                  </td>
                  <td data-label="状态">
                    <button
                      className={`ds-btn ds-btn--sm ${on ? "ds-btn--danger" : "ds-btn--primary"}`}
                      disabled={busy === t.type || !t.available}
                      title={
                        t.available
                          ? undefined
                          : "该类信号目前仅在页面实时计算，尚未落库"
                      }
                      onClick={() => {
                        // 放开推送是对外行为,与全站危险操作一致地二次确认;
                        // 关闭不确认(止血动作不该有摩擦)。
                        if (
                          !on &&
                          !window.confirm(
                            `确认开启「${t.label}」并开始投递给订阅方？`,
                          )
                        )
                          return;
                        void post({ busType: t.type, enabled: !on }, t.type);
                      }}
                    >
                      {on ? "关闭" : "开启"}
                    </button>
                  </td>
                  <td data-label="阈值">
                    {t.threshold ? (
                      <span
                        style={{
                          display: "inline-flex",
                          gap: 6,
                          alignItems: "center",
                        }}
                      >
                        <input
                          className="ds-input ds-input--mono"
                          style={{ width: 110 }}
                          inputMode="numeric"
                          value={draft[t.type] ?? cur}
                          disabled={!t.available}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              [t.type]: e.target.value,
                            }))
                          }
                          onBlur={() => {
                            const v = Number(draft[t.type] ?? cur);
                            if (!Number.isFinite(v) || String(v) === cur)
                              return;
                            void post(
                              { busType: t.type, threshold: v },
                              t.type,
                            );
                          }}
                        />
                        <span className="ds-hint">{t.threshold.unit}</span>
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="mono is-right" data-label="近 24h">
                    {counts[t.type] ?? 0}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {token && ledger != null && (
        <>
          <div
            className="ds-label"
            style={{ margin: "var(--s-5) 0 var(--s-2)" }}
          >
            最近 20 条台账信号 · 逐通道投递状态
          </div>
          {ledger.length === 0 ? (
            <div className="ds-empty">
              总线台账暂无信号（类型全关或尚无达标事件）。
            </div>
          ) : (
            <div className="ds-table-wrap">
              <table className="ds-table ds-table--compact">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>类型</th>
                    <th>市场</th>
                    <th>摘要</th>
                    <th>投递</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((r) => (
                    <tr key={r.id}>
                      <td
                        className="ds-hint mono"
                        style={{ whiteSpace: "nowrap" }}
                      >
                        {timeText(r.emittedAt)}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {types?.find((t) => t.type === r.sourceType)?.label ??
                          r.sourceType}
                      </td>
                      <td
                        style={{
                          maxWidth: 240,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={r.title ?? undefined}
                      >
                        {r.title ?? <span className="muted">—</span>}
                      </td>
                      <td className="mono" style={{ whiteSpace: "nowrap" }}>
                        {r.summary || <span className="muted">—</span>}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {r.channels.length === 0 ? (
                          <span
                            className="muted"
                            title="没有任何端点勾选该类型,或事件早于端点登记(不回灌)"
                          >
                            未投递
                          </span>
                        ) : (
                          r.channels.map((c) => (
                            <Tag
                              key={c.channel}
                              variant={
                                c.status === "sent"
                                  ? "up"
                                  : c.status === "failed_permanent"
                                    ? "down"
                                    : undefined
                              }
                            >
                              {c.channel}
                              {c.status !== "sent" ? ` · ${c.status}` : ""}
                            </Tag>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
