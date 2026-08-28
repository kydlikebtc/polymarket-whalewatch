import type { WfTierReport, WalkforwardReport } from "../../lib/walkforward";

// 🧪 阈值重推卡的纯展示逻辑(与渲染分开,才测得动 —— routing.ts 同一纪律)。
// 卡只做「最新报告的摘要」:跑于何时/窗口/网格数/各档一行结论;不做一键建档
// (设计 §6.2:能力可达即可,一键化留给验证过报告价值之后)。

const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const pts = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(2)}`;

/** 卡头:跑于/窗口/网格/G/折。 */
export function reportMeta(r: {
  createdAt: number;
  report: WalkforwardReport;
}): string {
  const rp = r.report;
  return (
    `跑于 ${new Date(r.createdAt * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC · ` +
    `validate 折 ${rp.folds.map((f) => day(f)).join("/")} · ` +
    `网格 ${rp.gridTotal} 格 → 发布成绩 G=${rp.scoredCells} · ` +
    `Bonferroni z=${rp.zBonf.toFixed(2)} · 随机化 ${rp.randDraws.toLocaleString("en-US")} 次(种子 ${rp.seed})`
  );
}

/** 一档一行结论:薄档 / 无存活 / 存活 top(按 Bonferroni 下界挑)。 */
export function tierLine(t: WfTierReport): string {
  const head = `${t.name} · settled ${t.settledRaw} → 宇宙 ${t.universeN}`;
  if (t.thin) {
    const c = t.currentStat;
    const cur =
      c == null || !Number.isFinite(c.seC)
        ? "现状样本不足"
        : `现状 ${pts(c.point)} ± ${(1.96 * c.seC * 100).toFixed(2)} 点/仓`;
    return `🪶 ${head} —— 薄档只报现状:${cur}(市场 ${c?.nc ?? 0})`;
  }
  const survivors = t.candidates.filter((c) => c.survives);
  if (survivors.length === 0) {
    return (
      `⭕ ${head} —— 无变体存活(候选 ${t.candidates.length},` +
      `基线 OOS ${t.baseline?.pooled ? pts(t.baseline.pooled.point) : "—"} 点)`
    );
  }
  const top = survivors.reduce((a, b) =>
    (b.loBonf ?? -Infinity) > (a.loBonf ?? -Infinity) ? b : a,
  );
  return (
    `🏁 ${head} —— 存活 ${survivors.length} 个,最强:${top.label} ` +
    `OOS ${top.pooled ? pts(top.pooled.point) : "—"} 点` +
    `(Bonf 下界 ${top.loBonf != null ? pts(top.loBonf) : "—"},p=${top.randP?.toFixed(4) ?? "—"})`
  );
}
