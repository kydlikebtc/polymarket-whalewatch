"use client";

import { useCallback, useEffect, useState } from "react";
import { CopyButton, Segmented, Tag } from "../ui";
import { SectionHead } from "./bits";
import { agoText, authHeaders, KEY_SCOPES, timeText } from "./shared";
import WebhookEndpointsSection, {
  type BusDefRow,
  type WebhookRow,
} from "./WebhookEndpointsSection";

// 区块:API key 管理 + 承载 webhook 端点子区块。
// 数据面完全复用批次 2/3 的 admin 路由(/api/admin/keys、/api/admin/webhooks)。
// 明文 key 只在签发响应里出现一次 —— callout 醒目展示 + 站内 CopyButton
// (自带剪贴板降级与 ✓ 反馈)。tier 选择用 Segmented,与全站同一交互语言。
//
// 端点的登记/运维搬去了 ./WebhookEndpointsSection(2026-08-19,拆分前 795 行,
// 贴着 CLAUDE.md 的 800 行上限)。数据仍在这里一次拉齐 —— 两个组件各自 fetch
// 会把 admin 路由的请求数翻倍,而那些路由是 perIp 30/分钟的限流。

interface KeyRow {
  id: number;
  label: string;
  tier: string;
  busTypes?: string[] | null;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

const TIERS = [
  { value: "delayed", label: "delayed(延迟)" },
  { value: "realtime", label: "realtime(实时)" },
] as const;

export default function KeysSection({ token }: { token: string }) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookRow[] | null>(null);
  // 信号定义(① 各类型的多档):webhook 端点可用 def:<id> 只订某一档。
  const [busDefs, setBusDefs] = useState<BusDefRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ id: number; key: string } | null>(
    null,
  );
  const [label, setLabel] = useState("");
  const [tier, setTier] = useState<"realtime" | "delayed">("delayed");
  const [subs, setSubs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [kRes, wRes, sRes] = await Promise.all([
        fetch("/api/admin/keys", { headers: authHeaders(token) }),
        fetch("/api/admin/webhooks", { headers: authHeaders(token) }),
        fetch("/api/admin/signals", { headers: authHeaders(token) }),
      ]);
      const k = (await kRes.json()) as { keys?: KeyRow[]; error?: string };
      const w = (await wRes.json()) as {
        webhooks?: WebhookRow[];
        error?: string;
      };
      if (!kRes.ok || k.error) {
        setKeys(null);
        setWebhooks(null);
        setError(k.error ?? `HTTP ${kRes.status}`);
        return;
      }
      setKeys(k.keys ?? []);
      setWebhooks(w.webhooks ?? []);
      try {
        const sj = (await sRes.json()) as { busDefs?: BusDefRow[] };
        setBusDefs(sj.busDefs ?? []);
      } catch {
        setBusDefs([]);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const issue = async () => {
    if (!label.trim()) {
      setError("请先填订户备注(label)");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/keys", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({ label: label.trim(), tier, busTypes: subs }),
      });
      const j = (await res.json()) as {
        id?: number;
        key?: string;
        error?: string;
      };
      if (!res.ok || j.error || !j.key) {
        setError(j.error ?? `HTTP ${res.status}`);
      } else {
        setIssued({ id: j.id!, key: j.key });
        setLabel("");
        setSubs([]);
        await load();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: number, keyLabel: string) => {
    // 吊销不可逆(订户立即断连)—— 必须二次确认。
    if (
      !window.confirm(
        `吊销 key #${id}(${keyLabel})?\n该订户的 API 拉取与挂在其上的 webhook 会立即失效,不可恢复。`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await fetch(`/api/admin/keys?id=${id}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const realtimeKeys = (keys ?? []).filter(
    (k) => k.tier === "realtime" && k.revokedAt == null,
  );

  return (
    <section
      id="keys"
      className="ds-card"
      style={{
        padding: "var(--s-5)",
        marginBottom: "var(--s-5)",
        scrollMarginTop: "var(--s-6)",
      }}
    >
      <SectionHead
        title="🅑 API key 与 webhook"
        aside={
          keys && (
            <span className="ds-hint">
              有效 {keys.filter((k) => k.revokedAt == null).length} / 共{" "}
              {keys.length}
            </span>
          )
        }
        hint={
          <>
            key 用于 /api/signals
            拉取(realtime=实时全量,delayed=延迟视图);webhook 只可挂在 realtime
            key 上。库中只存哈希,明文仅签发时显示一次。
            {" 订阅方接入文档:"}
            <a href="/api-docs" target="_blank" rel="noreferrer">
              /api-docs
            </a>
            {"(把这个链接连同 key 一起发给对方)"}
          </>
        }
      />
      {notice && (
        <div className="ds-callout" style={{ marginBottom: "var(--s-3)" }}>
          {notice}
        </div>
      )}
      {error && (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-3)" }}
        >
          {error}
        </div>
      )}
      {issued && (
        <div
          className="ds-callout ds-callout--warn"
          style={{ marginBottom: "var(--s-4)" }}
        >
          <b>✅ 已签发 #{issued.id}</b> —— 明文只显示这一次,请立即复制保存:
          <div
            style={{
              margin: "var(--s-2) 0",
              padding: "var(--s-2) var(--s-3)",
              background: "var(--ww-surface-sunken)",
              border: "1px solid var(--ww-border)",
              borderRadius: "var(--r-sm)",
              wordBreak: "break-all",
              userSelect: "all",
              display: "flex",
              alignItems: "center",
              gap: "var(--s-2)",
            }}
          >
            {issued.key}
            <CopyButton text={issued.key} label="复制 key" />
          </div>
          <button
            className="ds-btn ds-btn--sm ds-btn--subtle"
            onClick={() => setIssued(null)}
          >
            我已保存,关闭
          </button>
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: "var(--s-3)",
          flexWrap: "wrap",
          alignItems: "flex-end",
          marginBottom: "var(--s-4)",
        }}
      >
        <div>
          <div className="ds-label" style={{ marginBottom: "var(--s-1)" }}>
            订户备注
          </div>
          <input
            className="ds-input"
            value={label}
            placeholder="订户A"
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div>
          <div className="ds-label" style={{ marginBottom: "var(--s-1)" }}>
            tier
          </div>
          <Segmented
            ariaLabel="key tier"
            options={TIERS}
            value={tier}
            onChange={(v) => setTier(v)}
          />
        </div>
        <div style={{ flexBasis: "100%" }}>
          <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
            订阅信号类型（不勾 = 不限，拿全部）
          </div>
          {/* 任选子集 —— 一排描边钮 + 选中态蓝描边（.ds-btn--active）。
              这里刻意不用 Segmented：那是互斥控件,会让人以为只能选一个。 */}
          <div className="filter-bar" style={{ marginBottom: "var(--s-2)" }}>
            {KEY_SCOPES.map((o) => {
              const on = subs.includes(o.type);
              return (
                <button
                  key={o.type}
                  type="button"
                  aria-pressed={on}
                  className={`ds-btn ds-btn--sm${on ? " ds-btn--active" : ""}`}
                  onClick={() =>
                    setSubs((prev) =>
                      prev.includes(o.type)
                        ? prev.filter((x) => x !== o.type)
                        : [...prev, o.type],
                    )
                  }
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          <div className="ds-hint">
            过滤在服务端执行：没订阅的类型，该 key 在 /api/signals 与 webhook
            上都拿不到，不需要订阅方自己筛。
          </div>
        </div>
        <button
          className="ds-btn ds-btn--primary"
          disabled={busy}
          onClick={issue}
        >
          签发新 key
        </button>
      </div>

      {keys == null ? (
        <div className="ds-empty">
          需要有效管理令牌后加载。
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            令牌在页头「🔑 令牌已验证」里更换；服务端认了才算认。
          </div>
        </div>
      ) : keys.length === 0 ? (
        <div className="ds-empty">
          尚无 key。
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            填上方「订户备注」并选 tier 后点「签发新 key」，明文只显示一次。
          </div>
        </div>
      ) : (
        <div className="ds-table-wrap" style={{ marginBottom: "var(--s-5)" }}>
          <table className="ds-table">
            <thead>
              <tr>
                <th className="is-right">#</th>
                <th>备注</th>
                <th>tier</th>
                <th>订阅范围</th>
                <th>签发</th>
                <th>最近使用</th>
                <th>状态</th>
                {/* 操作列的表头不留空 —— 移动堆叠卡靠 data-label 说「操作」,
                    桌面表头也得说同一句话（与 🅑 端点表、𝕏 账号表同一张脸）。 */}
                <th className="is-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {/* 行没有任何行级强调：已吊销不调暗整行,只靠状态徽章分轻重。 */}
              {keys.map((k) => (
                <tr key={k.id}>
                  <td className="is-right muted" data-label="#">
                    {k.id}
                  </td>
                  <td className="cell-wrap" data-label="备注">
                    {k.label}
                  </td>
                  <td data-label="tier">
                    <Tag variant={k.tier === "realtime" ? "brand" : "default"}>
                      {k.tier}
                    </Tag>
                  </td>
                  <td data-label="订阅范围">
                    {k.busTypes && k.busTypes.length > 0 ? (
                      <span
                        style={{ display: "flex", gap: 4, flexWrap: "wrap" }}
                      >
                        {k.busTypes.map((t) => (
                          <Tag key={t}>
                            {KEY_SCOPES.find((o) => o.type === t)?.label ?? t}
                          </Tag>
                        ))}
                      </span>
                    ) : (
                      <span className="muted">不限</span>
                    )}
                  </td>
                  <td className="muted" data-label="签发">
                    {timeText(k.createdAt)}
                  </td>
                  <td className="muted" data-label="最近使用">
                    {agoText(k.lastUsedAt)}
                  </td>
                  <td data-label="状态">
                    {k.revokedAt != null ? (
                      <Tag variant="down">已吊销</Tag>
                    ) : (
                      <Tag variant="up">有效</Tag>
                    )}
                  </td>
                  <td
                    className="is-right"
                    data-label="操作"
                    style={{ whiteSpace: "nowrap" }}
                  >
                    {k.revokedAt == null ? (
                      <button
                        className="ds-btn ds-btn--sm ds-btn--danger"
                        disabled={busy}
                        onClick={() => revoke(k.id, k.label)}
                      >
                        吊销
                      </button>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="note-strip">
            「最近使用」的 <span className="faint">—</span> 是「从没被用过」,
            不是零 —— 签发了但订户还没接。已吊销的行留在表里做审计痕迹,不会
            被清理。
          </div>
        </div>
      )}

      <WebhookEndpointsSection
        token={token}
        webhooks={webhooks}
        realtimeKeys={realtimeKeys}
        busDefs={busDefs}
        reload={load}
      />
    </section>
  );
}
