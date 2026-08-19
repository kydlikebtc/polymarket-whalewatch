"use client";

import { useCallback, useEffect, useState } from "react";
import { Tag } from "../ui";
import { SectionHead } from "./bits";
import { agoText, authHeaders, timeText } from "./shared";

// 区块:📣 TG 推送目标(bot + 频道 的可管理组合)。
//
// 语义(与 𝕏 播报账号的关键差异):X 一次只能用一个账号发,所以那边是
// 「多账号、一个使用中」;TG 可以同时发多个频道,所以这里是「多目标各自
// 独立开关」—— 没有「使用中」,只有暂停。
//
// bot token 只进不出:新增时填一次写库,此后列表只显示尾部指纹(…AAA)。

interface TgKinds {
  large: boolean;
  consensus: boolean;
  strategy: boolean;
  ops: boolean;
}

interface TargetRow {
  id: number;
  label: string;
  chatId: string;
  kinds: TgKinds;
  delayMin: number;
  paused: boolean;
  createdAt: number;
  lastOkAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  consecutiveFailures: number;
  botHint: string;
}

interface Payload {
  targets: TargetRow[];
  active: {
    label: string;
    chatId: string;
    kinds: TgKinds;
    delayMin: number;
    source: "db" | "env";
  }[];
  envConfigured: boolean;
}

// 与 lib/tgTargets.TG_KINDS 同源语义;客户端组件不能 import 碰 DB 的模块,
// 故就近镜像一份最小集。
const KINDS: { kind: keyof TgKinds; label: string; hint: string }[] = [
  { kind: "large", label: "🐳 大额成交", hint: "量最大的一类" },
  { kind: "consensus", label: "🔥 聪明钱共识", hint: "稀有且独家" },
  { kind: "strategy", label: "📡 策略信号", hint: "可配延迟做分层" },
  { kind: "ops", label: "🩺 运维通知", hint: "自检/断更/熔断，建议只发给自己" },
];

export default function TgTargetsSection({ token }: { token: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    label: "",
    botToken: "",
    chatId: "",
    delayMin: 0,
    kinds: {
      large: true,
      consensus: true,
      strategy: false,
      ops: false,
    } as TgKinds,
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/tg-targets", {
        headers: authHeaders(token),
      });
      const j = (await res.json()) as Payload & { error?: string };
      if (j.error) {
        setError(j.error);
        setData(null);
        return;
      }
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token]);

  useEffect(() => {
    if (token) void load();
  }, [token, load]);

  const post = async (body: Record<string, unknown>, okMsg?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/tg-targets", {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string };
      if (j.error) {
        setError(j.error);
        return false;
      }
      if (okMsg) setNotice(okMsg);
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggleKind = (t: TargetRow, kind: keyof TgKinds) =>
    void post({
      action: "update",
      id: t.id,
      kinds: { [kind]: !t.kinds[kind] },
    });

  return (
    <section className="ds-card" style={{ padding: "var(--s-5)" }}>
      <SectionHead
        title="🅐 Telegram · 推送目标"
        hint="一条 = 一个 bot 发到一个频道/群。可同时有多个目标，各自决定收哪些信号；改完引擎下一轮（≤60s）生效，无需重启。"
        aside={
          <button
            className="ds-btn ds-btn--primary ds-btn--sm"
            disabled={busy || !token}
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? "取消" : "新增目标"}
          </button>
        }
      />

      {notice ? (
        <div className="ds-callout" style={{ marginBottom: "var(--s-3)" }}>
          {notice}
        </div>
      ) : null}
      {error ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-3)" }}
        >
          {error}
        </div>
      ) : null}

      {/* 当前实际生效的解析结果 —— 库里没有行时会回退到 .env 的配置,
          必须让运营者一眼看出「现在到底在往哪儿发」,而不是看到空列表
          误以为没在推。 */}
      {data && data.active.some((a) => a.source === "env") ? (
        <div className="ds-callout" style={{ marginBottom: "var(--s-3)" }}>
          当前仍在使用 <code>.env</code> 里的 TG 配置（下方尚无目标）：
          {data.active.map((a) => (
            <div key={a.chatId} className="mono" style={{ marginTop: 4 }}>
              {a.chatId} · {a.delayMin > 0 ? `延迟 ${a.delayMin} 分钟` : "实时"}
            </div>
          ))}
          <div style={{ marginTop: 6 }}>
            在这里新增任意一个目标后，<b>.env 的配置将完全让位</b>
            （不叠加，避免同一条消息推两遍）。
          </div>
        </div>
      ) : null}

      {adding ? (
        <div
          className="ds-card"
          style={{ padding: "var(--s-4)", marginBottom: "var(--s-3)" }}
        >
          <div
            style={{
              display: "grid",
              gap: "var(--s-3)",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            }}
          >
            <label>
              <div className="muted" style={{ fontSize: "var(--t-sm)" }}>
                名称（自己看的）
              </div>
              <input
                className="ds-input"
                value={form.label}
                placeholder="公开频道 / VIP 群"
                onChange={(e) => setForm({ ...form, label: e.target.value })}
              />
            </label>
            <label>
              <div className="muted" style={{ fontSize: "var(--t-sm)" }}>
                Bot Token（@BotFather 获取，只进不出）
              </div>
              <input
                className="ds-input mono"
                type="password"
                value={form.botToken}
                placeholder="123456:ABC-DEF..."
                onChange={(e) => setForm({ ...form, botToken: e.target.value })}
              />
            </label>
            <label>
              <div className="muted" style={{ fontSize: "var(--t-sm)" }}>
                Chat ID（@频道名 或 -100 开头的群 id）
              </div>
              <input
                className="ds-input mono"
                value={form.chatId}
                placeholder="@mychannel"
                onChange={(e) => setForm({ ...form, chatId: e.target.value })}
              />
            </label>
            <label>
              <div className="muted" style={{ fontSize: "var(--t-sm)" }}>
                策略信号延迟（分钟，0 = 实时）
              </div>
              <input
                className="ds-input mono"
                type="number"
                min={0}
                value={form.delayMin}
                onChange={(e) =>
                  setForm({ ...form, delayMin: Number(e.target.value) || 0 })
                }
              />
            </label>
          </div>
          <div
            style={{
              display: "flex",
              gap: "var(--s-3)",
              flexWrap: "wrap",
              margin: "var(--s-3) 0",
            }}
          >
            {KINDS.map((k) => (
              <label
                key={k.kind}
                style={{ display: "flex", gap: 6, alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  checked={form.kinds[k.kind]}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      kinds: { ...form.kinds, [k.kind]: e.target.checked },
                    })
                  }
                />
                {k.label}
              </label>
            ))}
          </div>
          <button
            className="ds-btn ds-btn--primary ds-btn--sm"
            disabled={busy || !form.botToken.trim() || !form.chatId.trim()}
            onClick={async () => {
              const ok = await post(
                { action: "add", ...form },
                "已添加。建议点「测试」确认 bot 有权限发消息。",
              );
              if (ok) {
                setAdding(false);
                setForm({ ...form, label: "", botToken: "", chatId: "" });
              }
            }}
          >
            添加
          </button>
          <div
            className="muted"
            style={{ fontSize: "var(--t-sm)", marginTop: "var(--s-2)" }}
          >
            bot 必须是该频道/群的管理员，否则发送会失败。添加后用「测试」验证。
          </div>
        </div>
      ) : null}

      {!token ? (
        <div className="ds-empty">填入管理令牌后可查看与管理推送目标</div>
      ) : !data ? (
        <div className="ds-empty">加载中…</div>
      ) : data.targets.length === 0 ? (
        <div className="ds-empty">
          尚无目标 —— 点右上角「新增目标」。在此之前使用 .env 里的 TG 配置。
        </div>
      ) : (
        <table className="ds-table ds-table--compact">
          <thead>
            <tr>
              <th>目标</th>
              <th>信号类型</th>
              <th>延迟</th>
              <th>状态</th>
              <th className="is-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {data.targets.map((t) => (
              <tr key={t.id} style={t.paused ? { opacity: 0.55 } : undefined}>
                <td data-label="目标">
                  <div>{t.label}</div>
                  <div
                    className="mono muted"
                    style={{ fontSize: "var(--t-sm)" }}
                  >
                    {t.chatId} · bot {t.botHint}
                  </div>
                </td>
                <td data-label="信号类型">
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {KINDS.map((k) => (
                      <label
                        key={k.kind}
                        title={k.hint}
                        style={{
                          display: "flex",
                          gap: 4,
                          alignItems: "center",
                          cursor: busy ? "default" : "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={t.kinds[k.kind]}
                          disabled={busy}
                          onChange={() => toggleKind(t, k.kind)}
                        />
                        <span style={{ fontSize: "var(--t-sm)" }}>
                          {k.label}
                        </span>
                      </label>
                    ))}
                  </div>
                </td>
                <td className="mono" data-label="延迟">
                  {t.delayMin > 0 ? `${t.delayMin} 分钟` : "实时"}
                </td>
                <td data-label="状态">
                  {t.paused ? (
                    <Tag>⏸ 已暂停</Tag>
                  ) : t.consecutiveFailures > 0 ? (
                    <Tag variant="down">
                      ⚠️ 连续失败 {t.consecutiveFailures}
                    </Tag>
                  ) : (
                    <Tag variant="up">🟢 正常</Tag>
                  )}
                  <div
                    className="mono muted"
                    style={{ fontSize: "var(--t-sm)", marginTop: 2 }}
                  >
                    {t.lastOkAt
                      ? `最近成功 ${agoText(t.lastOkAt)}`
                      : "尚未发过"}
                  </div>
                  {/* 沉默是最贵的故障形态:最后一条错误必须看得见。 */}
                  {t.lastError ? (
                    <div
                      className="mono"
                      style={{
                        fontSize: "var(--t-sm)",
                        color: "var(--down)",
                        marginTop: 2,
                      }}
                      title={`${timeText(t.lastErrorAt ?? 0)}`}
                    >
                      {t.lastError.slice(0, 60)}
                    </div>
                  ) : null}
                </td>
                <td className="is-right" data-label="操作">
                  <button
                    className="ds-btn ds-btn--sm"
                    disabled={busy || t.paused}
                    onClick={() =>
                      void post({ action: "test", id: t.id }, "测试消息已发出")
                    }
                  >
                    测试
                  </button>{" "}
                  <button
                    className="ds-btn ds-btn--sm"
                    disabled={busy}
                    onClick={() =>
                      void post({
                        action: "pause",
                        id: t.id,
                        paused: !t.paused,
                      })
                    }
                  >
                    {t.paused ? "恢复" : "暂停"}
                  </button>{" "}
                  <button
                    className="ds-btn ds-btn--danger ds-btn--sm"
                    disabled={busy}
                    onClick={() => {
                      // 删掉最后一个目标会回退到 .env（可能是完全不同的频道），
                      // 与全站危险操作一致地二次确认。
                      const last = data.targets.length === 1;
                      const msg = last
                        ? `这是最后一个目标，删除后将回退到 .env 里的 TG 配置（若未配置则完全停推）。确认删除「${t.label}」？`
                        : `确认删除「${t.label}」（${t.chatId}）？`;
                      if (window.confirm(msg)) {
                        void post({ action: "delete", id: t.id });
                      }
                    }}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
