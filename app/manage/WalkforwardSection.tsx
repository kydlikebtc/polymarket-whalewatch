"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WalkforwardReport, WfTierReport } from "../../lib/walkforward";
import type { WfRunState } from "../../lib/walkforwardRun";
import { SectionHead } from "./bits";
import { sectionView } from "./sectionGate";
import { authHeaders } from "./shared";
import { reportMeta, runStateLine, tierLine } from "./walkforwardView";

// 🧪 阈值重推 tab(2026-08-28,walk-forward 批次;设计 §6.2 + 同日增补)。
//
// 三件事,全在一屏:①「▶ 跑一次」触发服务端子进程对生产库执行
// scripts/walkforward.ts(与运维 SSH 手工跑同一条路径,互斥锁防并跑,跑中
// 每 4s 轮询直到新报告落库);②「⬇ 下载」把最新报告完整 JSON(config 可复现
// 清单 + 全部格明细)拉成附件 —— 需带 token 走 fetch→blob,普通 <a> 带不了
// 管理头;③最新报告摘要 + 逐档存活明细。采纳仍是手工建挑战者档(见说明卡),
// 一键建档刻意不做。

interface LatestReport {
  id: number | null;
  createdAt: number | null;
  report: WalkforwardReport | null;
  runState: WfRunState;
}

const POLL_MS = 4_000;
const pts = (v: number) =>
  `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(2)}`;

function SurvivorRows({ t }: { t: WfTierReport }) {
  const survivors = t.candidates.filter((c) => c.survives);
  if (survivors.length === 0) return null;
  return (
    <table
      className="ds-table ds-table--compact"
      style={{ marginTop: "var(--s-2)" }}
    >
      <thead>
        <tr>
          <th>存活变体</th>
          <th>OOS 超额(点/仓)</th>
          <th>Bonferroni 下界</th>
          <th>随机化 p</th>
          <th>各折 OOS</th>
        </tr>
      </thead>
      <tbody>
        {survivors.map((v) => (
          <tr key={v.key}>
            <td>{v.label}</td>
            <td className="mono">
              {v.pooled
                ? `${pts(v.pooled.point)}(n=${v.pooled.n} 市场=${v.pooled.markets})`
                : "—"}
            </td>
            <td className="mono">{v.loBonf != null ? pts(v.loBonf) : "—"}</td>
            <td className="mono">{v.randP?.toFixed(4) ?? "—"}</td>
            <td className="mono ds-hint">
              {v.folds
                .filter((f) => f.evaluable)
                .map(
                  (f) =>
                    `${new Date(f.fold * 1000).toISOString().slice(5, 10)}:${
                      f.validatePoint == null ? "—" : pts(f.validatePoint)
                    }`,
                )
                .join("  ")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function WalkforwardSection({ token }: { token: string }) {
  const [data, setData] = useState<LatestReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/walkforward", {
        headers: authHeaders(token),
      });
      const body = (await res.json()) as LatestReport & { error?: string };
      if (!alive.current) return;
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setData(body);
      setError(null);
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [token]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  // 跑中每 4s 轮询:完成的判据不是「running 翻 false」本身,而是随后 GET
  // 读到的新报告行 —— 同一次轮询把两件事都带回来了。
  const running = data?.runState.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const startRun = async () => {
    setActionMsg(null);
    try {
      const res = await fetch("/api/admin/walkforward", {
        method: "POST",
        headers: authHeaders(token),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setActionMsg(body.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e));
    }
    void load();
  };

  const download = async () => {
    setActionMsg(null);
    try {
      const res = await fetch("/api/admin/walkforward?download=1", {
        headers: authHeaders(token),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setActionMsg(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const name =
        disposition.match(/filename="([^"]+)"/)?.[1] ??
        "walkforward-report.json";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const view = sectionView(data, error);
  const stateLine =
    data == null
      ? null
      : runStateLine(data.runState, Math.floor(Date.now() / 1000));

  return (
    <>
      <section
        className="ds-card"
        style={{ padding: "var(--s-5)", marginBottom: "var(--s-5)" }}
      >
        <SectionHead
          title="🧪 阈值重推(walk-forward)"
          hint="对厚档做收紧/平移方向的网格×子集选择,三道显著性闸(聚类 CI + Bonferroni + 方向随机化)。报告只给建议 —— 绝不自动改任何存量档参数。完整方法论与读法见下方使用说明。"
        />
        <div
          style={{
            display: "flex",
            gap: "var(--s-3)",
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: "var(--s-3)",
          }}
        >
          <button
            className="ds-btn ds-btn--sm"
            disabled={running}
            onClick={() => void startRun()}
          >
            {running ? "⏳ 跑中…" : "▶ 对生产库跑一次重推"}
          </button>
          <button
            className="ds-btn ds-btn--subtle ds-btn--sm"
            disabled={data?.report == null}
            onClick={() => void download()}
          >
            ⬇ 下载完整报告 JSON
          </button>
          {stateLine && <span className="ds-hint mono">{stateLine}</span>}
        </div>
        {actionMsg && (
          <div
            className="ds-hint"
            style={{
              color: "var(--warn, #b45309)",
              marginBottom: "var(--s-3)",
            }}
          >
            {actionMsg}
          </div>
        )}
        {data?.runState.lastRun && !data.runState.lastRun.ok && (
          <pre
            className="mono ds-hint"
            style={{
              whiteSpace: "pre-wrap",
              maxHeight: 200,
              overflow: "auto",
              border: "1px solid var(--line, #ddd)",
              borderRadius: 6,
              padding: "var(--s-3)",
              marginBottom: "var(--s-3)",
            }}
          >
            {data.runState.lastRun.tail.slice(-2_000)}
          </pre>
        )}

        {view.kind === "loading" && <div className="ds-hint">加载中…</div>}
        {view.kind === "error" && (
          <div className="ds-hint" style={{ color: "var(--warn, #b45309)" }}>
            加载失败:{view.message}
          </div>
        )}
        {view.kind === "ready" &&
          (view.data.report == null ? (
            <div className="ds-hint">
              还没有任何报告。点上方「▶ 对生产库跑一次重推」,或在服务器上执行:
              <code className="mono" style={{ margin: "0 var(--s-2)" }}>
                npx tsx scripts/walkforward.ts [dbPath]
              </code>
            </div>
          ) : (
            <>
              <div
                className="ds-hint mono"
                style={{ marginBottom: "var(--s-3)" }}
              >
                {reportMeta({
                  createdAt: view.data.createdAt ?? 0,
                  report: view.data.report,
                })}
              </div>
              {view.data.report.tiers.map((t) => (
                <div key={t.strategyId} style={{ marginBottom: "var(--s-4)" }}>
                  <div className="ds-hint">{tierLine(t)}</div>
                  <SurvivorRows t={t} />
                  {(t.watchlist.length > 0 || t.trainRejected > 0) && (
                    <div
                      className="ds-hint muted"
                      style={{ marginTop: "var(--s-1)" }}
                    >
                      格账本:候选 {t.candidates.length} · train 落选{" "}
                      {t.trainRejected}(validate 从未被看)· 可评折不足{" "}
                      {t.insufficient}
                      {t.watchlist.length > 0 &&
                        ` · 观察名单 ${t.watchlist.length}:${t.watchlist
                          .slice(0, 4)
                          .map((w) => `${w.label}(${w.validFolds}折)`)
                          .join("、")}${t.watchlist.length > 4 ? "…" : ""}`}
                    </div>
                  )}
                </div>
              ))}
              <div className="ds-hint muted">
                可观测锥:本报告只能回放收紧方向(原始流未归档);放松方向的唯一
                诚实做法是开更松的挑战者档向前跑。逐折明细/落选格/固定诚实段落
                在「⬇ 下载完整报告 JSON」里。
              </div>
            </>
          ))}
      </section>

      <section
        className="ds-card"
        style={{ padding: "var(--s-5)", marginBottom: "var(--s-5)" }}
      >
        <SectionHead
          title="📖 使用说明"
          hint="从跑一次到建挑战者档的完整路径;数字口径与红线在最后。"
        />
        <ol style={{ margin: 0, paddingLeft: "1.4em", lineHeight: 1.9 }}>
          <li>
            <b>这是什么。</b>19 个策略档的检测参数(单笔下限 / 钱包数 / 价格上限
            / 新鲜度 / 偏离护栏…)全是设计时的直觉初值。本工具用已结算纸面仓做
            walk-forward 检验:「假如当时参数更紧,战绩会不会显著更好」。每个变体
            = 对历史仓的过滤器子集(真滑点真手续费,零新模拟);退出维度查九规则
            反事实表。<b>它只产出建议,永不改动任何在跑档位的参数</b> ——
            档位参数一旦运行就是其公开战绩的定义。
          </li>
          <li>
            <b>怎么跑。</b>点上方「▶ 对生产库跑一次重推」:服务端起独立子进程执行
            <code className="mono"> npx tsx scripts/walkforward.ts</code>
            (与 SSH 手工跑同一条路径),一般几秒到一分钟,完成后本页自动出新报告;
            每次运行在 <code className="mono">walkforward_reports</code>{" "}
            表新增一行(历史留痕,不覆盖)。同一数据窗口重跑结果逐字节相同
            (随机化种子固定)。<b>节律:月度</b> —— validate 折按完整 UTC
            周自然长出,窗口没长新折时重跑只会得到同一份结论。
          </li>
          <li>
            <b>怎么读。</b>每档一行结论:🏁 有存活变体(下方表格给明细)/ ⭕
            无变体存活(这是一等结论,不是失败)/ 🪶 薄档(样本不足两折, 只报现状)。
            <b>存活 = 三道闸全过</b>:①市场聚类 CI 的 Bonferroni 下界 &gt;
            0(同市场多仓是一次随机事件的副本,按仓数算区间会虚窄); ②Bonferroni
            按「实际发布 validate 成绩的格数 G」校正(跑得越多单个
            显著越不值钱);③方向随机化 p ≤ 0.05/G(按市场隐含概率重掷结算一万次,
            专治「子集选择把运气选出来」)。数字口径:OOS 超额 =
            费用后、入场赔率调整的逐仓贡献(概率点);train 只选 validate 只评,
            train 落选的格连数字都不发布(发布即烧 OOS)。
          </li>
          <li>
            <b>怎么采纳(手工挑战者档)。</b>从存活变体里挑 ≤3 个(贪多 = 把
            Bonferroni 白算了)→ 到「🧭 对外产出 → ② 策略信号」手工新建档位:
            名称加 <code className="mono">·t26</code> 类标记、params
            按变体参数填 (注意:报告里 minPerWalletUsd
            是均值口径近似,建档要配真逐钱包值)、
            <b>push 保持关</b>,静默向前跑。满一个月后回本页再跑一次,同一份报告
            自然评出 champion vs challenger;原档去留(继续跑 / 关推送)是运营
            决定,工具不代劳。
          </li>
          <li>
            <b>红线与近似(读数前必知)。</b>只能回放收紧方向 —— 原始成交流
            刻意未归档,「假如阈值更松」没有数据基础,放松只能开更松的新档向前跑;
            score 下限维度不可回放(仓位未记录触发钱包与彼时评分),已用净买下限
            平移顶替;退出规则读数是纸面对纸面的下界(~10min 蜡烛盲区,实盘须
            另计退出侧盘口与费);报告不输出任何买卖建议。完整的固定诚实段落
            随每份下载的 JSON 落库。
          </li>
        </ol>
      </section>
    </>
  );
}
