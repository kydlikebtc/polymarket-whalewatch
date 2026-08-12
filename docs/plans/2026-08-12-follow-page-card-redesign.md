# 跟单页策略卡改版 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 `/follow` 从「12 张平铺大卡 × 14 个指标」改成「克制卡片（1 条 sparkline + 4 个数字）+ 下沉的策略详情弹窗 + 可交互的大图」。

**Architecture:** 卡态判定与 sparkline 定域这两块纯逻辑提取到 `lib/followCardView.ts` 并配单测（`app/` 下没有组件测试基建，纯逻辑下沉是唯一能被自动化覆盖的部分）；`StrategyCard` 瘦身、新增 `Sparkline` 与 `StrategyDetailDialog` 组件、`EquityCurve` 加族筛选与 hover 高亮，这三块靠 `npm run typecheck` + 真机目视验收。

**Tech Stack:** TypeScript · Next.js 16 · React 19 · vitest。设计见 `docs/plans/2026-08-12-follow-page-card-redesign-design.md`。

**约定:** 纯函数先写失败测试 → 跑失败 → 最小实现 → 跑通 → 提交。测试命令 `npx vitest run <path>`，全量 `npm test`（基线 **871**），类型检查 `npm run typecheck`。分支 `claude/follow-page-card-redesign`，勿动 main。

**红线:**

1. **不写内联硬编码色值** —— `app/globals.css` 的 OKLCH token 与 `app/ui.tsx` 的共享组件是单一真相源。这条约定踩过坑：展示侧若用自己的一套默认值，界面会显示「无护栏」而实际护栏生效，看板骗人比没看板更糟。
2. **不引入跨档聚合 KPI** —— 与页面已有的「战绩不可跨档相加」口径声明直接冲突。
3. **搬运现有弹窗内容时逐字不改** —— `AccountPlanDialog` / `HistoryDialog` 的内容是前几轮迭代反复打磨过的（含口径说明与 tooltip），本次只改它们的**容器**，不改内容。

---

## Task 1: 提取卡态判定与 sparkline 定域（纯逻辑 + TDD）

**Files:**

- Create: `lib/followCardView.ts`
- Test: `lib/followCardView.test.ts`

**Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import {
  classifyCardState,
  sparklinePath,
  LOW_SAMPLE_THRESHOLD,
} from "./followCardView";

describe("classifyCardState — 三种卡态", () => {
  it("已结算 0 仓 → empty(不画曲线,虚线卡)", () => {
    expect(classifyCardState({ settledCount: 0, openCount: 0 })).toBe("empty");
  });

  it("已结算 0 仓但有持仓 → 仍是 empty(净值曲线需要结算点才有数据)", () => {
    expect(classifyCardState({ settledCount: 0, openCount: 3 })).toBe("empty");
  });

  it("已结算不足阈值 → low_sample(照常显示数字,但加警示)", () => {
    expect(classifyCardState({ settledCount: 3, openCount: 1 })).toBe(
      "low_sample",
    );
  });

  it("恰好等于阈值 → normal(阈值是「达到即可信」)", () => {
    expect(
      classifyCardState({ settledCount: LOW_SAMPLE_THRESHOLD, openCount: 0 }),
    ).toBe("normal");
  });

  it("超过阈值 → normal", () => {
    expect(classifyCardState({ settledCount: 44, openCount: 7 })).toBe(
      "normal",
    );
  });
});

describe("sparklinePath — 各自缩放的阶梯路径", () => {
  const W = 240;
  const H = 52;

  it("空曲线 → 空字符串(调用方据此不渲染 svg)", () => {
    expect(sparklinePath([], W, H)).toBe("");
  });

  it("单点 → 一条水平线(不能除零)", () => {
    const d = sparklinePath([{ ts: 100, cum: 50 }], W, H);
    expect(d).toContain("M");
    expect(d).not.toContain("NaN");
  });

  it("全部同值(cum 恒定)→ 水平线,不产生 NaN(值域为零的除法防护)", () => {
    const d = sparklinePath(
      [
        { ts: 1, cum: 10 },
        { ts: 2, cum: 10 },
        { ts: 3, cum: 10 },
      ],
      W,
      H,
    );
    expect(d).not.toContain("NaN");
    expect(d).not.toContain("Infinity");
  });

  it("各自缩放:最低点贴底、最高点贴顶(留 padding)", () => {
    const d = sparklinePath(
      [
        { ts: 1, cum: -100 },
        { ts: 2, cum: 100 },
      ],
      W,
      H,
    );
    // 提取所有 y 坐标,最小值应接近 0(顶),最大值接近 H(底)
    const ys = [...d.matchAll(/[ML] [\d.]+ ([\d.]+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(Math.min(...ys)).toBeLessThan(H * 0.2);
    expect(Math.max(...ys)).toBeGreaterThan(H * 0.8);
  });

  it("阶梯形状:相邻两点之间先水平后垂直(step-after,与大图同口径)", () => {
    const d = sparklinePath(
      [
        { ts: 0, cum: 0 },
        { ts: 10, cum: 100 },
      ],
      W,
      H,
    );
    // step-after 会产生 3 个坐标点:起点、水平延伸点、垂直跳变点
    expect((d.match(/L/g) ?? []).length).toBe(2);
  });

  it("输入乱序时按 ts 升序重排(不信任入参有序性)", () => {
    const ordered = sparklinePath(
      [
        { ts: 1, cum: 0 },
        { ts: 2, cum: 100 },
      ],
      W,
      H,
    );
    const shuffled = sparklinePath(
      [
        { ts: 2, cum: 100 },
        { ts: 1, cum: 0 },
      ],
      W,
      H,
    );
    expect(shuffled).toBe(ordered);
  });

  it("不修改入参数组", () => {
    const input = [
      { ts: 2, cum: 100 },
      { ts: 1, cum: 0 },
    ];
    const snapshot = JSON.stringify(input);
    sparklinePath(input, W, H);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/followCardView.test.ts`
Expected: FAIL — `Failed to resolve import "./followCardView"`

**Step 3: 最小实现**

```ts
// lib/followCardView.ts

// 跟单页策略卡的纯展示逻辑。提到 lib/ 是因为 app/ 下没有组件测试基建 ——
// 卡态判定与 sparkline 定域是这次改版里仅有的两块可被自动化覆盖的逻辑,
// 留在 page.tsx 里就只能靠目视。
// 设计见 docs/plans/2026-08-12-follow-page-card-redesign-design.md §3.1。

/**
 * 小样本阈值:已结算 <10 仓时,卡上的 ROI/胜率不具备可读性 —— 一档跟了 3 仓
 * 恰好赢 2 仓,胜率就是 67%,与另一档 44 仓的 48% 差着数量级的可信度。
 * 取 10 与项目既有纪律同源:聪明钱准入的质量闸用的也是「≥10 结算」。
 */
export const LOW_SAMPLE_THRESHOLD = 10;

export type CardState = "normal" | "low_sample" | "empty";

/**
 * 卡态判定。empty 只看 settledCount —— 净值曲线由结算点构成,有持仓但零结算
 * 时曲线依然是空的,画不出东西。两者的文案区分(「等待首次结算」vs「等待信号
 * 命中」)由调用方按 openCount 决定,不在这里编码。
 */
export function classifyCardState(m: {
  settledCount: number;
  openCount: number;
}): CardState {
  if (m.settledCount === 0) return "empty";
  if (m.settledCount < LOW_SAMPLE_THRESHOLD) return "low_sample";
  return "normal";
}

/**
 * 卡片 sparkline 的阶梯路径(step-after,与大图 stepPath 同口径:每个结算点
 * 之前维持前一水平,到该点垂直跳变)。
 *
 * **各自缩放**:按本条曲线自己的 min/max 定域,不接受外部统一值域 —— 统一
 * 缩放会把小额档压成一条平线(设计文档 U5)。代价是两张卡的曲线不可直接横比,
 * 横比职责交给页面下方的大图(统一坐标系)。
 *
 * 值域为零(全部同值/单点)时退化成水平居中线,不做除法 —— 否则会产出 NaN
 * 污染整个 path 属性,SVG 静默不渲染,比画错更难排查。
 */
export function sparklinePath(
  curve: { ts: number; cum: number }[],
  width: number,
  height: number,
): string {
  if (curve.length === 0) return "";
  const pts = [...curve].sort((a, b) => a.ts - b.ts);
  const PAD = 4; // 上下各留 4px,避免极值点被裁掉一半
  const vals = pts.map((p) => p.cum);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo;
  const tMin = pts[0].ts;
  const tSpan = pts[pts.length - 1].ts - tMin;
  const sx = (t: number) =>
    tSpan > 0 ? ((t - tMin) / tSpan) * width : width / 2;
  const sy = (v: number) =>
    span > 0 ? PAD + (1 - (v - lo) / span) * (height - PAD * 2) : height / 2;

  let d = `M ${sx(pts[0].ts).toFixed(1)} ${sy(pts[0].cum).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const x = sx(pts[i].ts).toFixed(1);
    d += ` L ${x} ${sy(pts[i - 1].cum).toFixed(1)}`;
    d += ` L ${x} ${sy(pts[i].cum).toFixed(1)}`;
  }
  return d;
}

/**
 * 面积填充路径 = 折线路径 + 沿底边闭合。仅用于 sparkline 的视觉重量,
 * 不承载任何额外信息。
 */
export function sparklineAreaPath(
  linePath: string,
  width: number,
  height: number,
): string {
  if (!linePath) return "";
  return `${linePath} L ${width.toFixed(1)} ${height} L 0 ${height} Z`;
}
```

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/followCardView.test.ts`
Expected: PASS (12 tests)

**Step 5: 提交**

```bash
git add lib/followCardView.ts lib/followCardView.test.ts
git commit -m "feat: 提取卡态判定与 sparkline 定域到 lib —— 改版里仅有的可测逻辑"
```

---

## Task 2: `Sparkline` 组件 + `StrategyCard` 瘦身

**Files:**

- Modify: `app/follow/page.tsx`

**这一步没有自动化测试**（`app/` 下无组件测试基建），验收靠 `npm run typecheck` + 下一轮真机目视。

**Step 1: 新增 `Sparkline` 组件**

放在 `StrategyCard` 之前：

```tsx
/**
 * 卡片迷你净值曲线。240×52,不画坐标轴 —— 这个尺寸塞不下可读的刻度,
 * 卡上只负责传达"走势形状",具体数值由下面 4 个指标承担,横向对比由
 * 页面下方的大图承担(统一坐标系)。
 * 颜色按终值正负取 up/down 语义色,与卡上「结算净值」的着色一致。
 */
function Sparkline({ curve }: { curve: { ts: number; cum: number }[] }) {
  const W = 240;
  const H = 52;
  const line = sparklinePath(curve, W, H);
  if (!line) return null;
  const net = curve[curve.length - 1]?.cum ?? 0;
  const tone = net >= 0 ? "var(--up-500)" : "var(--down-500)";
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height: H, display: "block" }}
      aria-hidden
    >
      <path d={sparklineAreaPath(line, W, H)} fill={tone} opacity={0.1} />
      <path d={line} fill="none" stroke={tone} strokeWidth={1.6} />
    </svg>
  );
}
```

从 `lib/followCardView` 导入 `sparklinePath` / `sparklineAreaPath` / `classifyCardState` / `LOW_SAMPLE_THRESHOLD`。

**Step 2: `StrategyCard` 瘦身**

保留：标题行（名称 + 领先/停用标签 + `low_sample` 时的「样本不足」标签）、`paramsHint`、`Sparkline`、**4 个 `Metric`**（结算净值 / ROI / 结算胜率 / 最大回撤）、元信息行、`CardActions`。

删除卡上的其余 10 个 `Metric`（平均年化 / 已结算·持有 / 累计追价成本 / 协议费 / 净盈亏(含成本) / 均延迟成本 / 均执行滑点 / 开始时间 / 运行时间 / 最大占用资金）—— 它们在 Task 3 进入详情弹窗。

**元信息行**（取代被删的「已结算 · 持有」Metric）：

```tsx
<div
  className="ds-hint"
  style={{
    display: "flex",
    gap: "var(--s-3)",
    flexWrap: "wrap",
    borderTop: "1px solid var(--n-100)",
    paddingTop: "var(--s-2)",
  }}
>
  {state === "low_sample" ? (
    <span style={{ color: "var(--warn-700)" }}>
      ⚠ 已结算仅 {m.settledCount} 仓
    </span>
  ) : (
    <span>已结算 {m.settledCount} 仓</span>
  )}
  <span>持有 {m.openCount}</span>
  {fund?.runDays != null ? (
    <span>运行 {Math.floor(fund.runDays)} 天</span>
  ) : null}
</div>
```

**`empty` 卡态**：不渲染 `Sparkline` 与 4 个 `Metric`，改为虚线边框 + 一句说明：

```tsx
// 空档:10 条新档刚上线时全是这个状态。虚线边框 + 说明把「还没轮到它」和
// 「跑了但没赚到钱」在视觉上分开 —— 沿用正常卡样式会显示 12 张写满「—」
// 的同样大小的卡,容易被误判成「新档都不工作」。
<div
  className="ds-hint"
  style={{ textAlign: "center", padding: "var(--s-4) 0", lineHeight: 1.7 }}
>
  {m.openCount > 0 ? (
    <>
      尚无已结算仓位
      <br />
      持有 {m.openCount} 仓 · 等待首次结算
    </>
  ) : (
    <>
      尚无仓位
      <br />
      等待信号命中
    </>
  )}
</div>
```

卡容器在 `empty` 时加 `borderStyle: "dashed"`、`background: "var(--n-50)"`。

**Step 3: 验证**

Run: `npm run typecheck`
Expected: 零错误

Run: `npm test`
Expected: 871 全绿（前端改动不影响 lib 测试）

**Step 4: 提交**

```bash
git add app/follow/page.tsx
git commit -m "feat: 策略卡瘦身 —— 14 指标收敛到 sparkline + 4 个核心数字 + 元信息行"
```

---

## Task 3: 策略详情弹窗（合并两个现有弹窗 + 承接下沉指标）

**Files:**

- Modify: `app/follow/page.tsx`

**Step 1: 新增 `StrategyDetailDialog`**

四区结构。**`AccountPlanDialog` 与 `HistoryDialog` 的内容逐字搬入，不改一个字**（它们含反复打磨过的口径说明与 tooltip）—— 本次只换容器：把两个独立 `<dialog>` 改成同一个弹窗里的两个 `<section>`。

```tsx
function StrategyDetailDialog({
  s,
  open,
  onClose,
}: {
  s: FollowStrategyView;
  open: boolean;
  onClose: () => void;
}) {
  // 四区:战绩全景 / 成本四段分解 / 账户推演 / 操作历史
}
```

**区 1「战绩全景」**：完整 14 指标，复用现有 `Metric` 组件与全部 `title` tooltip 文案（那些 tooltip 是口径说明的载体，删掉等于丢失口径）。

**区 2「成本四段分解」**：这是唯一新增的信息组织，把四个原本并列的指标串成一条链：

```tsx
// 追价成本 → 延迟成本 → 执行滑点 → 协议费 → 净盈亏(含成本)
// 单独成区的理由:这四项在旧卡片里是四个并列的 Metric,读者看不出它们是
// 一条推导链 —— 串起来才回答「纸面盈亏和实盘差在哪」。
// 净盈亏一档必须带覆盖率标注(feeSamples/settledCount):它只在费用已知的
// 那批仓上算,不是全量。
```

**区 3/4**：账户推演、操作历史，内容原样。

**Step 2: `CardActions` 简化**

两个按钮（「账户推演」「操作历史」）合并成一个「查看详情」。**保留卡上的「建议跟单额度 $X」** —— 它是少数几个「一眼有用」的数字，删掉会让读者必须开弹窗才知道这档要备多少钱。

**Step 3: 验证**

Run: `npm run typecheck` → 零错误
Run: `npm test` → 871 全绿

**Step 4: 提交**

```bash
git add app/follow/page.tsx
git commit -m "feat: 策略详情弹窗 —— 四区承接下沉指标,成本四段分解首次成链呈现"
```

---

## Task 4: 大图族筛选 + hover 高亮 + 空档过滤

**Files:**

- Modify: `app/follow/page.tsx`

**Step 1: 空档过滤**

`EquityCurve` 已有 `withData = series.filter((s) => s.curve.length > 0)` —— 确认它已经排除了空档（`curve` 来自 `metrics.equityCurve`，零结算时为空数组）。若已排除，本步无需改动，在报告里说明。

**Step 2: 族开关**

在 `EquityCurve` 上方加一排族 toggle（复用 `app/ui.tsx` 的 `Tag` 或 `Segmented`，**不新造组件**）：

```tsx
// 族开关:默认全开。点某族只看该族 —— 族内最多 5 条线,永远不会拥挤。
// 12 条线同屏时即便有 12 种可区分样式,人眼追踪单条仍然吃力。
const [activeFamilies, setActiveFamilies] = useState<Set<FamilyKey> | null>(
  null,
);
// null = 全部;非空 Set = 只显示这些族
```

族归属复用现有的 `familyOf(source)`。

**Step 3: hover 图例高亮**

`EquityCurve` 内部加 `const [hoverId, setHoverId] = useState<number | null>(null)`，图例项加 `onMouseEnter` / `onMouseLeave`（并加 `onFocus`/`onBlur` 供键盘用户）。

线条渲染时：

```tsx
opacity={hoverId == null || hoverId === s.id ? 1 : 0.2}
strokeWidth={hoverId === s.id ? 2.6 : 1.8}
```

**Step 4: 验证**

Run: `npm run typecheck` → 零错误
Run: `npm test` → 871 全绿

**Step 5: 提交**

```bash
git add app/follow/page.tsx
git commit -m "feat: 净值曲线加族筛选与 hover 高亮 —— 12 条线同屏时能追踪单条"
```

---

## 收尾验证

```bash
npm test          # 871 全绿
npm run typecheck # 零错误
```

**真机目视验收（必做，前端改动无自动化覆盖）：**

主仓库跑 `npm run dev`，打开 `/follow`，逐项确认：

1. **三种卡态都出现且可区分** —— 正常卡（有曲线 + 4 数字）、小样本卡（⚠ 标注）、空档卡（虚线边框）
2. **页面总高度** —— 卡片区应从 1600–2000px 降到 600–800px 量级
3. **sparkline 形状可读** —— 不是一条压平的直线，也没有因 NaN 而整条消失
4. **详情弹窗四区完整** —— 尤其账户推演与操作历史的内容与改版前逐字一致
5. **族开关与 hover 高亮生效** —— 点单族后图上只剩该族的线；悬停图例时其余线变淡
6. **窄窗口不溢出** —— 把浏览器拖到 900px 宽，卡片网格与族开关都不出现横向滚动

**若 dev server 起不来**：worktree 里 `node_modules` 为空是已知情况，本次在主仓库工作不受影响；若 turbopack 报工作区根解析错误，用 `npm run dev:webpack`。

---

## 本批不做

- **排序 / 打分 / 推荐标记** —— 设计文档 U2 已裁决；小样本下任何排序都会制造误导性的第一名
- **跨档聚合 KPI** —— 与页面已有的「战绩不可跨档相加」声明直接冲突
- **sparkline 统一 Y 轴** —— U5 已裁决走各自缩放；横比职责在大图
- **组件测试基建** —— 引入 React Testing Library 是独立课题，不在这次改版范围
