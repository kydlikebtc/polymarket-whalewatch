"use client";

// /pulse 的展示层:五个榜单表格 + 它们共用的微条/趋势线/口径折叠/
// 品类标签/市场单元格,以及顶部 KPI 概览条。与 page.tsx 的分工是
// 「怎么画」对「画哪个」—— 标签页选择、URL 同步、可用性回落全在
// page.tsx,这里的组件不知道自己是不是当前标签。2026-08-31 拆分:
// 合并成一个文件后 926 行,越过了 CLAUDE.md 的 800 行上限。

import type { ReactNode } from "react";
import { useLang } from "../i18n";
import { catLabel, subLabel } from "../../lib/categoryLabel";
import type { ConvictionReport } from "../../lib/convictionIndex";
import type { PulseReport } from "../../lib/marketPulse";
import { MarketSlugActions, StatCard, Tag } from "../ui";
import type { BoardTag, Membership } from "./membership";
import { otherTags } from "./membership";

// /api/pulse 的完整 payload:PulseReport + additive 的确信指数键(服务端
// 现算失败会降级 null,页面必须能在没有它的情况下照常渲染其余榜单)。
// ghosts/washTop 标为可选:部署后 5 分钟内(max-age=300)浏览器/中间缓存可能
// 把旧 payload 喂给新页面 JS,必须与 conviction 同一套渲染侧防御 —— 缓存
// 世界里「同一次部署所以键必在」不成立。
export type PulsePayload = Omit<PulseReport, "ghosts" | "washTop"> & {
  conviction?: ConvictionReport | null;
  ghosts?: PulseReport["ghosts"];
  washTop?: PulseReport["washTop"];
};

// 视图层行数上限。封在视图层而不是数据层有两个理由:payload 不变(别的消费
// 者与 5 分钟缓存都不受影响),且「展开全部」不需要重新请求。10 行与数据层
// 给异常日榜的 topN 同一个数,五榜口径一致。
const ROWS_COLLAPSED = 10;

const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const cents = (p: number | null): string =>
  p == null ? "—" : `${(p * 100).toFixed(1).replace(/\.0$/, "")}¢`;

// 各榜自带的口径折叠。此前全页五节的方法学挤在页尾一坨三大段,读第一张表想
// 核对「异常分怎么算」得滚到页底再滚回来 —— 拆开就近可查。写法沿用 /status、
// /record 的既有先例(原生 details + .ds-hint summary),不新增 CSS。只有真正
// 全页共用的两把尺(小单/鲸鱼口径)仍留在页尾,不在各榜重复。
function Methodology({ children }: { children: ReactNode }) {
  const { t } = useLang();
  return (
    <details style={{ marginTop: "var(--s-3)" }}>
      <summary className="ds-hint" style={{ cursor: "pointer" }}>
        {t("口径")}
      </summary>
      <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
        {children}
      </div>
    </details>
  );
}

// 超出 ROWS_COLLAPSED 时的展开/收起。行数未超上限就整个不渲染 —— 一个恒为
// 「展开全部 2 行」的按钮只会制造噪声。
function RowsToggle({
  total,
  expanded,
  onToggle,
}: {
  total: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useLang();
  if (total <= ROWS_COLLAPSED) return null;
  return (
    <button
      type="button"
      className="ds-btn ds-btn--subtle ds-btn--sm"
      style={{ marginTop: "var(--s-3)" }}
      onClick={onToggle}
    >
      {expanded
        ? t("收起，只看前 {n} 行", { n: ROWS_COLLAPSED })
        : t("展开全部 {total} 行（还有 {rest} 条）", {
            total,
            rest: total - ROWS_COLLAPSED,
          })}
    </button>
  );
}

function CompChips({
  c,
}: {
  c: {
    volSurge: number;
    oneSided: number;
    whaleShare: number;
    priceMove: number;
  };
}) {
  const { t } = useLang();
  const item = (label: string, v: number) => (
    <span className="pulse-comp" key={label}>
      <span className="pulse-comp__bar" aria-hidden>
        <span style={{ width: `${Math.round(v * 100)}%` }} />
      </span>
      {t(label)} {Math.round(v * 100)}
    </span>
  );
  return (
    <span className="pulse-comps">
      {item("量能", c.volSurge)}
      {item("单边", c.oneSided)}
      {item("鲸鱼", c.whaleShare)}
      {item("价移", c.priceMove)}
    </span>
  );
}

// 确信指数四分量微条(复用 .pulse-comp 系列样式;标签集与日榜的不同,不硬套
// CompChips 的类型)。
function ConvictionChips({
  c,
}: {
  c: {
    contest: number;
    divergence: number;
    priceMove: number;
    volSurge: number;
  };
}) {
  const { t } = useLang();
  const item = (label: string, v: number) => (
    <span className="pulse-comp" key={label}>
      <span className="pulse-comp__bar" aria-hidden>
        <span style={{ width: `${Math.round(v * 100)}%` }} />
      </span>
      {t(label)} {Math.round(v * 100)}
    </span>
  );
  return (
    <span className="pulse-comps">
      {item("对峙", c.contest)}
      {item("对立", c.divergence)}
      {item("价移", c.priceMove)}
      {item("量能", c.volSurge)}
    </span>
  );
}

// 迷你趋势线:分数天然 0-100 有界,直接线性映射,无需引入图表底座。
// 单点画圆不画线(polyline 单点不可见,会被误读为无数据)。
function ScoreSpark({ series }: { series: { day: string; score: number }[] }) {
  const W = 120;
  const H = 26;
  const PAD = 3;
  if (series.length === 0) return null;
  const y = (s: number) => PAD + (1 - s / 100) * (H - PAD * 2);
  if (series.length === 1) {
    return (
      <svg width={W} height={H} aria-hidden>
        <circle
          cx={W / 2}
          cy={y(series[0].score)}
          r={2.5}
          fill="currentColor"
        />
      </svg>
    );
  }
  const x = (i: number) => PAD + (i / (series.length - 1)) * (W - PAD * 2);
  const points = series.map((s, i) => `${x(i)},${y(s.score)}`).join(" ");
  return (
    <svg width={W} height={H} aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// 概览条:四张卡按标签页的漏斗层级排(宏观 → 微观 → 规模),数字全部从现有
// payload 客户端现算 —— 不给 /api/pulse 加键,5 分钟缓存窗口里的旧 payload
// 照常渲染,每张卡各自降级成「—」而不是整条消失。一次只见一榜之后,这条是
// 全局视野的主要来源,所以它常驻在标签之上而不是进某个标签。
export function PulseOverview({ report }: { report: PulsePayload }) {
  const { t } = useLang();
  const cats = report.conviction?.categories ?? [];
  // ⚠️ categories 按 volumeUsd 降序(convictionIndex.ts:232),不是 score ——
  // 取 [0] 会把「成交量最大的品类」当成「最激辩的品类」显示:数字看着合理、
  // 不报错、类型也对,是最难发现的那种错。求最激辩必须自己扫一遍 max。
  const hottest =
    cats.length > 0 ? cats.reduce((a, b) => (b.score > a.score ? b : a)) : null;
  // top 按 score 降序(marketPulse.ts:261),这里取 [0] 是对的。
  const topMarket = report.top[0] ?? null;
  const totalVol = report.top.reduce((s, m) => s + m.volumeUsd, 0);
  const ellipsis = {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as const;
  return (
    <section className="kpi" style={{ marginBottom: "var(--s-5)" }}>
      <StatCard label={t("最激辩品类")}>
        <div className="kpi-value">{hottest ? hottest.score : "—"}</div>
        <div className="kpi-sub" style={ellipsis}>
          {hottest ? t(catLabel(hottest.key)) : t("确信指数暂不可用")}
        </div>
      </StatCard>
      <StatCard label={t("最异常市场")}>
        <div className="kpi-value">{topMarket ? topMarket.score : "—"}</div>
        <div
          className="kpi-sub"
          style={ellipsis}
          title={topMarket?.title ?? undefined}
        >
          {topMarket
            ? (topMarket.title ?? topMarket.conditionId)
            : t("该日无市场入榜")}
        </div>
      </StatCard>
      <StatCard label={t("方向分歧")}>
        <div className="kpi-value">{report.divergences.length}</div>
        <div className="kpi-sub" style={ellipsis}>
          {t("组达双边门槛")}
        </div>
      </StatCard>
      <StatCard label={t("入榜市场")}>
        <div className="kpi-value">{report.top.length}</div>
        <div className="kpi-sub" style={ellipsis}>
          {t("日榜总量 {v}", { v: usd(totalVol) })}
        </div>
      </StatCard>
    </section>
  );
}

/* ------------------------------------------------------------- 五个榜单 */

function BoardHeading({ children }: { children: ReactNode }) {
  return (
    <h2 style={{ fontSize: "var(--t-lg)", margin: "0 0 var(--s-3)" }}>
      {children}
    </h2>
  );
}

/* --------------------------------------------------- 本站给市场打的标记 */

// 四个标记统一用 warn(琥珀)而不是各配一色:它们语义上是同一件事 ——「本站
// 标记了这个市场」。也刻意避开 ds-tag--up/--down(金融方向语义)与品类用掉的
// --brand,三套色各司其职,一眼能分清「分类 / 我们的判断 / 涨跌」。
// 标签文案写成一串三元里的直接 t 调用而不是 Record 查表:coverage 闸是对源码
// 做正则扫描,只认参数为字符串字面量的调用,查表写法(参数是变量)扫不到,漏译
// 会从机器闸底下溜过去 —— 闸自己的注释写明了这条限制。
// (本注释刻意不写出那个调用形态的示例:扫描器不剥注释,写了就会被当成真调用
//  而要求补译文 —— 第一版就是这么把闸踩红的。)
function BoardTagChip({ kind }: { kind: BoardTag }) {
  const { t } = useLang();
  const label =
    kind === "anomaly"
      ? t("异常")
      : kind === "divergence"
        ? t("分歧")
        : kind === "ghost"
          ? t("无鲸")
          : t("洗量");
  return <Tag variant="warn">{label}</Tag>;
}

// 品类标签(2026-08-31)。此前品类是灰色 hint 里 run-on 长串的第一段
// (「体育·电竞 · LOUD · 量能为其 1 日均值的 2.3 倍 · 洗量占比 43%」):四类
// 性质完全不同的事实共用一个「·」,而品类自己内部还有一个「·」,分隔符层级
// 是乱的,品类被埋掉。抽成 chip 后一眼可辨,剩下的提示继续留在灰行。
//
// 配色刻意只用 brand + 默认灰:ds-tag--up/--down 在本仓是金融方向语义
// (ui.tsx SideTag:BUY 绿 / SELL 红),给「政治」发一个红 chip 会被读成
// 「跌」。一级用 brand 上色、二级留灰,层级靠既有色阶而不是新造一套品类
// 调色板 —— 八个品类要八种在明暗两套主题下都成立的颜色,那是另一个活。
// catLabel/subLabel 的输出是全站的**规范中文键**(它把 gamma 的英文标签映射
// 成中文),显示前必须再过一次 t() 才能在英文界面回到英文 —— 否则英文页面上
// 只有词表里有的品类会显示中文(Sports→体育),词表外的反而透传英文(Iran),
// 一行里两种语言。这是 /follow DeepAnalysis 与 /wallet 档案页的既有写法。
// t(变量) 逃得过 i18n coverage 闸,译文由 deep/home/wallet 三个分片保证。
function CategoryTags({
  category,
  subcategory,
}: {
  category: string | null;
  subcategory: string | null;
}) {
  const { t } = useLang();
  const primary = t(catLabel(category));
  const sub = subcategory ? t(subLabel(subcategory)) : "";
  return (
    <>
      <Tag variant="brand">{primary}</Tag>
      {/* 二级与一级同名时不重复发一个 chip —— 与 catLabelFine 的既有去重
          规则同一条(categoryLabel.ts:72),换了渲染形式不换语义。去重在
          译后比较:两个英文标签可能译到同一中文,也可能反过来。 */}
      {sub !== "" && sub !== primary && <Tag>{sub}</Tag>}
    </>
  );
}

// 四个榜的「市场」单元格此前是四份几乎相同的 JSX。抽出来的同时把品类换成
// chip、把剩余提示改成数组 join —— 原先每段都自带前导「 · 」,一旦品类被
// 摘走,首段就会顶着一个孤儿分隔符。
function MarketCell({
  title,
  conditionId,
  slug,
  eventSlug,
  category,
  subcategory,
  boardTags = [],
  hints = [],
}: {
  title: string | null;
  conditionId: string;
  slug: string | null;
  eventSlug?: string | null;
  category: string | null;
  subcategory: string | null;
  boardTags?: BoardTag[];
  hints?: string[];
}) {
  const { t } = useLang();
  return (
    <>
      <div style={{ fontWeight: 500 }}>
        {title ?? conditionId}
        {/* conditionId 必须传:MarketSlugActions 的 🎯(打开本站市场信号卡)只在
            拿得到它时才渲染,而全站只有 /pulse 漏了这个参数 —— 榜单行因此比
            首页/共识/分歧/拆单累计/发现少一个入口,偏偏榜上是最该往下追一层的
            市场。也不再用 slug 做外层守卫:组件自己判空(!s && !conditionId 才
            返回 null),外层挡着会让无 slug 的市场连信号卡入口一起丢掉。 */}
        <MarketSlugActions
          slug={slug}
          eventSlug={eventSlug ?? undefined}
          conditionId={conditionId}
        />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "var(--s-2)",
          marginTop: 4,
        }}
      >
        <CategoryTags category={category} subcategory={subcategory} />
        {boardTags.length > 0 && (
          <span
            style={{ display: "inline-flex", gap: "var(--s-1)" }}
            title={t("本站给该市场打的其他榜单标记")}
          >
            {boardTags.map((k) => (
              <BoardTagChip key={k} kind={k} />
            ))}
          </span>
        )}
        {hints.length > 0 && (
          <span className="ds-hint">{hints.join(" · ")}</span>
        )}
      </div>
    </>
  );
}

export function ConvictionBoard({
  data,
  expanded,
  onToggle,
}: {
  data: ConvictionReport;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useLang();
  const rows = expanded
    ? data.categories
    : data.categories.slice(0, ROWS_COLLAPSED);
  return (
    <section>
      <BoardHeading>{t("确信指数 · 品类激辩度")}</BoardHeading>
      <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
        {t(
          "高 = 激辩/恐慌（阵营对峙、小单与鲸鱼对立、价格动荡、量能异动），低 = 确信（一边倒、平静）。VIX 语义，逐品类按日合成。",
        )}
      </div>
      <div className="ds-table-wrap">
        <table className="ds-table">
          <thead>
            <tr>
              <th>{t("品类")}</th>
              <th className="is-right">{t("指数")}</th>
              <th>{t("构成")}</th>
              <th>{t("近 {n} 日", { n: data.days })}</th>
              <th className="is-right">{t("量能")}</th>
              <th className="is-right">{t("市场数")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.key || "__other"}>
                <td style={{ fontWeight: 500 }}>{t(catLabel(c.key))}</td>
                <td
                  className="is-right num mono"
                  style={{ fontSize: "var(--t-lg)", fontWeight: 600 }}
                >
                  {c.score}
                </td>
                <td>
                  <ConvictionChips c={c.components} />
                </td>
                <td className="ds-hint">
                  <ScoreSpark series={c.series} />
                </td>
                <td className="is-right num mono">{usd(c.volumeUsd)}</td>
                <td className="is-right num mono">{c.markets}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RowsToggle
        total={data.categories.length}
        expanded={expanded}
        onToggle={onToggle}
      />
      <Methodology>
        {t(
          "确信指数 = 0.30·阵营对峙（量能加权 1−单边度）+ 0.30·对立度（合格分歧市场量能占比，双边门槛与「方向分歧」标签页同尺）+ 0.20·价格动荡 + 0.20·量能异动；品类日总量 <$10k 不给分；量能异动在品类自身基线不足 3 天时退化为当日横截面分位。",
        )}
      </Methodology>
    </section>
  );
}

export function AnomalyBoard({
  rows: all,
  membership,
  expanded,
  onToggle,
}: {
  rows: PulseReport["top"];
  membership: Membership;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useLang();
  const rows = expanded ? all : all.slice(0, ROWS_COLLAPSED);
  return (
    <section>
      <BoardHeading>{t("异常市场日榜")}</BoardHeading>
      {all.length === 0 ? (
        <div className="ds-hint">
          {t("该日无达到材料性门槛（$10k 总量）的市场。")}
        </div>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t("市场")}</th>
                <th className="is-right">{t("异常分")}</th>
                <th>{t("构成")}</th>
                <th className="is-right">{t("量能")}</th>
                <th className="is-right">{t("顶结果首→末价")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m, i) => (
                <tr key={m.conditionId}>
                  <td className="num mono">{i + 1}</td>
                  <td>
                    <MarketCell
                      title={m.title}
                      conditionId={m.conditionId}
                      slug={m.slug}
                      eventSlug={m.eventSlug}
                      category={m.category}
                      subcategory={m.subcategory}
                      boardTags={otherTags(
                        membership,
                        m.conditionId,
                        "anomaly",
                      )}
                      hints={[
                        ...(m.topOutcome ? [m.topOutcome] : []),
                        ...(m.volRatio != null
                          ? [
                              t("量能为其 {n} 日均值的 {r} 倍", {
                                n: m.volBaselineDays,
                                r: m.volRatio.toFixed(1),
                              }),
                            ]
                          : []),
                        ...(m.washRatio != null && m.washRatio >= 0.1
                          ? [
                              t("洗量占比 {p}%", {
                                p: Math.round(m.washRatio * 100),
                              }),
                            ]
                          : []),
                      ]}
                    />
                  </td>
                  <td
                    className="is-right num mono"
                    style={{ fontSize: "var(--t-lg)", fontWeight: 600 }}
                  >
                    {m.score}
                  </td>
                  <td>
                    <CompChips c={m.components} />
                  </td>
                  <td className="is-right num mono">{usd(m.volumeUsd)}</td>
                  <td className="is-right num mono">
                    {cents(m.priceFirst)} → {cents(m.priceLast)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RowsToggle total={all.length} expanded={expanded} onToggle={onToggle} />
      <Methodology>
        {t(
          "异常分 = 0.35·量能异动 + 0.25·单边度 + 0.20·鲸鱼占比 + 0.20·日内价移，各分量 0–1 可逐项核对；量能异动在同市场基线不足 3 天时退化为当日横截面分位。",
        )}
      </Methodology>
    </section>
  );
}

export function DivergenceBoard({
  rows: all,
  membership,
  expanded,
  onToggle,
}: {
  rows: PulseReport["divergences"];
  membership: Membership;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useLang();
  const rows = expanded ? all : all.slice(0, ROWS_COLLAPSED);
  return (
    <section>
      <BoardHeading>{t("小单 vs 鲸鱼 · 方向分歧")}</BoardHeading>
      {all.length === 0 ? (
        <div className="ds-hint">
          {t("该日无达到双边材料性门槛的方向分歧。")}
        </div>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th>{t("市场")}</th>
                <th>{t("小单在买")}</th>
                <th>{t("鲸鱼在买")}</th>
                <th className="is-right">{t("分歧强度")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.conditionId}>
                  <td>
                    <MarketCell
                      title={d.title}
                      conditionId={d.conditionId}
                      slug={d.slug}
                      category={d.category}
                      subcategory={d.subcategory}
                      boardTags={otherTags(
                        membership,
                        d.conditionId,
                        "divergence",
                      )}
                    />
                  </td>
                  <td>
                    {d.smallTopOutcome}{" "}
                    <span className="num mono up">+{usd(d.smallNetUsd)}</span>
                  </td>
                  <td>
                    {d.whaleTopOutcome}{" "}
                    <span className="num mono up">+{usd(d.whaleNetUsd)}</span>
                  </td>
                  <td className="is-right num mono">{usd(d.strength)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RowsToggle total={all.length} expanded={expanded} onToggle={onToggle} />
      <Methodology>
        {t(
          "入榜需两桶各自净买入的顶结果不同，且小单净买入 ≥$5k、鲸鱼净买入 ≥$50k；分歧强度 = min(小单净额, 鲸鱼净额) —— 两边都得有真金白银才算真分歧，弱的那边定强度。",
        )}
      </Methodology>
    </section>
  );
}

export function GhostBoard({
  rows: all,
  membership,
  expanded,
  onToggle,
}: {
  rows: PulseReport["ghosts"];
  membership: Membership;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useLang();
  const rows = expanded ? all : all.slice(0, ROWS_COLLAPSED);
  return (
    <section>
      <BoardHeading>{t("无鲸异动 · 没人付大钱的剧烈价移")}</BoardHeading>
      <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
        {t(
          "价移 ≥10¢ 但当日没有任何一笔 ≥$10k —— 要么簿子薄到小单就能推，要么有人在蚂蚁搬家。",
        )}
      </div>
      <div className="ds-table-wrap">
        <table className="ds-table">
          <thead>
            <tr>
              <th>{t("市场")}</th>
              <th className="is-right">{t("价移")}</th>
              <th className="is-right">{t("首→末价")}</th>
              <th className="is-right">{t("量能")}</th>
              <th className="is-right">{t("单笔最大")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.conditionId}>
                <td>
                  <MarketCell
                    title={g.title}
                    conditionId={g.conditionId}
                    slug={g.slug}
                    eventSlug={g.eventSlug}
                    category={g.category}
                    subcategory={g.subcategory}
                    boardTags={otherTags(membership, g.conditionId, "ghost")}
                    hints={
                      g.washRatio != null && g.washRatio >= 0.1
                        ? [
                            t("洗量占比 {p}%", {
                              p: Math.round(g.washRatio * 100),
                            }),
                          ]
                        : []
                    }
                  />
                </td>
                <td className="is-right num mono">{g.moveCents.toFixed(0)}¢</td>
                <td className="is-right num mono">
                  {cents(g.priceFirst)} → {cents(g.priceLast)}
                </td>
                <td className="is-right num mono">{usd(g.volumeUsd)}</td>
                <td className="is-right num mono">{usd(g.maxFillUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RowsToggle total={all.length} expanded={expanded} onToggle={onToggle} />
      <Methodology>
        {t(
          "无鲸异动 = 价移 ≥10¢ 且当日单笔最大 <$10k（判定材料 2026-08-28 起采集，之前的日份不进榜）。",
        )}
      </Methodology>
    </section>
  );
}

export function WashBoard({
  rows: all,
  membership,
  expanded,
  onToggle,
}: {
  rows: PulseReport["washTop"];
  membership: Membership;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useLang();
  const rows = expanded ? all : all.slice(0, ROWS_COLLAPSED);
  return (
    <section>
      <BoardHeading>{t("洗量榜 · 同钱包当日往返")}</BoardHeading>
      <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
        {t(
          "同一钱包在同一市场当日既买又卖的配对量占比（双腿口径）。是结构描述不是指控——做市、调仓也长这样；把它当「这个市场的量能里有多少不是方向性意见」来读。",
        )}
      </div>
      <div className="ds-table-wrap">
        <table className="ds-table">
          <thead>
            <tr>
              <th>{t("市场")}</th>
              <th className="is-right">{t("洗量占比")}</th>
              <th className="is-right">{t("配对量")}</th>
              <th className="is-right">{t("量能")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.conditionId}>
                <td>
                  <MarketCell
                    title={w.title}
                    conditionId={w.conditionId}
                    slug={w.slug}
                    category={w.category}
                    subcategory={w.subcategory}
                    boardTags={otherTags(membership, w.conditionId, "wash")}
                  />
                </td>
                <td className="is-right num mono" style={{ fontWeight: 600 }}>
                  {Math.round(w.washRatio * 100)}%
                </td>
                <td className="is-right num mono">{usd(2 * w.washUsd)}</td>
                <td className="is-right num mono">{usd(w.volumeUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RowsToggle total={all.length} expanded={expanded} onToggle={onToggle} />
      <Methodology>
        {t(
          "洗量占比 = 同钱包当日买卖配对量 ×2 ÷ 总量，只统计单笔 ≥$2k 的抓取窗口；入榜需占比 ≥20% 且当日总量 ≥$10k。",
        )}
      </Methodology>
    </section>
  );
}
