"use client";

import { useCallback, useEffect, useState } from "react";
import { Tag } from "../ui";
import { SectionHead } from "./bits";
import { authHeaders, timeText } from "./shared";
import { sectionView } from "./sectionGate";

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

interface BusDefRow {
  id: number;
  sourceType: string;
  label: string;
  threshold: number;
  enabled: boolean;
}

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
  const [defs, setDefs] = useState<BusDefRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [routing, setRouting] = useState<RoutingState | null>(null);
  const [ledger, setLedger] = useState<EventLedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    // 不看本地 token 就直接发 —— 能不能读由服务端说了算(见 ./sectionGate)。
    // 未配 ADMIN_TOKEN 的部署上 checkWriteAccess 恒放行,这里若按 token 空
    // 就 return,整页解锁了这个区块却永远空着。
    setError(null);
    try {
      const res = await fetch("/api/admin/signals", {
        headers: authHeaders(token),
      });
      const j = (await res.json()) as {
        busTypes?: BusTypeMeta[];
        busDefs?: BusDefRow[];
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
      setDefs(j.busDefs ?? []);
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

  // 两块数据各自的门:类型开关来自 busTypes,台账来自 eventLedger,同一次
  // 请求但可以一个到手另一个为空。
  const typesView = sectionView(types, error);
  const ledgerView = sectionView(ledger, error);

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
        busDefs?: BusDefRow[];
        error?: string;
      };
      if (j.error) {
        setError(j.error);
        return;
      }
      if (j.busDefs) setDefs(j.busDefs);
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

      {typesView.kind === "error" ? (
        <div className="ds-empty">
          {typesView.message}
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            这是服务端的原话 —— 通常是管理令牌失效。换令牌后本区块自动重试。
          </div>
        </div>
      ) : typesView.kind === "loading" ? (
        <div className="ds-empty">正在读取事件类型与阈值…</div>
      ) : (
        <div
          style={{
            display: "grid",
            gap: "var(--s-4)",
            marginBottom: "var(--s-5)",
          }}
        >
          {typesView.data.map((t) => {
            const typeDefs = defs.filter((d) => d.sourceType === t.type);
            const anyOn = typeDefs.some((d) => d.enabled);
            return (
              // 卡片一律白底 —— 启不启用靠徽章说话,不给整块内容染色。
              <div
                key={t.type}
                className="ds-card"
                style={{ padding: "var(--s-4)" }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "var(--s-3)",
                    flexWrap: "wrap",
                    marginBottom: "var(--s-2)",
                  }}
                >
                  <div style={{ display: "grid", gap: 2 }}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "var(--s-2)",
                        flexWrap: "wrap",
                      }}
                    >
                      {t.label}
                      {!t.available ? <Tag variant="warn">待接入</Tag> : null}
                      {t.available && (
                        <Tag variant={anyOn ? "up" : undefined}>
                          {anyOn
                            ? `${typeDefs.filter((d) => d.enabled).length} 档启用`
                            : "关（无启用定义）"}
                        </Tag>
                      )}
                    </span>
                    <span className="ds-hint">{t.hint}</span>
                  </div>
                  <div className="ds-hint" style={{ textAlign: "right" }}>
                    <div>近 24h 事件 {counts[t.type] ?? 0}</div>
                    {routing && t.available && (
                      <div style={{ marginTop: 4 }}>
                        {pipeCells(t.type, routing, anyOn).map((c) => (
                          <div key={c.pipe} title={`属主:${c.owner}`}>
                            {c.pipe} {c.state}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {t.available && (
                  <>
                    {/* 同一类型可多档:各档独立阈值/启停,可被 webhook 端点
                        以 def:<id> 单独订阅(🅑 登记时选)。 */}
                    {typeDefs.map((d) => (
                      <div
                        key={d.id}
                        style={{
                          display: "flex",
                          gap: "var(--s-3)",
                          alignItems: "center",
                          flexWrap: "wrap",
                          padding: "var(--s-2) 0",
                          borderTop: "1px solid var(--ww-border)",
                        }}
                      >
                        <span
                          className="ds-hint"
                          style={{ minWidth: 56 }}
                          title="webhook 端点可用 def:<id> 单独订阅这一档"
                        >
                          def:{d.id}
                        </span>
                        <span style={{ minWidth: 90 }}>{d.label}</span>
                        <span
                          style={{
                            display: "inline-flex",
                            gap: 6,
                            alignItems: "center",
                          }}
                        >
                          <span className="ds-hint">≥</span>
                          <input
                            className="ds-input ds-input--mono"
                            style={{ width: 100 }}
                            inputMode="numeric"
                            value={draft[`d${d.id}`] ?? String(d.threshold)}
                            onChange={(e) =>
                              setDraft((x) => ({
                                ...x,
                                [`d${d.id}`]: e.target.value,
                              }))
                            }
                            onBlur={() => {
                              const v = Number(
                                draft[`d${d.id}`] ?? d.threshold,
                              );
                              if (!Number.isFinite(v) || v === d.threshold)
                                return;
                              void post(
                                { defAction: "update", id: d.id, threshold: v },
                                `d${d.id}`,
                              );
                            }}
                          />
                          <span className="ds-hint">
                            {t.threshold?.unit ?? ""}
                          </span>
                        </span>
                        {/* 描边白底 —— 本屏没有主按钮；启用是「点亮」不是
                            「提交」,危险方向（停用会断投递）才上红。 */}
                        <button
                          className={`ds-btn ds-btn--sm${d.enabled ? " ds-btn--danger" : ""}`}
                          disabled={busy === `d${d.id}`}
                          onClick={() => {
                            if (
                              !d.enabled &&
                              !window.confirm(
                                `确认启用「${t.label} · ${d.label}」并开始投递给订阅方？`,
                              )
                            )
                              return;
                            void post(
                              {
                                defAction: "update",
                                id: d.id,
                                enabled: !d.enabled,
                              },
                              `d${d.id}`,
                            );
                          }}
                        >
                          {d.enabled ? "停用" : "启用"}
                        </button>
                        <button
                          className="ds-btn ds-btn--sm ds-btn--subtle"
                          disabled={busy === `d${d.id}`}
                          onClick={() => {
                            if (
                              !window.confirm(
                                `删除定义「${d.label}」？订了 def:${d.id} 的端点将不再收到事件(端点配置不会被自动改写)。`,
                              )
                            )
                              return;
                            void post(
                              { defAction: "delete", id: d.id },
                              `d${d.id}`,
                            );
                          }}
                        >
                          删除
                        </button>
                      </div>
                    ))}

                    <div
                      style={{
                        display: "flex",
                        gap: "var(--s-3)",
                        alignItems: "center",
                        flexWrap: "wrap",
                        paddingTop: "var(--s-2)",
                        borderTop:
                          typeDefs.length > 0
                            ? "1px solid var(--ww-border)"
                            : undefined,
                      }}
                    >
                      <span className="filter-row__label">新增一档</span>
                      <input
                        className="ds-input"
                        style={{ width: 130 }}
                        placeholder="新档名(如 巨额)"
                        value={draft[`nl:${t.type}`] ?? ""}
                        onChange={(e) =>
                          setDraft((x) => ({
                            ...x,
                            [`nl:${t.type}`]: e.target.value,
                          }))
                        }
                      />
                      <span
                        style={{
                          display: "inline-flex",
                          gap: 6,
                          alignItems: "center",
                        }}
                      >
                        <span className="ds-hint">≥</span>
                        <input
                          className="ds-input ds-input--mono"
                          style={{ width: 100 }}
                          inputMode="numeric"
                          placeholder="阈值"
                          value={draft[`nt:${t.type}`] ?? ""}
                          onChange={(e) =>
                            setDraft((x) => ({
                              ...x,
                              [`nt:${t.type}`]: e.target.value,
                            }))
                          }
                        />
                        <span className="ds-hint">
                          {t.threshold?.unit ?? ""}
                        </span>
                      </span>
                      <button
                        className="ds-btn ds-btn--sm"
                        disabled={
                          busy === `new:${t.type}` ||
                          !(draft[`nl:${t.type}`] ?? "").trim() ||
                          !Number.isFinite(Number(draft[`nt:${t.type}`]))
                        }
                        onClick={() => {
                          void post(
                            {
                              defAction: "create",
                              sourceType: t.type,
                              label: (draft[`nl:${t.type}`] ?? "").trim(),
                              threshold: Number(draft[`nt:${t.type}`]),
                            },
                            `new:${t.type}`,
                          ).then(() =>
                            setDraft((x) => ({
                              ...x,
                              [`nl:${t.type}`]: "",
                              [`nt:${t.type}`]: "",
                            })),
                          );
                        }}
                      >
                        + 添加档
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="ds-label">最近 20 条事件台账 · 去向</div>
      {/* 口径先行：这张表的「去向」列不是全景,读之前先知道少了哪一路。 */}
      <div
        className="ds-callout ds-callout--warn"
        style={{ margin: "var(--s-2) 0 var(--s-4)" }}
      >
        大额/共识源自 alerts，发现源自总线。<b>TG 先发后记，没有逐行记录</b> ——
        这张表看不到它，配置见 🅐；𝕏 与总线 → webhook 才有逐行记录。
      </div>
      {ledgerView.kind === "error" ? (
        <div className="ds-empty">
          {ledgerView.message}
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            这是服务端的原话 —— 通常是管理令牌失效。换令牌后本区块自动重试。
          </div>
        </div>
      ) : ledgerView.kind === "loading" ? (
        <div className="ds-empty">正在读取事件台账…</div>
      ) : ledgerView.data.length === 0 ? (
        <div className="ds-empty">
          台账暂无事件。
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            要么进料条件一条都没命中，要么引擎还没跑起来 —— 去 /status
            看循环有没有在跳。
          </div>
        </div>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table">
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
              {ledgerView.data.map((r) => (
                <tr key={`${r.type}:${r.id}`}>
                  <td
                    className="muted"
                    style={{ whiteSpace: "nowrap" }}
                    data-label="时间"
                  >
                    {timeText(r.emittedAt)}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }} data-label="类型">
                    {TYPE_LABEL[r.type] ?? r.type}
                  </td>
                  {/* 市场名 / 结果名永不截断 —— 换行,最多两行,顶对齐。 */}
                  <td
                    className="cell-wrap"
                    style={{ maxWidth: 260 }}
                    data-label="市场"
                  >
                    {r.title ?? <span className="faint">—</span>}
                  </td>
                  <td className="cell-wrap" data-label="方向">
                    {r.outcome ?? <span className="faint">—</span>}
                  </td>
                  <td className="cell-wrap" data-label="摘要">
                    {r.summary || <span className="faint">—</span>}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }} data-label="𝕏">
                    {r.type === "discovery" ? (
                      <span className="muted" title="发现事件不接 𝕏">
                        不适用
                      </span>
                    ) : r.xStatus == null ? (
                      <span
                        className="faint"
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
                  <td
                    style={{ whiteSpace: "nowrap" }}
                    data-label="总线 → webhook"
                  >
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
          <div className="note-strip">
            <span className="faint">—</span> 是「判不了」不是零：𝕏
            列的它表示这条根本没进发帖流程（开关关 / 配额吃满 /
            未命中阈值），市场与方向列的它表示这类事件本来就不带该字段。
            「未入总线」= 类型未开启或事件早于开启时刻；「入总线 · 未投递」=
            没有端点勾选该类型，或事件早于端点登记（不回灌）。
          </div>
        </div>
      )}
    </section>
  );
}
