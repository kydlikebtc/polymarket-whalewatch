# X 推文文案 v2 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 按已批准设计 `docs/plans/2026-08-19-x-post-copy-density-design.md`，把五类 X 帖模板填满 280 加权字符折叠位（断言式抬头 / 钱包回执 / 赛前双边 / 战报回报率抬头 / 承诺行双闸门 / cashtag），全程 ≤280 绝不折叠。

**Architecture:** 全部改动集中在纯函数模板层（`lib/xComposer.ts`）与三个消费循环的传参处（`lib/xBroadcast.ts` / `lib/xPregame.ts` / `lib/xSettled.ts`）。新增两个纯函数底座：`weightedLength`（X 加权计数，emoji/`└` 计 2）与 `fitPost`（显式变体阶梯，先丢可选行后截标题）。凭证数据用 `getSmartTags` 本地 SQLite 查（零上游请求），共识回执/时间跨度全部来自 alerts payload 已有字段。**不改任何 TG 主链路代码。**

**Tech Stack:** TypeScript + vitest（`npx vitest run <file>`）。无新依赖。

**设计文档：** `docs/plans/2026-08-19-x-post-copy-density-design.md`（五类样例与四个拍板点都在里面，实现时对照）。

**与设计文档的一处偏差（已论证）：** 战报帖佐证行不用 "settled today"（`alert_outcomes` 无真实结算时刻，backfill 可能滞后数天，说 "today" 会撒谎），改用 `posted 2d ago`——`xSettled` 的查询**已经**带出 `posted_at`，从 thread 可直接验证，且多传达「提前量」。

---

## 背景速览（给零上下文执行者）

- 这是一个 Polymarket 监控项目。worker 把「大单/聪明钱共识」告警写进 SQLite `alerts` 表（`type` ∈ `large`/`smart`/`consensus`，`payload` 是 JSON）。
- `lib/xBroadcast.ts` 每 60s 消费 alerts 表发英文 X 帖；`lib/xPregame.ts` 每 10min 扫结算前 1-6h 的热市场；`lib/xSettled.ts` 对已发信号帖在结算后 self-reply 战报。
- 模板全在 `lib/xComposer.ts`（纯函数，无 I/O）。两条硬不变量有测试钉着：≤280 字符、除周报外无 URL。
- 测试跑法：`npx vitest run lib/xComposer.test.ts`（单文件）/ `npx vitest run`（全量，改完必须全绿）。
- 提交规范：`<type>: <中文描述>`（看 `git log --oneline` 学样）。**每个 Task 一个 commit。**

---

### Task 1: `weightedLength` — X 加权计数

**Files:**

- Modify: `lib/xComposer.ts`（`X_POST_MAX_CHARS` 附近新增导出）
- Test: `lib/xComposer.test.ts`

**Step 1: 写失败测试**（先读一遍 `lib/xComposer.test.ts` 开头，模仿现有 describe/it 风格，追加到文件末尾）

```ts
import { weightedLength } from "./xComposer"; // 并入文件顶部已有的 import

describe("weightedLength", () => {
  it("拉丁字母/数字/常用标点计 1", () => {
    expect(weightedLength("WHALE: $200K @ 80")).toBe(17);
    expect(weightedLength("¢")).toBe(1); // U+00A2 在拉丁补充区
    expect(weightedLength("·")).toBe(1); // U+00B7
    expect(weightedLength("—")).toBe(1); // U+2014 em dash 在 [8208,8223]
  });
  it("emoji 与制表符号计 2", () => {
    expect(weightedLength("🐳")).toBe(2);
    expect(weightedLength("└")).toBe(2); // U+2514
    expect(weightedLength("…")).toBe(2); // U+2026 不在权 1 区间
    expect(weightedLength("⏳")).toBe(2);
  });
  it("混排：真实抬头行", () => {
    // 🐳(2) + 空格(1)*6 + "WHALE:"(6) + "$200K"(5) + "says"(4) + "NO"(2) + "@"(1) + "80¢"(3)
    expect(weightedLength("🐳 WHALE: $200K says NO @ 80¢")).toBe(29);
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/xComposer.test.ts -t weightedLength`
Expected: FAIL — `weightedLength is not exported`

**Step 3: 最小实现**（放在 `X_POST_MAX_CHARS` 声明后面）

```ts
// X 的加权计数(twitter-text v3 口径):下列码点区间计 1,其余(emoji、└、…、
// ⏱ 等)计 2。旧实现用 [...s].length 数码点,每帖比 X 的算法少算 3~5 —— 填满
// 280 额度后这个差值就是折叠事故,必须按 X 的尺子量。
const WEIGHT_1_RANGES: [number, number][] = [
  [0, 4351], // 拉丁/西里尔/希腊等基本区
  [8192, 8205], // 常用空白与零宽
  [8208, 8223], // 连字符/引号/em dash
  [8242, 8247], // prime marks
];

export function weightedLength(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    w += WEIGHT_1_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return w;
}
```

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/xComposer.test.ts -t weightedLength`
Expected: PASS（3 个用例）

**Step 5: Commit**

```bash
git add lib/xComposer.ts lib/xComposer.test.ts
git commit -m "feat: weightedLength —— X 加权计数(emoji/制表符计2),照 X 的尺子量长度"
```

---

### Task 2: `fitPost` — 变体阶梯 + 加权截标题

**Files:**

- Modify: `lib/xComposer.ts`（替换 `fitByTruncatingTitle`，190 行附近）
- Test: `lib/xComposer.test.ts`

**Step 1: 写失败测试**

```ts
import { fitPost } from "./xComposer";

describe("fitPost", () => {
  const tags = "\n\n#Polymarket";
  it("取第一个 ≤280 加权的变体", () => {
    const rich = (t: string) => `HEAD\n\n${t}\n\nEXTRA LINE${tags}`;
    const lean = (t: string) => `HEAD\n\n${t}${tags}`;
    const title = "short title";
    expect(fitPost([rich, lean], title)).toBe(rich(title));
  });
  it("富变体超限时降到简变体，标题不动", () => {
    const pad = "x".repeat(270); // 富变体必超
    const rich = (t: string) => `${pad}\n\n${t}${tags}`;
    const lean = (t: string) => `HEAD\n\n${t}${tags}`;
    const title = "short title";
    expect(fitPost([rich, lean], title)).toBe(lean(title));
  });
  it("全部变体超限才截标题（按加权预算装入 + 省略号）", () => {
    const lean = (t: string) => `HEAD\n\n${t}${tags}`;
    const title = "T".repeat(400);
    const out = fitPost([lean], title);
    expect(weightedLength(out)).toBeLessThanOrEqual(280);
    expect(out).toContain("…");
    expect(out.startsWith("HEAD")).toBe(true);
  });
  it("emoji 标题截断不超限（权 2 字符正确扣预算）", () => {
    const lean = (t: string) => `HEAD\n\n${t}${tags}`;
    const title = "🐳".repeat(300);
    expect(weightedLength(fitPost([lean], title))).toBeLessThanOrEqual(280);
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/xComposer.test.ts -t fitPost`
Expected: FAIL — `fitPost is not exported`

**Step 3: 实现**（放在 `fitByTruncatingTitle` 旁边；**先不删旧函数**，各模板迁移完再删）

```ts
/**
 * 变体阶梯限长:variants 从最富到最简排列(每个 build 把 title 恰好嵌入一次),
 * 取第一个 ≤280 加权的;全超才截标题 —— 降级顺序从「砍标题」反转成「先丢可选
 * 事实行」:市场标题是读者判断"这事关不关我"的唯一依据,最后才动。
 */
function fitPost(
  variants: ((title: string) => string)[],
  title: string,
): string {
  for (const build of variants) {
    const full = build(title);
    if (weightedLength(full) <= X_POST_MAX_CHARS) return full;
  }
  // 全部梯级超限:用最简梯级截标题。预算 = 280 − 模板底座 − 2("…"权 2);
  // 按字符逐个累权装入,一次收敛无过冲(加权下"超 N 砍 N 码点"会砍错量)。
  const lean = variants[variants.length - 1];
  const budget = X_POST_MAX_CHARS - weightedLength(lean("")) - 2;
  let used = 0;
  let keep = 0;
  const chars = [...title];
  for (const ch of chars) {
    const cw = weightedLength(ch);
    if (used + cw > budget) break;
    used += cw;
    keep++;
  }
  return lean(chars.slice(0, keep).join("") + "…");
}
```

再加 `export { fitPost };` 或直接 `export function fitPost`（跟文件其他导出风格一致，用 `export function`）。

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/xComposer.test.ts -t fitPost`
Expected: PASS（4 个用例）

**Step 5: Commit**

```bash
git add lib/xComposer.ts lib/xComposer.test.ts
git commit -m "feat: fitPost 变体阶梯 —— 先丢可选行后截标题,加权预算装入"
```

---

### Task 3: 大单模板 v2（says/sells 断言抬头 + 聪明钱凭证行 + 承诺行）

**Files:**

- Modify: `lib/xComposer.ts`（`WhalePostInput` + `composeWhalePost`，199-256 行）
- Test: `lib/xComposer.test.ts`（whale 相关旧断言需同步改）

**Step 1: 写失败测试**（新 describe；同时把旧 whale 用例里断言 `"🐳 WHALE BUY · $200K"` 之类的期望串改成新版式——先跑一遍旧测试看哪些红了再逐个更新期望值）

```ts
describe("composeWhalePost v2", () => {
  const base = {
    usd: 200_000,
    side: "BUY" as const,
    outcome: "No",
    title: "Will Bitcoin dip to $45,000 by December 31, 2026?",
    priceCents: 80,
    pct24h: 94,
    liquidityUsd: 186_000,
    hoursToEnd: 136 * 24,
  };
  it("匿名大单:断言式抬头 says + outcome + 价格一行读完", () => {
    const t = composeWhalePost(base);
    expect(t.startsWith("🐳 WHALE: $200K says NO @ 80¢")).toBe(true);
    expect(t).toContain("📊 94% of 24h vol");
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
  });
  it("SELL 用 sells(卖出≠看反,不硬造方向)", () => {
    const t = composeWhalePost({ ...base, side: "SELL" });
    expect(t).toContain("$200K sells NO @ 80¢");
  });
  it("占比 ≥100% 升级抬头,佐证行不重复占比", () => {
    const t = composeWhalePost({ ...base, usd: 300_000, pct24h: 140 });
    expect(t).toContain(
      "🚨 WHALE: $300K says NO @ 80¢ — more than this market's entire 24h volume",
    );
    expect(t).not.toContain("% of 24h vol");
  });
  it("smart 传入 → 🏆 抬头 + Track record 行(null 段省略)", () => {
    const t = composeWhalePost({
      ...base,
      smart: { winRate: 0.74, netPnl: 1_200_000 },
    });
    expect(t.startsWith("🏆 SMART MONEY: $200K says NO @ 80¢")).toBe(true);
    expect(t).toContain("Track record: 74% win rate · +$1.2M PnL");
  });
  it("smart 全 null → 🏆 抬头保留,凭证行整行不出", () => {
    const t = composeWhalePost({ ...base, smart: {} });
    expect(t.startsWith("🏆 SMART MONEY:")).toBe(true);
    expect(t).not.toContain("Track record");
  });
  it("负 PnL 照实输出(Just the record)", () => {
    const t = composeWhalePost({ ...base, smart: { netPnl: -50_000 } });
    expect(t).toContain("Track record: -$50K PnL");
  });
  it("promiseSettled → 承诺行独立成段", () => {
    const t = composeWhalePost({
      ...base,
      hoursToEnd: 30,
      promiseSettled: true,
    });
    expect(t).toContain("\n\nResult posted at settlement — win or lose.\n\n");
  });
  it("超长标题:先丢承诺行再丢佐证行,标题最后才截", () => {
    const t = composeWhalePost({
      ...base,
      title: "Will " + "the committee ".repeat(18) + "decide?",
      promiseSettled: true,
    });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).not.toContain("Result posted");
  });
  it("硬不变量:≤280 加权 + 无 URL", () => {
    const t = composeWhalePost({
      ...base,
      smart: { winRate: 0.74, netPnl: 1_200_000 },
      promiseSettled: true,
      title: base.title + " https://example.com/x",
    });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).not.toMatch(/https?:\/\//);
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/xComposer.test.ts`
Expected: 新 describe 全 FAIL；旧 whale 用例可能也红（正常，Step 3 一起解决）

**Step 3: 实现**（替换 `WhalePostInput` 与 `composeWhalePost` 整体；文件头注释里「≤280 字符」改为「≤280 **加权**字符 = 蓝V时间线折叠位（非蓝V下仍是 API 硬限），计数见 weightedLength」）

```ts
export interface WhalePostInput {
  usd: number;
  side: "BUY" | "SELL";
  outcome: string;
  title: string;
  priceCents: number;
  pct24h?: number | null;
  liquidityUsd?: number | null;
  hoursToEnd?: number | null;
  category?: string | null;
  subcategory?: string | null;
  /**
   * type='smart'(白名单聪明钱)时传入:凭证行数据。null 段省略,全 null 时
   * 凭证行整行不出但 🏆 抬头保留(「当时是白名单钱包」是告警时刻的事实)。
   * 不传/null = 匿名大单(type='large'),沿用 🐳/🚨 抬头。
   */
  smart?: { winRate?: number | null; netPnl?: number | null } | null;
  /**
   * 承诺行开关。调用方按双闸门判定(见 xBroadcast):hoursToEnd ≤144h
   * (xSettled 只补发 7 天内原帖,超过就是空头支票)且 settled 功能开着。
   */
  promiseSettled?: boolean;
}

export const SETTLE_PROMISE_LINE = "Result posted at settlement — win or lose.";

/**
 * 断言式抬头(v2):`$200K says NO @ 80¢` 是一句有立场的人话 —— quote-tweet
 * 的饵;`says {outcome}` 对任意 outcome 语法成立(says YES / says Lakers)。
 * BUY→says,SELL→sells(卖出≠看反,不硬造方向)。
 *
 *   🐳 WHALE: $200K says NO @ 80¢
 *
 *   Will Bitcoin dip to $45,000 by December 31, 2026?
 *
 *   📊 94% of 24h vol · 💧 $186K liq · ⏳ 136d to settle
 *
 *   #Polymarket $BTC
 *
 * 降级阶梯:丢承诺行 → 丢佐证行 → 丢凭证行 → 截标题。
 */
export function composeWhalePost(i: WhalePostInput): string {
  const isSmart = i.smart != null;
  const icon = isSmart ? "🏆" : i.usd >= WHALE_SIREN_USD ? "🚨" : "🐳";
  const label = isSmart ? "SMART MONEY" : "WHALE";
  const verb = i.side === "SELL" ? "sells" : "says";
  const headline = i.pct24h != null && i.pct24h >= IMPACT_HEADLINE_PCT;
  const head =
    `${icon} ${label}: ${usdCompact(i.usd)} ${verb} ` +
    `${outcomeDisplay(i.outcome)} @ ${i.priceCents}¢` +
    (headline ? " — more than this market's entire 24h volume" : "");
  // Track record 凭证行(仅聪明钱)。
  const cred: string[] = [];
  if (isSmart) {
    const seg: string[] = [];
    const wr = i.smart?.winRate;
    if (wr != null) seg.push(`${Math.round(wr * 100)}% win rate`);
    const pnl = i.smart?.netPnl;
    if (pnl != null) seg.push(`${pnl >= 0 ? "+" : ""}${usdCompact(pnl)} PnL`);
    if (seg.length > 0) cred.push(`Track record: ${seg.join(" · ")}`);
  }
  const facts: string[] = [];
  if (i.pct24h != null && !headline)
    facts.push(`📊 ${Math.round(i.pct24h)}% of 24h vol`);
  if (i.liquidityUsd != null)
    facts.push(`💧 ${usdCompact(i.liquidityUsd)} liq`);
  if (i.hoursToEnd != null) facts.push(`⏳ ${settleShort(i.hoursToEnd)}`);
  const tags = buildTags({
    category: i.category,
    subcategory: i.subcategory,
    title: i.title,
  });
  const variant =
    (withFacts: boolean, withCred: boolean, withPromise: boolean) =>
    (title: string) => {
      const mid = [
        ...(withCred ? cred : []),
        ...(withFacts && facts.length > 0 ? [facts.join(" · ")] : []),
      ];
      return (
        `${head}\n\n${title}` +
        (mid.length > 0 ? `\n\n${mid.join("\n")}` : "") +
        (withPromise ? `\n\n${SETTLE_PROMISE_LINE}` : "") +
        `\n\n${tags}`
      );
    };
  const promise = i.promiseSettled === true;
  const ladder = [variant(true, true, promise)];
  if (promise) ladder.push(variant(true, true, false));
  ladder.push(variant(false, true, false));
  if (cred.length > 0) ladder.push(variant(false, false, false));
  return fitPost(ladder, sanitizeTitle(i.title));
}
```

注意：`usdCompact` 负数自带 `-` 号，所以 PnL 只在 ≥0 时补 `+`。

**Step 4: 跑测试**（新旧一起）

Run: `npx vitest run lib/xComposer.test.ts`
Expected: 新 describe PASS；把旧 whale 用例中过期的期望串更新为新版式（注意旧用例 `"含标签时仍守住 ≤280"` 这类不变量断言应原样保留并通过）

**Step 5: Commit**

```bash
git add lib/xComposer.ts lib/xComposer.test.ts
git commit -m "feat: 大单帖 v2 —— says/sells 断言抬头 + 聪明钱 Track record 行 + 承诺行"
```

---

### Task 4: xBroadcast — smart/large 分支 + 承诺行双闸门

**Files:**

- Modify: `lib/xBroadcast.ts`（`parseCandidate` 111-153 行、`XBroadcastDeps.kinds` 37 行、`runXBroadcastCycle` 传参 193 行）
- Test: `lib/xBroadcast.test.ts`

**Step 1: 写失败测试**（先读 `lib/xBroadcast.test.ts` 学它怎么造内存 DB 与 alerts 行；`smart_wallets` 表已在 db.ts 建表，直接 INSERT 即可）

```ts
describe("smart/large 分支与承诺行闸门", () => {
  it("type='smart' 查本地凭证 → 🏆 SMART MONEY 抬头 + Track record", () => {
    // 造一行 type='smart' 的告警(payload 含 proxyWallet),并往 smart_wallets
    // INSERT 该钱包 score/win_rate/realized_pnl
    // 断言 claim 的 text 含 "🏆 SMART MONEY:" 和 "Track record:"
  });
  it("type='large' 不查凭证 → 🐳 抬头,无 Track record", () => {
    // 同一钱包在 smart_wallets 有记录,但告警 type='large'
    // 断言 text 不含 "Track record"(当初没被判定为聪明钱,此刻不回头查)
  });
  it("type='smart' 但钱包已出池 → 🏆 抬头保留,无凭证行", () => {});
  it("承诺行双闸门:kinds.settled=true 且 hoursToEnd≤144 才出现", () => {
    // 四象限:(settled on/off) × (hoursToEnd 30h / 200h)
    // 只有 on × 30h 的 text 含 "Result posted at settlement"
  });
});
```

（测试体按该文件现有夹具风格补全——它已有完整的「造 alerts 行 → runXBroadcastCycle → 查 x_posts.text」路径可模仿。）

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/xBroadcast.test.ts`
Expected: 新用例 FAIL

**Step 3: 实现**

`XBroadcastDeps.kinds` 类型加 `settled?: boolean`（注释：不是发帖开关，是承诺行闸门的输入——settled 功能关着时承诺会落空，所以不印）。

`parseCandidate` whale 分支（`return { alertId... composeWhalePost({...}) }` 之前）：

```ts
import { getSmartTags } from "./smartWallets";

// 承诺行的时效闸门:xSettled 只补发 7 天内的原帖(SETTLED_MAX_AGE_SEC),
// 留 1 天缓冲 —— 更远的结算写承诺就是可被抓包的空头支票。
export const SETTLE_PROMISE_MAX_H = 144;

// parseCandidate 签名加第四参:
function parseCandidate(
  db: DB,
  row: AlertRow,
  minTradeUsd: number,
  settledOn: boolean,
): Candidate | null | "below_floor" {
  // ... whale 分支组装处:
  // 凭证:仅 type='smart' 查(type='large' 当初就没被判定为聪明钱,
  // 此刻回头查会前后不一致)。getSmartTags 是纯本地 SQLite,零上游请求。
  let smart: WhalePostInput["smart"] = null;
  if (row.type === "smart" && typeof p.proxyWallet === "string") {
    const tag = getSmartTags(db, [p.proxyWallet])[p.proxyWallet.toLowerCase()];
    smart = tag ? { winRate: tag.winRate, netPnl: tag.netPnl } : {};
  }
  const hoursToEnd = ctx?.hoursToEnd ?? null;
  // ...composeWhalePost 传参追加:
  //   smart,
  //   promiseSettled:
  //     settledOn && hoursToEnd != null && hoursToEnd <= SETTLE_PROMISE_MAX_H,
```

`runXBroadcastCycle` 里调用处改为 `parseCandidate(d.db, row, d.minTradeUsd, d.kinds?.settled === true)`。
（`WhalePostInput` 需要从 `./xComposer` import type。）

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/xBroadcast.test.ts`
Expected: PASS 全绿

**Step 5: Commit**

```bash
git add lib/xBroadcast.ts lib/xBroadcast.test.ts
git commit -m "feat: xBroadcast 找回 smart/large 区分 —— 本地查凭证 + 承诺行双闸门(144h×settled开关)"
```

---

### Task 5: 共识模板 v2（叙事 └ 行 + 逐钱包回执 + 阶梯）

**Files:**

- Modify: `lib/xComposer.ts`（`ConsensusPostInput` + `composeConsensusPost`，258-296 行）
- Test: `lib/xComposer.test.ts`

**Step 1: 写失败测试**

```ts
describe("composeConsensusPost v2", () => {
  const base = {
    walletCount: 2,
    outcome: "Nongshim Red Force",
    title: "LoL: Nongshim Red Force vs DN SOOPers - Game 2 Winner",
    totalUsd: 33_900,
    priceCents: 49,
    spanSec: 14 * 60,
    wallets: [
      { netUsd: 12_499, avgPriceCents: 64, winRate: 0.74 },
      { netUsd: 9_600, avgPriceCents: 45, winRate: 0.57 },
    ],
  };
  it("满配:叙事 └ 行 + 逐钱包回执(截图传播主体)", () => {
    const t = composeConsensusPost(base);
    expect(t).toContain(
      "└ 2 top-PnL wallets → Nongshim Red Force @ 49¢ avg · $33.9K within 14 min",
    );
    expect(t).toContain("🏆 $12.5K @ 64¢ · 74% win rate");
    expect(t).toContain("🏆 $9.6K @ 45¢ · 57% win rate");
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
  });
  it("窗口 >60min 不讲集中度(不稀奇就删句),金额落回 combined", () => {
    const t = composeConsensusPost({ ...base, spanSec: 2 * 3600 });
    expect(t).not.toContain("within");
    expect(t).toContain("$33.9K combined");
  });
  it("winRate 为 null 的回执省略胜率段", () => {
    const t = composeConsensusPost({
      ...base,
      wallets: [{ netUsd: 12_499, avgPriceCents: 64, winRate: null }],
    });
    expect(t).toContain("🏆 $12.5K @ 64¢\n");
    expect(t).not.toContain("null");
  });
  it("老 payload 无 wallets/spanSec → 无回执块,└ 行仍完整", () => {
    const t = composeConsensusPost({
      walletCount: 3,
      outcome: "Yes",
      title: "Fed cut in Sept?",
      totalUsd: 92_000,
      priceCents: 58,
    });
    expect(t).toContain("└ 3 top-PnL wallets → YES @ 58¢ avg · $92K combined");
    expect(t).not.toContain("🏆 $");
  });
  it("长标题降级:回执坍缩成聚合行,标题不截", () => {
    const longTitle =
      "Will the Federal Reserve cut interest rates by 50bps or more at the September 2026 FOMC meeting?";
    const t = composeConsensusPost({
      ...base,
      title: longTitle,
      walletCount: 3,
      wallets: [
        { netUsd: 48_000, avgPriceCents: 57, winRate: 0.81 },
        { netUsd: 27_000, avgPriceCents: 58, winRate: 0.74 },
        { netUsd: 17_000, avgPriceCents: 60, winRate: 0.57 },
      ],
      spanSec: 41 * 60,
    });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).toContain(longTitle); // 标题完整
    // 3 行回执装不下(实测 296) → 先试 2 行(实测 265,装得下)
    expect(t).toContain("🏆 $48K @ 57¢ · 81% win rate");
    expect(t).not.toContain("$17K");
  });
  it("硬不变量:≤280 加权 + 无 URL", () => {
    const t = composeConsensusPost({
      ...base,
      title: base.title + " https://leak.example",
    });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).not.toMatch(/https?:\/\//);
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/xComposer.test.ts -t "composeConsensusPost v2"`
Expected: FAIL

**Step 3: 实现**（整体替换）

```ts
export interface ConsensusWalletReceipt {
  netUsd: number;
  avgPriceCents: number;
  winRate?: number | null; // 0-1
}

export interface ConsensusPostInput {
  walletCount: number;
  outcome: string;
  title: string;
  totalUsd: number;
  /** 聚钱的金额加权买入均价(¢)。缺失整段省略(老告警行没有,0¢ 像白送)。 */
  priceCents?: number | null;
  /** lastTs − firstTs。>60min 不讲(不稀奇就删句,以保诚实)。 */
  spanSec?: number | null;
  /** 逐钱包回执,netUsd 降序(payload 里本就有序)。老 payload 缺失 → 无回执。 */
  wallets?: ConsensusWalletReceipt[];
  category?: string | null;
  subcategory?: string | null;
}

/**
 * 品牌抬头保持恒定(识别度即品牌),叙事下沉到 └ 行一句讲完,正文主体是
 * 逐钱包回执 —— 截图传播的主体,别家给不出:
 *
 *   🔥 SMART-MONEY CONSENSUS
 *
 *   LoL: Nongshim Red Force vs DN SOOPers - Game 2 Winner
 *   └ 2 top-PnL wallets → Nongshim Red Force @ 49¢ avg · $33.9K within 14 min
 *
 *   🏆 $12.5K @ 64¢ · 74% win rate
 *   🏆 $9.6K @ 45¢ · 57% win rate
 *
 *   #Polymarket #Esports #LeagueOfLegends
 *
 * 明确不放:钱包 PnL(装不下,小 PnL 反削弱说服力)、last fill Xm ago
 * (播报 ≤60s 一轮,发帖时刻≈最后一笔时刻,废字符)。
 * 降级阶梯:丢金额最小的回执行 → 坍缩成聚合胜率行 → 无凭证块 → 截标题。
 */
export function composeConsensusPost(i: ConsensusPostInput): string {
  const at = i.priceCents != null ? ` @ ${i.priceCents}¢ avg` : "";
  const within =
    i.spanSec != null && i.spanSec >= 0 && i.spanSec <= 3600
      ? ` within ${Math.max(1, Math.round(i.spanSec / 60))} min`
      : "";
  const money = within
    ? `${usdCompact(i.totalUsd)}${within}`
    : `${usdCompact(i.totalUsd)} combined`;
  const story = (title: string) =>
    `🔥 SMART-MONEY CONSENSUS\n\n${title}\n└ ${i.walletCount} top-PnL wallets → ${outcomeDisplay(i.outcome)}${at} · ${money}`;
  const receipts = (i.wallets ?? []).slice(0, 3).map((w) => {
    const wr =
      w.winRate != null ? ` · ${Math.round(w.winRate * 100)}% win rate` : "";
    return `🏆 ${usdCompact(w.netUsd)} @ ${w.avgPriceCents}¢${wr}`;
  });
  const rates = (i.wallets ?? [])
    .map((w) => w.winRate)
    .filter((r): r is number => r != null)
    .map((r) => `${Math.round(r * 100)}%`);
  const tags = buildTags({
    category: i.category,
    subcategory: i.subcategory,
    title: i.title,
  });
  const variant = (cred: string[]) => (title: string) =>
    story(title) +
    (cred.length > 0 ? `\n\n${cred.join("\n")}` : "") +
    `\n\n${tags}`;
  const ladder: ((t: string) => string)[] = [];
  for (let k = receipts.length; k >= Math.min(2, receipts.length); k--) {
    if (k > 0) ladder.push(variant(receipts.slice(0, k)));
  }
  if (rates.length > 0)
    ladder.push(variant([`🏆 Win rates: ${rates.join(" · ")}`]));
  ladder.push(variant([]));
  return fitPost(ladder, sanitizeTitle(i.title));
}
```

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/xComposer.test.ts`
Expected: 新 describe PASS；旧 consensus 用例期望串同步更新（`SMART-MONEY CONSENSUS` 抬头没变，`└ N top-PnL wallets → …` 行措辞变了）

**Step 5: Commit**

```bash
git add lib/xComposer.ts lib/xComposer.test.ts
git commit -m "feat: 共识帖 v2 —— 叙事└行 + 逐钱包胜率回执 + 坍缩式降级阶梯"
```

---

### Task 6: xBroadcast — 共识 payload 透传 wallets/spanSec

**Files:**

- Modify: `lib/xBroadcast.ts`（`parseCandidate` consensus 分支，81-110 行）
- Test: `lib/xBroadcast.test.ts`

**Step 1: 写失败测试**（payload 用真实 `ConsensusGroup` 形状：`wallets: [{wallet, netUsd, buyCount, avgBuyPrice, score, winRate, qualifiedTs}]` + `firstTs/lastTs`）

```ts
it("共识候选透传 wallets 回执与时间跨度", () => {
  // payload: walletCount 2、firstTs 1000、lastTs 1840(14min)、
  // wallets 两个(netUsd 12499/avgBuyPrice 0.64/winRate 0.74;9600/0.45/0.57)
  // 断言 text 含 "within 14 min"、"🏆 $12.5K @ 64¢ · 74% win rate"
});
it("老共识 payload(无 wallets/firstTs)不崩,text 无回执块", () => {});
it("wallets 里的脏项(缺 netUsd/avgBuyPrice≤0)被过滤", () => {});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/xBroadcast.test.ts`

**Step 3: 实现**（consensus 分支 `return` 前）

```ts
// 回执与时间跨度:payload = 完整 ConsensusGroup,零新增查询。容错解析 ——
// 老告警行没有这些字段,缺哪段模板就省哪段。
const receipts = (Array.isArray(p.wallets) ? p.wallets : [])
  .filter(
    (w): w is Record<string, unknown> => typeof w === "object" && w !== null,
  )
  .map((w) => ({
    netUsd: typeof w.netUsd === "number" ? w.netUsd : NaN,
    avgBuyPrice: typeof w.avgBuyPrice === "number" ? w.avgBuyPrice : NaN,
    winRate: typeof w.winRate === "number" ? w.winRate : null,
  }))
  .filter((w) => Number.isFinite(w.netUsd) && w.avgBuyPrice > 0)
  .map((w) => ({
    netUsd: w.netUsd,
    avgPriceCents: Math.round(w.avgBuyPrice * 100),
    winRate: w.winRate,
  }));
const spanSec =
  typeof p.firstTs === "number" &&
  typeof p.lastTs === "number" &&
  p.lastTs >= p.firstTs
    ? p.lastTs - p.firstTs
    : null;
// composeConsensusPost 传参追加: wallets: receipts, spanSec,
```

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/xBroadcast.test.ts`

**Step 5: Commit**

```bash
git add lib/xBroadcast.ts lib/xBroadcast.test.ts
git commit -m "feat: xBroadcast 共识候选透传钱包回执与时间跨度(payload 白拿,零新查询)"
```

---

### Task 7: 赛前模板 v2（三种局面抬头 + 双边资金 + 单复数修正）

**Files:**

- Modify: `lib/xComposer.ts`（`PregamePostInput` + `composePregamePost`，298-336 行）
- Test: `lib/xComposer.test.ts`

**Step 1: 写失败测试**

```ts
describe("composePregamePost v2", () => {
  const base = {
    title: "Lakers vs Celtics",
    hoursToEnd: 3,
    alertCount: 7,
    topSidePriceCents: 61,
    sides: [
      { name: "Lakers", usd: 310_000 },
      { name: "Celtics", usd: 42_000 },
    ],
  };
  it("比例 ≥2:X-to-1 抬头 + 双边资金行", () => {
    const t = composePregamePost(base);
    expect(t).toContain("⏰ SETTLES IN 3H — smart money is 7-to-1 on Lakers");
    expect(t).toContain("└ Lakers @ 61¢");
    expect(t).toContain(
      "📡 7 signals in 24h · $310K on Lakers vs $42K on Celtics",
    );
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
  });
  it("一边倒:every signal 抬头 + all on one side(不输出 vs $0)", () => {
    const t = composePregamePost({
      ...base,
      hoursToEnd: 6,
      alertCount: 1,
      topSidePriceCents: 62,
      sides: [{ name: "Nongshim Red Force", usd: 13_100 }],
    });
    expect(t).toContain("— every signal is on Nongshim Red Force");
    expect(t).toContain("📡 1 signal in 24h · all $13.1K on one side");
    expect(t).not.toContain("vs $0");
  });
  it("比例 <2:SPLIT 抬头 + Slight lean 前缀(分歧本身是好故事)", () => {
    const t = composePregamePost({
      ...base,
      hoursToEnd: 2,
      alertCount: 9,
      topSidePriceCents: 54,
      sides: [
        { name: "Chiefs", usd: 180_000 },
        { name: "Bills", usd: 150_000 },
      ],
      title: "Chiefs vs Bills",
    });
    expect(t).toContain("— smart money is SPLIT on this one");
    expect(t).toContain("└ Slight lean Chiefs @ 54¢");
  });
  it("无 sides(全 SELL 市场):裸抬头不崩,资金行不出", () => {
    const t = composePregamePost({ ...base, sides: [] });
    expect(t).toContain("⏰ SETTLES IN 3H\n");
    expect(t).toContain("📡 7 signals in 24h\n");
  });
  it("二元市场 outcome 大写:YES/NO 经 outcomeDisplay", () => {
    const t = composePregamePost({
      ...base,
      sides: [
        { name: "Yes", usd: 200_000 },
        { name: "No", usd: 50_000 },
      ],
    });
    expect(t).toContain("4-to-1 on YES");
    expect(t).toContain("$200K on YES vs $50K on NO");
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/xComposer.test.ts -t "composePregamePost v2"`

**Step 3: 实现**（整体替换；`totalUsd`/`topSide` 字段删除，`sides` 取代——`buyUsdByOutcome` 只含 BUY，`sides[0].usd` 才是「押在这边」的诚实数字，旧 `totalUsd` 混着 SELL 与共识金额）

```ts
export interface PregameSide {
  name: string;
  usd: number; // 该结果上的 BUY 金额(24h)
}

export interface PregamePostInput {
  title: string;
  hoursToEnd: number;
  alertCount: number;
  /** sides[0] 的现价(¢),取不到就省略。 */
  topSidePriceCents?: number | null;
  /** 按 BUY 金额降序,composer 用前两个。空数组 = 无方向可讲。 */
  sides?: PregameSide[];
  category?: string | null;
  subcategory?: string | null;
}

/**
 * 三种局面三种讲法(buyUsdByOutcome 存了两边,旧模板只讲 Leaning 一边):
 *   比例 ≥2   ⏰ SETTLES IN 3H — smart money is 7-to-1 on Lakers
 *   对面为 0  ⏰ SETTLES IN 6H — every signal is on Nongshim Red Force
 *   比例 <2   ⏰ SETTLES IN 2H — smart money is SPLIT on this one
 * 资金行:$310K on Lakers vs $42K on Celtics / all $13.1K on one side。
 */
export function composePregamePost(i: PregamePostInput): string {
  const hh = settleShort(i.hoursToEnd).replace(" to settle", "").toUpperCase();
  const s0 = i.sides?.[0];
  const s1 = i.sides?.[1];
  let stance = "";
  let leanPrefix = "";
  if (s0 && s0.usd > 0) {
    if (s1 && s1.usd > 0) {
      const ratio = s0.usd / s1.usd;
      if (ratio >= 2) {
        stance = ` — smart money is ${Math.round(ratio)}-to-1 on ${outcomeDisplay(s0.name)}`;
      } else {
        stance = " — smart money is SPLIT on this one";
        leanPrefix = "Slight lean ";
      }
    } else {
      stance = ` — every signal is on ${outcomeDisplay(s0.name)}`;
    }
  }
  const head = `⏰ SETTLES IN ${hh}${stance}`;
  const lean = s0
    ? `\n└ ${leanPrefix}${outcomeDisplay(s0.name)}` +
      (i.topSidePriceCents != null ? ` @ ${i.topSidePriceCents}¢` : "")
    : "";
  const sig = `📡 ${i.alertCount} signal${i.alertCount === 1 ? "" : "s"} in 24h`;
  const moneyClause =
    s0 && s0.usd > 0
      ? s1 && s1.usd > 0
        ? ` · ${usdCompact(s0.usd)} on ${outcomeDisplay(s0.name)} vs ${usdCompact(s1.usd)} on ${outcomeDisplay(s1.name)}`
        : ` · all ${usdCompact(s0.usd)} on one side`
      : "";
  const tags = buildTags({
    category: i.category,
    subcategory: i.subcategory,
    title: i.title,
  });
  const variant = (withMoney: boolean) => (title: string) =>
    `${head}\n\n${title}${lean}\n\n${sig}${withMoney ? moneyClause : ""}\n\n${tags}`;
  return fitPost(
    moneyClause ? [variant(true), variant(false)] : [variant(false)],
    sanitizeTitle(i.title),
  );
}
```

**Step 4: 跑测试**（新 PASS；旧 pregame 用例期望串更新——`SETTLING IN` → `SETTLES IN`、`smart-money signals` → `signals`）

Run: `npx vitest run lib/xComposer.test.ts`

**Step 5: Commit**

```bash
git add lib/xComposer.ts lib/xComposer.test.ts
git commit -m "feat: 赛前帖 v2 —— 三种局面抬头(X-to-1/every/SPLIT) + 双边资金 + 单复数修正"
```

---

### Task 8: xPregame — 调用点传 sides

**Files:**

- Modify: `lib/xPregame.ts`（`topSideOf` 114-126 行改造 + compose 调用 188-200 行）
- Test: `lib/xPregame.test.ts`

**Step 1: 写失败测试**（模仿现有夹具；断言最终 claim 的 text）

```ts
it("双边资金进帖:top2 按 BUY 金额降序", () => {
  // 造两边 BUY 告警($310K Lakers / $42K Celtics) → text 含 "7-to-1 on Lakers"
});
it("只有一边有 BUY:text 含 all … on one side", () => {});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/xPregame.test.ts`

**Step 3: 实现**：`topSideOf` 改为 `sidesOf`：

```ts
// BUY 金额降序的两边(composer 只用前两个)。SELL 不进 buyUsdByOutcome,
// 所以这里的数字是"押在这边"的诚实口径。
function sidesOf(agg: MarketAgg): { name: string; usd: number }[] {
  return [...agg.buyUsdByOutcome.entries()]
    .map(([name, usd]) => ({ name, usd }))
    .filter((s) => s.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 2);
}
```

调用点：

```ts
const sides = sidesOf(c);
let topSidePriceCents: number | null = null;
if (sides[0]) {
  const idx = c.meta.outcomes.indexOf(sides[0].name);
  const price = idx >= 0 ? c.meta.outcomePrices[idx] : undefined;
  if (typeof price === "number" && Number.isFinite(price)) {
    topSidePriceCents = Math.round(price * 100);
  }
}
const text = composePregamePost({
  title: c.title,
  hoursToEnd: c.hoursToEnd,
  alertCount: c.alertCount,
  topSidePriceCents,
  sides,
  ...taxonomy,
});
```

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/xPregame.test.ts`

**Step 5: Commit**

```bash
git add lib/xPregame.ts lib/xPregame.test.ts
git commit -m "feat: xPregame 传双边资金 —— buyUsdByOutcome 两边都用上"
```

---

### Task 9: 战报模板 v2（回报率抬头 + 信号类型标签 + posted-ago + 输帖立场行）

**Files:**

- Modify: `lib/xComposer.ts`（`SettlementPostInput` + `composeSettlementPost`，338-408 行）
- Test: `lib/xComposer.test.ts`

**Step 1: 写失败测试**

```ts
describe("composeSettlementPost v2", () => {
  const base = {
    title: "Baltimore Orioles vs. Tampa Bay Rays",
    outcome: "Baltimore Orioles",
    entryCents: 40,
    side: "BUY" as const,
    won: true,
    signalKind: "consensus" as const,
    postedAgoSec: 2 * 86400,
  };
  it("赢:回报率提进抬头(被 quote 的就是这行),无立场行", () => {
    const t = composeSettlementPost(base);
    expect(t.startsWith("✅ CALLED IT · 40¢ → $1.00 (+150%)")).toBe(true);
    expect(t).toContain(
      "└ Consensus signal on Baltimore Orioles, posted 2d ago",
    );
    expect(t).not.toContain("every result");
  });
  it("输:立场行是全场最硬的信任证明(不对称是刻意的)", () => {
    const t = composeSettlementPost({
      ...base,
      entryCents: 62,
      won: false,
      signalKind: "whale",
    });
    expect(t.startsWith("❌ MISSED · 62¢ → $0")).toBe(true);
    expect(t).toContain("└ Whale signal on Baltimore Orioles");
    expect(t).toContain("We post every result, wins and losses.");
  });
  it("SELL 沿用两个可核对价格,不编回报率", () => {
    const t = composeSettlementPost({
      ...base,
      side: "SELL",
      entryCents: 62,
      won: true,
    });
    expect(t.startsWith("✅ CALLED IT · sold 62¢ → $0.00")).toBe(true);
  });
  it("无入场价:裸抬头", () => {
    const t = composeSettlementPost({ ...base, entryCents: null });
    expect(t.startsWith("✅ CALLED IT\n")).toBe(true);
  });
  it("postedAgoSec <48h 用小时,缺失省略从句", () => {
    expect(
      composeSettlementPost({ ...base, postedAgoSec: 14 * 3600 }),
    ).toContain("posted 14h ago");
    expect(
      composeSettlementPost({ ...base, postedAgoSec: null }),
    ).not.toContain("posted");
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/xComposer.test.ts -t "composeSettlementPost v2"`

**Step 3: 实现**（整体替换；保留原注释里「输的也发 / 只报单笔事实 / 名义回报」三点设计立场，追加第 4 点：**输帖才带立场行**——赢时自夸+表态是油，输时表态是最硬的信任证明）

```ts
export interface SettlementPostInput {
  title: string;
  outcome: string;
  entryCents?: number | null;
  side?: "BUY" | "SELL";
  won: boolean;
  /** 原信号类型 → "Consensus signal"/"Whale signal" 标签;缺省退 "Signal"。 */
  signalKind?: "whale" | "consensus";
  /**
   * 原帖发出距今秒数(posted_at → now)。不用 "settled today" ——
   * alert_outcomes 没有真实结算时刻,backfill 可能滞后;"posted 2d ago"
   * 从 thread 就能验证,还多给了提前量信息。
   */
  postedAgoSec?: number | null;
  category?: string | null;
  subcategory?: string | null;
}

function agoShort(sec: number): string {
  const h = sec / 3600;
  if (h < 1) return "under 1h ago";
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function composeSettlementPost(i: SettlementPostInput): string {
  const c = i.entryCents;
  const priced = c != null && Number.isFinite(c) && c > 0 && c <= 100;
  const isSell = i.side === "SELL";
  let head = i.won ? "✅ CALLED IT" : "❌ MISSED";
  if (priced) {
    const entry = c as number;
    const settle = i.won === !isSell ? "$1.00" : "$0.00";
    if (isSell) {
      head += ` · sold ${entry}¢ → ${settle}`;
    } else if (i.won) {
      const pct = Math.round((100 / entry - 1) * 100);
      head += ` · ${entry}¢ → $1.00 (+${pct}%)`;
    } else {
      head += ` · ${entry}¢ → $0`;
    }
  }
  const kindLabel =
    i.signalKind === "consensus"
      ? "Consensus signal"
      : i.signalKind === "whale"
        ? "Whale signal"
        : "Signal";
  const ago =
    i.postedAgoSec != null ? `, posted ${agoShort(i.postedAgoSec)}` : "";
  const line = `└ ${kindLabel} on ${outcomeDisplay(i.outcome)}${ago}`;
  const stance = i.won ? "" : `\n\nWe post every result, wins and losses.`;
  const tags = buildTags({
    category: i.category,
    subcategory: i.subcategory,
    title: i.title,
  });
  return fitPost(
    [(title) => `${head}\n\n${title}\n${line}${stance}\n\n${tags}`],
    sanitizeTitle(i.title),
  );
}
```

**Step 4: 跑测试**（新 PASS；旧 settlement 用例期望串更新——`SETTLED · CALLED IT` → `CALLED IT`，价格行从 └ 挪进抬头）

Run: `npx vitest run lib/xComposer.test.ts`

**Step 5: Commit**

```bash
git add lib/xComposer.ts lib/xComposer.test.ts
git commit -m "feat: 战报帖 v2 —— 回报率提进抬头 + posted-ago 佐证 + 输帖立场行"
```

---

### Task 10: xSettled — 传 signalKind 与 postedAgoSec

**Files:**

- Modify: `lib/xSettled.ts`（compose 调用 122-132 行；`posted_at` 查询里**已有**）
- Test: `lib/xSettled.test.ts`

**Step 1: 写失败测试**

```ts
it("战报带原信号类型与 posted-ago", () => {
  // 造 kind='consensus' 的已发帖 + 已结算 outcome,posted_at = now - 2d
  // 断言 replyText 收到的 text 含 "Consensus signal" 和 "posted 2d ago"
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/xSettled.test.ts`

**Step 3: 实现**（compose 调用追加两参）

```ts
signalKind: r.kind === "consensus" ? "consensus" : "whale",
postedAgoSec: nowSec - r.posted_at,
```

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/xSettled.test.ts`

**Step 5: Commit**

```bash
git add lib/xSettled.ts lib/xSettled.test.ts
git commit -m "feat: xSettled 战报传信号类型与 posted-ago(posted_at 本就在查询里,白拿)"
```

---

### Task 11: 加密实体标签换 cashtag

**Files:**

- Modify: `lib/xComposer.ts`（`ENTITY_TAGS` 110-132 行的 5 个币种条目）
- Test: `lib/xComposer.test.ts`

**Step 1: 写失败测试**

```ts
it("加密币种输出 cashtag(交易员真在监控的流)", () => {
  expect(entityTag("Will Bitcoin dip to $45,000?")).toBe("$BTC");
  expect(entityTag("Ethereum above $5k?")).toBe("$ETH");
  expect(buildTags({ category: "Crypto", title: "Bitcoin up?" })).toBe(
    "#Polymarket #Crypto $BTC",
  );
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/xComposer.test.ts -t cashtag`

**Step 3: 实现**：五个条目值改为 `"$BTC"` / `"$ETH"` / `"$SOL"` / `"$XRP"` / `"$DOGE"`，币种区注释追加一句：cashtag 流是交易员真在监控的频道，受众比 #Bitcoin 话题页精准（2026-08-19 拍板）。

**Step 4: 跑测试**（新 PASS；旧断言 `#Bitcoin` 的用例同步改 `$BTC`）

Run: `npx vitest run lib/xComposer.test.ts`

**Step 5: Commit**

```bash
git add lib/xComposer.ts lib/xComposer.test.ts
git commit -m "feat: 加密实体标签换 cashtag($BTC 等) —— 交易员流比话题页受众精准"
```

---

### Task 12: 收尾 —— 删旧函数、全量回归、文档

**Files:**

- Modify: `lib/xComposer.ts`（确认 `fitByTruncatingTitle` 已无引用 → 删除；文件头两条硬不变量注释改为「≤280 **加权**字符 = 折叠位」口径）
- Modify: `CHANGELOG.md`（按现有条目风格补一条 v2 文案改版记录）

**Step 1: 确认旧函数无引用并删除**

Run: `grep -rn "fitByTruncatingTitle" lib worker app`
Expected: 只剩定义处 → 删除该函数

**Step 2: 全量回归**

Run: `npx vitest run`
Expected: **全绿**（基线约 1017+ 测试，新增 30 上下）。任何红都要修完才许过。

**Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 零错误

**Step 4: 更新 CHANGELOG 与文件头注释**

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: X 文案 v2 收尾 —— 删旧截断函数 + 注释口径改加权折叠位 + CHANGELOG"
```

---

## 验收清单（对照设计文档 §3 逐条）

- [ ] 五类样例的**实测加权长度**全部 ≤280（设计文档里的数字是基准：152/213/223/256/161/138…）
- [ ] Fed 96 字符长标题的共识帖：标题完整、回执从 3 行降到 2 行
- [ ] `type='smart'` 与 `type='large'` 在时间线上可肉眼区分（🏆 vs 🐳）
- [ ] 承诺行只出现在 `settled 开 × hoursToEnd≤144h` 的帖子上
- [ ] `1 smart-money signals` 语法 bug 消失
- [ ] 输的战报带 `We post every result, wins and losses.`，赢的不带
- [ ] `npx vitest run` 全绿 + `npx tsc --noEmit` 零错误

## 运维备忘（上线时人工动作，不在代码内）

- /manage 打开 `settled` 开关——否则承诺行永不出现（双闸门设计使然）。
- 首批发出后，人工在时间线上核对一条 256 字符的共识帖**确实没被折叠**（我们按 280 加权口径实现，X 客户端渲染若有出入，微调 `X_POST_MAX_CHARS` 即可，一处常数改动全局生效）。

---

## 执行记录（2026-08-19）

12 个任务全部完成，每任务一提交（`7849dc9` weightedLength → `ff6cca2` cashtag，收尾另有一笔 chore）。
最终验收：`npx vitest run` **1401 测试 / 106 文件全绿**，`npx tsc --noEmit` 零错误。

与计划的偏差（均在对应提交里论证过）：

- **战报佐证行用 posted-ago 替代 settled today**（计划头部已声明的偏差）：`alert_outcomes`
  无真实结算时刻，`posted 2d ago` 可从 thread 直接验证，还多传达提前量。
- **Task 8 并入 Task 7 提交**（`0b1497b`）：`xPregame` 传 sides 与赛前模板 v2 联动紧密，
  拆开则中间态测试跑不绿。
- **赛前比例 round → floor**（`bd1c1db` 搭车）：2.5 说 3-to-1 是凭空夸大 20%，floor 永不
  夸大 ——「不编数字」是品牌立场。
- **三标签不去重的语义变化**（Task 11）：赛道话题页（#Bitcoin）与实体 cashtag（$BTC）形态
  不同不触发去重，恰好凑满「平台 + 赛道 + 主体」三个 —— 计划原文只改五个条目值，实际多出
  这一层可见行为。
- **搭车修正若干**：whale 变体参数对象化 + fitPost 契约注释修正（`cf92be1`）；Task 4/5 审查
  发现随 Task 6 一并修（`d2ea1fb`）。
- **收尾扩展**（超出计划 Task 12 原文的部分）：删 `fitByTruncatingTitle` 之外又删了同样零调用
  的 `settlesIn`；`parseCandidate` 拆成 `parseConsensusCandidate` / `parseWhaleCandidate` +
  模块级 `taxonomyOf` / `walletReceipts`；测试双轨归并（v1/v2 describe 合一，独有用例全保留，
  `xComposer.test.ts` 927 → 779 行）并把标签系统单测拆到 `lib/xComposer.tags.test.ts`（129 行），
  两个文件都回到 800 行以内；补 `agoShort` under-1h 档与输帖最重版式超长标题两个测试缺口。
