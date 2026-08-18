// Edge 体检 —— 用已结算告警的历史,回答「哪些筛选条件真的有 edge」。
//
//   npx tsx scripts/edge-audit.ts [dbPath]        # 默认 data.sqlite
//
// 为什么需要它:告警条件(金额档/价格带/地址年龄/距结算…)一直是凭直觉设的,
// 而验证闭环攒下的 alert_outcomes 恰好能反过来给这些条件打分。首次运行
// (2026-08-18)就推翻了两个主打假设,并暴露了 43 天断更 —— 成本几乎为零。
//
// 三层校正,缺一层结论就翻向(实测同一份数据三种口径符号相反):
//
//   ① 价格校准  edge = P(won) − 隐含概率。不做的话比的是「谁买的票更稳」
//              而不是「谁更聪明」:老钱包均价 0.708、新钱包 0.577,裸胜率
//              必然是老钱包高。
//   ② 扣手续费  用 lib/fees 的同一套公式(每份额 rate×p×(1−p))。中间价位
//              吃掉约 1.2 个点,足以把薄 edge 全部变成幻觉。
//   ③ 市场聚类  同一市场的多条告警共享唯一结算结果 —— 是一次随机事件的 N
//              份副本。不聚类会把误差低估约 1.9 倍。见 lib/outcomeStats 的
//              clusteredInterval。
//
// 输出的显著性一律以【聚类口径】判定;naive 口径只作对照打印,永不用于结论。
import Database from "better-sqlite3";
import { parseFeeSchedule, takerFeeUsd } from "../lib/fees";
import { clusteredInterval } from "../lib/outcomeStats";

const DB_PATH = process.argv[2] ?? "data.sqlite";

// 检验的分组总数,用于 Bonferroni 校正。跑得越多,单个「显著」越不值钱:
// α=0.05 下 60 个分组期望 3 个假阳性。加维度时必须同步更新。
const BONFERRONI_GROUPS = 60;

interface Row {
  won: number;
  /** 押注方向上的隐含概率:BUY 取 price,SELL 取 1−price。 */
  q: number;
  price: number;
  /** 名义额 = 份额 × 价格。 */
  notional: number;
  /** 每份额手续费(概率点),与 edge 同单位。null = 无法定价,绝不当 0。 */
  feePerShare: number | null;
  ts: number;
  title: string;
  side: string;
  /** 聚类键 = 市场。不含结果方向:二元市场正反两面完全互补。 */
  cluster: string;
  ageDays: number | null;
  hoursToEnd: number | null;
  price1h: number | null;
  density: number;
}

function loadRows(db: Database.Database): Row[] {
  const raw = db
    .prepare(
      `SELECT o.won, o.price_1h,
              json_extract(a.payload,'$.conditionId') AS cid,
              json_extract(a.payload,'$.side')        AS side,
              json_extract(a.payload,'$.price')       AS price,
              json_extract(a.payload,'$.size')        AS size,
              json_extract(a.payload,'$.timestamp')   AS ts,
              json_extract(a.payload,'$.title')       AS title,
              w.first_ts,
              json_extract(m.meta_json,'$.feesEnabled')  AS fees_on,
              json_extract(m.meta_json,'$.feeSchedule')  AS fee_schedule,
              json_extract(m.meta_json,'$.endDate')      AS end_date
         FROM alerts a
         JOIN alert_outcomes o ON o.alert_id = a.id
         LEFT JOIN market_meta m ON m.condition_id = json_extract(a.payload,'$.conditionId')
         LEFT JOIN wallet_age  w ON w.wallet = lower(json_extract(a.payload,'$.proxyWallet'))
        WHERE o.resolved = 1 AND o.won IS NOT NULL`,
    )
    .all() as Record<string, unknown>[];

  const density = new Map<string, number>();
  for (const r of raw) {
    const cid = String(r.cid ?? "");
    density.set(cid, (density.get(cid) ?? 0) + 1);
  }

  return raw.flatMap((r): Row[] => {
    const price = Number(r.price);
    const size = Number(r.size);
    const ts = Number(r.ts);
    if (!Number.isFinite(price) || !Number.isFinite(size)) return [];
    const side = String(r.side ?? "BUY");
    const notional = size * price;
    // feesEnabled=false 是确知的 0;fees on 但 schedule 缺失/形状未知 → null。
    // 猜 0 正是「Polymarket 零手续费」的旧结论活了六周的原因(见 lib/fees)。
    const feesOn = r.fees_on === 1 || r.fees_on === true;
    let schedule = null;
    try {
      schedule =
        typeof r.fee_schedule === "string"
          ? parseFeeSchedule(JSON.parse(r.fee_schedule))
          : parseFeeSchedule(r.fee_schedule);
    } catch {
      schedule = null;
    }
    const feeUsd = takerFeeUsd({
      sizeUsd: notional,
      price,
      feesEnabled: feesOn,
      schedule,
    });
    // 每份额费用 = 每笔费用 ÷ 份额,换成与 edge 同一单位(概率点)。
    const feePerShare = feeUsd == null || size <= 0 ? null : feeUsd / size;
    const firstTs = r.first_ts == null ? null : Number(r.first_ts);
    const endMs = r.end_date ? Date.parse(String(r.end_date)) : NaN;
    return [
      {
        won: r.won === 1 ? 1 : 0,
        q: side === "BUY" ? price : 1 - price,
        price,
        notional,
        feePerShare,
        ts,
        side,
        title: String(r.title ?? ""),
        cluster: String(r.cid ?? `#${Math.random()}`),
        ageDays:
          firstTs != null && ts >= firstTs ? (ts - firstTs) / 86400 : null,
        hoursToEnd: Number.isFinite(endMs) ? (endMs / 1000 - ts) / 3600 : null,
        price1h: r.price_1h == null ? null : Number(r.price_1h),
        density: density.get(String(r.cid ?? "")) ?? 1,
      },
    ];
  });
}

const mean = (a: number[]) =>
  a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

/**
 * 标准正态分位数(Abramowitz & Stegun 26.2.23 有理近似,|ε| < 4.5e-4)。
 * 只为把 Bonferroni 的 α' 换算成临界 z:α'=0.05/60 → z≈3.34,而不是 1.96。
 */
function normalQuantile(p: number): number {
  const tail = p < 0.5 ? p : 1 - p;
  const t = Math.sqrt(-2 * Math.log(tail));
  const x = t - (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481));
  return p < 0.5 ? -x : x;
}

interface Stat {
  n: number;
  /** 有效样本量 = 不同市场数。 */
  nc: number;
  winRate: number;
  implied: number;
  grossEdge: number;
  feePts: number | null;
  /** 净 edge 点估计(按全部告警,不折叠) —— 「我们发的信号实际赚亏多少」。 */
  netEdge: number | null;
  /** 聚类稳健置信半径 —— 判定只看它。 */
  ci95C: number;
  /** 普通置信半径,仅作「被低估多少」的对照,永不用于判定。 */
  ci95Naive: number;
}

/**
 * 一组告警的三层校正统计。
 *
 * 聚类用的是【稳健标准误(CRVE)】,不是「把每个市场折成一个观测」。这点很
 * 要紧:折叠需要给整簇指定一个 won,而同一市场里买 Yes 与买 No 的输赢正好
 * 相反 —— 取簇内任意一条都等于随机挑边,会把点估计带跑(实测同一份数据
 * 从 −0.87 跳到 +2.96)。
 *
 * CRVE 的做法是点估计照旧用全部行(那是一句真话:这些信号就是这个结果),
 * 只让【方差】反映簇内相关:同簇残差先求和再平方,簇内完全同向时方差不会
 * 被行数稀释。这也与 lib/outcomeStats.clusteredInterval 的原则一致 ——
 * 点估计不动,只修区间。
 */
function stat(
  rows: Row[],
  priceOf: (r: Row) => number = (r) => r.price,
): Stat | null {
  if (!rows.length) return null;
  const qOf = (r: Row) => (r.side === "BUY" ? priceOf(r) : 1 - priceOf(r));
  const feeOf = (r: Row) => {
    if (r.feePerShare == null) return null;
    // 换价重算(用于「1h 后追入」场景):费率形状 rate×p×(1−p) 随价格变化。
    const p = priceOf(r);
    if (p === r.price) return r.feePerShare;
    const scale = (p * (1 - p)) / (r.price * (1 - r.price) || 1);
    return r.feePerShare * scale;
  };

  const n = rows.length;
  const w = mean(rows.map((r) => r.won));
  const q = mean(rows.map(qOf));
  const fees = rows.map(feeOf);
  const allPriced = fees.every((x) => x != null);
  const fee = allPriced ? mean(fees as number[]) : null;

  // 每条告警的净 edge 贡献(概率点)。费用不可定价时退回毛 edge,并让
  // netEdge 整体报 null —— 不猜 0。
  const contrib = rows.map(
    (r, i) => r.won - qOf(r) - (allPriced ? (fees[i] as number) : 0),
  );
  const point = mean(contrib);

  // 聚类稳健方差:Var = Σ_g (Σ_{i∈g} u_i)² / n²,u 为去均值残差。
  // 簇内完全同向时(结算维度正是如此),簇内求和不会互相抵消,方差因此
  // 不被行数稀释 —— 这正是 naive 口径低估误差的地方。
  const clusterResid = new Map<string, number>();
  rows.forEach((r, i) => {
    clusterResid.set(
      r.cluster,
      (clusterResid.get(r.cluster) ?? 0) + (contrib[i] - point),
    );
  });
  const G = clusterResid.size;
  const ss = [...clusterResid.values()].reduce((s, x) => s + x * x, 0);
  // G/(G−1) 小样本校正:簇数少时残差被过度收缩,不校正会低估方差。
  const varC = G > 1 ? (ss / (n * n)) * (G / (G - 1)) : Infinity;
  const seC = Math.sqrt(varC);

  const sdNaive = Math.sqrt(
    mean(contrib.map((x) => (x - point) * (x - point))) / Math.max(n, 1),
  );

  return {
    n,
    nc: G,
    winRate: w * 100,
    implied: q * 100,
    grossEdge: (w - q) * 100,
    feePts: fee == null ? null : fee * 100,
    netEdge: allPriced ? point * 100 : null,
    ci95C: Number.isFinite(seC) ? 196 * seC : Infinity,
    ci95Naive: 196 * sdNaive,
  };
}

/** 判定一律用聚类稳健区间 —— naive 会因告警扎堆而虚报显著。 */
function verdict(s: Stat): string {
  if (s.netEdge == null) return "费用未知";
  if (s.nc < 10 || !Number.isFinite(s.ci95C)) return "· 市场数不足";
  const lo = s.netEdge - s.ci95C;
  const hi = s.netEdge + s.ci95C;
  if (lo > 0) return "✅ 显著为正";
  if (hi < 0) return "❌ 显著为负";
  return "○ 不显著";
}

const f = (v: number | null, d = 1) =>
  v == null ? "   — " : v.toFixed(d).padStart(6);

function table(
  title: string,
  groups: [string, Row[]][],
  pad = 22,
  priceOf?: (r: Row) => number,
) {
  console.log(`\n${"═".repeat(100)}\n${title}\n${"═".repeat(100)}`);
  console.log(
    "分组".padEnd(pad) +
      "告警".padStart(6) +
      "市场".padStart(6) +
      "胜率".padStart(8) +
      "隐含".padStart(8) +
      "毛edge".padStart(8) +
      "费用".padStart(7) +
      "净edge".padStart(8) +
      " │ ±95%聚类".padStart(11) +
      "  ±95%朴素".padStart(11) +
      "  判定",
  );
  console.log("─".repeat(100));
  for (const [label, rows] of groups) {
    const s = stat(rows, priceOf);
    if (!s) continue;
    console.log(
      label.padEnd(pad) +
        String(s.n).padStart(6) +
        String(s.nc).padStart(6) +
        f(s.winRate) +
        "%" +
        f(s.implied) +
        "%" +
        f(s.grossEdge) +
        " " +
        f(s.feePts, 2) +
        f(s.netEdge) +
        "  │ ±" +
        f(Number.isFinite(s.ci95C) ? s.ci95C : null) +
        "   (±" +
        f(s.ci95Naive).trim() +
        ")" +
        "  " +
        verdict(s),
    );
  }
}

/** 按 key 分组并排序,key 返回 null 的行被丢弃。 */
function group(rows: Row[], key: (r: Row) => string | null): [string, Row[]][] {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    const g = m.get(k);
    if (g) g.push(r);
    else m.set(k, [r]);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * 样本代表性 —— 报告最该先看的一节。edge 结论的外部有效性全靠它:
 * 首次运行时发现「52 天数据」其实只有 10 个交易日、95% 挤在 6 天、
 * 78% 是同一批足球赛事,所有分组结论都不能外推。
 */
function representativeness(rows: Row[]) {
  console.log(
    `\n${"═".repeat(100)}\n⚠️  样本代表性(先看这一节)\n${"═".repeat(100)}`,
  );
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const d = new Date(r.ts * 1000).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  const days = [...byDay.entries()].sort((a, b) => b[1] - a[1]);
  const markets = new Set(rows.map((r) => r.cluster)).size;
  const top = days.slice(0, 5).reduce((s, [, c]) => s + c, 0);
  // 体育启发式:标题里的对阵 / "win on <日期>" 形态。
  const isSport = (r: Row) =>
    / vs\.? |win on \d{4}-|Game \d|: .+ vs/i.test(r.title);
  const sport = rows.filter(isSport).length;

  console.log(`  已结算告警        ${rows.length}`);
  console.log(
    `  不同市场          ${markets}  (平均每市场 ${(rows.length / Math.max(markets, 1)).toFixed(1)} 条)`,
  );
  console.log(`  覆盖交易日        ${byDay.size} 天`);
  console.log(
    `  最集中 5 天占比    ${((100 * top) / rows.length).toFixed(1)}%   [${days
      .slice(0, 5)
      .map(([d, c]) => `${d}:${c}`)
      .join("  ")}]`,
  );
  console.log(
    `  体育类占比        ${((100 * sport) / rows.length).toFixed(1)}%`,
  );
  const ages = rows.filter((r) => r.ageDays != null).length;
  console.log(
    `  地址年龄覆盖      ${((100 * ages) / rows.length).toFixed(0)}%  ${
      ages / rows.length < 0.9
        ? "⚠️ 非随机抽样(仅被查过的钱包),年龄维度仅供参考"
        : ""
    }`,
  );

  const warn: string[] = [];
  if (byDay.size < 30)
    warn.push(`只有 ${byDay.size} 个交易日 —— 不足以支撑任何 edge 结论`);
  if (top / rows.length > 0.8)
    warn.push("超过 80% 的告警挤在 5 天内 —— 事件驱动的偶发样本,不可外推");
  if (sport / rows.length > 0.6)
    warn.push(
      "体育占比过高 —— 同一赛事的胜负/大小球/让分盘高度相关,聚类吃不掉这层",
    );
  if (rows.length / Math.max(markets, 1) > 3)
    warn.push(
      `平均每市场 ${(rows.length / markets).toFixed(1)} 条告警 —— 若按告警数算区间会严重高估精度`,
    );
  // 断更检测:相邻交易日之间的最大间隔。
  const sorted = [...byDay.keys()].sort();
  let maxGap = 0;
  let gapAt = "";
  for (let i = 1; i < sorted.length; i++) {
    const g =
      (Date.parse(sorted[i]) - Date.parse(sorted[i - 1])) / 86400000 - 1;
    if (g > maxGap) {
      maxGap = g;
      gapAt = `${sorted[i - 1]} → ${sorted[i]}`;
    }
  }
  if (maxGap >= 2)
    warn.push(`存在 ${Math.round(maxGap)} 天断更(${gapAt}) —— 采集有空窗`);

  if (warn.length) {
    console.log("\n  ⚠️ 警告:");
    for (const w of warn) console.log(`     · ${w}`);
  } else {
    console.log("\n  ✓ 未发现明显的代表性问题");
  }
}

/**
 * 自检:`npx tsx scripts/edge-audit.ts --selftest`
 *
 * 统计口径是这个工具的全部价值,错了比没有更糟(会给出一个看起来很权威的
 * 错结论)。用合成数据钉死 CRVE 的三条性质,任何一条不成立都会让整份报告
 * 失效。
 */
function selftest() {
  const mk = (won: number, price: number, cluster: string): Row => ({
    won,
    q: price,
    price,
    notional: 1000,
    feePerShare: 0, // 免费市场,把费用这一层排除掉,只测方差
    ts: 0,
    side: "BUY",
    title: "",
    cluster,
    ageDays: null,
    hoursToEnd: null,
    price1h: null,
    density: 1,
  });
  let failed = 0;
  const check = (name: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : "  ← " + detail}`);
    if (!ok) failed++;
  };

  // ① 每行自成一簇 ⇒ 聚类区间 ≈ 朴素区间(仅差 G/(G−1) 小样本校正)。
  const indep = Array.from({ length: 200 }, (_, i) => mk(i % 2, 0.5, `m${i}`));
  const a = stat(indep)!;
  check(
    "每行独立时,聚类区间 ≈ 朴素区间",
    Math.abs(a.ci95C / a.ci95Naive - 1) < 0.02,
    `比值 ${(a.ci95C / a.ci95Naive).toFixed(3)}`,
  );

  // ② 同一结果复制 10 份到同一市场 ⇒ 点估计不变,但区间不该被行数收窄。
  //    这正是 naive 口径出错的地方:20 个市场 × 10 条 = 200 行,朴素会
  //    按 200 算,聚类必须按 20 算。
  const dup = Array.from({ length: 20 }, (_, g) =>
    Array.from({ length: 10 }, () => mk(g % 2, 0.5, `m${g}`)),
  ).flat();
  const b = stat(dup)!;
  check(
    "簇内完全同向时,聚类区间约为朴素的 √(簇大小) 倍",
    b.ci95C / b.ci95Naive > 2.8 && b.ci95C / b.ci95Naive < 3.5,
    `比值 ${(b.ci95C / b.ci95Naive).toFixed(2)},期望 ≈√10=3.16`,
  );
  check(
    "复制不改变点估计",
    Math.abs((b.netEdge ?? 0) - 0) < 1e-9,
    `netEdge=${b.netEdge}`,
  );

  // ③ 同市场正反两面(won 相反)不该被当成一条 —— 这是「折成一个观测」
  //    方案的致命伤:取簇内任一条的 won 会随机挑边,把点估计带跑。
  const opposed = [mk(1, 0.6, "m1"), mk(0, 0.4, "m1")];
  const c = stat(opposed)!;
  // 买 0.6 赢(+0.4) 与 买 0.4 输(−0.4) 精确抵消 ⇒ 点估计必须是 0。
  check(
    "同市场正反两面各自入账,点估计不被挑边带跑",
    Math.abs(c.netEdge ?? 99) < 1e-9,
    `netEdge=${c.netEdge}(折叠方案会得到 ±40)`,
  );

  // ④ 逆正态近似:两个最关键的分位点。
  check(
    "normalQuantile(0.975) ≈ 1.96",
    Math.abs(normalQuantile(0.975) - 1.95996) < 5e-4,
    `${normalQuantile(0.975)}`,
  );
  check(
    "normalQuantile(1−0.05/120) ≈ 3.34",
    Math.abs(normalQuantile(1 - 0.05 / 120) - 3.3441) < 5e-3,
    `${normalQuantile(1 - 0.05 / 120)}`,
  );

  console.log(
    failed
      ? `\n  ${failed} 项自检失败 —— 报告结论不可信。\n`
      : "\n  全部通过。\n",
  );
  process.exitCode = failed ? 1 : 0;
}

function main() {
  if (process.argv.includes("--selftest")) {
    console.log("\nEdge 体检 · 统计口径自检");
    selftest();
    return;
  }
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const rows = loadRows(db);
    if (!rows.length) {
      console.log(`${DB_PATH}: 没有已结算且已回填的告警,无法体检。`);
      return;
    }
    console.log(`\nEdge 体检 · ${DB_PATH}`);
    representativeness(rows);

    const all = stat(rows);
    if (all) {
      console.log(`\n${"═".repeat(100)}\n全样本基线\n${"═".repeat(100)}`);
      console.log(
        `  告警 ${all.n} / 市场 ${all.nc}   胜率 ${all.winRate.toFixed(1)}%  隐含 ${all.implied.toFixed(1)}%`,
      );
      console.log(
        `  毛 edge ${all.grossEdge.toFixed(2)} 点   费用 ${all.feePts?.toFixed(2) ?? "—"} 点   净 edge ${all.netEdge?.toFixed(2) ?? "—"} 点`,
      );
      console.log(
        `  净 edge ${all.netEdge?.toFixed(2) ?? "—"} ± ${all.ci95C.toFixed(2)}(聚类稳健)  →  ${verdict(all)}`,
      );
      console.log(
        `  [对照] 朴素 ±${all.ci95Naive.toFixed(2)} vs 聚类 ±${all.ci95C.toFixed(2)} —— 按告警数算会把误差低估 ${(all.ci95C / Math.max(all.ci95Naive, 0.01)).toFixed(1)} 倍`,
      );
    }

    table(
      "① 价格带(押注方向的隐含概率)",
      group(rows, (r) =>
        r.q < 0.15
          ? "1  <15¢"
          : r.q < 0.3
            ? "2  15-30¢"
            : r.q < 0.45
              ? "3  30-45¢"
              : r.q < 0.55
                ? "4  45-55¢"
                : r.q < 0.7
                  ? "5  55-70¢"
                  : r.q < 0.85
                    ? "6  70-85¢"
                    : r.q < 0.95
                      ? "7  85-95¢"
                      : "8  >95¢",
      ),
    );

    table(
      "② 金额档(名义额 = 份额 × 价格)",
      group(rows, (r) =>
        r.notional < 15000
          ? "1  $10-15k"
          : r.notional < 20000
            ? "2  $15-20k"
            : r.notional < 30000
              ? "3  $20-30k"
              : r.notional < 50000
                ? "4  $30-50k"
                : r.notional < 100000
                  ? "5  $50-100k"
                  : r.notional < 200000
                    ? "6  $100-200k"
                    : "7  $200k+",
      ),
    );

    table(
      "③ 买 / 卖方向",
      group(rows, (r) => r.side),
    );

    table(
      "④ 距结算时间",
      group(rows, (r) => {
        const h = r.hoursToEnd;
        if (h == null || h < 0) return null;
        return h < 2
          ? "1  <2小时"
          : h < 6
            ? "2  2-6小时"
            : h < 24
              ? "3  6-24小时"
              : h < 72
                ? "4  1-3天"
                : h < 168
                  ? "5  3-7天"
                  : "6  >7天";
      }),
    );

    table(
      "⑤ 地址年龄(覆盖率见代表性一节;非随机抽样)",
      group(rows, (r) => {
        const a = r.ageDays;
        if (a == null) return null;
        return a <= 1
          ? "1  ≤1天"
          : a <= 7
            ? "2  1-7天"
            : a <= 30
              ? "3  7-30天"
              : a <= 90
                ? "4  30-90天"
                : "5  >90天";
      }),
    );

    table(
      "⑥ 该市场的告警密度",
      group(rows, (r) =>
        r.density === 1
          ? "1  独苗(1条)"
          : r.density <= 3
            ? "2  2-3条"
            : r.density <= 10
              ? "3  4-10条"
              : r.density <= 30
                ? "4  11-30条"
                : "5  >30条(扎堆)",
      ),
    );

    // ⑦ 动量:信号后 1h 的价格反应。关键在于用【1h 后的新价格】重算 —— 按
    // 原价算出的 edge 是事后信息(等你看到涨了,已经买不到原价了)。
    const w1 = rows.filter(
      (r) => r.price1h != null && r.price1h > 0 && r.price1h < 1,
    );
    if (w1.length) {
      const dir = (r: Row) => {
        const d = (r.price1h as number) - r.price;
        return r.side === "BUY" ? d : -d;
      };
      table(
        "⑦ 信号后 1h 价格反应 —— 按【原价】计(事后信息,不可交易)",
        group(w1, (r) =>
          dir(r) > 0.03
            ? "1  顺向 >+3¢"
            : dir(r) > 0.01
              ? "2  顺向 +1~3¢"
              : dir(r) >= -0.01
                ? "3  基本不动"
                : dir(r) >= -0.03
                  ? "4  逆向 -1~-3¢"
                  : "5  逆向 <-3¢",
        ),
      );
      table(
        "⑧ 同上,但按【1h 后的真实成交价】重算 —— 这一列才是可交易收益",
        group(w1, (r) =>
          dir(r) > 0.03
            ? "1  顺向 >+3¢"
            : dir(r) > 0.01
              ? "2  顺向 +1~3¢"
              : dir(r) >= -0.01
                ? "3  基本不动"
                : dir(r) >= -0.03
                  ? "4  逆向 -1~-3¢"
                  : "5  逆向 <-3¢",
        ),
        22,
        (r) => r.price1h as number,
      );
    }

    console.log(`\n${"═".repeat(100)}\n多重比较提醒\n${"═".repeat(100)}`);
    console.log(
      `  本轮检验约 ${BONFERRONI_GROUPS} 个分组。α=0.05 下期望假阳性 ≈ ${(
        BONFERRONI_GROUPS * 0.05
      ).toFixed(1)} 个 —— 看到一两个「显著」是常态,不是发现。`,
    );
    const alphaAdj = 0.05 / BONFERRONI_GROUPS;
    const zAdj = normalQuantile(1 - alphaAdj / 2);
    console.log(
      `  Bonferroni:α'=0.05/${BONFERRONI_GROUPS}=${alphaAdj.toFixed(5)} → 临界 |z| = ${zAdj.toFixed(2)}(而非 1.96)。`,
    );
    console.log(
      `  换算成上表的读法:净 edge 的绝对值要超过 ±95% 半径的 ${(zAdj / 1.96).toFixed(2)} 倍,才算真的站住。`,
    );
    console.log(
      "  任何单个分组的「✅ 显著为正」在被独立时间段复现之前,都只是候选假设。\n",
    );
  } finally {
    db.close();
  }
}

main();
