"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Tag } from "../ui";
import { SectionHead } from "./bits";
import { agoText, authHeaders, timeText } from "./shared";
import { sectionView } from "./sectionGate";

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

// 数字参数(镜像 lib/xParams.XBroadcastParams;客户端组件不能 import 碰 DB
// 的模块)。params = 生效值,defaults = 出厂值(含 env 派生的预算/阈值)。
interface XParams {
  budgetUsd: number;
  dailySpendCapUsd: number | null;
  weeklySpendCapUsd: number | null;
  whaleMinTradeUsd: number;
  whaleDailyCap: number;
  whaleSirenUsd: number;
  consensusDailyCap: number | null;
  pregameDailyCap: number;
  pregameMinH: number;
  pregameMaxH: number;
  settledDailyCap: number;
  weeklyUtcHour: number;
  pulseUtcHour: number;
}

interface HistogramDay {
  day: string;
  total: number;
  hours: Record<string, number>[];
}

interface Payload {
  accounts: XAccountRow[];
  kinds: Record<string, boolean>;
  history: {
    posts: XPostRow[];
    spentThisMonthUsd: number;
    counts: Record<string, number>;
  };
  params: XParams;
  defaults: XParams;
  /** 各 kind 的文案模板;null = 内置文案。 */
  templates: Record<string, string | null>;
  /** 各 kind 可用的 {占位符} 词表(服务端 TEMPLATE_VOCAB,图例用)。 */
  templateVocab: Record<string, string[]>;
  /** 近 14 天,天 × UTC 小时 × 类型的 posted 计数。 */
  histogram: HistogramDay[];
  budgetUsd: number;
  appConfigured: boolean;
  envFallback: boolean;
  callbackUrl: string;
}

// 各类内容的展示元数据(与 lib/xSettings.X_KINDS 同源语义;这里是客户端
// 组件,不能 import 那个碰 DB 的模块,故就近镜像一份最小集)。
// hint 不再写死数字 —— 由生效参数动态生成(kindHint),页面永不说旧话。
const KINDS: { kind: string; label: string }[] = [
  { kind: "whale", label: "🐳 巨鲸大单" },
  { kind: "consensus", label: "🔥 聪明钱共识" },
  { kind: "pregame", label: "⏰ 赛前聚合" },
  { kind: "weekly", label: "📊 周报成绩单" },
  { kind: "settled", label: "✅ 结算战报" },
  { kind: "pulse", label: "📈 异常市场日榜" },
  { kind: "divergence", label: "⚔️ 小单vs鲸鱼分歧" },
];

function kindHint(kind: string, p: XParams): string {
  switch (kind) {
    case "whale":
      return `单笔 ≥ $${p.whaleMinTradeUsd.toLocaleString("en-US")} 即发,≥ $${p.whaleSirenUsd.toLocaleString("en-US")} 升 🚨 警报抬头。量最大,最容易吃满日配额(上限 ${p.whaleDailyCap} 条/天)`;
    case "consensus":
      return p.consensusDailyCap == null
        ? "稀有且独家,优先级最高,不设日上限"
        : `稀有且独家,优先级最高,至多 ${p.consensusDailyCap} 条/天`;
    case "pregame":
      return `结算前 ${p.pregameMinH}-${p.pregameMaxH}h 热门市场汇总,至多 ${p.pregameDailyCap} 条/天`;
    case "weekly":
      return `每周一 ${String(p.weeklyUtcHour).padStart(2, "0")}:00 UTC 后图卡 + 链接,唯一的 $0.20 帖`;
    case "settled":
      return `回复自己发过的信号帖,补上结果(赢输都发),至多 ${p.settledDailyCap} 条/天。默认关`;
    case "pulse":
      return `每日 ${String(p.pulseUtcHour).padStart(2, "0")}:00 UTC 后发昨日最异常市场(异常分四分量拆解,与 /pulse 页同源),每天至多 1 条。默认关`;
    case "divergence":
      return `每日 ${String(p.pulseUtcHour).padStart(2, "0")}:00 UTC 后发昨日「小单与鲸鱼对立」的市场(双边材料性达标才有),每天至多 1 条,无分歧的日子静默。默认关`;
    default:
      return "";
  }
}

// 每张卡片下渲染的参数输入。suffix 是输入框后的单位字;width 给长数字留位。
const PARAM_FIELDS: Record<
  string,
  { key: keyof XParams; label: string; suffix?: string; width?: number }[]
> = {
  whale: [
    { key: "whaleDailyCap", label: "日上限", suffix: "条" },
    { key: "whaleMinTradeUsd", label: "单笔 ≥ $", width: 88 },
    { key: "whaleSirenUsd", label: "🚨 级 ≥ $", width: 88 },
  ],
  consensus: [{ key: "consensusDailyCap", label: "日上限", suffix: "条" }],
  pregame: [
    { key: "pregameDailyCap", label: "日上限", suffix: "条" },
    { key: "pregameMinH", label: "窗口 ≥", suffix: "h" },
    { key: "pregameMaxH", label: "≤", suffix: "h" },
  ],
  weekly: [{ key: "weeklyUtcHour", label: "周一", suffix: "点(UTC)后发" }],
  settled: [{ key: "settledDailyCap", label: "日上限", suffix: "条" }],
  // 日榜与分歧共用同一发帖时刻(同一底座、同一节奏);字段挂在日榜卡下,
  // 分歧卡 hint 里已写明共用。
  pulse: [{ key: "pulseUtcHour", label: "每日", suffix: "点(UTC)后发" }],
  divergence: [],
};

// 客户端预检的字段名(拦「不是数」;规则校验由服务端 zod 说了算)。
const PARAM_LABELS: Record<keyof XParams, string> = {
  budgetUsd: "月花费上限",
  dailySpendCapUsd: "日花费上限",
  weeklySpendCapUsd: "周花费上限",
  whaleMinTradeUsd: "巨鲸金额阈值",
  whaleDailyCap: "巨鲸日上限",
  whaleSirenUsd: "巨鲸警报级阈值",
  consensusDailyCap: "共识日上限",
  pregameDailyCap: "赛前日上限",
  pregameMinH: "赛前窗口下限",
  pregameMaxH: "赛前窗口上限",
  settledDailyCap: "战报日上限",
  weeklyUtcHour: "周报发帖时刻",
  pulseUtcHour: "脉搏日帖时刻",
};

// 空串合法(= 不限)的可空参数;其余字段空串是校验错误。
const NULLABLE_PARAMS = new Set<keyof XParams>([
  "consensusDailyCap",
  "dailySpendCapUsd",
  "weeklySpendCapUsd",
]);

// 表单以字符串保存(数字输入的中间态如「1.」必须可存在);可空参数空串
// = 不限。
type ParamForm = Record<keyof XParams, string>;

function toForm(p: XParams): ParamForm {
  const s = (v: number | null) => (v == null ? "" : String(v));
  return {
    budgetUsd: String(p.budgetUsd),
    dailySpendCapUsd: s(p.dailySpendCapUsd),
    weeklySpendCapUsd: s(p.weeklySpendCapUsd),
    whaleMinTradeUsd: String(p.whaleMinTradeUsd),
    whaleDailyCap: String(p.whaleDailyCap),
    whaleSirenUsd: String(p.whaleSirenUsd),
    consensusDailyCap: s(p.consensusDailyCap),
    pregameDailyCap: String(p.pregameDailyCap),
    pregameMinH: String(p.pregameMinH),
    pregameMaxH: String(p.pregameMaxH),
    pulseUtcHour: String(p.pulseUtcHour),
    settledDailyCap: String(p.settledDailyCap),
    weeklyUtcHour: String(p.weeklyUtcHour),
  };
}

// 文案模板表单:kind → 模板字符串("" = 内置)。
type TplForm = Record<string, string>;

function toTplForm(t: Record<string, string | null>): TplForm {
  const out: TplForm = {};
  for (const k of KINDS) out[k.kind] = t[k.kind] ?? "";
  return out;
}

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
  const [form, setForm] = useState<ParamForm | null>(null);
  const [tplForm, setTplForm] = useState<TplForm | null>(null);
  // 表单的种子快照:kinds 开关等无关操作也会触发重载,不能冲掉尚未保存的
  // 数字/文案输入 —— 只有服务端对应值真变了(保存成功)才重置表单。
  const seededFrom = useRef<string>("");
  const seededTpl = useRef<string>("");

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
      const pj = JSON.stringify(j.params);
      if (seededFrom.current !== pj) {
        seededFrom.current = pj;
        setForm(toForm(j.params));
      }
      const tj = JSON.stringify(j.templates);
      if (seededTpl.current !== tj) {
        seededTpl.current = tj;
        setTplForm(toTplForm(j.templates));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token]);

  useEffect(() => {
    // 不按本地 token 拦 —— 能不能读由服务端说了算(见 ./sectionGate)。
    void load();
  }, [load]);

  const view = sectionView(data, error);

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

  // 数字参数整表提交。客户端只拦「不是数」,范围/跨键规则由服务端 zod
  // 说了算(读写两侧同规,错误信息原样展示)。
  const saveParams = () => {
    if (!form) return;
    const params: Record<string, number | null> = {};
    for (const key of Object.keys(PARAM_LABELS) as (keyof XParams)[]) {
      const raw = form[key].trim();
      if (NULLABLE_PARAMS.has(key) && raw === "") {
        params[key] = null; // 空 = 明确的「不限」
        continue;
      }
      const n = Number(raw);
      if (raw === "" || !Number.isFinite(n)) {
        setError(`「${PARAM_LABELS[key]}」不是有效数字:${raw || "(空)"}`);
        return;
      }
      params[key] = n;
    }
    void post({ action: "params", params });
  };

  // 文案模板整表提交:空串 = 恢复内置。词表/长度/URL 校验都在服务端
  // (lib/xTemplates),错误信息原样展示。
  const saveTemplates = () => {
    if (!tplForm) return;
    const templates: Record<string, string | null> = {};
    for (const k of KINDS) {
      const v = tplForm[k.kind].trim();
      templates[k.kind] = v === "" ? null : v;
    }
    void post({ action: "templates", templates });
  };

  // 有未保存的改动时才点亮对应保存钮。字符串级比较即可:格式化差异
  // (如 "020")造成的假 dirty 只是让按钮可点,保存后即归位。
  const dirty =
    !!data &&
    !!form &&
    JSON.stringify(form) !== JSON.stringify(toForm(data.params));
  const dirtyTpl =
    !!data &&
    !!tplForm &&
    JSON.stringify(tplForm) !== JSON.stringify(toTplForm(data.templates));

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

      {view.kind === "error" ? (
        <div className="ds-empty">{view.message}</div>
      ) : view.kind === "loading" ? (
        <div className="ds-empty">加载中…</div>
      ) : data!.accounts.length === 0 ? (
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
            {view.data.accounts.map((a) => (
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
              hint="关掉的类型不再发帖也不占预算；数字参数（日上限/阈值/窗口/预算）改完点「保存参数」。开关与参数都在引擎下一轮（≤60s）生效，无需重启。重新开启不会补发关闭期间的旧内容。"
              aside={
                <button
                  className="ds-btn ds-btn--primary ds-btn--sm"
                  disabled={busy || !token || !dirty}
                  onClick={saveParams}
                >
                  保存参数
                </button>
              }
            />
            {form ? (
              <div
                className="ds-hint"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "wrap",
                  marginBottom: "var(--s-2)",
                }}
              >
                💰 花费上限(全类型共享)：日 $
                <input
                  className="ds-input mono"
                  style={{ width: 56, padding: "2px 6px" }}
                  value={form.dailySpendCapUsd}
                  placeholder="不限"
                  title="UTC 日花费上限(claimed+posted 台账口径)。留空 = 不限"
                  disabled={busy || !token}
                  onChange={(e) =>
                    setForm({ ...form, dailySpendCapUsd: e.target.value })
                  }
                />
                · 周 $
                <input
                  className="ds-input mono"
                  style={{ width: 56, padding: "2px 6px" }}
                  value={form.weeklySpendCapUsd}
                  placeholder="不限"
                  title="UTC 周(周一起)花费上限。留空 = 不限"
                  disabled={busy || !token}
                  onChange={(e) =>
                    setForm({ ...form, weeklySpendCapUsd: e.target.value })
                  }
                />
                · 月 $
                <input
                  className="ds-input mono"
                  style={{ width: 56, padding: "2px 6px" }}
                  value={form.budgetUsd}
                  title={`月硬熔断,必填。默认 $${data.defaults.budgetUsd}(来自 .env X_MONTHLY_BUDGET_USD)`}
                  disabled={busy || !token}
                  onChange={(e) =>
                    setForm({ ...form, budgetUsd: e.target.value })
                  }
                />
                —— 月上限是硬熔断(必填,默认来自
                .env，保存后以后台值为准)；日/周留空 = 不限。
              </div>
            ) : null}
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
                  <div
                    key={k.kind}
                    className="ds-card"
                    style={{
                      padding: "var(--s-3)",
                      display: "grid",
                      gap: "var(--s-2)",
                      alignContent: "start",
                    }}
                  >
                    {/* 开关独占内层 label:参数输入不能进 label,否则点
                        输入框会误触 checkbox。 */}
                    <label
                      style={{
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
                        <span className="ds-hint">
                          {kindHint(k.kind, data.params)}
                        </span>
                      </span>
                    </label>
                    {form ? (
                      <span
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          alignItems: "center",
                          gap: "var(--s-2)",
                          paddingLeft: 24,
                        }}
                      >
                        {(PARAM_FIELDS[k.kind] ?? []).map((f) => (
                          <label
                            key={f.key}
                            className="ds-hint"
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                            }}
                          >
                            {f.label}
                            <input
                              className="ds-input mono"
                              style={{
                                width: f.width ?? 52,
                                padding: "2px 6px",
                              }}
                              value={form[f.key]}
                              placeholder={
                                f.key === "consensusDailyCap" ? "不限" : ""
                              }
                              title={
                                f.key === "consensusDailyCap"
                                  ? "默认不限(留空)"
                                  : `默认 ${String(data.defaults[f.key])}`
                              }
                              disabled={busy || !token}
                              onChange={(e) =>
                                setForm({ ...form, [f.key]: e.target.value })
                              }
                            />
                            {f.suffix}
                          </label>
                        ))}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ---- 文案模板 ---- */}
          <div style={{ marginTop: "var(--s-6)" }}>
            <SectionHead
              title="✍️ 文案模板"
              hint="留空 = 内置英文文案。{占位符} 替换为实时数据，数据缺失的段渲染为空并自动收行。保存时校验：未知占位符/缺 {title}/夹带链接/固定部分超长都会被拒；运行时超 280 加权字符自动截标题，模板不可用则回退内置 —— 怎么都不会发出折叠帖或带链接帖。"
              aside={
                <button
                  className="ds-btn ds-btn--primary ds-btn--sm"
                  disabled={busy || !token || !dirtyTpl}
                  onClick={saveTemplates}
                >
                  保存文案
                </button>
              }
            />
            {tplForm ? (
              <div style={{ display: "grid", gap: "var(--s-3)" }}>
                {KINDS.map((k) => (
                  <div key={k.kind} style={{ display: "grid", gap: 4 }}>
                    <span className="ds-hint">
                      <b>{k.label}</b>
                      {data.templates[k.kind] ? (
                        <Tag variant="up">自定义中</Tag>
                      ) : (
                        <span className="muted">（内置）</span>
                      )}
                      {" · 可用占位符:"}
                      <code>
                        {(data.templateVocab[k.kind] ?? [])
                          .map((v) => `{${v}}`)
                          .join(" ")}
                      </code>
                    </span>
                    <textarea
                      className="ds-input mono"
                      rows={3}
                      style={{
                        width: "100%",
                        resize: "vertical",
                        fontSize: "var(--t-sm)",
                      }}
                      value={tplForm[k.kind]}
                      placeholder="留空 = 内置文案"
                      disabled={busy || !token}
                      onChange={(e) =>
                        setTplForm({ ...tplForm, [k.kind]: e.target.value })
                      }
                    />
                  </div>
                ))}
              </div>
            ) : null}
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
            {data.histogram.some((d2) => d2.total > 0) ? (
              <div style={{ margin: "var(--s-2) 0", overflowX: "auto" }}>
                <div className="ds-hint" style={{ marginBottom: 4 }}>
                  时间分布 · 近 14 天 × UTC
                  小时，仅统计已发布。悬停格子看类型明细。
                </div>
                <table
                  className="ds-table ds-table--compact"
                  style={{ width: "auto" }}
                >
                  <thead>
                    <tr>
                      <th />
                      {Array.from({ length: 24 }, (_, h) => (
                        <th
                          key={h}
                          className="mono muted"
                          style={{ padding: "2px 4px", fontSize: 10 }}
                        >
                          {h}
                        </th>
                      ))}
                      <th
                        className="mono muted"
                        style={{ padding: "2px 4px", fontSize: 10 }}
                      >
                        Σ
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.histogram.map((d2) => (
                      <tr key={d2.day}>
                        <td
                          className="mono muted"
                          style={{ padding: "2px 6px", fontSize: 11 }}
                        >
                          {d2.day}
                        </td>
                        {d2.hours.map((cell, h) => {
                          const total = Object.values(cell).reduce(
                            (a, b) => a + b,
                            0,
                          );
                          const tip = Object.entries(cell)
                            .map(
                              ([kk, n]) =>
                                `${KINDS.find((x) => x.kind === kk)?.label ?? kk} ×${n}`,
                            )
                            .join("\n");
                          return (
                            <td
                              key={h}
                              className="mono is-right"
                              title={tip || undefined}
                              style={{
                                padding: "2px 4px",
                                fontSize: 11,
                                background:
                                  total > 0 ? "var(--up-50)" : undefined,
                                // 量级一眼可辨:≥5 加粗(接近日 cap 的时段)。
                                fontWeight: total >= 5 ? 700 : undefined,
                              }}
                            >
                              {total > 0 ? (
                                total
                              ) : (
                                <span className="muted">·</span>
                              )}
                            </td>
                          );
                        })}
                        <td
                          className="mono is-right"
                          style={{
                            padding: "2px 6px",
                            fontSize: 11,
                            fontWeight: 600,
                          }}
                        >
                          {d2.total}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
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
