"use client";

import { useCallback, useEffect, useState } from "react";
import { Tag } from "../ui";
import { SectionHead } from "./bits";
import { agoText, authHeaders, timeText } from "./shared";

// 区块:𝕏 播报账号(3-legged OAuth 授权 + 主/备切换)。
//
// 语义(设计定稿):同时只有一个账号「使用中」,其余待命 —— 封号/换品牌/
// 测试号转正式号时一键切换,引擎下一轮(≤60s)自动改用新账号,无需重启。
// access token 存在库里,本页永不显示它们(只显示 @handle 与时间)。

interface XAccountRow {
  id: number;
  userId: string;
  screenName: string;
  isActive: boolean;
  createdAt: number;
  lastPostAt: number | null;
}

interface XPostRow {
  id: number;
  kind: string;
  text: string;
  status: string;
  xPostId: string | null;
  costUsd: number;
  createdAt: number;
}

interface Payload {
  accounts: XAccountRow[];
  kinds: Record<string, boolean>;
  history: {
    posts: XPostRow[];
    spentThisMonthUsd: number;
    counts: Record<string, number>;
  };
  budgetUsd: number;
  appConfigured: boolean;
  envFallback: boolean;
  callbackUrl: string;
}

// 各类内容的展示元数据(与 lib/xSettings.X_KINDS 同源语义;这里是客户端
// 组件,不能 import 那个碰 DB 的模块,故就近镜像一份最小集)。
const KINDS: { kind: string; label: string; hint: string }[] = [
  {
    kind: "whale",
    label: "🐳 巨鲸大单",
    hint: "量最大,最容易吃满日配额(上限 20 条/天)",
  },
  {
    kind: "consensus",
    label: "🔥 聪明钱共识",
    hint: "稀有且独家,优先级最高,不设日上限",
  },
  {
    kind: "pregame",
    label: "⏰ 赛前聚合",
    hint: "结算前 1-6h 热门市场汇总,至多 3 条/天",
  },
  {
    kind: "weekly",
    label: "📊 周报成绩单",
    hint: "每周一图卡 + 链接,唯一的 $0.20 帖",
  },
  {
    kind: "settled",
    label: "✅ 结算战报",
    hint: "回复自己发过的信号帖,补上结果(赢输都发),至多 5 条/天。默认关",
  },
];

const STATUS_TONE: Record<string, "up" | "down" | "warn" | "default"> = {
  posted: "up",
  failed: "down",
  claimed: "warn",
  skipped: "default",
};

const STATUS_TEXT: Record<string, string> = {
  posted: "已发布",
  failed: "失败",
  claimed: "发送中",
  skipped: "已跳过",
};

// 回调结果经 URL query 带回(见 app/api/x-callback),读完即从地址栏抹掉,
// 免得刷新页面时反复弹同一条提示。
const AUTH_MSG: Record<string, { text: string; tone: "ok" | "err" }> = {
  ok: { text: "账号授权成功", tone: "ok" },
  denied: { text: "已取消授权（在 X 页面点了拒绝）", tone: "err" },
  expired: {
    text: "授权已过期或链接已被使用，请重新发起（15 分钟内有效，且只能用一次）",
    tone: "err",
  },
  bad_request: { text: "回调参数不完整，请重新发起授权", tone: "err" },
  failed: { text: "换取 access token 失败，详见服务器日志", tone: "err" },
};

export default function XAccountsSection({ token }: { token: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    text: string;
    tone: "ok" | "err";
  } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/x-accounts", {
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

  // 授权回调带回的结果提示(一次性)。
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const r = q.get("x_auth");
    if (!r) return;
    const m = AUTH_MSG[r];
    const handle = q.get("handle");
    if (m) {
      setNotice({
        text: handle ? `${m.text}：@${handle}` : m.text,
        tone: m.tone,
      });
    }
    q.delete("x_auth");
    q.delete("handle");
    const rest = q.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (rest ? `?${rest}` : ""),
    );
  }, []);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/x-accounts", {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as {
        url?: string;
        ok?: boolean;
        error?: string;
      };
      if (j.error) {
        setError(j.error);
        return;
      }
      if (j.url) {
        // 授权页开新标签:当前页面保持不动,回调会跳回 /manage。
        window.open(j.url, "_blank", "noopener,noreferrer");
        return;
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ds-card" style={{ padding: "var(--s-5)" }}>
      <SectionHead
        title="🅒 𝕏 播报账号"
        hint="同时只有一个账号「使用中」，其余待命。切换后引擎下一轮（≤60s）自动改用新账号，无需重启。"
        aside={
          <button
            className="ds-btn ds-btn--primary ds-btn--sm"
            disabled={busy || !token || !data?.appConfigured}
            onClick={() => void post({ action: "start" })}
          >
            授权新账号
          </button>
        }
      />

      {notice ? (
        <div
          className={
            notice.tone === "ok" ? "ds-callout" : "ds-callout ds-callout--error"
          }
          style={{ marginBottom: "var(--s-3)" }}
        >
          {notice.text}
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

      {data && !data.appConfigured ? (
        <div className="ds-callout" style={{ marginBottom: "var(--s-3)" }}>
          未配置 X App 凭据：请在服务器 <code>.env</code> 设置{" "}
          <code>X_API_KEY</code> 与 <code>X_API_SECRET</code> 后重启。这两项属于
          App（不属于账号），永远只从 .env 读、不进库。
        </div>
      ) : null}

      {data ? (
        <div className="ds-callout" style={{ marginBottom: "var(--s-3)" }}>
          X App 后台的 Callback URI 必须<b>逐字</b>登记为：
          <code style={{ marginLeft: 6 }}>{data.callbackUrl}</code>
          {data.envFallback && data.accounts.length === 0 ? (
            <div style={{ marginTop: 6 }}>
              当前使用 .env 里的单账号 token 发帖（向后兼容）。授权任意账号后，
              库中账号优先。
            </div>
          ) : null}
        </div>
      ) : null}

      {!token ? (
        <div className="ds-empty">填入管理令牌后可查看与管理授权账号</div>
      ) : !data ? (
        <div className="ds-empty">加载中…</div>
      ) : data.accounts.length === 0 ? (
        <div className="ds-empty">
          尚无授权账号 —— 点右上角「授权新账号」，用要发帖的那个 X
          账号登录并同意
        </div>
      ) : (
        <table className="ds-table ds-table--compact">
          <thead>
            <tr>
              <th>账号</th>
              <th>状态</th>
              <th>授权时间</th>
              <th>最近发帖</th>
              <th className="is-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {data.accounts.map((a) => (
              <tr
                key={a.id}
                style={a.isActive ? { background: "var(--up-50)" } : undefined}
              >
                <td data-label="账号">
                  <a
                    className="mono"
                    href={`https://x.com/${a.screenName}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    @{a.screenName}
                  </a>
                </td>
                <td data-label="状态">
                  {a.isActive ? (
                    <Tag variant="up">🟢 使用中</Tag>
                  ) : (
                    <Tag>待命</Tag>
                  )}
                </td>
                <td className="mono muted" data-label="授权时间">
                  {timeText(a.createdAt)}
                </td>
                <td className="mono muted" data-label="最近发帖">
                  {agoText(a.lastPostAt)}
                </td>
                <td className="is-right" data-label="操作">
                  {!a.isActive ? (
                    <button
                      className="ds-btn ds-btn--sm"
                      disabled={busy}
                      onClick={() =>
                        void post({ action: "activate", id: a.id })
                      }
                    >
                      设为使用中
                    </button>
                  ) : null}{" "}
                  <button
                    className="ds-btn ds-btn--danger ds-btn--sm"
                    disabled={busy}
                    onClick={() => {
                      // 删使用中的账号会让播报换号(或在没有其它账号时停摆),
                      // 与全站危险操作一致地二次确认。
                      const msg = a.isActive
                        ? `@${a.screenName} 正在使用中，删除后将由其余账号顶上（若无其余账号则停止发帖）。确认删除？`
                        : `确认删除 @${a.screenName} 的授权？`;
                      if (window.confirm(msg)) {
                        void post({ action: "delete", id: a.id });
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

      {data ? (
        <>
          {/* ---- 播报内容设置 ---- */}
          <div style={{ marginTop: "var(--s-6)" }}>
            <SectionHead
              title="播报内容类型"
              hint="关掉的类型不再发帖也不占预算；改完引擎下一轮（≤60s）生效，无需重启。重新开启不会补发关闭期间的旧内容。"
            />
            <div
              style={{
                display: "grid",
                gap: "var(--s-2)",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              }}
            >
              {KINDS.map((k) => {
                const on = data.kinds[k.kind] !== false;
                return (
                  <label
                    key={k.kind}
                    className="ds-card"
                    style={{
                      padding: "var(--s-3)",
                      display: "flex",
                      gap: "var(--s-2)",
                      alignItems: "flex-start",
                      cursor: busy ? "default" : "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={busy || !token}
                      onChange={(e) =>
                        void post({
                          action: "kinds",
                          kinds: { [k.kind]: e.target.checked },
                        })
                      }
                      style={{ marginTop: 3 }}
                    />
                    <span style={{ display: "grid", gap: 2 }}>
                      <span style={{ fontWeight: 500 }}>
                        {k.label}{" "}
                        {!on ? <Tag variant="warn">已关闭</Tag> : null}
                      </span>
                      <span className="ds-hint">{k.hint}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* ---- 发帖历史 ---- */}
          <div style={{ marginTop: "var(--s-6)" }}>
            <SectionHead
              title="播报历史"
              hint="最近 50 条。「已跳过」= 被类型开关/金额阈值/预算熔断拦下，未发出也不计费。"
              aside={
                <span className="ds-hint mono">
                  本月已花费 ${data.history.spentThisMonthUsd.toFixed(3)} / $
                  {data.budgetUsd}
                  {Object.entries(data.history.counts).length > 0 ? (
                    <span className="muted">
                      {" · "}
                      {Object.entries(data.history.counts)
                        .map(([k, v]) => `${STATUS_TEXT[k] ?? k} ${v}`)
                        .join(" · ")}
                    </span>
                  ) : null}
                </span>
              }
            />
            {data.history.posts.length === 0 ? (
              <div className="ds-empty">
                还没有播报记录 —— 授权账号并等待信号触发后，这里会出现每条帖子
              </div>
            ) : (
              <table className="ds-table ds-table--compact">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>类型</th>
                    <th>状态</th>
                    <th>内容</th>
                    <th className="is-right">成本</th>
                    <th>链接</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.posts.map((pst) => (
                    <tr key={pst.id}>
                      <td className="mono muted" data-label="时间">
                        {timeText(pst.createdAt)}
                      </td>
                      <td data-label="类型">
                        {KINDS.find((k) => k.kind === pst.kind)?.label ??
                          pst.kind}
                      </td>
                      <td data-label="状态">
                        <Tag variant={STATUS_TONE[pst.status] ?? "default"}>
                          {STATUS_TEXT[pst.status] ?? pst.status}
                        </Tag>
                      </td>
                      <td
                        data-label="内容"
                        style={{
                          whiteSpace: "normal",
                          maxWidth: 420,
                          fontSize: "var(--t-sm)",
                        }}
                      >
                        {pst.text || <span className="muted">—</span>}
                      </td>
                      <td className="mono is-right" data-label="成本">
                        {pst.costUsd > 0 ? `$${pst.costUsd.toFixed(3)}` : "—"}
                      </td>
                      <td data-label="链接">
                        {pst.xPostId ? (
                          <a
                            href={`https://x.com/i/status/${pst.xPostId}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            查看 ↗
                          </a>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
