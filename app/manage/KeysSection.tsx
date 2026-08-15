"use client";

import { useCallback, useEffect, useState } from "react";
import { agoText, authHeaders, timeText } from "./shared";

// 区块 3:API key 与 webhook 端点管理。
// 数据面完全复用批次 2/3 的 admin 路由(/api/admin/keys、/api/admin/webhooks)。
// 明文 key 只在签发响应里出现一次 —— 这里用醒目 callout 展示并提醒立即保存。

interface KeyRow {
  id: number;
  label: string;
  tier: string;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

interface WebhookRow {
  id: number;
  api_key_id: number;
  url: string;
  active: number;
  consecutive_failures: number;
  last_error: string | null;
  key_label: string;
  key_tier: string;
  key_revoked_at: number | null;
}

export default function KeysSection({ token }: { token: string }) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ id: number; key: string } | null>(
    null,
  );
  const [label, setLabel] = useState("");
  const [tier, setTier] = useState<"realtime" | "delayed">("delayed");
  const [whKeyId, setWhKeyId] = useState("");
  const [whUrl, setWhUrl] = useState("");
  const [whSecret, setWhSecret] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [kRes, wRes] = await Promise.all([
        fetch("/api/admin/keys", { headers: authHeaders(token) }),
        fetch("/api/admin/webhooks", { headers: authHeaders(token) }),
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
        body: JSON.stringify({ label: label.trim(), tier }),
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
        await load();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: number) => {
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

  const registerWh = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({
          apiKeyId: Number(whKeyId),
          url: whUrl.trim(),
          secret: whSecret,
        }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok || j.error) {
        setError(j.error ?? `HTTP ${res.status}`);
      } else {
        setWhUrl("");
        setWhSecret("");
        await load();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const disableWh = async (id: number) => {
    setBusy(true);
    try {
      await fetch(`/api/admin/webhooks?id=${id}`, {
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
    <section className="ds-card" style={{ marginBottom: "var(--s-5)" }}>
      <h2 style={{ fontSize: "var(--t-lg)", marginBottom: "var(--s-1)" }}>
        🔑 API key 与 webhook
      </h2>
      <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
        key 用于 /api/signals 拉取(realtime=实时全量,delayed=延迟视图); webhook
        只可挂在 realtime key 上。库中只存哈希,明文仅签发时显示一次。
      </div>
      {error && (
        <div className="ds-callout" style={{ marginBottom: "var(--s-3)" }}>
          {error}
        </div>
      )}
      {issued && (
        <div className="ds-callout" style={{ marginBottom: "var(--s-3)" }}>
          ✅ 已签发 #{issued.id} —— 明文只显示这一次,请立即复制保存:
          <div>
            <code style={{ userSelect: "all", wordBreak: "break-all" }}>
              {issued.key}
            </code>
          </div>
          <button
            className="ds-btn"
            style={{ marginTop: "var(--s-2)" }}
            onClick={() => setIssued(null)}
          >
            我已保存,关闭
          </button>
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: "var(--s-2)",
          flexWrap: "wrap",
          alignItems: "flex-end",
          marginBottom: "var(--s-3)",
        }}
      >
        <div>
          <label className="ds-label">订户备注</label>
          <input
            className="ds-input"
            value={label}
            placeholder="订户A"
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div>
          <label className="ds-label">tier</label>
          <select
            className="ds-input"
            value={tier}
            onChange={(e) => setTier(e.target.value as "realtime" | "delayed")}
          >
            <option value="delayed">delayed(延迟)</option>
            <option value="realtime">realtime(实时)</option>
          </select>
        </div>
        <button className="ds-btn" disabled={busy} onClick={issue}>
          签发新 key
        </button>
      </div>

      {keys == null ? (
        <div className="ds-hint">需要有效管理令牌后加载。</div>
      ) : keys.length === 0 ? (
        <div className="ds-hint">尚无 key。</div>
      ) : (
        <div className="ds-table-wrap" style={{ marginBottom: "var(--s-4)" }}>
          <table className="ds-table">
            <thead>
              <tr>
                <th>#</th>
                <th>备注</th>
                <th>tier</th>
                <th>签发</th>
                <th>最近使用</th>
                <th>状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.id}</td>
                  <td>{k.label}</td>
                  <td>
                    <span className="ds-tag">{k.tier}</span>
                  </td>
                  <td className="ds-hint">{timeText(k.createdAt)}</td>
                  <td className="ds-hint">{agoText(k.lastUsedAt)}</td>
                  <td>{k.revokedAt != null ? "🚫 已吊销" : "🟢 有效"}</td>
                  <td>
                    {k.revokedAt == null && (
                      <button
                        className="ds-btn"
                        disabled={busy}
                        onClick={() => revoke(k.id)}
                      >
                        吊销
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
        webhook 端点(realtime key 专属,连续失败 10 次自动熔断)
      </div>
      <div
        style={{
          display: "flex",
          gap: "var(--s-2)",
          flexWrap: "wrap",
          alignItems: "flex-end",
          marginBottom: "var(--s-3)",
        }}
      >
        <div>
          <label className="ds-label">挂在 key</label>
          <select
            className="ds-input"
            value={whKeyId}
            onChange={(e) => setWhKeyId(e.target.value)}
          >
            <option value="">选择 realtime key…</option>
            {realtimeKeys.map((k) => (
              <option key={k.id} value={String(k.id)}>
                #{k.id} {k.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: "1 1 240px" }}>
          <label className="ds-label">URL</label>
          <input
            className="ds-input"
            value={whUrl}
            placeholder="https://…/hook"
            onChange={(e) => setWhUrl(e.target.value)}
          />
        </div>
        <div>
          <label className="ds-label">HMAC secret(≥16 字符)</label>
          <input
            className="ds-input"
            value={whSecret}
            onChange={(e) => setWhSecret(e.target.value)}
          />
        </div>
        <button
          className="ds-btn"
          disabled={busy || !whKeyId || !whUrl || whSecret.length < 16}
          onClick={registerWh}
        >
          登记端点
        </button>
      </div>
      {webhooks != null && webhooks.length > 0 && (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th>#</th>
                <th>key</th>
                <th>URL</th>
                <th>连败</th>
                <th>状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {webhooks.map((w) => (
                <tr key={w.id}>
                  <td>{w.id}</td>
                  <td>
                    #{w.api_key_id} {w.key_label}
                  </td>
                  <td
                    style={{
                      maxWidth: 260,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={w.url}
                  >
                    {w.url}
                  </td>
                  <td>
                    {w.consecutive_failures}
                    {w.last_error && (
                      <span className="ds-hint">({w.last_error})</span>
                    )}
                  </td>
                  <td>
                    {w.key_revoked_at != null
                      ? "🚫 key 已吊销"
                      : w.active === 1
                        ? "🟢 活跃"
                        : "⛔ 已停用"}
                  </td>
                  <td>
                    {w.active === 1 && (
                      <button
                        className="ds-btn"
                        disabled={busy}
                        onClick={() => disableWh(w.id)}
                      >
                        停用
                      </button>
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
