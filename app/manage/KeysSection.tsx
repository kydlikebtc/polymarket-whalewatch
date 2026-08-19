"use client";

import { useCallback, useEffect, useState } from "react";
import { CopyButton, Segmented, Tag } from "../ui";
import { SectionHead } from "./bits";
import { agoText, authHeaders, timeText } from "./shared";

// 区块:API key 与 webhook 端点管理。
// 数据面完全复用批次 2/3 的 admin 路由(/api/admin/keys、/api/admin/webhooks)。
// 明文 key 只在签发响应里出现一次 —— callout 醒目展示 + 站内 CopyButton
// (自带剪贴板降级与 ✓ 反馈)。tier 选择用 Segmented,与全站同一交互语言。

interface KeyRow {
  id: number;
  label: string;
  tier: string;
  busTypes?: string[] | null;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

interface WebhookRow {
  id: number;
  api_key_id: number;
  url: string;
  active: number;
  bus_types: string | null;
  consecutive_failures: number;
  last_error: string | null;
  key_label: string;
  key_tier: string;
  key_revoked_at: number | null;
}

// 可订阅的信号类型。与 lib/signalBus.BUS_TYPES 同源语义(这是客户端组件,
// 不能 import 碰 DB 的模块),外加 "strategy" —— 19 档策略信号在订阅层面
// 也是一个类型。不勾任何项 = 不限(全部),与既有 key 的语义一致。
const SUBSCRIBABLE = [
  { type: "strategy", label: "策略信号(19 档)" },
  { type: "large", label: "🐳 大额成交" },
  { type: "consensus", label: "🔥 聪明钱共识" },
  { type: "discovery", label: "🔭 聪明钱发现" },
] as const;

const TIERS = [
  { value: "delayed", label: "delayed(延迟)" },
  { value: "realtime", label: "realtime(实时)" },
] as const;

export default function KeysSection({ token }: { token: string }) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ id: number; key: string } | null>(
    null,
  );
  const [label, setLabel] = useState("");
  const [tier, setTier] = useState<"realtime" | "delayed">("delayed");
  const [subs, setSubs] = useState<string[]>([]);
  const [whKeyId, setWhKeyId] = useState("");
  const [whUrl, setWhUrl] = useState("");
  const [whSecret, setWhSecret] = useState("");
  // 端点推送类型,默认仅策略信号(与存量端点的历史行为一致)。
  const [whSubs, setWhSubs] = useState<string[]>(["strategy"]);
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
          busTypes: whSubs,
        }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok || j.error) {
        setError(j.error ?? `HTTP ${res.status}`);
      } else {
        setWhUrl("");
        setWhSecret("");
        setWhSubs(["strategy"]);
        await load();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 端点运维动作(停用/恢复/删除)的公共通道。测试不走这里 —— 它的失败是
  // 「HTTP 200 但 ok:false」,套进这套 error 判定会被静默当成功。
  const actWh = async (body: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token) },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok || j.error) {
        setError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      setNotice(okMsg);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const testWh = async (id: number) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({ action: "test", id }),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        status?: number | null;
        ms?: number;
        detail?: string;
        error?: string;
      };
      if (!res.ok || j.error) {
        setError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      const head = `端点 #${id} ${j.ok ? "测试通过" : "测试未通过"}(${j.ms}ms)`;
      // 探针不写库,列表没有任何变化 —— 不必 reload。
      if (j.ok) setNotice(`✅ ${head}:${j.detail}`);
      else setError(`❌ ${head}:${j.detail}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const disableWh = (id: number, url: string) => {
    if (
      !window.confirm(
        `停用 webhook #${id}?\n${url}\n停止投递但保留端点与投递史,随时可点「恢复」重新启用。`,
      )
    ) {
      return;
    }
    void actWh({ action: "disable", id }, `端点 #${id} 已停用`);
  };

  const deleteWh = (id: number, url: string) => {
    // 硬删不可逆:secret 一并消失,恢复只能让订户重新配一遍。
    if (
      !window.confirm(
        `删除 webhook #${id}?\n${url}\n端点连同 HMAC secret 一并销毁,不可恢复 —— 只是想临时停推请用「停用」。`,
      )
    ) {
      return;
    }
    void actWh({ action: "delete", id }, `端点 #${id} 已删除`);
  };

  const realtimeKeys = (keys ?? []).filter(
    (k) => k.tier === "realtime" && k.revokedAt == null,
  );

  return (
    <section
      id="keys"
      className="ds-card"
      style={{ marginBottom: "var(--s-5)", scrollMarginTop: "var(--s-6)" }}
    >
      <SectionHead
        title="🅑 API key 与 webhook"
        aside={
          keys && (
            <span className="ds-hint num">
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
        <div className="ds-callout" style={{ marginBottom: "var(--s-4)" }}>
          <b>✅ 已签发 #{issued.id}</b> —— 明文只显示这一次,请立即复制保存:
          <div
            className="mono"
            style={{
              margin: "var(--s-2) 0",
              padding: "var(--s-2) var(--s-3)",
              background: "var(--n-50)",
              border: "1px solid var(--n-150)",
              borderRadius: "var(--r-sm, 6px)",
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
          <div className="ds-label" style={{ marginBottom: "var(--s-1)" }}>
            订阅信号类型（不勾 = 不限，拿全部）
          </div>
          <div style={{ display: "flex", gap: "var(--s-3)", flexWrap: "wrap" }}>
            {SUBSCRIBABLE.map((o) => (
              <label
                key={o.type}
                style={{
                  display: "inline-flex",
                  gap: 6,
                  alignItems: "center",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={subs.includes(o.type)}
                  onChange={(e) =>
                    setSubs((prev) =>
                      e.target.checked
                        ? [...prev, o.type]
                        : prev.filter((x) => x !== o.type),
                    )
                  }
                />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
          <div className="ds-hint" style={{ marginTop: "var(--s-1)" }}>
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
        <div className="ds-empty">需要有效管理令牌后加载。</div>
      ) : keys.length === 0 ? (
        <div className="ds-empty">尚无 key。</div>
      ) : (
        <div className="ds-table-wrap" style={{ marginBottom: "var(--s-5)" }}>
          <table className="ds-table ds-table--compact">
            <thead>
              <tr>
                <th className="is-right">#</th>
                <th>备注</th>
                <th>tier</th>
                <th>订阅范围</th>
                <th>签发</th>
                <th>最近使用</th>
                <th>状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr
                  key={k.id}
                  style={k.revokedAt != null ? { opacity: 0.55 } : undefined}
                >
                  <td className="is-right num muted">{k.id}</td>
                  <td style={{ fontWeight: 600 }}>{k.label}</td>
                  <td>
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
                            {SUBSCRIBABLE.find((o) => o.type === t)?.label ?? t}
                          </Tag>
                        ))}
                      </span>
                    ) : (
                      <span className="muted">不限</span>
                    )}
                  </td>
                  <td className="ds-hint mono">{timeText(k.createdAt)}</td>
                  <td className="ds-hint">{agoText(k.lastUsedAt)}</td>
                  <td>
                    {k.revokedAt != null ? (
                      <Tag variant="down">已吊销</Tag>
                    ) : (
                      <Tag variant="up">有效</Tag>
                    )}
                  </td>
                  <td>
                    {k.revokedAt == null && (
                      <button
                        className="ds-btn ds-btn--sm ds-btn--danger"
                        disabled={busy}
                        onClick={() => revoke(k.id, k.label)}
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
        webhook 端点(realtime key 专属,连续失败 10
        次自动熔断;熔断后先「测试」确认端点修好,再「恢复」)
      </div>
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
            挂在 key
          </div>
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
          <div className="ds-label" style={{ marginBottom: "var(--s-1)" }}>
            URL
          </div>
          <input
            className="ds-input ds-input--mono"
            value={whUrl}
            placeholder="https://…/hook"
            onChange={(e) => setWhUrl(e.target.value)}
            style={{ width: "100%" }}
          />
        </div>
        <div>
          <div className="ds-label" style={{ marginBottom: "var(--s-1)" }}>
            HMAC secret(≥16 字符)
          </div>
          <input
            className="ds-input ds-input--mono"
            type="password"
            value={whSecret}
            onChange={(e) => setWhSecret(e.target.value)}
          />
        </div>
        <div>
          <div className="ds-label" style={{ marginBottom: "var(--s-1)" }}>
            推送类型(勾选须在 key 订阅范围内)
          </div>
          <div style={{ display: "flex", gap: "var(--s-3)", flexWrap: "wrap" }}>
            {SUBSCRIBABLE.map((o) => (
              <label
                key={o.type}
                style={{
                  display: "inline-flex",
                  gap: 6,
                  alignItems: "center",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={whSubs.includes(o.type)}
                  onChange={(e) =>
                    setWhSubs((prev) =>
                      e.target.checked
                        ? [...prev, o.type]
                        : prev.filter((x) => x !== o.type),
                    )
                  }
                />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        </div>
        <button
          className="ds-btn ds-btn--primary"
          disabled={
            busy ||
            !whKeyId ||
            !whUrl ||
            whSecret.length < 16 ||
            whSubs.length === 0
          }
          onClick={registerWh}
        >
          登记端点
        </button>
      </div>
      {webhooks != null && webhooks.length > 0 && (
        <div className="ds-table-wrap">
          <table className="ds-table ds-table--compact">
            <thead>
              <tr>
                <th className="is-right">#</th>
                <th>key</th>
                <th>URL</th>
                <th>推送类型</th>
                <th className="is-right">连败</th>
                <th>状态</th>
                <th className="is-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {webhooks.map((w) => (
                <tr
                  key={w.id}
                  style={
                    w.active !== 1 || w.key_revoked_at != null
                      ? { opacity: 0.55 }
                      : undefined
                  }
                >
                  <td className="is-right num muted">{w.id}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    #{w.api_key_id} {w.key_label}
                  </td>
                  <td
                    className="mono"
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
                  <td style={{ whiteSpace: "nowrap" }}>
                    {(() => {
                      // null/坏 JSON = 仅策略信号(历史默认);一行脏数据
                      // 不该白屏整张表。
                      let picked: string[] | null = null;
                      try {
                        if (w.bus_types) {
                          const v: unknown = JSON.parse(w.bus_types);
                          if (Array.isArray(v)) picked = v as string[];
                        }
                      } catch {
                        picked = null;
                      }
                      if (!picked) return <Tag>策略(默认)</Tag>;
                      return picked.map((t) => (
                        <Tag key={t}>
                          {SUBSCRIBABLE.find((o) => o.type === t)?.label ?? t}
                        </Tag>
                      ));
                    })()}
                  </td>
                  <td className="is-right num">
                    {w.consecutive_failures}
                    {w.last_error && (
                      <span className="ds-hint">({w.last_error})</span>
                    )}
                  </td>
                  <td>
                    {w.key_revoked_at != null ? (
                      <Tag variant="down">key 已吊销</Tag>
                    ) : w.active === 1 ? (
                      <Tag variant="up">活跃</Tag>
                    ) : (
                      <Tag>已停用</Tag>
                    )}
                  </td>
                  <td
                    className="is-right"
                    data-label="操作"
                    style={{ whiteSpace: "nowrap" }}
                  >
                    <button
                      className="ds-btn ds-btn--sm"
                      disabled={busy}
                      title="向该端点投一条测试事件(id=0、带 X-Signal-Test 头),走真实投递路径但不计入连败"
                      onClick={() => void testWh(w.id)}
                    >
                      测试
                    </button>{" "}
                    {w.active === 1 ? (
                      <button
                        className="ds-btn ds-btn--sm"
                        disabled={busy}
                        onClick={() => disableWh(w.id, w.url)}
                      >
                        停用
                      </button>
                    ) : (
                      <button
                        className="ds-btn ds-btn--sm"
                        disabled={
                          busy ||
                          w.key_revoked_at != null ||
                          w.key_tier !== "realtime"
                        }
                        title={
                          w.key_revoked_at != null
                            ? "该端点挂在已吊销的 key 上,恢复了也不会投递 —— 需先签发新 realtime key 再登记端点"
                            : w.key_tier !== "realtime"
                              ? `该端点挂的 key 是 ${w.key_tier} tier,webhook 只服务 realtime`
                              : "恢复投递,并把连败计数清零(否则下一次失败会立刻二次熔断)"
                        }
                        onClick={() =>
                          void actWh(
                            { action: "enable", id: w.id },
                            `端点 #${w.id} 已恢复投递(连败计数已清零)`,
                          )
                        }
                      >
                        恢复
                      </button>
                    )}{" "}
                    <button
                      className="ds-btn ds-btn--sm ds-btn--danger"
                      disabled={busy}
                      onClick={() => deleteWh(w.id, w.url)}
                    >
                      删除
                    </button>
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
