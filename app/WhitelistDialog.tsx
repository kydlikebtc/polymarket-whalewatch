"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CopyButton,
  Modal,
  Segmented,
  Tag,
  WalletLink,
  fmtSignedUsdCompact,
} from "./ui";
import { useLang } from "./i18n";

type Row = {
  address: string;
  score: number | null;
  winRate: number | null;
  netPnl: number | null;
  isWhitelist: boolean;
  // MM-tagged pool members keep membership but never vote in consensus /
  // disagreement (P0.5) — badged so the pool count stays explainable.
  isMarketMaker?: boolean;
};

function shortWallet(w: string): string {
  return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

// 池的三档视图。互斥（用 Segmented，不是一排 FilterButton），口径由算术
// 闭合：全部 = 有投票权 + 机器人，因为「有投票权」就是 !isMarketMaker。
// 不引入新判据、不调新接口 —— 复用行上已有的 isMarketMaker 字段。
type Scope = "all" | "voting" | "mm";

// Clickable smart-money whitelist: searchable list of addresses (each links to
// the wallet dossier) with score / win-rate / realized PnL. Fetched once on
// first open and kept for the session.
export function WhitelistDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useLang();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("all");

  useEffect(() => {
    if (!open || rows) return;
    let active = true;
    fetch("/api/whitelist")
      .then((r) => r.json())
      .then((j) => {
        if (active) setRows((j.wallets as Row[]) ?? []);
      })
      .catch(() => {
        if (active) setRows([]);
      });
    return () => {
      active = false;
    };
  }, [open, rows]);

  // 档位与搜索串联（搜索 AND 档位），顺序不影响结果。
  const filtered = useMemo(() => {
    const list = rows ?? [];
    const inScope =
      scope === "all"
        ? list
        : scope === "voting"
          ? list.filter((r) => !r.isMarketMaker)
          : list.filter((r) => r.isMarketMaker);
    const s = q.trim().toLowerCase();
    return s ? inScope.filter((r) => r.address.includes(s)) : inScope;
  }, [rows, q, scope]);

  // 标题条副行与档位钮上的读数 —— 纯展示派生量，不改任何取数逻辑。
  const total = rows?.length ?? 0;
  const mmCount = (rows ?? []).filter((r) => r.isMarketMaker).length;
  const votingCount = total - mmCount;
  // 匹配读数的分母跟着当前档位走，否则「2/330」会把档位筛掉的行也算进去。
  const scopeTotal =
    scope === "all" ? total : scope === "voting" ? votingCount : mmCount;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={640}
      // 标题条：12px 大写小标（emoji 前缀）+ 20/600 主行 + 14px muted 副行。
      title={
        <>
          <span className="ds-label" style={{ display: "block" }}>
            🏆 {t("共识白名单池")}
          </span>
          <span style={{ display: "block", marginTop: 4 }}>
            {rows ? t("{n} 个钱包", { n: rows.length }) : t("聪明钱白名单")}
            {mmCount > 0 && (
              <span
                style={{
                  marginLeft: 6,
                  fontSize: "var(--t-md)",
                  fontWeight: 400,
                  color: "var(--ww-text-muted)",
                }}
              >
                {t("其中 {n} 个无投票权", { n: mmCount })}
              </span>
            )}
          </span>
        </>
      }
    >
      {/* 工具条（帧 14）：240px 搜索框 + 右对齐的三档互斥筛选。计数写在
          档位钮上 —— 「全部 = 有投票权 + 机器人」在钮上自己闭合，不需要
          一句说明。档位在 rows 到位后才出现，免得先闪一排 0。 */}
      <div className="filter-bar" style={{ marginBottom: "var(--s-4)" }}>
        <input
          className="ds-input"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("搜索地址…（0x…）")}
          aria-label={t("搜索白名单地址")}
          style={{ width: 240, maxWidth: "100%" }}
        />
        {rows != null && q.trim() !== "" && (
          <span className="ds-hint">
            {t("{shown}/{total} 条匹配", {
              shown: filtered.length,
              total: scopeTotal,
            })}
          </span>
        )}
        {rows != null && (
          <span className="filter-bar__right">
            <Segmented<Scope>
              ariaLabel={t("白名单范围")}
              value={scope}
              onChange={setScope}
              options={[
                { value: "all", label: t("全部 {n}", { n: total }) },
                {
                  value: "voting",
                  label: t("有投票权 {n}", { n: votingCount }),
                },
                { value: "mm", label: t("机器人 {n}", { n: mmCount }) },
              ]}
            />
          </span>
        )}
      </div>
      {rows == null ? (
        <div className="ds-empty">{t("加载中…")}</div>
      ) : filtered.length === 0 ? (
        // 空态给内容也给出路：搜不到（或档位筛空）时给一个回到全量的按钮，
        // 两个条件都要复位 —— 只清搜索会把人留在一个仍然空的档位里。
        <div className="ds-empty">
          {rows.length === 0
            ? t("白名单为空（引擎首次播种约需 1 分钟）")
            : t("无匹配地址")}
          {(q.trim() !== "" || scope !== "all") && (
            <div style={{ marginTop: "var(--s-3)" }}>
              <button
                className="ds-btn ds-btn--sm"
                onClick={() => {
                  setQ("");
                  setScope("all");
                }}
              >
                {t("清除")}
              </button>
            </div>
          )}
        </div>
      ) : (
        // 弹窗里不套第二层卡：Modal 自己已经是「标题条 + 内容区」两层
        // (readme §5)，再包一层 .ds-table-wrap 的描边 / 圆角 / 卡阴影就成了
        // 卡中卡。这里只保留横向滚动兜底，行与卡底琥珀条直接躺在内容区上，
        // 层级交回 1px 分格线。
        <div style={{ overflowX: "auto" }}>
          <table className="ds-table">
            <thead>
              <tr>
                <th>{t("地址")}</th>
                <th className="is-right" style={{ width: 80 }}>
                  {t("评分")}
                </th>
                <th className="is-right" style={{ width: 80 }}>
                  {t("胜率")}
                </th>
                <th className="is-right" style={{ width: 130 }}>
                  {t("净盈亏")}
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.address}>
                  {/* 地址是唯一做首尾省略的东西；来源与投票权是常驻徽章，
                      不再是只有桌面 hover 才读得到的 title —— 徽章说「是什么」，
                      title 只补「怎么判出来的」那个阈值。 */}
                  <td data-label={t("地址")}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "var(--s-2)",
                        flexWrap: "wrap",
                      }}
                    >
                      {/* 地址做了首尾省略，复制钮把完整地址交回给读者 ——
                          与 /wallet 档案页页头同一枚 13px ⧉。地址与 ⧉ 是同
                          一个单元，收在内层 span 里（间距由 .copy-btn 自带的
                          4px 左外边距给），外层 8px 才是它与徽章的间距。 */}
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          minWidth: 0,
                        }}
                      >
                        <WalletLink address={r.address}>
                          {shortWallet(r.address)}
                        </WalletLink>
                        <CopyButton text={r.address} />
                      </span>
                      {/* 灰底名称标签 = 「这个地址是谁」，不表示状态：手动
                          白名单行(is_whitelist=1)不参与 30 天老化清退，
                          「永不过期」是它与其余池成员的实际区别。 */}
                      {r.isWhitelist ? <Tag>{t("手动 · 永不过期")}</Tag> : null}
                      {r.isMarketMaker ? (
                        // 判定阈值收进 title —— 它解释「怎么判出来的」，
                        // 不改变任何读数，不占卡底说明条的那一行。
                        <span
                          style={{ display: "inline-flex" }}
                          title={t("做市机器人判定：成交市场数 ≥ 1000")}
                        >
                          <Tag variant="warn">🤖 {t("无投票权")}</Tag>
                        </span>
                      ) : null}
                    </span>
                  </td>
                  {/* `—` 是「判不了」，不是零 —— muted 与真实 0 分家。 */}
                  <td className="is-right" data-label={t("评分")}>
                    {r.score != null ? (
                      Math.round(r.score)
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="is-right" data-label={t("胜率")}>
                    {r.winRate != null ? (
                      `${Math.round(r.winRate * 100)}%`
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  {/* 净盈亏是真正的盈亏方向 —— 涨绿跌红成立（成本类才中性）。
                      判不了的行不染色：原来 null 会落进 `>= 0` 分支拿到绿。 */}
                  <td
                    className="is-right"
                    data-label={t("净盈亏")}
                    style={
                      r.netPnl != null
                        ? {
                            color:
                              r.netPnl >= 0 ? "var(--ww-up)" : "var(--ww-down)",
                          }
                        : undefined
                    }
                  >
                    {r.netPnl != null ? (
                      fmtSignedUsdCompact(r.netPnl)
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* 卡底说明条 —— 本弹窗唯一一条，压到一行。留下的两句都会改变
              读数：不读第一句就会把池子大小当成投票人数，不读第二句就会
              把「—」读成 0。做市机器人的判定阈值与「保留池籍以积累战绩」
              的设计理由是方法论，不占正文。 */}
          <div className="note-strip note-strip--warn">
            ⚠️{" "}
            {t(
              "「无投票权」= 做市机器人：库存再平衡不是方向性观点，不计入共识 / 分歧投票。评分 / 胜率 / 净盈亏的「—」是判不了、不是 0。",
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
