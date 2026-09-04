"use client";

import { useEffect, useState } from "react";
import type { RecordFeed, RecordFeedStrategy } from "../../lib/recordFeed";
import { formatRecordLine } from "../../lib/signalRecord";
import { CopyButton, StatCard, Tag } from "../ui";

// 对外信号批次 3:公开信号战绩页。
// 口径与 /follow 的区别是本页的存在理由:这里只统计**公开发出过**的信号
// (strategy_signals × sent 投递),不是全部纸面历史 —— 拿全量纸面账给发布
// 记录背书,就是社会证明造假的软形态。战绩行文案直接复用 formatRecordLine
// (lib/signalRecord,全站唯一实现;该模块对 db 仅 type-import,client 安全)。

// 概率的裸值(不带 ¢)—— 只用在「进 → 结算」这种变化写法的左半边,
// 单位跟在末位一次:41.2 → 100¢(设计稿 §1 数字格式)。
const centsBare = (p: number | null): string =>
  p == null ? "—" : `${(p * 100).toFixed(1).replace(/\.0$/, "")}`;

const cents = (p: number | null): string =>
  p == null ? "—" : `${centsBare(p)}¢`;

// 负号用真减号 U+2212(与 signed1、设计稿的「−$4,390」一致);ASCII 连字符
// 在正文字体里比加号窄一截,整列右对齐时看得出参差。
const usdSigned = (n: number | null): string => {
  if (n == null) return "—";
  const s = `$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
};

const signed1 = (n: number): string =>
  `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}`;

const timeText = (sec: number): string =>
  new Date(sec * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const SOURCE_LABEL: Record<string, string> = {
  consensus: "共识",
  heavy: "巨鲸单",
  lopsided: "一边倒分歧",
  resolved: "分歧解除",
  lone_wolf: "独狼",
  early_winner: "早期赢家",
};

function StrategyCard({ s }: { s: RecordFeedStrategy }) {
  const line = formatRecordLine(s.name, s.record);
  // implied vs wins 对比条:市场预期是基准刻度,超出/不足一眼可见。
  const denom = Math.max(s.record.settled, 1);
  const winsPct = Math.min(100, (s.record.wins / denom) * 100);
  const impliedPct = Math.min(100, (s.record.implied / denom) * 100);
  const settled = s.record.settled > 0;
  // 样本闸不在呈现层复算。formatRecordLine(lib/signalRecord,全站唯一实现)
  // 在 settled < MIN_RECORD_SAMPLE 时刻意只返回「N/M 中（样本不足）」——
  // 既不给 excess 也不给 ±2σ 判词,免得没有噪声底的数字被当成结论引用
  // (见该函数 wording rules 第 2、3 条)。这里只读它的结论、不自己定阈值:
  // 它没发判词,这一屏就不许把 excess 裸印成 18px 读数。
  // 「样本不足」只出现在短式那一支,长式必带判词。用 includes 而不是 endsWith:
  // 万一字面量将来变形,includes 的失手方向是「多藏一格」而不是「多给一个数」,
  // 而这一格宁可少说也不能虚报(代价:档位名里若含这四个字会误判成不足)。
  const graded = line != null && !line.includes("样本不足");
  return (
    <section style={{ marginBottom: "var(--s-10)" }}>
      {/* 档位标识行 —— 占设计稿的「筛选条」槽位(一排控件高的元素 + 右对齐
          附注):20px 区块标题 + 灰底来源名称标签 + 右侧已发布条数。
          层级来自 12px 小标与 1px 分格线,不靠再加大字号。 */}
      <div className="filter-bar">
        <h2
          style={{
            margin: 0,
            fontSize: "var(--t-xl)",
            fontWeight: 600,
            lineHeight: "var(--lh-tight)",
          }}
        >
          {s.name}
        </h2>
        <Tag>{SOURCE_LABEL[s.source] ?? s.source}</Tag>
        <span className="filter-bar__right ds-hint">
          已发布 {s.pushedCount} 条
        </span>
      </div>

      {/* 显著性判词 —— 统计声明放在数据前面,不放脚注(readme §1 口径先行)。
          「样本不足」/「仍在运气范围内」/「已超运气范围」这三句判词全站只有
          formatRecordLine 产出,是对下面整排 KPI 的定性;它排在读数之后就成了
          脚注,读者会先记住 18px 的百分数再决定要不要读它。 */}
      <div className="ds-callout" style={{ marginBottom: "var(--s-4)" }}>
        {line ??
          "已发布信号尚无结算样本:胜率、超额都要等第一条结算判定落地后才谈得上。"}
      </div>

      {/* KPI 分格卡 —— 已发布 / 已结算 / 命中率(含市场预期基准线)/ 超额 */}
      <section className="kpi">
        <StatCard label="已发布" icon="📣">
          <div className="kpi-value">
            {s.pushedCount.toLocaleString("en-US")}
          </div>
          <div className="kpi-sub">经信号通道公开发出,含未结算</div>
        </StatCard>
        <StatCard label="已结算" icon="🧾">
          <div className="kpi-value">
            {s.record.settled.toLocaleString("en-US")}
          </div>
          <div className="kpi-sub">盈亏 $0 的平局不进胜率分母</div>
        </StatCard>
        <StatCard
          label={
            settled
              ? `命中率 · 命中 ${s.record.wins} vs 市场预期 ${s.record.implied.toFixed(1)}`
              : "命中率"
          }
          icon="🎯"
        >
          {/* 蓝色强调只给「读得动的读数」—— 样本不足时同一个百分数不过是
              原始计数的另一种写法(formatRecordLine 允许照实报计数,但不许
              把它打扮成结论),所以退回中性色 + 琥珀「样本不足」徽章。 */}
          <div
            className="kpi-value"
            style={graded ? { color: "var(--ww-link)" } : undefined}
          >
            {settled ? (
              <>
                {winsPct.toFixed(1)}%{" "}
                <span
                  style={{
                    fontSize: "var(--t-base)",
                    color: "var(--ww-text-muted)",
                  }}
                >
                  基准 {impliedPct.toFixed(1)}%
                </span>
              </>
            ) : (
              <span className="faint">—</span>
            )}
          </div>
          {settled && !graded ? (
            <div style={{ marginTop: "var(--s-2)" }}>
              <Tag variant="warn">样本不足 · {s.record.settled} 仓</Tag>
            </div>
          ) : null}
          {settled ? (
            <>
              <div
                title={`命中 ${s.record.wins} · 市场同价位预期 ${s.record.implied.toFixed(1)}`}
                style={{
                  position: "relative",
                  marginTop: "var(--s-2)",
                  height: 6,
                  borderRadius: "var(--r-pill)",
                  background: "var(--ww-border)",
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${winsPct}%`,
                    minWidth: 2,
                    borderRadius: "var(--r-pill)",
                    background: "var(--ww-link)",
                  }}
                />
                <span
                  style={{
                    position: "absolute",
                    left: `${impliedPct}%`,
                    top: -3,
                    bottom: -3,
                    width: 2,
                    background: "var(--ww-text)",
                  }}
                />
              </div>
              <div className="kpi-sub">黑线 = 市场同价位预期基准</div>
            </>
          ) : (
            <div className="kpi-sub">尚无结算样本,判不了</div>
          )}
        </StatCard>
        <StatCard label="超额 · 命中 − 市场预期" icon="📐">
          {/* 超额永远不与噪声底判词分家:没过样本闸就走「—」+ 琥珀徽章,
              不给数(「—」是判不了,不是零)。 */}
          <div className="kpi-value">
            {graded ? (
              signed1(s.record.excess)
            ) : (
              <span className="faint">—</span>
            )}
          </div>
          {settled && !graded ? (
            <div style={{ marginTop: "var(--s-2)" }}>
              <Tag variant="warn">样本不足 · {s.record.settled} 仓</Tag>
            </div>
          ) : null}
          <div className="kpi-sub">
            {graded
              ? s.record.sd > 0
                ? `运气尺度 1σ = ${s.record.sd.toFixed(1)}`
                : "运气尺度算不出 —— 这批入场价全在 0 / 100¢"
              : settled
                ? "样本够了才给数:没有 ±2σ 判词的超额只是噪声"
                : "尚无结算样本"}
          </div>
        </StatCard>
      </section>

      {/* 主表卡 —— 卡内标题条 → 判定徽章表 → 灰色说明条 */}
      <div className="ds-table-wrap" style={{ marginTop: "var(--s-4)" }}>
        <div className="card-bar">
          <span className="ds-label">🧾 已结算明细</span>
          <span className="ds-hint">最近 {s.settledRecent.length} 条</span>
          <span className="ds-hint" style={{ marginLeft: "auto" }}>
            平局不入分母
          </span>
        </div>
        {s.settledRecent.length > 0 ? (
          <table className="ds-table">
            <thead>
              <tr>
                <th>市场 / 结果</th>
                <th className="is-right">进 → 结算</th>
                <th>判定</th>
                <th className="is-right">纸面盈亏</th>
                <th className="is-right">结算时间</th>
              </tr>
            </thead>
            <tbody>
              {s.settledRecent.map((r) => (
                <tr key={r.id}>
                  <td className="cell-wrap">
                    <span style={{ display: "block" }}>{r.title}</span>
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--s-2)",
                        marginTop: "var(--s-1)",
                      }}
                    >
                      <Tag>{r.outcome}</Tag>
                    </span>
                  </td>
                  <td className="is-right" data-label="进 → 结算">
                    {centsBare(r.entryPrice)} → {cents(r.exitPrice)}
                  </td>
                  <td data-label="判定">
                    {r.won === true ? (
                      <Tag variant="up">✅ 命中</Tag>
                    ) : r.won === false ? (
                      <Tag variant="down">❌ 未中</Tag>
                    ) : (
                      <Tag>平局 · 不入分母</Tag>
                    )}
                  </td>
                  <td
                    className="is-right"
                    data-label="纸面盈亏"
                    style={
                      r.realizedPnl == null
                        ? { color: "var(--ww-text-faint)" }
                        : r.realizedPnl > 0
                          ? { color: "var(--ww-up)" }
                          : r.realizedPnl < 0
                            ? { color: "var(--ww-down)" }
                            : undefined
                    }
                  >
                    {usdSigned(r.realizedPnl)}
                  </td>
                  <td className="is-right muted" data-label="结算时间">
                    {timeText(r.settledAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="ds-empty" style={{ border: 0, borderRadius: 0 }}>
            {/* 空态给内容也给出路 —— 绝不只留一句「暂无数据」 */}
            <div>已发布信号尚无结算样本 —— 结算回填后此表开始记账。</div>
            <div style={{ marginTop: "var(--s-2)" }}>
              该档的全量纸面履历(含未发布信号)在 <a href="/follow">策略中心</a>
              。
            </div>
          </div>
        )}
        {/* 判词已上移到 KPI 之前(口径先行);这里只留读表用的口径条。 */}
        {s.settledRecent.length > 0 && (
          <div className="note-strip note-strip--warn">
            表内「—」是判不了,不是零 ——
            该行缺成交价(老仓没有形成价)或缺结算回填价时不做计算,既不算命中
            也不算未中;判定为「平局」的行同样不进胜率分母。
          </div>
        )}
      </div>
    </section>
  );
}

export default function RecordPage() {
  const [feed, setFeed] = useState<RecordFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 嵌入代码要绝对地址,SSR 阶段没有 window —— 挂载后再补,避免水合错位。
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const embedSnippet = `<iframe src="${origin}/embed/record" width="440" height="340" style="border:0" loading="lazy" title="WhaleWatch record"></iframe>`;
  useEffect(() => {
    fetch("/api/record")
      .then((r) => r.json())
      .then((j) => {
        if (j.error) setError(String(j.error));
        setFeed(j as RecordFeed);
      })
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main className="ds-main">
      <header className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="page-head__eyebrow">
            📐 先发布 · 后结算 · 逐条认账
          </div>
          <h1 className="page-head__title">公开信号战绩</h1>
          <p className="page-head__desc">
            本页只统计通过信号通道公开发出过的策略买入信号(不是全部纸面历史,
            完整策略履历见「策略中心」)。
          </p>
        </div>
        <div className="page-head__actions">
          <a className="ds-btn" href="#caliber">
            口径三声明
          </a>
        </div>
      </header>

      {/* 口径条 —— 统计声明放在数据前面,不放脚注 */}
      <div
        className="ds-callout ds-callout--warn"
        id="caliber"
        style={{ marginBottom: "var(--s-5)" }}
      >
        <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
          ⚠️ 口径三声明
        </div>
        {/* 三条声明各占一行 —— 口径条是读表前必读的东西,挤成一段没人读完。
            分行靠 1px 之外的空行节奏,不靠字号跳档。 */}
        <div>
          ①纸面口径 —— 入场 / 盈亏是模拟跟单数字(真实数据 · 模拟策略),
          不含真实执行成本。
        </div>
        <div style={{ marginTop: "var(--s-1)" }}>
          ②已结算口径 —— 只统计有结算判定的信号,盈亏 $0 的平局不进胜率分母。
        </div>
        <div style={{ marginTop: "var(--s-1)" }}>
          ③各档独立 —— 不同档位常在同一市场重叠开仓,战绩不可跨档相加。
        </div>
        <div style={{ marginTop: "var(--s-2)" }}>
          命中数旁必印「市场同价位预期」:入场价本身就是市场给的概率,
          跑赢它才是本事,超额未过 ±2σ 一律注明「仍在运气范围内」。
        </div>
        <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
          研究用途模拟信号 · 非投资建议 · 只读非托管
        </div>
      </div>

      {error && (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-4)" }}
        >
          加载失败:{error}
        </div>
      )}
      {!feed && !error && <div className="ds-empty">加载中…</div>}
      {feed && feed.strategies.length === 0 && (
        <div className="ds-empty">
          <div>尚无公开发布的信号 —— 台账静默积累中。</div>
          <div style={{ marginTop: "var(--s-2)" }}>
            首批档位按战绩放开后此页开始记账;在那之前可看{" "}
            <a href="/follow">策略中心</a> 的全量纸面履历。
          </div>
        </div>
      )}
      {feed?.strategies.map((s) => (
        <StrategyCard key={s.id} s={s} />
      ))}

      {feed?.digest.day && (
        <div
          className="ds-card"
          style={{ marginTop: "var(--s-5)", overflow: "hidden" }}
        >
          <div className="card-bar">
            <span className="ds-label">🔏 存证链</span>
            <span>最近存证 {feed.digest.day}</span>
            {/* 链尾框 —— 沉底 #f1f3f5 的短哈希槽(--ww-surface-sunken 就是
                为它留的)。字体继承正文:这套皮里等宽只出现在代码面板。 */}
            <span
              className="ds-hint"
              style={{
                marginLeft: "auto",
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--s-1)",
              }}
            >
              链尾
              <code
                style={{
                  fontFamily: "inherit",
                  fontSize: "var(--t-base)",
                  color: "var(--ww-text)",
                  background: "var(--ww-surface-sunken)",
                  padding: "2px 6px",
                  borderRadius: "var(--r-sm)",
                }}
              >
                {feed.digest.tail?.slice(0, 16)}…
              </code>
            </span>
          </div>
          <div className="note-strip">
            每 UTC 日把昨日全部已发布信号的链式 sha256 摘要发布到公开 Telegram
            频道(消息带官方时间戳、不可编辑)。任何人可按明细复算,事后删改任何
            一条信号,摘要必变。
          </div>
        </div>
      )}

      <div
        className="ds-card"
        style={{ marginTop: "var(--s-4)", overflow: "hidden" }}
      >
        <div className="card-bar">
          <span className="ds-label">📦 数据出口</span>
          <a className="ds-btn ds-btn--sm" href="/api/dataset/record.csv">
            下载全量 CSV 数据集
          </a>
          <span className="ds-hint" style={{ marginLeft: "auto" }}>
            CC BY 4.0 · 署名 whalewatch.wired.fund
          </span>
        </div>
        <div className="note-strip">
          已发布信号逐行台账,含未结算行 —— 分母诚实。防篡改校验走上方存证链, CSV
          是便利导出不是存证载体。
        </div>
      </div>

      {origin && (
        <details
          className="ds-card"
          style={{
            marginTop: "var(--s-4)",
            padding: "var(--s-3) var(--s-4)",
          }}
        >
          <summary style={{ cursor: "pointer", fontSize: "var(--t-md)" }}>
            嵌入此战绩卡
          </summary>
          <div className="embed-snippet">
            <code>{embedSnippet}</code>
            <CopyButton text={embedSnippet} />
          </div>
          <div className="ds-hint">
            嵌入卡 60 秒缓存、无脚本、自带署名回链;加 ?theme=dark 得深色版。
          </div>
        </details>
      )}
    </main>
  );
}
