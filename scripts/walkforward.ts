// Walk-forward 阈值重推 —— 30 天数据闸门达标后,用已结算纸面仓回答
// 「哪些收紧/平移方向的参数变体真的更好」。设计:docs/plans/
// 2026-08-28-walkforward-rederivation-design.md;口径:同名实现计划 §0。
//
//   npx tsx scripts/walkforward.ts [dbPath]        # 默认 data.sqlite
//
// 可观测锥声明(整份报告的边界):本系统刻意不归档原始成交流,持久化的是
// 「在当前阈值下触发过的事实」。因此**只能回放收紧方向**(更严变体的子集
// 逐仓事实全在库里,零前视零新模拟);放松方向没有数据基础,唯一诚实做法是
// 开更松的挑战者档从今天向前跑。本脚本产出=报告建议+手工挑战者档路径,
// **绝不修改任何存量档参数**(档位参数一旦运行就是其公开战绩的定义)。
//
// 统计纪律(edge-audit 三件套 + 两件新的,实现全在 lib/walkforward.ts 由
// vitest 钉死 —— 本脚本没有 --selftest,校准测试见 lib/walkforward.test.ts
// 「反事实校验」一节):
//   ① 价格校准  逐仓贡献 = (盈亏 − 费)/份额,二元结算下恰为 won − 隐含概率;
//   ② 市场聚类  CI 用 CRVE(同市场多仓 = 一次随机事件的副本);
//   ③ Bonferroni 临界 z 按**实际发布过 validate 成绩的格数 G** 换算(G 是
//      算出来的,不写死 —— 本文件顶部只写死网格阶梯与最小样本闸);
//   ④ 选择/评价分离  train 只选 validate 只评,train 落选的格连数字都不发布;
//   ⑤ 方向随机化  市场级抽签 10,000 次,种子固定 → 同库同种子逐字节可复现。
//
// 写库范围:只 INSERT 一行 walkforward_reports(报告是数据,进库不进 git),
// 不碰任何业务表;零上游请求。
import Database from "better-sqlite3";
import { categoriesFor } from "../lib/eventCategory";
import { parseStrategyForTest } from "../lib/follow";
import { strategyCode } from "../lib/strategyCodes";
import {
  listValidateFolds,
  runWalkforward,
  WF_DECLARATIONS,
  type WalkforwardReport,
  type WfPosition,
  type WfTierInput,
  type WfTierReport,
  type WfVariantReport,
} from "../lib/walkforward";

const DB_PATH = process.argv[2] ?? "data.sqlite";

// 闸门起点 = /api/continuity 的 streak 起点 2026-07-28 00:00 UTC。
// ⚠️ 设计前提修正:这天是 UTC **周二**(设计 §4.1 误记为周一)——
// lib/walkforward.listValidateFolds 按真实日历把首个干净整周顺延到 08-03,
// 07-28~08-02 的残段与闸门前数据一样只进 train,有测试钉住这条。
const GATE_START = Date.UTC(2026, 6, 28) / 1000;
const RAND_DRAWS = 10_000;
const SEED = 20_260_828;
// 最小样本闸(设计 §4.4):折内 settled ≥10 且去重市场 ≥5(train/validate
// 双侧同闸),可评折 <2 → 观察名单;基线自己不足 → 整档薄档只报现状。
const MIN_FOLD_SETTLED = 10;
const MIN_FOLD_MARKETS = 5;
const MIN_VALID_FOLDS = 2;
const ALPHA = 0.05;
// tilt 快照的 atOrBefore 窗:formation 前 1h 内无快照 = 该维事实缺失。
const TILT_LOOKBACK_SEC = 3_600;

const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const pts = (v: number | null | undefined, d = 2) =>
  v == null ? "  —  " : (v * 100).toFixed(d);

interface RawRow {
  id: number;
  strategy_id: number;
  condition_id: string;
  outcome: string;
  formation_ts: number | null;
  entry_ts: number | null;
  entry_price: number | null;
  formation_price: number | null;
  shares: number | null;
  size_usd: number | null;
  fee_usd: number | null;
  realized_pnl: number;
  event_slug: string | null;
  sig_wallets: number | null;
  sig_total: number | null;
}

function loadTiers(db: Database.Database): {
  tiers: WfTierInput[];
  disclosures: string[];
} {
  const strategies = db
    .prepare("SELECT id, name, enabled, params_json FROM follow_strategies")
    .all() as {
    id: number;
    name: string;
    enabled: number;
    params_json: string | null;
  }[];

  const rows = db
    .prepare(
      `SELECT p.id, p.strategy_id, p.condition_id, p.outcome, p.formation_ts,
              p.entry_ts, p.entry_price, p.formation_price, p.shares, p.size_usd,
              p.fee_usd, p.realized_pnl, p.event_slug,
              s.wallet_count AS sig_wallets, s.total_net_usd AS sig_total
         FROM follow_positions p
         LEFT JOIN strategy_signals s ON s.position_id = p.id
        WHERE p.status = 'settled' AND p.realized_pnl IS NOT NULL`,
    )
    .all() as RawRow[];

  // 赛道:event_slug → 分类,与全站 categoriesFor 同一实现口径。
  const cats = categoriesFor(
    db as never,
    rows.map((r) => r.event_slug),
  );

  // 退出 sims 批量(分块防变量上限)。
  const simsById = new Map<
    number,
    Record<string, { exited: number; pnl: number }>
  >();
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900);
    const simRows = db
      .prepare(
        `SELECT position_id, rule, exited, pnl FROM position_exit_sims
          WHERE position_id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(...chunk) as {
      position_id: number;
      rule: string;
      exited: number;
      pnl: number;
    }[];
    for (const s of simRows) {
      const bucket = simsById.get(s.position_id) ?? {};
      bucket[s.rule] = { exited: s.exited, pnl: s.pnl };
      simsById.set(s.position_id, bucket);
    }
  }

  const tiltStmt = db.prepare(
    `SELECT tilt_pct FROM market_tilt_history
      WHERE condition_id = ? AND ts <= ? AND ts >= ?
      ORDER BY ts DESC LIMIT 1`,
  );

  const byStrategy = new Map<number, RawRow[]>();
  for (const r of rows) {
    const g = byStrategy.get(r.strategy_id);
    if (g) g.push(r);
    else byStrategy.set(r.strategy_id, [r]);
  }

  const tiers: WfTierInput[] = [];
  const disclosures: string[] = [];
  for (const s of strategies) {
    const mine = byStrategy.get(s.id) ?? [];
    if (mine.length === 0) continue;
    const params = parseStrategyForTest(s.id, s.params_json);
    if (!params) {
      disclosures.push(
        `策略 ${s.id}「${s.name}」params_json 不可解析,跳过(${mine.length} 仓)`,
      );
      continue;
    }
    const needTilt =
      params.source === "lopsided" || params.source === "resolved";
    const dropped = { noFormation: 0, noFee: 0, badShares: 0 };
    const positions: WfPosition[] = [];
    for (const r of mine) {
      // 宇宙过滤(实现计划 §0.2):缺 formation 无法归折、fee null 不可定价、
      // 坏价格/份额无法记账 —— 全部剔除并计数,不猜值。
      if (r.formation_ts == null) {
        dropped.noFormation++;
        continue;
      }
      if (r.fee_usd == null) {
        dropped.noFee++;
        continue;
      }
      const entry = r.entry_price;
      if (entry == null || !(entry > 0 && entry < 1) || r.entry_ts == null) {
        dropped.badShares++;
        continue;
      }
      let shares = r.shares;
      if (shares == null || !(shares > 0)) {
        shares =
          r.size_usd != null && r.size_usd > 0 ? r.size_usd / entry : null;
      }
      if (shares == null || !(shares > 0)) {
        dropped.badShares++;
        continue;
      }
      const tilt = needTilt
        ? ((
            tiltStmt.get(
              r.condition_id,
              r.formation_ts,
              r.formation_ts - TILT_LOOKBACK_SEC,
            ) as { tilt_pct: number | null } | undefined
          )?.tilt_pct ?? null)
        : null;
      positions.push({
        id: r.id,
        conditionId: r.condition_id,
        outcome: r.outcome,
        formationTs: r.formation_ts,
        entryTs: r.entry_ts,
        entryPrice: entry,
        formationPrice: r.formation_price,
        shares,
        feeUsd: r.fee_usd,
        realizedPnl: r.realized_pnl,
        category: cats[r.event_slug ?? ""]?.category ?? null,
        walletCount: r.sig_wallets,
        totalNetUsd: r.sig_total,
        tiltPct: tilt,
        exitSims: simsById.get(r.id) ?? null,
      });
    }
    tiers.push({
      strategyId: s.id,
      name: s.name,
      code: strategyCode(s.name),
      params,
      positions,
      settledRaw: mine.length,
      universeDropped: dropped,
    });
  }
  // settled 多的档排前面 —— 报告的阅读顺序就是数据的话语权顺序。
  tiers.sort((a, b) => b.settledRaw - a.settledRaw);
  return { tiers, disclosures };
}

function line(ch = "═", n = 100) {
  console.log(ch.repeat(n));
}

function printRepresentativeness(
  tiers: WfTierInput[],
  folds: number[],
  disclosures: string[],
) {
  console.log(`\n`);
  line();
  console.log("⚠️  样本代表性与事实覆盖(先看这一节)");
  line();
  console.log(
    `  闸门起点        ${day(GATE_START)}(UTC 周二 —— 设计文档误记周一,首个干净整周顺延到 ${day(
      GATE_START + 6 * 86_400,
    )})`,
  );
  console.log(
    `  validate 折     ${folds.length} 个:${folds.map((f) => day(f)).join(" · ")}(各 7 天,按 formation_ts 归折)`,
  );
  console.log(
    "  事实覆盖窗      fee_usd 08-04 起 · tilt 快照 08-11 起 · 信号关联(钱包数/金额)08-15 起 —— 更早的仓在相应维度按缺事实剔除",
  );
  console.log(
    "  已结算宇宙偏置  最近折的 settled 子集天然偏向快结算市场;体育扎堆时同赛事相关性聚类吃不掉",
  );
  console.log(
    "\n  档位            settled  宇宙  剔:无形成 无费 坏价/份额   信号关联   sims覆盖   体育占比",
  );
  console.log("─".repeat(100));
  for (const t of tiers) {
    const sig = t.positions.filter((p) => p.walletCount != null).length;
    const sims = t.positions.filter((p) => p.exitSims != null).length;
    const sports = t.positions.filter((p) => p.category === "Sports").length;
    const pc = (n: number) =>
      t.positions.length === 0
        ? "  —"
        : `${Math.round((100 * n) / t.positions.length)}%`.padStart(4);
    console.log(
      `  ${t.name.padEnd(14)}${String(t.settledRaw).padStart(8)}${String(
        t.positions.length,
      ).padStart(
        6,
      )}${String(t.universeDropped.noFormation).padStart(10)}${String(
        t.universeDropped.noFee,
      ).padStart(5)}${String(t.universeDropped.badShares).padStart(10)}${pc(
        sig,
      ).padStart(11)}${pc(sims).padStart(11)}${pc(sports).padStart(11)}`,
    );
  }
  for (const d of disclosures) console.log(`  ⚠️ ${d}`);
}

function variantLine(v: WfVariantReport, alphaAdj: number): string {
  const folds = v.folds
    .filter((f) => f.evaluable)
    .map((f) => `${day(f.fold)}:${pts(f.validatePoint, 1)}`)
    .join(" ");
  const p = v.pooled;
  return (
    `    ${v.survives ? "✅" : v.passClustered ? "◐" : "○"} ${v.label.padEnd(30)}` +
    `OOS ${pts(p?.point)} 点(n=${p?.n} 市场=${p?.markets}) ` +
    `Bonf下界 ${pts(v.loBonf)} 随机化p ${v.randP?.toFixed(4) ?? "—"}(≤${alphaAdj.toFixed(4)} 过) ` +
    `各折[${folds}]`
  );
}

function printTier(t: WfTierReport, report: WalkforwardReport) {
  const alphaAdj = report.alpha / Math.max(report.scoredCells, 1);
  console.log("");
  line("─");
  const cur = t.currentStat;
  const curLine = cur
    ? `现状(全样本 hold):净超额 ${pts(cur.point)} ± ${pts(
        Number.isFinite(cur.seC) ? 1.96 * cur.seC : null,
      )} 点/仓(n=${cur.n} 市场=${cur.nc})`
    : "现状:宇宙为空";
  console.log(
    `▶ ${t.name}${t.code ? `(${t.code})` : ""} · ${t.source} · settled ${t.settledRaw} → 宇宙 ${t.universeN}`,
  );
  console.log(`  ${curLine}`);
  if (t.thin) {
    console.log(
      `  🪶 薄档:基线可评折不足(${
        t.baseline?.folds.filter((f) => f.evaluable).length ?? 0
      } < ${MIN_VALID_FOLDS})→ 整档跳过网格,「数据不够」是结论不是障碍。`,
    );
    for (const f of t.baseline?.folds ?? []) {
      if (!f.evaluable) console.log(`     · ${day(f.fold)} 折:${f.reason}`);
    }
    return;
  }
  const b = t.baseline;
  console.log(
    `  基线 OOS(当前参数):${pts(b?.pooled?.point)} 点(n=${b?.pooled?.n} 市场=${b?.pooled?.markets})` +
      ` 各折[${(b?.folds ?? [])
        .filter((f) => f.evaluable)
        .map((f) => `${day(f.fold)}:${pts(f.validatePoint, 1)}`)
        .join(" ")}]`,
  );
  const survivors = t.candidates.filter((c) => c.survives);
  if (survivors.length === 0) {
    console.log(
      `  ⭕ 无变体存活(一等结论)。候选 ${t.candidates.length} 个全部止步:` +
        `${t.candidates.filter((c) => !c.passClustered).length} 个聚类闸,` +
        `${t.candidates.filter((c) => c.passClustered && !c.passRand).length} 个随机化闸。`,
    );
  } else {
    console.log(`  🏁 存活变体 ${survivors.length} 个(三道闸全过):`);
    for (const v of survivors) console.log(variantLine(v, alphaAdj));
  }
  const failed = t.candidates.filter((c) => !c.survives);
  if (failed.length > 0 && failed.length <= 8) {
    console.log("  候选但未存活:");
    for (const v of failed) console.log(variantLine(v, alphaAdj));
  } else if (failed.length > 8) {
    console.log(`  候选但未存活 ${failed.length} 个(细节在落库报告 JSON 里)`);
  }
  console.log(
    `  格账本:train 落选 ${t.trainRejected}(validate 从未被看) · 可评折不足 ${t.insufficient}` +
      (t.watchlist.length > 0
        ? ` · 观察名单 ${t.watchlist.length}:${t.watchlist
            .slice(0, 5)
            .map((w) => `${w.label}(${w.validFolds}折)`)
            .join("、")}${t.watchlist.length > 5 ? "…" : ""}`
        : ""),
  );
}

function main() {
  const db = new Database(DB_PATH, { fileMustExist: true });
  // 生产库上引擎在持续写:默认 busy_timeout=0 会让末尾那一条 INSERT 在撞上
  // 写锁的瞬间直接 SQLITE_BUSY 抛掉整轮计算 —— 等 5s 足够(引擎单笔写都是
  // 毫秒级)。只读段不受影响(WAL 读者从不阻塞)。
  db.pragma("busy_timeout = 5000");
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const folds = listValidateFolds(GATE_START, nowSec);
    console.log(`\nWalk-forward 阈值重推 · ${DB_PATH}`);
    if (folds.length === 0) {
      console.log(
        "干净窗内还没有可评的完整周(首个干净整周之后至少再满一整周才有 validate 折),本次不产报告。",
      );
      return;
    }
    const { tiers, disclosures } = loadTiers(db);
    if (tiers.length === 0) {
      console.log("没有任何带已结算仓的策略档,无法重推。");
      return;
    }
    const report = runWalkforward(tiers, {
      gateStart: GATE_START,
      folds,
      randDraws: RAND_DRAWS,
      seed: SEED,
      minFoldSettled: MIN_FOLD_SETTLED,
      minFoldMarkets: MIN_FOLD_MARKETS,
      minValidFolds: MIN_VALID_FOLDS,
      alpha: ALPHA,
    });

    printRepresentativeness(tiers, folds, disclosures);
    for (const t of report.tiers) printTier(t, report);

    console.log("");
    line();
    console.log("多重比较与三道闸");
    line();
    const alphaAdj = ALPHA / Math.max(report.scoredCells, 1);
    console.log(
      `  网格总数 ${report.gridTotal} 格(薄档整档不计)→ 实际发布 validate 成绩 G = ${report.scoredCells} 格` +
        `(候选 + 非薄档基线;train 落选的格连数字都没发布,不烧 OOS)。`,
    );
    console.log(
      `  Bonferroni:α'=${ALPHA}/${report.scoredCells}=${alphaAdj.toFixed(5)} → 聚类临界 |z|=${report.zBonf.toFixed(2)};` +
        `随机化 ${RAND_DRAWS.toLocaleString()} 次(种子 ${SEED},可复现),判过线 p ≤ ${alphaAdj.toFixed(5)}。`,
    );
    if (1 / (RAND_DRAWS + 1) > alphaAdj) {
      console.log(
        `  ⚠️ G 太大:随机化最小可达 p = ${(1 / (RAND_DRAWS + 1)).toFixed(6)} > 阈值 —— 这道闸在当前网格规模下不可能通过,任何「存活」都不该被相信。`,
      );
    }
    console.log("\n固定诚实段落(逐条随报告落库):");
    for (const d of WF_DECLARATIONS) console.log(`  · ${d}`);

    const windowTo = folds[folds.length - 1] + 7 * 86_400;
    const config = {
      gateStart: GATE_START,
      folds,
      randDraws: RAND_DRAWS,
      seed: SEED,
      minFoldSettled: MIN_FOLD_SETTLED,
      minFoldMarkets: MIN_FOLD_MARKETS,
      minValidFolds: MIN_VALID_FOLDS,
      alpha: ALPHA,
      tiltLookbackSec: TILT_LOOKBACK_SEC,
      ladders:
        "单维平移×赛道×退出;阶梯定义见 lib/walkforward.ts buildEntryVariants",
    };
    // 与 lib/db.ts 同一张表定义:快照库可能建于本批之前,幂等补建让脚本
    // 在生产每日快照上直接可跑(设计 §9 的真机路径)。
    db.prepare(
      "CREATE TABLE IF NOT EXISTS walkforward_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, window_from INTEGER NOT NULL, window_to INTEGER NOT NULL, grid_size INTEGER NOT NULL, config_json TEXT NOT NULL, report_json TEXT NOT NULL)",
    ).run();
    const res = db
      .prepare(
        `INSERT INTO walkforward_reports
           (created_at, window_from, window_to, grid_size, config_json, report_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        nowSec,
        GATE_START,
        windowTo,
        report.gridTotal,
        JSON.stringify(config),
        JSON.stringify(report),
      );
    console.log(
      `\n已写入 walkforward_reports id=${res.lastInsertRowid}(/manage → ② 策略信号 → 🧪 阈值重推 可见)。\n`,
    );
  } finally {
    db.close();
  }
}

main();
