"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  fmtSignedUsdCompact,
  MarketSlugActions,
  Modal,
  Segmented,
  Tag,
  WalletLink,
} from "../ui";
import { WalletTagChips, tagVariant } from "../walletTagChips";
import { WALLET_TAGS } from "../glossary";
import type { WalletTag } from "../../lib/walletTags";

// -------------------------------------------------------------- read model

interface EvidenceDetail {
  channel: string;
  conditionId: string;
  ts: number;
  usd: number;
  price: number;
  note: string;
  // Full market context; null on legacy rows written before the columns
  // existed (they self-heal when the behavior is re-observed).
  title: string | null;
  slug: string | null;
  eventSlug: string | null;
  outcome: string | null;
}
interface ChannelStat {
  channel: string;
  markets: number;
}
interface CandidateRow {
  address: string;
  channels: ChannelStat[];
  totalMarkets: number;
  lastTs: number;
  latestNote: string;
  status: "candidate" | "bot";
  tags: WalletTag[];
  evidence: EvidenceDetail[];
}
interface MemberRow {
  address: string;
  source: string | null;
  isWhitelist: boolean;
  score: number | null;
  winRate: number | null;
  netPnl: number | null;
  updatedAt: number | null;
  tags: WalletTag[];
  evidence: EvidenceDetail[];
}
interface DiscoveryPayload {
  candidates: CandidateRow[];
  members: MemberRow[];
  counts: {
    evidenceRows: number;
    candidateWallets: number;
    poolTotal: number;
    poolGlobal: number;
    poolDiscovery: number;
  };
  error?: string;
}

type View = "candidates" | "members";

// ------------------------------------------------------------- formatting

const CHANNEL_META: Record<string, { icon: string; label: string }> = {
  echo: { icon: "🔁", label: "共识同行" },
  splitter: { icon: "🧩", label: "拆单建仓" },
  insider: { icon: "🕵️", label: "内幕签名" },
  early_winner: { icon: "🎯", label: "早期赢家" },
};

function channelLabel(channel: string): string {
  const m = CHANNEL_META[channel];
  return m ? `${m.icon} ${m.label}` : channel;
}

function shortWallet(w: string): string {
  if (!w) return "";
  return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

function fmtAgo(tsSec: number): string {
  const mins = Math.max(0, Math.round(Date.now() / 1000 - tsSec) / 60);
  if (mins < 60) return `${Math.round(mins)} 分钟前`;
  const h = mins / 60;
  if (h < 48) return `${Math.round(h)} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

// Pool members graduate OUT of this list into the pool tab, so the funnel
// statuses are binary: still watching, or permanently disqualified.
function statusTag(status: CandidateRow["status"]) {
  if (status === "bot") return <Tag variant="warn">🤖 做市机器人</Tag>;
  return <Tag>候选中</Tag>;
}

// Generic (per-wallet-count-free) chip label for the filter bar.
function filterChipLabel(key: string, sample: WalletTag): string {
  if (key.startsWith("ch:")) return channelLabel(key.slice(3));
  return sample.label.replace(/ ×\d+$/, "");
}

// ---------------------------------------------------------- funnel strip

function FunnelArrow({ label }: { label: string }) {
  return (
    <div
      aria-hidden
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 56,
        flex: "0 0 auto",
        gap: 2,
      }}
    >
      <span
        className="ds-hint"
        style={{ fontSize: 11, textAlign: "center", lineHeight: 1.3 }}
      >
        {label}
      </span>
      <span style={{ color: "var(--n-500)", fontSize: 16 }}>→</span>
    </div>
  );
}

// ------------------------------------------------------- expandable detail

function EvidenceDetailRows({
  evidence,
  colSpan,
}: {
  evidence: EvidenceDetail[];
  colSpan: number;
}) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ background: "var(--n-50)" }}>
        {evidence.length === 0 ? (
          <div className="ds-hint" style={{ padding: "var(--s-2)" }}>
            近 30 天无渠道证据 —— 经榜单播种入池（全局榜/分类榜），或证据已滚出
            30 天窗口
          </div>
        ) : (
          <table className="ds-table" style={{ margin: "var(--s-2) 0" }}>
            <thead>
              <tr>
                <th style={{ width: 130 }}>渠道</th>
                <th>证据</th>
                <th>市场 · 结果</th>
                <th className="is-right" style={{ width: 110 }}>
                  金额
                </th>
                <th className="is-right" style={{ width: 90 }}>
                  价格
                </th>
                <th className="is-right" style={{ width: 110 }}>
                  时间
                </th>
              </tr>
            </thead>
            <tbody>
              {evidence.map((e) => (
                <tr key={`${e.channel}:${e.conditionId}`}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {channelLabel(e.channel)}
                  </td>
                  <td style={{ whiteSpace: "normal", lineHeight: 1.5 }}>
                    {e.note}
                  </td>
                  {/* Full market title + outcome with the standard ⧉↗ pair —
                      the note above only carries a 40-char truncated title.
                      Legacy rows (no stored market context) fall back to a
                      muted em-dash and self-heal on re-observation. */}
                  <td style={{ whiteSpace: "normal", maxWidth: 300 }}>
                    {e.title ? (
                      <>
                        {e.eventSlug ? (
                          <a
                            href={`https://polymarket.com/event/${e.eventSlug}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {e.title}
                          </a>
                        ) : (
                          e.title
                        )}
                        <div
                          className="kpi-sub"
                          style={{ whiteSpace: "nowrap" }}
                        >
                          {e.outcome ?? ""}
                          <MarketSlugActions
                            slug={e.slug}
                            eventSlug={e.eventSlug}
                          />
                        </div>
                      </>
                    ) : (
                      <span
                        className="muted"
                        title="旧证据行未存市场详情 — 引擎会从 gamma 自动回填（启动后约 1 分钟），个别已下架市场保持空缺"
                      >
                        —
                      </span>
                    )}
                  </td>
                  <td className="mono is-right">
                    ${Math.round(e.usd).toLocaleString("en-US")}
                  </td>
                  <td className="mono is-right">
                    {(e.price * 100).toFixed(1)}¢
                  </td>
                  <td
                    className="mono is-right"
                    style={{ whiteSpace: "nowrap" }}
                  >
                    {fmtAgo(e.ts)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </td>
    </tr>
  );
}

// ------------------------------------------------------------------ page

export default function DiscoveryPage() {
  const [data, setData] = useState<DiscoveryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("candidates");
  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tagHelpOpen, setTagHelpOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/discovery");
      const json = (await res.json()) as DiscoveryPayload;
      if (json.error) setError(json.error);
      else setError(null);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Tag filter chips for the ACTIVE view: union of row tag keys with the
  // number of wallets carrying each. Selecting several = AND (a wallet must
  // carry every selected tag — "echo AND splitter" is the interesting query).
  const rows: Array<CandidateRow | MemberRow> = useMemo(
    () =>
      view === "candidates" ? (data?.candidates ?? []) : (data?.members ?? []),
    [data, view],
  );
  const chipStats = useMemo(() => {
    const byKey = new Map<string, { sample: WalletTag; wallets: number }>();
    for (const r of rows) {
      for (const t of r.tags) {
        const prev = byKey.get(t.key);
        if (prev) prev.wallets++;
        else byKey.set(t.key, { sample: t, wallets: 1 });
      }
    }
    return [...byKey.entries()].sort((a, b) => b[1].wallets - a[1].wallets);
  }, [rows]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        for (const k of activeTags) {
          // Funnel-segment pseudo filters (set by clicking a pool segment in
          // the funnel strip): group across every category/discovered source.
          if (k === "grp:discovery") {
            if (
              !r.tags.some(
                (t) =>
                  t.key.startsWith("src:category:") ||
                  t.key.startsWith("src:discovered:"),
              )
            ) {
              return false;
            }
            continue;
          }
          if (!r.tags.some((t) => t.key === k)) return false;
        }
        if (!q) return true;
        if (r.address.includes(q)) return true;
        if (r.tags.some((t) => t.label.toLowerCase().includes(q))) return true;
        return r.evidence.some((e) => e.note.toLowerCase().includes(q));
      }),
    [rows, activeTags, q],
  );

  const switchView = (v: View, presetTags?: string[]) => {
    setView(v);
    setActiveTags(new Set(presetTags ?? [])); // chips are view-specific
    setExpanded(new Set());
  };
  const toggleTag = (key: string) => {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleExpand = (address: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  };

  const walletCell = (address: string) => (
    <WalletLink address={address}>{shortWallet(address)}</WalletLink>
  );

  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-5)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", marginBottom: "var(--s-1)" }}>
          🔭 聪明钱发现
        </h1>
        <div className="ds-hint">
          白名单之外的聪明钱候选漏斗：成交流涌现（共识同行 / 拆单建仓 /
          内幕签名）+ 已结算市场早期赢家 + 分类榜专家。候选须 30 天内证据广度 ≥3
          并通过战绩审查（做市机器人硬拒）才会入池。点击行展开证据明细。
        </div>
      </header>

      {error && (
        <div className="ds-callout" style={{ marginBottom: "var(--s-4)" }}>
          加载失败：{error}
        </div>
      )}

      {/* Live funnel strip — the discovery pipeline with real counts.
          Stages are clickable and drive the tabs/filters below. */}
      <section
        aria-label="发现漏斗"
        style={{
          display: "flex",
          alignItems: "stretch",
          gap: "var(--s-2)",
          flexWrap: "wrap",
          marginBottom: "var(--s-2)",
        }}
      >
        <div className="kpi-card" style={{ flex: "1 1 130px" }}>
          <div className="ds-label">① 30 天证据</div>
          <div className="kpi-value">{data?.counts.evidenceRows ?? "—"}</div>
          <div className="kpi-sub">成交流涌现 + 结算回溯</div>
        </div>
        <FunnelArrow label="聚合" />
        <div
          className="kpi-card"
          role="button"
          tabIndex={0}
          onClick={() => switchView("candidates")}
          onKeyDown={(e) => e.key === "Enter" && switchView("candidates")}
          style={{
            flex: "1 1 130px",
            cursor: "pointer",
            outline:
              view === "candidates" ? "2px solid var(--brand-500)" : "none",
          }}
          title="查看候选漏斗列表"
        >
          <div className="ds-label">② 候选钱包 →</div>
          <div className="kpi-value">
            {data?.counts.candidateWallets ?? "—"}
          </div>
          <div className="kpi-sub">纯观察 · 不进任何信号</div>
        </div>
        <FunnelArrow label="复发≥3 · 战绩审查" />
        <div
          className="kpi-card"
          style={{ flex: "1 1 130px", borderColor: "var(--warn-700)" }}
          title="准入闸门：复发广度 ≥3 → 战绩审查（胜率≥55%&≥10结算 或 盈利&ROI≥5%&≥5结算）→ 做市机器人硬拒。分类榜走旁路：免复发、仅战绩审查。"
        >
          <div className="ds-label">③ 准入闸门</div>
          <div className="kpi-value" aria-hidden>
            ⛩
          </div>
          <div className="kpi-sub">机器人硬拒 · 分类榜旁路</div>
        </div>
        <FunnelArrow label="通过" />
        <div className="kpi-card" style={{ flex: "2 1 240px", padding: 0 }}>
          <div style={{ padding: "var(--s-4) var(--s-4) 0" }}>
            <div className="ds-label">
              ④ 共识白名单池 · {data?.counts.poolTotal ?? "—"}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              gap: "var(--s-2)",
              padding: "var(--s-2) var(--s-4) var(--s-3)",
            }}
          >
            <div
              role="button"
              tabIndex={0}
              onClick={() => switchView("members", ["src:leaderboard"])}
              onKeyDown={(e) =>
                e.key === "Enter" && switchView("members", ["src:leaderboard"])
              }
              style={{ flex: 1, cursor: "pointer" }}
              title="查看全局榜成员（top-100 自带门槛，免审查）"
            >
              <div className="kpi-value">{data?.counts.poolGlobal ?? "—"}</div>
              <div className="kpi-sub">🏛 全局榜 →</div>
            </div>
            <div
              role="button"
              tabIndex={0}
              onClick={() => switchView("members", ["grp:discovery"])}
              onKeyDown={(e) =>
                e.key === "Enter" && switchView("members", ["grp:discovery"])
              }
              style={{ flex: 1, cursor: "pointer" }}
              title="查看发现渠道产出的成员（分类榜专家 + 漏斗毕业生）"
            >
              <div className="kpi-value" style={{ color: "var(--up-700)" }}>
                {data?.counts.poolDiscovery ?? "—"}
              </div>
              <div className="kpi-sub">🔭 发现渠道 →</div>
            </div>
          </div>
        </div>
      </section>
      <div className="ds-hint" style={{ marginBottom: "var(--s-4)" }}>
        🏅 分类榜旁路：六类 × 周/月榜前 25
        直接进闸门（榜单排名即复发证据，仅过战绩审查） · ↺
        在池成员每日按战绩重新认证，30
        天不再合格自动出池——行为再现即可重新成为候选
      </div>

      {/* Controls: tab toggle + search */}
      <div
        style={{
          display: "flex",
          gap: "var(--s-3)",
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: "var(--s-3)",
        }}
      >
        <Segmented<View>
          ariaLabel="视图切换"
          value={view}
          onChange={switchView}
          options={[
            {
              label: `候选漏斗 (${data?.counts.candidateWallets ?? 0})`,
              value: "candidates",
            },
            {
              label: `白名单池 (${data?.counts.poolTotal ?? 0})`,
              value: "members",
            },
          ]}
        />
        <input
          className="ds-input"
          style={{ minWidth: 260, flex: "0 1 340px" }}
          placeholder="搜索地址 / 市场 / 标签…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索"
        />
        <button
          className="ds-btn"
          onClick={() => setTagHelpOpen(true)}
          title="查看全部钱包标签的定义（与说明页同一数据源）"
        >
          🏷 标签说明
        </button>
        {(activeTags.size > 0 || q) && (
          <span className="ds-hint">
            {filtered.length}/{rows.length} 条匹配
            <button
              className="ds-btn"
              style={{ marginLeft: "var(--s-2)" }}
              onClick={() => {
                setActiveTags(new Set());
                setQuery("");
              }}
            >
              清除
            </button>
          </span>
        )}
      </div>

      {/* Tag filter chips (multi-select = AND) */}
      {chipStats.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--s-1)",
            alignItems: "center",
            marginBottom: "var(--s-3)",
          }}
        >
          <span className="ds-label" style={{ marginRight: "var(--s-1)" }}>
            标签筛选
          </span>
          {chipStats.map(([key, s]) => {
            const active = activeTags.has(key);
            return (
              <button
                key={key}
                onClick={() => toggleTag(key)}
                aria-pressed={active}
                style={{
                  border: "none",
                  background: "none",
                  padding: 0,
                  cursor: "pointer",
                  outline: active ? "2px solid var(--brand-500)" : "none",
                  outlineOffset: 1,
                  borderRadius: "var(--r-sm)",
                }}
                title={`${filterChipLabel(key, s.sample)} — ${s.wallets} 个钱包${active ? "（点击取消）" : ""}`}
              >
                <Tag variant={active ? "brand" : tagVariant(s.sample)}>
                  {filterChipLabel(key, s.sample)}{" "}
                  <span className="mono">{s.wallets}</span>
                </Tag>
              </button>
            );
          })}
        </div>
      )}

      {/* Active view table */}
      {view === "candidates" ? (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th style={{ width: 130 }}>钱包</th>
                <th>标签</th>
                <th
                  className="is-right"
                  style={{ width: 90 }}
                  title="各渠道去重市场数之和（同一市场被两个渠道命中计两次——两种独立行为签名强于一种）"
                >
                  复发广度
                </th>
                <th>最近证据</th>
                <th style={{ width: 130 }}>状态</th>
              </tr>
            </thead>
            <tbody>
              {(filtered as CandidateRow[]).map((c) => (
                <Fragment key={c.address}>
                  <tr
                    onClick={() => toggleExpand(c.address)}
                    style={{ cursor: "pointer" }}
                    title="点击展开证据明细"
                  >
                    <td>{walletCell(c.address)}</td>
                    <td>
                      <WalletTagChips tags={c.tags} max={4} />
                    </td>
                    <td className="mono is-right">{c.totalMarkets}</td>
                    <td
                      style={{
                        whiteSpace: "normal",
                        maxWidth: 380,
                        lineHeight: 1.5,
                      }}
                    >
                      {c.latestNote}
                      <span
                        className="ds-hint"
                        style={{ marginLeft: "var(--s-2)" }}
                      >
                        {fmtAgo(c.lastTs)}
                      </span>
                    </td>
                    <td>{statusTag(c.status)}</td>
                  </tr>
                  {expanded.has(c.address) && (
                    <EvidenceDetailRows evidence={c.evidence} colSpan={5} />
                  )}
                </Fragment>
              ))}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="ds-hint">
                    {rows.length === 0
                      ? "暂无候选 —— 证据由共识循环（每 5 分钟）与每日已结算市场扫描持续积累"
                      : "无匹配 —— 试试清除搜索或标签筛选"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {data && data.counts.candidateWallets > data.candidates.length && (
            <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
              仅加载复发广度前 {data.candidates.length} 名（30 天窗口内共{" "}
              {data.counts.candidateWallets} 个候选钱包）
            </div>
          )}
        </div>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th style={{ width: 130 }}>钱包</th>
                <th>标签</th>
                <th className="is-right" style={{ width: 80 }}>
                  评分
                </th>
                <th className="is-right" style={{ width: 80 }}>
                  胜率
                </th>
                <th className="is-right" style={{ width: 110 }}>
                  净盈亏
                </th>
                <th
                  className="is-right"
                  style={{ width: 110 }}
                  title="最近一次通过播种/重认证确认资格的时间；30 天不再合格自动出池"
                >
                  最近确认
                </th>
              </tr>
            </thead>
            <tbody>
              {(filtered as MemberRow[]).map((a) => (
                <Fragment key={a.address}>
                  <tr
                    onClick={() => toggleExpand(a.address)}
                    style={{ cursor: "pointer" }}
                    title="点击展开证据明细"
                  >
                    <td>{walletCell(a.address)}</td>
                    <td>
                      <WalletTagChips tags={a.tags} max={4} />
                    </td>
                    <td className="mono is-right">
                      {a.score != null ? Math.round(a.score) : "—"}
                    </td>
                    <td className="mono is-right">
                      {a.winRate != null
                        ? `${Math.round(a.winRate * 100)}%`
                        : "—"}
                    </td>
                    <td
                      className="mono is-right"
                      style={
                        a.netPnl != null
                          ? {
                              color:
                                a.netPnl >= 0
                                  ? "var(--up-700)"
                                  : "var(--down-700)",
                            }
                          : undefined
                      }
                    >
                      {a.netPnl != null ? fmtSignedUsdCompact(a.netPnl) : "—"}
                    </td>
                    <td className="mono is-right">
                      {a.updatedAt != null ? fmtAgo(a.updatedAt) : "—"}
                    </td>
                  </tr>
                  {expanded.has(a.address) && (
                    <EvidenceDetailRows evidence={a.evidence} colSpan={6} />
                  )}
                </Fragment>
              ))}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="ds-hint">
                    {rows.length === 0
                      ? "暂无 —— 候选通过准入审查（复发 ≥3 + 战绩闸）或分类榜播种后出现在这里"
                      : "无匹配 —— 试试清除搜索或标签筛选"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Tag definitions dialog — same data source as /glossary (WALLET_TAGS) */}
      <Modal
        open={tagHelpOpen}
        onClose={() => setTagHelpOpen(false)}
        title="🏷 钱包标签说明"
        width={720}
      >
        <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
          与「说明」页同一数据源；悬停任意标签也能看到一句话提示。点击下方标签可直接按其筛选当前列表。
        </div>
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th style={{ width: 150 }}>标签</th>
                <th style={{ width: 86 }}>类别</th>
                <th>定义</th>
              </tr>
            </thead>
            <tbody>
              {WALLET_TAGS.map((t) => (
                <tr key={t.keyPrefix}>
                  <td style={{ whiteSpace: "nowrap", fontWeight: 600 }}>
                    {t.icon} {t.name}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{t.kind}</td>
                  <td style={{ whiteSpace: "normal", lineHeight: 1.6 }}>
                    {t.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    </main>
  );
}
