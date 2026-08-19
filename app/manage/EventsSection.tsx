"use client";

import { useCallback, useEffect, useState } from "react";
import { Tag } from "../ui";
import { SectionHead } from "./bits";
import { authHeaders, timeText } from "./shared";

// 区块:① 原始事件信号 —— 大额成交 / 聪明钱共识 / 钱包发现(+待接入)。
//
// 2026-08-19 概念重排的落点:信号 = 事件(触发后发出、不可变、有稳定 id),
// 管线只挂在事件上;此前叫「聪明钱动向」的那条"线"其实是这些事件的**折叠
// 视图**(active[]/settled[]),已移出信号线、归入「视图」子 tab。原
// BusTypesSection(类型开关)与 SmartMovesSection(台账)在此合并 —— 同一条
// 事件线的条件、管线、台账本来就该是一张脸。
//
// 每类型三段信息:
//   1. 条件(阈值):bus 逐类型阈值;大额/共识的**进料闸**(哪些成交能进
//      alerts 台账)在 🅐 的告警条件 —— 两道闸都真实存在,各有属主;
//   2. 管线归属:该类型当前能到达哪些下游(取自 routing 真实开关态);
//   3. 台账:三类合并按时间倒序 + 去向(𝕏/总线→webhook 有逐行记录;TG
//      先发后记无逐行记录,只注记配置态)。

interface BusTypeMeta {
  type: string;
  label: string;
  hint: string;
  available: boolean;
  threshold?: { key: string; label: string; unit: string };
}

type BusSetting = { enabled: boolean } & Record<string, boolean | number>;

interface EventLedgerRow {
  id: number;
  type: string;
  title: string | null;
  outcome: string | null;
  emittedAt: number;
  summary: string;
  xStatus: string | null;
  bus: { projected: boolean; channels: { channel: string; status: string }[] };
}

interface RoutingState {
  alertPush: boolean;
  xKinds: Record<string, boolean>;
  tgTargetKinds: Record<string, number>;
  webhookTypes: Record<string, number>;
}

/** 各事件类型的管线归属(从 routing 真实开关态拼装,每格注明属主)。 */
function pipeCells(
  type: string,
  r: RoutingState,
  busOn: boolean,
): { pipe: string; state: string; owner: string }[] {
  const on = (b: boolean) => (b ? "开" : "关");
  const tgt = (k: string) => r.tgTargetKinds[k] ?? 0;
  const wh = (k: string) => r.webhookTypes[k] ?? 0;
  if (type === "large") {
    return [
      {
        pipe: "TG 告警",
        state: `${on(r.alertPush)} · 目标 ${tgt("large")}`,
        owner: "🅐 告警条件 + tg_targets",
      },
      {
        pipe: "𝕏",
        state: on(r.xKinds.whale === true),
        owner: "🅒 巨鲸大单开关",
      },
      {
        pipe: "webhook",
        state: `总线${on(busOn)} · 端点 ${wh("large")}`,
        owner: "本区开关 + 🅑 端点勾选",
      },
      { pipe: "API bus[]", state: on(busOn), owner: "本区开关" },
    ];
  }
  if (type === "consensus") {
    return [
      {
        pipe: "TG 告警",
        state: `频道即发 · 目标 ${tgt("consensus")}`,
        owner: "env 频道 + tg_targets",
      },
      {
        pipe: "𝕏",
        state: on(r.xKinds.consensus === true),
        owner: "🅒 共识开关",
      },
      {
        pipe: "webhook",
        state: `总线${on(busOn)} · 端点 ${wh("consensus")}`,
        owner: "本区开关 + 🅑 端点勾选",
      },
      { pipe: "API bus[]", state: on(busOn), owner: "本区开关" },
    ];
  }
  if (type === "discovery") {
    return [
      {
        pipe: "webhook",
        state: `总线${on(busOn)} · 端点 ${wh("discovery")}`,
        owner: "本区开关 + 🅑 端点勾选",
      },
      { pipe: "API bus[]", state: on(busOn), owner: "本区开关" },
    ];
  }
  return [];
}

const TYPE_LABEL: Record<string, string> = {
  consensus: "🔥 共识",
  smart: "🐳 大额(白名单)",
  discovery: "🔭 发现",
};

export default function EventsSection({ token }: { token: string }) {
  const [types, setTypes] = useState<BusTypeMeta[] | null>(null);
  const [settings, setSettings] = useState<Record<string, BusSetting>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [routing, setRouting] = useState<RoutingState | null>(null);
  const [ledger, setLedger] = useState<EventLedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
        routing?: RoutingState;
        eventLedger?: EventLedgerRow[];
        error?: string;
      };
      if (j.error) {
        setError(j.error);
        return;
      }
      setTypes(j.busTypes ?? []);
      setSettings(j.busSettings ?? {});
      setCounts(j.busCounts24h ?? {});
      setRouting(j.routing ?? null);
      setLedger(j.eventLedger ?? []);
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
        title="① 原始事件信号（大额 / 共识 / 发现）"
        hint="信号=事件:触发后发出、不可变、有稳定 id。每类型两道闸:进料闸(大额/共识进 alerts 台账的条件,在 🅐 告警条件)与总线阈值(本区,决定进入可推送台账)。active[]/settled[] 是这些事件的折叠视图,不是信号 —— 见「视图」子 tab。"
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
        <div className="ds-empty">填入管理令牌后可管理事件类型</div>
      ) : !types ? (
        <div className="ds-empty">加载中…</div>
      ) : (
        <div className="ds-table-wrap" style={{ marginBottom: "var(--s-5)" }}>
          <table className="ds-table ds-table--compact">
            <thead>
              <tr>
                <th>事件类型</th>
                <th>总线开关</th>
                <th>阈值</th>
                <th>管线归属（属主开关）</th>
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
                    <td data-label="类型" style={{ minWidth: 180 }}>
                      <div style={{ display: "grid", gap: 2 }}>
                        <span style={{ fontWeight: 500 }}>
                          {t.label}{" "}
                          {!t.available ? (
                            <Tag variant="warn">待接入</Tag>
                          ) : null}
                        </span>
                        <span className="ds-hint">{t.hint}</span>
                      </div>
                    </td>
                    <td data-label="总线开关">
                      <button
                        className={`ds-btn ds-btn--sm ${on ? "ds-btn--danger" : "ds-btn--primary"}`}
                        disabled={busy === t.type || !t.available}
                        title={
                          t.available
                            ? "控制该类型是否进入可推送台账(bus[] 与 webhook)"
                            : "该类信号目前仅在页面实时计算,尚未落库"
                        }
                        onClick={() => {
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
                            style={{ width: 100 }}
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
                    <td data-label="管线">
                      {routing && t.available ? (
                        <div style={{ display: "grid", gap: 2 }}>
                          {pipeCells(t.type, routing, on).map((c) => (
                            <span
                              key={c.pipe}
                              className="ds-hint"
                              title={`属主:${c.owner}`}
                              style={{ whiteSpace: "nowrap" }}
                            >
                              {c.pipe} {c.state}
                            </span>
                          ))}
                        </div>
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
        </div>
      )}

      <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
        最近 20 条事件台账 · 去向
        <span className="muted">
          （大额/共识源自 alerts,发现源自总线;TG 先发后记无逐行记录,配置见 🅐;𝕏
          与总线→webhook 有逐行记录）
        </span>
      </div>
      {!token ? (
        <div className="ds-empty">填入管理令牌后加载</div>
      ) : ledger == null ? (
        <div className="ds-empty">加载中…</div>
      ) : ledger.length === 0 ? (
        <div className="ds-empty">
          台账暂无事件（进料条件未命中,或引擎尚未运行）。
        </div>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table ds-table--compact">
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>市场</th>
                <th>方向</th>
                <th>摘要</th>
                <th>𝕏</th>
                <th>总线 → webhook</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((r) => (
                <tr key={`${r.type}:${r.id}`}>
                  <td className="ds-hint mono" style={{ whiteSpace: "nowrap" }}>
                    {timeText(r.emittedAt)}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {TYPE_LABEL[r.type] ?? r.type}
                  </td>
                  <td
                    style={{
                      maxWidth: 220,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={r.title ?? undefined}
                  >
                    {r.title ?? <span className="muted">—</span>}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {r.outcome ?? <span className="muted">—</span>}
                  </td>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}>
                    {r.summary || <span className="muted">—</span>}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {r.type === "discovery" ? (
                      <span className="muted" title="发现事件不接 𝕏">
                        不适用
                      </span>
                    ) : r.xStatus == null ? (
                      <span
                        className="muted"
                        title="未发帖(开关关/配额/未命中)"
                      >
                        —
                      </span>
                    ) : (
                      <Tag variant={r.xStatus === "posted" ? "up" : undefined}>
                        {r.xStatus}
                      </Tag>
                    )}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {!r.bus.projected ? (
                      <span
                        className="muted"
                        title="未投影进总线(类型未开启,或早于开启时刻)"
                      >
                        未入总线
                      </span>
                    ) : r.bus.channels.length === 0 ? (
                      <span
                        className="muted"
                        title="已入总线;无端点勾选该类型,或事件早于端点登记(不回灌)"
                      >
                        入总线 · 未投递
                      </span>
                    ) : (
                      r.bus.channels.map((c) => (
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
    </section>
  );
}
