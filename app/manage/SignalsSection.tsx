"use client";

import { useState } from "react";
import type { AdminSignalOverview } from "../../lib/adminOverview";
import { formatRecordLine } from "../../lib/signalRecord";
import { Tag } from "../ui";
import { SectionHead } from "./bits";
import { agoText, authHeaders, cents, timeText } from "./shared";

// 区块:可推送信号的呈现与管理。
// 上半:全部档位(含未放开)—— 放开哪档要看它的台账表现,pushEnabled 开关
// 是本页唯一高频写操作。下半:最近 20 条信号的逐通道投递状态,回答
// 「刚才那条到底推没推出去、卡在哪」。

const SOURCE_LABEL: Record<string, string> = {
  consensus: "共识",
  heavy: "巨鲸单",
  lopsided: "一边倒",
  resolved: "分歧解除",
  lone_wolf: "独狼",
  early_winner: "早期赢家",
};

const CH_LABEL: Record<string, string> = {
  tg_paid: "付费",
  tg_public: "公开",
};

function DeliveryTag({ channel, status }: { channel: string; status: string }) {
  const label = CH_LABEL[channel] ?? channel.replace("webhook:", "wh#");
  if (status === "sent") return <Tag variant="up">{label} 已发</Tag>;
  if (status === "failed_permanent")
    return <Tag variant="down">{label} 失败</Tag>;
  if (status === "skipped_stale") return <Tag>{label} 过期跳过</Tag>;
  return (
    <Tag>
      {label} {status}
    </Tag>
  );
}

/** 30d 战绩紧凑三元组;悬停显示 formatRecordLine 完整口径句。 */
function RecordCell({
  record,
  line,
}: {
  record: AdminSignalOverview["strategies"][number]["record"];
  line: string | null;
}) {
  if (record.settled === 0) {
    return <span className="muted">无已结算样本</span>;
  }
  if (record.settled < 5) {
    return (
      <span title={line ?? undefined}>
        {record.wins}/{record.settled} 中{" "}
        <Tag variant="warn">样本不足 · {record.settled} 仓</Tag>
      </span>
    );
  }
  const beyond = record.sd > 0 && Math.abs(record.excess) >= 2 * record.sd;
  // 超额只有越过 2×sd 才敢上色（那才是真方向）；运气范围内一律中性,
  // 不给读者一个「已经赢了」的假信号。
  const excessCls = !beyond ? "faint" : record.excess >= 0 ? "up" : "down";
  return (
    <span title={line ?? undefined}>
      {record.wins}/{record.settled} 中
      <span className="muted"> · 预期 {record.implied.toFixed(1)} · </span>
      <span className={excessCls}>
        {record.excess >= 0 ? "+" : "−"}
        {Math.abs(record.excess).toFixed(1)}
      </span>
      <span className="muted">{beyond ? " 超运气" : " 运气内"}</span>
    </span>
  );
}

export default function SignalsSection({
  token,
  overview,
  reload,
}: {
  token: string;
  overview: AdminSignalOverview | null;
  reload: () => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (strategyId: number, pushEnabled: boolean) => {
    // 放开推送是对外动作(订户会立刻开始收到该档信号)—— 二次确认;
    // 关闭是止损方向,单击即生效。
    if (pushEnabled) {
      const name =
        overview?.strategies.find((s) => s.id === strategyId)?.name ??
        `#${strategyId}`;
      if (
        !window.confirm(
          `放开「${name}」的对外推送?\n该档后续触发的买入信号将实时进入付费频道、延迟进入公开频道/API。`,
        )
      ) {
        return;
      }
    }
    setBusyId(strategyId);
    setError(null);
    try {
      const res = await fetch("/api/admin/signals", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({ strategyId, pushEnabled }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok || j.error) {
        setError(j.error ?? `HTTP ${res.status}`);
      } else {
        await reload();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const pushedCount =
    overview?.strategies.filter((s) => s.pushEnabled).length ?? 0;

  return (
    <section
      id="signals"
      className="ds-card"
      style={{
        padding: "var(--s-5)",
        marginBottom: "var(--s-5)",
        scrollMarginTop: "var(--s-6)",
      }}
    >
      <SectionHead
        title="② 策略信号（19 档 · 买入/结算事件）"
        aside={
          overview && (
            <span className="ds-hint">
              推送中 {pushedCount} / {overview.strategies.length} 档
            </span>
          )
        }
        hint="推送开关默认全关(先静默积累台账,按战绩放开)。开关只影响对外投递,不影响策略本身的纸面开仓。"
      />
      {error && (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-3)" }}
        >
          {error}
        </div>
      )}
      {!overview && (
        <div className="ds-empty">
          需要有效管理令牌后加载。
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            令牌在页头「🔑 令牌已验证」里更换；只想确认引擎是否在跑,去 /status。
          </div>
        </div>
      )}
      {overview && (
        <>
          {/* 口径先行：战绩列的读法写在表前面,不放脚注。 */}
          <div
            className="ds-callout ds-callout--warn"
            style={{ marginBottom: "var(--s-4)" }}
          >
            30d 战绩是<b>全量纸面</b>口径（不管有没有对外推送都记）。已结算 &lt;
            5 仓的档一律标「样本不足」；超额只有越过 2×sd 才上色,否则仍
            <b>在运气范围内</b>,别按它调仓。
          </div>
          <div className="ds-table-wrap" style={{ marginBottom: "var(--s-5)" }}>
            <table className="ds-table">
              <thead>
                <tr>
                  <th>档位</th>
                  <th>信号源</th>
                  <th>30d 战绩(全量纸面)</th>
                  <th className="is-right">台账信号</th>
                  <th className="is-right">已投递</th>
                  <th>推送</th>
                </tr>
              </thead>
              <tbody>
                {/* 行没有任何行级强调：不染整行、不调暗、不加左边线 ——
                    「推送中」「策略停用」全靠徽章与开关钮的颜色说话。 */}
                {overview.strategies.map((s) => {
                  const line = formatRecordLine(s.name, s.record);
                  return (
                    <tr key={s.id}>
                      <td className="cell-wrap" data-label="档位">
                        {s.name}{" "}
                        {!s.enabled && <Tag variant="down">策略停用</Tag>}
                        {/* 订阅方按 code 认档,答疑时要能一眼看到它对应哪档。 */}
                        {s.code && <div className="ds-hint">{s.code}</div>}
                      </td>
                      <td data-label="信号源">
                        <Tag>{SOURCE_LABEL[s.source] ?? s.source}</Tag>
                      </td>
                      <td
                        style={{ whiteSpace: "nowrap" }}
                        data-label="30d 战绩"
                      >
                        <RecordCell record={s.record} line={line} />
                      </td>
                      <td
                        className="is-right"
                        style={{ whiteSpace: "nowrap" }}
                        data-label="台账信号"
                      >
                        <span>
                          {s.signals.total}
                          <span className="muted"> · 24h </span>
                          {s.signals.last24h}
                        </span>
                        <div className="ds-hint">
                          最近 {agoText(s.signals.lastEmittedAt)}
                        </div>
                      </td>
                      <td
                        className="is-right"
                        style={{ whiteSpace: "nowrap" }}
                        data-label="已投递"
                      >
                        <span>
                          <span className="muted">付费 </span>
                          {s.deliveries.sentPaid}
                          <span className="muted"> · 公开 </span>
                          {s.deliveries.sentPublic}
                        </span>
                      </td>
                      <td data-label="推送">
                        <button
                          className={
                            s.pushEnabled
                              ? "ds-btn ds-btn--sm ds-btn--active"
                              : "ds-btn ds-btn--sm"
                          }
                          disabled={busyId === s.id}
                          aria-pressed={s.pushEnabled}
                          onClick={() => toggle(s.id, !s.pushEnabled)}
                          title={
                            s.pushEnabled
                              ? "点击关闭对外推送"
                              : "点击放开对外推送"
                          }
                        >
                          {busyId === s.id
                            ? "…"
                            : s.pushEnabled
                              ? "推送中"
                              : "已关"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="note-strip">
              「推送中」是蓝描边的选中态（可点即关）；「已关」是描边白底。
              档位停用与推送关闭是两件事 —— 停用的档连纸面开仓都不做,
              关推送的档照常记台账,只是不对外说话。
            </div>
          </div>

          <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
            最近 20 条台账信号 · 逐通道投递状态
          </div>
          {overview.recent.length === 0 ? (
            <div className="ds-empty">
              台账暂无信号（followCycle 尚未触发）。
              <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
                引擎每轮跑完才会写台账；先去 /status 确认 follow
                循环还在跳,再回来看。
              </div>
            </div>
          ) : (
            <div className="ds-table-wrap">
              <table className="ds-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>档位</th>
                    <th>市场</th>
                    <th>方向</th>
                    <th className="is-right">进</th>
                    <th>结算</th>
                    <th>投递</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.recent.map((r) => (
                    <tr key={r.id}>
                      <td
                        className="muted"
                        style={{ whiteSpace: "nowrap" }}
                        data-label="时间"
                      >
                        {timeText(r.emittedAt)}
                      </td>
                      <td className="cell-wrap" data-label="档位">
                        {r.strategyName}
                      </td>
                      {/* 市场名永不截断 —— 换行,最多两行,顶对齐。 */}
                      <td
                        className="cell-wrap"
                        style={{ maxWidth: 280 }}
                        data-label="市场"
                      >
                        {r.title}
                      </td>
                      <td className="cell-wrap" data-label="方向">
                        {r.outcome}
                      </td>
                      <td className="is-right" data-label="进">
                        {cents(r.entryPrice)}
                      </td>
                      <td data-label="结算">
                        {r.settled ? (
                          r.won === true ? (
                            <Tag variant="up">✅ 中</Tag>
                          ) : r.won === false ? (
                            <Tag variant="down">❌ 负</Tag>
                          ) : (
                            <Tag>➖ 平</Tag>
                          )
                        ) : (
                          <span className="muted">持有中</span>
                        )}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }} data-label="投递">
                        {r.channels.length === 0 ? (
                          <span className="muted">未投递</span>
                        ) : (
                          <span
                            style={{
                              display: "inline-flex",
                              gap: "var(--s-1)",
                              flexWrap: "wrap",
                            }}
                          >
                            {r.channels.map((c) => (
                              <DeliveryTag
                                key={c.channel}
                                channel={c.channel}
                                status={c.status}
                              />
                            ))}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="note-strip">
                「未投递」= 该档推送开关关着,或事件早于端点登记（不回灌）。
                「进」是入场价,用 ¢ 表示。
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
