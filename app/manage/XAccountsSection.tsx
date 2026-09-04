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
  scorecardUtcHour: number;
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
//
// hint 是一句话的身份说明,不再复述数字:日上限 / 金额阈值 / 窗口 / 发帖时刻
// 全都以输入框的形式就在同一张卡里(PARAM_FIELDS),在句子里再写一遍等于同一
// 个数出现两处。「默认关」也删了 —— 开关自己就在左边,出厂值不是读数。
// 只有 divergence 的发帖时刻没有自己的输入框(与日榜共用),故那句留在 hint。
const KINDS: { kind: string; label: string; hint: string }[] = [
  {
    kind: "whale",
    label: "🐳 巨鲸大单",
    // emoji 不进正文句子(它只住灰底标签 / KPI 图标位 / 12px 小标前缀)——
    // 下方那枚输入框的标签「🚨 级 ≥ $」才是它的位置。
    hint: "单笔达阈值即发,超警报级金额时抬头升级;量最大,最容易吃满日配额",
  },
  { kind: "consensus", label: "🔥 聪明钱共识", hint: "稀有且独家,优先级最高" },
  { kind: "pregame", label: "⏰ 赛前聚合", hint: "结算前窗口内的热门市场汇总" },
  {
    kind: "weekly",
    label: "📊 周报成绩单",
    hint: "每周一发图卡 + 链接,唯一的 $0.20 帖",
  },
  {
    kind: "settled",
    label: "✅ 结算战报",
    hint: "回复自己发过的信号帖补结果(赢输都发);自回复没有独立分发,曝光靠「每日战报榜」",
  },
  {
    kind: "scorecard",
    label: "📋 每日战报榜",
    hint: "昨日全部结算聚成一条主帖(有输单必带),每天至多 1 条,0 结算的日子静默",
  },
  {
    kind: "pulse",
    label: "📈 异常市场日榜",
    hint: "昨日最异常市场(与 /pulse 页同源),每天至多 1 条",
  },
  {
    kind: "divergence",
    label: "⚔️ 小单vs鲸鱼分歧",
    hint: "昨日「小单与鲸鱼对立」的市场,每天至多 1 条,无分歧的日子静默;发帖时刻与日榜共用",
  },
];

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
  scorecard: [
    { key: "scorecardUtcHour", label: "每日", suffix: "点(UTC)后发" },
  ],
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
  scorecardUtcHour: "战报榜发帖时刻",
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
    scorecardUtcHour: String(p.scorecardUtcHour),
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

// skipped 刻意不在表里:灰底描边是**名称标签**,不表状态,而按运营现状(日
// 上限 22 条/天)跳过是常态 —— 整列徽章会把每一轮正常限流渲染成事故。它在
// 表格里走 muted 纯文字,见下方状态格。也不能改琥珀:琥珀是「需留神的口径」。
const STATUS_TONE: Record<string, "up" | "down" | "warn" | "default"> = {
  posted: "up",
  failed: "down",
  claimed: "warn",
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
    <section
      className="ds-card"
      style={{ padding: "var(--s-5)", marginBottom: "var(--s-5)" }}
    >
      <SectionHead
        title="🅒 𝕏 播报账号"
        // 「一个使用中、其余待命」原本在这儿与表底说明条逐字重复 —— 只留表底
        // 那条(它就在状态列旁边)。
        aside={
          // 描边白底 —— 页头的「刷新」是全页唯一的蓝底主按钮,任何子 tab 上
          // 都同屏可见。
          <button
            className="ds-btn ds-btn--sm"
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
        <div
          className="ds-callout ds-callout--warn"
          style={{ marginBottom: "var(--s-3)" }}
        >
          未配置 X App 凭据：请在服务器 <code className="doc-code">.env</code>{" "}
          设置 <code className="doc-code">X_API_KEY</code> 与{" "}
          <code className="doc-code">X_API_SECRET</code> 后重启。
        </div>
      ) : null}

      {data ? (
        <div className="ds-callout" style={{ marginBottom: "var(--s-3)" }}>
          X App 后台的 Callback URI 必须<b>逐字</b>登记为：
          <code className="doc-code" style={{ marginLeft: 6 }}>
            {data.callbackUrl}
          </code>
          {data.envFallback && data.accounts.length === 0 ? (
            <div style={{ marginTop: 6 }}>
              当前用 .env 的单账号 token 发帖；授权后库中账号优先。
            </div>
          ) : null}
        </div>
      ) : null}

      {view.kind === "error" ? (
        <div className="ds-empty">
          {view.message}
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            通常是管理令牌失效;换令牌后自动重试。
          </div>
        </div>
      ) : view.kind === "loading" ? (
        <div className="ds-empty">正在读取授权账号…</div>
      ) : data!.accounts.length === 0 ? (
        <div className="ds-empty">
          尚无授权账号。
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            {"点右上角「授权新账号」;在此之前引擎用 .env 的单账号 token 发帖。"}
          </div>
        </div>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table">
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
              {/* 行没有任何行级强调：使用中不染整行,只靠状态徽章分轻重。 */}
              {view.data.accounts.map((a) => (
                <tr key={a.id}>
                  <td data-label="账号">
                    <a
                      href={`https://x.com/${a.screenName}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      @{a.screenName}
                    </a>
                  </td>
                  {/* 「待命」不是故障也不是名字 —— 灰底名称标签不表状态,中性
                      态走 muted 纯文字,让绿徽章一眼指出唯一在用的那个账号。 */}
                  <td data-label="状态">
                    {a.isActive ? (
                      <Tag variant="up">✅ 使用中</Tag>
                    ) : (
                      <span className="muted">待命</span>
                    )}
                  </td>
                  <td className="muted" data-label="授权时间">
                    {timeText(a.createdAt)}
                  </td>
                  <td className="muted" data-label="最近发帖">
                    {agoText(a.lastPostAt)}
                  </td>
                  <td
                    className="is-right"
                    data-label="操作"
                    style={{ whiteSpace: "nowrap" }}
                  >
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
          <div className="note-strip">
            {
              "同时只有一个账号「使用中」,点「设为使用中」即换号,引擎下一轮(≤60s)自动改用。access token 存在库里,本页永不显示。"
            }
          </div>
        </div>
      )}

      {data ? (
        <>
          {/* ---- 播报内容设置 ---- */}
          <div style={{ marginTop: "var(--s-6)" }}>
            <SectionHead
              title="播报内容类型"
              hint="关掉的类型不再发帖也不占预算，重新开启不补发。改完点「保存参数」，引擎下一轮（≤60s）生效。"
              aside={
                /* 描边白底 —— 全页唯一的蓝底主按钮是页头的「刷新」。 */
                <button
                  className="ds-btn ds-btn--sm"
                  disabled={busy || !token || !dirty}
                  onClick={saveParams}
                >
                  保存参数
                </button>
              }
            />
            {form ? (
              <>
                <div
                  className="ds-label"
                  style={{ marginBottom: "var(--s-2)" }}
                >
                  💰 花费上限（全类型共享）
                </div>
                <div
                  className="filter-row"
                  style={{ marginBottom: "var(--s-2)" }}
                >
                  <span className="filter-row__label">日 $</span>
                  <input
                    className="ds-input ds-input--mono"
                    style={{ width: 72 }}
                    value={form.dailySpendCapUsd}
                    placeholder="不限"
                    title="UTC 日花费上限(claimed+posted 台账口径)。留空 = 不限"
                    disabled={busy || !token}
                    onChange={(e) =>
                      setForm({ ...form, dailySpendCapUsd: e.target.value })
                    }
                  />
                  <span className="filter-row__label">周 $</span>
                  <input
                    className="ds-input ds-input--mono"
                    style={{ width: 72 }}
                    value={form.weeklySpendCapUsd}
                    placeholder="不限"
                    title="UTC 周(周一起)花费上限。留空 = 不限"
                    disabled={busy || !token}
                    onChange={(e) =>
                      setForm({ ...form, weeklySpendCapUsd: e.target.value })
                    }
                  />
                  <span className="filter-row__label">月 $</span>
                  <input
                    className="ds-input ds-input--mono"
                    style={{ width: 72 }}
                    value={form.budgetUsd}
                    title={`月硬熔断,必填。默认 $${data.defaults.budgetUsd}(来自 .env X_MONTHLY_BUDGET_USD)`}
                    disabled={busy || !token}
                    onChange={(e) =>
                      setForm({ ...form, budgetUsd: e.target.value })
                    }
                  />
                </div>
                {/* 「月上限必填、默认来自 .env」已写在那个输入框的 title 里;
                    这里只留会被读错的那半句。 */}
                <div className="ds-hint" style={{ marginBottom: "var(--s-4)" }}>
                  日 / 周留空 = <b>不限</b>，不是 0；月上限是硬熔断。
                </div>
              </>
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
                    {/* 单个布尔开关 —— 设计系统的 .ds-toggle 胶囊（32×18）,
                        包在 button 里；参数输入独立成行,点它不会误触开关。 */}
                    <button
                      type="button"
                      aria-pressed={on}
                      disabled={busy || !token}
                      title={on ? "点击关闭这一类播报" : "点击开启这一类播报"}
                      style={{
                        display: "flex",
                        gap: "var(--s-2)",
                        alignItems: "flex-start",
                        textAlign: "left",
                        appearance: "none",
                        border: 0,
                        background: "transparent",
                        padding: 0,
                        font: "inherit",
                        color: "inherit",
                        cursor: busy || !token ? "default" : "pointer",
                      }}
                      onClick={() =>
                        void post({
                          action: "kinds",
                          kinds: { [k.kind]: !on },
                        })
                      }
                    >
                      <span
                        className="ds-toggle"
                        data-on={on}
                        style={{ marginTop: 3 }}
                      />
                      <span style={{ display: "grid", gap: 2 }}>
                        <span>
                          {/* 「已关闭」是需留神的状态,走琥珀 —— 灰底不表状态,
                              裸标签会让关掉的那张卡与 🐳/🔥 类型名同色同形。 */}
                          {k.label}{" "}
                          {!on ? <Tag variant="warn">已关闭</Tag> : null}
                        </span>
                        <span className="ds-hint">{k.hint}</span>
                      </span>
                    </button>
                    {form ? (
                      <span
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          alignItems: "center",
                          gap: "var(--s-2)",
                          paddingLeft: 40,
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
                              className="ds-input ds-input--mono"
                              style={{
                                width: f.width ?? 60,
                                padding: "0 6px",
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
              // 运行时的兜底(超 280 截标题、模板不可用回退内置)是「怎么都不会
              // 出事」的安抚,不改变任何操作 —— 删。保存会被拒的四种情形留着,
              // 那是写模板时必须知道的。
              hint="留空 = 内置英文文案。{占位符} 替换为实时数据；保存时校验：未知占位符 / 缺 {title} / 夹带链接 / 固定部分超长都会被拒。"
              aside={
                /* 描边白底 —— 全页唯一的蓝底主按钮是页头的「刷新」。 */
                <button
                  className="ds-btn ds-btn--sm"
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
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "var(--s-2)",
                        flexWrap: "wrap",
                      }}
                    >
                      {k.label}
                      {data.templates[k.kind] ? (
                        <Tag variant="brand">自定义中</Tag>
                      ) : (
                        <Tag>内置</Tag>
                      )}
                      <span className="ds-hint">
                        可用占位符：
                        <code className="doc-code">
                          {(data.templateVocab[k.kind] ?? [])
                            .map((v) => `{${v}}`)
                            .join(" ")}
                        </code>
                      </span>
                    </span>
                    <textarea
                      className="ds-input ds-input--mono"
                      rows={3}
                      style={{
                        width: "100%",
                        height: "auto",
                        padding: "var(--s-2) var(--s-3)",
                        resize: "vertical",
                        lineHeight: "var(--lh-normal)",
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
              hint="最近 50 条。「已跳过」= 被开关 / 阈值 / 预算拦下，未发出也不计费。"
              aside={
                <span className="ds-hint">
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
              <>
                <div
                  className="ds-label"
                  style={{ marginBottom: "var(--s-2)" }}
                >
                  时间分布 · 近 14 天 × UTC 小时
                </div>
                {/* 「悬停格子看类型明细」是可发现的交互,删;`·` 的口径留。 */}
                <div className="ds-hint" style={{ marginBottom: "var(--s-2)" }}>
                  仅统计已发布。<span className="faint">·</span>{" "}
                  是零，不是「判不了」。
                </div>
                <div
                  className="ds-table-wrap"
                  style={{ marginBottom: "var(--s-4)" }}
                >
                  <table
                    className="ds-table ds-table--compact"
                    style={{ width: "auto" }}
                  >
                    <thead>
                      <tr>
                        {/* 表头不留空 —— 窄屏堆叠卡靠 data-label 说「日期」,
                            桌面表头得说同一句话。 */}
                        <th style={{ padding: "6px 8px" }}>日期</th>
                        {Array.from({ length: 24 }, (_, h) => (
                          <th
                            key={h}
                            className="muted"
                            style={{ padding: "6px 5px" }}
                          >
                            {h}
                          </th>
                        ))}
                        <th className="muted" style={{ padding: "6px 8px" }}>
                          Σ
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.histogram.map((d2) => (
                        <tr key={d2.day}>
                          <td
                            className="muted"
                            style={{ padding: "6px 8px" }}
                            data-label="日期"
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
                              // 密度靠底色深浅,不靠加粗或字号跳档。
                              <td
                                key={h}
                                className="is-right"
                                title={tip || undefined}
                                style={{
                                  padding: "6px 5px",
                                  background:
                                    total >= 5
                                      ? "var(--ww-up-bg)"
                                      : total > 0
                                        ? "var(--ww-up-wash)"
                                        : undefined,
                                }}
                              >
                                {total > 0 ? (
                                  total
                                ) : (
                                  <span
                                    style={{ color: "var(--ww-text-empty)" }}
                                  >
                                    ·
                                  </span>
                                )}
                              </td>
                            );
                          })}
                          <td
                            className="is-right"
                            style={{ padding: "6px 8px" }}
                            data-label="Σ"
                          >
                            {d2.total}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
            {data.history.posts.length === 0 ? (
              <div className="ds-empty">
                还没有播报记录。
                <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
                  {"授权账号并等信号触发后,这里会出现每条帖子(含「已跳过」)。"}
                </div>
              </div>
            ) : (
              <div className="ds-table-wrap">
                <table className="ds-table">
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
                        <td className="muted" data-label="时间">
                          {timeText(pst.createdAt)}
                        </td>
                        <td data-label="类型">
                          {KINDS.find((k) => k.kind === pst.kind)?.label ??
                            pst.kind}
                        </td>
                        {/* 「已跳过」是常态不是状态:走 muted 纯文字,让绿/红
                            徽章留给真正发生过的事(发布成功 / 失败)。 */}
                        <td data-label="状态">
                          {pst.status === "skipped" ? (
                            <span
                              className="muted"
                              title="被类型开关 / 金额阈值 / 预算熔断拦下,未发出也不计费"
                            >
                              {STATUS_TEXT.skipped}
                            </span>
                          ) : (
                            <Tag variant={STATUS_TONE[pst.status] ?? "default"}>
                              {STATUS_TEXT[pst.status] ?? pst.status}
                            </Tag>
                          )}
                        </td>
                        {/* 帖子正文永不截断 —— 换行。 */}
                        <td
                          className="cell-wrap"
                          data-label="内容"
                          style={{ maxWidth: 420 }}
                        >
                          {pst.text || <span className="faint">—</span>}
                        </td>
                        {/* 成本是中性色 —— 它是成本,不是盈亏。 */}
                        <td className="is-right" data-label="成本">
                          {pst.costUsd > 0 ? (
                            `$${pst.costUsd.toFixed(3)}`
                          ) : (
                            <span className="faint">—</span>
                          )}
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
                            <span className="faint">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="note-strip">
                  <span className="faint">—</span>
                  {
                    " 两种:成本 = 没花钱(只有 $0.20 的周报图卡帖有成本),链接 = 没有产生真实帖子(跳过 / 失败 / 发送中)。"
                  }
                </div>
              </div>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
