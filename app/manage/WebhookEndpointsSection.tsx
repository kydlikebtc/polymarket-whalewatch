"use client";

import { useState } from "react";
import { Tag } from "../ui";
import { authHeaders, SUBSCRIBABLE } from "./shared";

// webhook 端点:登记 / 推送类型勾选 / 三件套(测试·停用↔恢复·删除)。
//
// 从 KeysSection 拆出来(2026-08-19):那个文件一度到 795 行,里面挤着三件
// 各自完整的事 —— key 签发吊销、端点登记、端点运维。数据仍由 KeysSection
// 统一拉取(一次 Promise.all 拿 keys/webhooks/busDefs),这里只收 props 并在
// 写操作后回调 reload:两个组件各自 fetch 会把 admin 路由的请求数翻倍,而
// 那些路由是 perIp 30/分钟的限流。
//
// error/notice 归本区块自己管 —— 端点操作的回执显示在端点表旁边,不必跑到
// 页面顶部去找。

/** 端点行的形状 —— 数据由 KeysSection 拉取,类型定义跟着渲染它的组件走。 */
export interface WebhookRow {
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

export interface BusDefRow {
  id: number;
  sourceType: string;
  label: string;
  threshold: number;
}

/** 端点行的推送类型标签。null/坏 JSON = 仅策略信号(历史默认)。 */
function pushTypes(raw: string | null) {
  let picked: string[] | null = null;
  try {
    if (raw) {
      const v: unknown = JSON.parse(raw);
      if (Array.isArray(v)) picked = v as string[];
    }
  } catch {
    // 一行脏数据不该白屏整张表。
    picked = null;
  }
  if (!picked) return <Tag>策略(默认)</Tag>;
  return picked.map((t) => (
    <Tag key={t}>{SUBSCRIBABLE.find((o) => o.type === t)?.label ?? t}</Tag>
  ));
}

export default function WebhookEndpointsSection({
  token,
  webhooks,
  realtimeKeys,
  busDefs,
  reload,
}: {
  token: string;
  webhooks: WebhookRow[] | null;
  /** 可挂端点的 key —— 只需要 id 与备注,不必知道 key 的其余字段。 */
  realtimeKeys: { id: number; label: string }[];
  busDefs: BusDefRow[];
  reload: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [whKeyId, setWhKeyId] = useState("");
  const [whUrl, setWhUrl] = useState("");
  const [whSecret, setWhSecret] = useState("");
  // 端点推送类型,默认仅策略信号(与存量端点的历史行为一致)。
  const [whSubs, setWhSubs] = useState<string[]>(["strategy"]);
  const [busy, setBusy] = useState(false);

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
        await reload();
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
      await reload();
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

  return (
    <>
      {/* 「realtime 专属 + 连败 10 次熔断」原本在这儿说一遍、表底说明条又说
          一遍 —— 只留表底那条(它就在「连败」列与三枚操作钮旁边)。 */}
      <div className="ds-label" style={{ marginBottom: "var(--s-3)" }}>
        webhook 端点
      </div>
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
        <div style={{ flexBasis: "100%" }}>
          <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
            推送类型（勾选须在 key 订阅范围内）
          </div>
          {/* 任选子集 —— 一排描边钮 + 选中态蓝描边,不用互斥控件。
              第二行是该类型下的 def 级细选（只订某一档）。 */}
          <div style={{ display: "grid", gap: "var(--s-2)" }}>
            {SUBSCRIBABLE.map((o) => {
              const typeDefs = busDefs.filter((d) => d.sourceType === o.type);
              const typeChecked = whSubs.includes(o.type);
              return (
                <div key={o.type} className="filter-row">
                  <button
                    type="button"
                    aria-pressed={typeChecked}
                    className={`ds-btn ds-btn--sm${typeChecked ? " ds-btn--active" : ""}`}
                    title={
                      typeDefs.length > 0
                        ? "选中 = 整类型（全部档）"
                        : undefined
                    }
                    onClick={() =>
                      setWhSubs((prev) => {
                        const rest = prev.filter(
                          (x) =>
                            x !== o.type &&
                            // 勾整类型时清掉该类型下的 def 细选(类型=全部)
                            !typeDefs.some((d) => `def:${d.id}` === x),
                        );
                        return typeChecked ? rest : [...rest, o.type];
                      })
                    }
                  >
                    {o.label}
                  </button>
                  {/* 「整类型 = 全部档」已在类型钮的 title 里,行内只留一个
                      指向后面那排档位钮的引导词。 */}
                  {typeDefs.length > 0 && (
                    <span className="ds-hint">或只选：</span>
                  )}
                  {typeDefs.map((d) => {
                    const ref = `def:${d.id}`;
                    const on = whSubs.includes(ref);
                    return (
                      <button
                        key={d.id}
                        type="button"
                        aria-pressed={on}
                        disabled={typeChecked}
                        className={`ds-btn ds-btn--sm${on ? " ds-btn--active" : ""}`}
                        title={`仅订「${d.label}」(≥${d.threshold})这一档`}
                        onClick={() =>
                          setWhSubs((prev) =>
                            prev.includes(ref)
                              ? prev.filter((x) => x !== ref)
                              : [...prev, ref],
                          )
                        }
                      >
                        {d.label}（≥{d.threshold}）
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        {/* 描边白底 —— 全页唯一的蓝底主按钮是页头的「刷新」,每屏至多一个。 */}
        <button
          className="ds-btn"
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
      {/* 「读不到」与「确实一个都没有」是两件事:上层 KeysSection 拉取失败时
          把 webhooks 置回 null,此刻屏幕上会同时出现 key 表的「需要有效管理
          令牌」与这里的「尚无端点」—— 后者把判不了说成了零。 */}
      {webhooks == null ? (
        <div className="ds-empty">
          还没读到端点清单。
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            {"与上方 key 表同一次请求,令牌失效时一起空;页头「刷新」可重取。"}
          </div>
        </div>
      ) : webhooks.length === 0 ? (
        <div className="ds-empty">
          尚无 webhook 端点。
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            {"端点只能挂在 realtime key 上 —— 在上方登记。"}
          </div>
        </div>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table">
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
              {/* 行没有任何行级强调：停用/吊销不调暗整行,只靠状态徽章分轻重。 */}
              {webhooks.map((w) => (
                <tr key={w.id}>
                  <td className="is-right muted" data-label="#">
                    {w.id}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }} data-label="key">
                    #{w.api_key_id} {w.key_label}
                  </td>
                  {/* URL 是有意义的文本,不截断 —— 换行。只有钱包地址与
                      交易哈希做首尾省略。 */}
                  <td
                    className="cell-wrap"
                    style={{ maxWidth: 280 }}
                    data-label="URL"
                  >
                    {w.url}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }} data-label="推送类型">
                    {pushTypes(w.bus_types)}
                  </td>
                  <td className="is-right" data-label="连败">
                    {w.consecutive_failures}
                    {w.last_error && (
                      <div className="ds-hint cell-wrap" title={w.last_error}>
                        {w.last_error}
                      </div>
                    )}
                  </td>
                  {/* 「已停用」是需留神的状态(手动停用,或连败 10 次自动熔断),
                      走琥珀 —— 灰底是名称标签,不表状态,此前它把一个「不再投递」
                      的端点渲染得像个中性名字。 */}
                  <td data-label="状态">
                    {w.key_revoked_at != null ? (
                      <Tag variant="down">key 已吊销</Tag>
                    ) : w.active === 1 ? (
                      <Tag variant="up">活跃</Tag>
                    ) : (
                      <Tag variant="warn">已停用</Tag>
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
          <div className="note-strip">
            {
              "「连败」到 10 自动熔断(转「已停用」,不再投递),恢复前先点「测试」。「停用」保留端点与投递史,「删除」连 HMAC secret 一并销毁。"
            }
          </div>
        </div>
      )}
    </>
  );
}
