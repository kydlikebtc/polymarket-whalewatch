"use client";

import { useCallback, useEffect, useState } from "react";
import { Tag } from "../ui";
import { SectionHead } from "./bits";
import { authHeaders, timeText } from "./shared";

// 区块:① 聪明钱动向。
//
// 这条线**没有可调的开关** —— 三种 kind 的判据是固定规则(与接入文档 §6.4
// 同一套口径,heavy 的 $50k 是 lib/signalFeed.HEAVY_MIN_USD 常量),这正是
// 它对订阅方可信的原因:规则不随运营者手抖漂移。本区块因此只做两件事:
//   1. 把定义讲清楚(此前这里放的是 alert-config 表单 —— 那是 TG 告警频道
//      的进料条件,已归位到管线 tab 的 🅐,见 page.tsx 的重排说明);
//   2. 台账:最近 20 条 ① 信号(consensus/smart 告警)· 去向。
//
// 「去向」三列的可得性刻意不同,如实呈现:
//   - 𝕏 / 总线→webhook:有逐行记录(x_posts / bus_deliveries);
//   - TG:没有逐行记录 —— alertEngine 先发后记(transient 失败连行都不落),
//     行的存在只证明「已入库」,所以 TG 列不存在,表头注记配置态即可。

interface SmartLedgerRow {
  id: number;
  type: string;
  title: string | null;
  outcome: string | null;
  emittedAt: number;
  summary: string;
  xStatus: string | null;
  bus: { projected: boolean; channels: { channel: string; status: string }[] };
}

const KIND_ROWS = [
  {
    kind: "共识 consensus",
    rule: "≥2 个白名单钱包在窗口内净买同一结果",
    read: "最强方向信号",
  },
  {
    kind: "分歧 split",
    rule: "同一市场两个对立结果上都有白名单钱包",
    read: "警告,不构成方向(outcome 恒为 null)",
  },
  {
    kind: "单笔大额 heavy",
    rule: "单个白名单钱包单笔 BUY ≥ $50,000(常量,非配置)",
    read: "单人观点,弱于共识;同市场已有共识时被抑制",
  },
];

export default function SmartMovesSection({ token }: { token: string }) {
  const [ledger, setLedger] = useState<SmartLedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      const res = await fetch("/api/admin/signals", {
        headers: authHeaders(token),
      });
      const j = (await res.json()) as {
        smartLedger?: SmartLedgerRow[];
        error?: string;
      };
      if (j.error) {
        setError(j.error);
        return;
      }
      setLedger(j.smartLedger ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      className="ds-card"
      style={{ padding: "var(--s-5)", marginBottom: "var(--s-5)" }}
    >
      <SectionHead
        title="① 聪明钱动向（consensus / split / heavy）"
        hint="白名单钱包的真实成交,按市场×方向折叠后进 API 的 active[]/settled[] 与 TG 告警。判据是固定规则(无开关)—— 进料条件(哪些成交能进 alerts 台账)在管线 tab 的 🅐 Telegram;想经 webhook 收本线,订阅总线的 consensus/large 类型(③)。"
      />

      <div className="ds-table-wrap" style={{ marginBottom: "var(--s-5)" }}>
        <table className="ds-table ds-table--compact">
          <thead>
            <tr>
              <th>kind</th>
              <th>判据（固定规则）</th>
              <th>怎么读</th>
            </tr>
          </thead>
          <tbody>
            {KIND_ROWS.map((r) => (
              <tr key={r.kind}>
                <td style={{ whiteSpace: "nowrap", fontWeight: 500 }}>
                  {r.kind}
                </td>
                <td>{r.rule}</td>
                <td className="ds-hint">{r.read}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-3)" }}
        >
          {error}
        </div>
      ) : null}

      <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
        最近 20 条台账信号 · 去向
        <span className="muted">
          （TG 告警为先发后记、无逐行投递记录,状态见 🅐;𝕏 与总线有逐行记录）
        </span>
      </div>
      {!token ? (
        <div className="ds-empty">填入管理令牌后加载</div>
      ) : ledger == null ? (
        <div className="ds-empty">加载中…</div>
      ) : ledger.length === 0 ? (
        <div className="ds-empty">
          台账暂无信号（进料条件未命中,或引擎尚未运行）。
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
                <tr key={r.id}>
                  <td className="ds-hint mono" style={{ whiteSpace: "nowrap" }}>
                    {timeText(r.emittedAt)}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {r.type === "consensus" ? "🔥 共识" : "🐳 大额(白名单)"}
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
                    {r.xStatus == null ? (
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
