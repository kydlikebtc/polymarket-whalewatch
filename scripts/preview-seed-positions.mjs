// 一次性的目视验收辅助脚本 —— 往 follow_positions 灌 mock 仓位，让改版后的
// 三种卡态（normal / low_sample / empty）能被真机看到。
//
// 存在的理由：跟单页改版把卡片从 14 指标收敛到「sparkline + 4 个数字」，但
// 本地库 follow_positions 是 0 行，所有 subagent 只看得到 empty 卡 —— 而改版
// 的核心恰恰是另外两态（sparkline 形状是否可读、4 个 Metric 在 320px 宽卡里
// 怎么排、Wilson 区间文本会不会撑破布局、440px 高度是否合适），全靠代码结构
// 估算，没人真正看过。
//
// 安全性：只写 follow_positions（执行前是 0 行），完全可逆 —— `node
// scripts/preview-seed-positions.mjs --clear` 删回 0 行，一行不多一行不少。
// 其余 20 张表（含 6833 条 alerts、102 行 wallet_stats）全程不碰。
//
// 用法:
//   node scripts/preview-seed-positions.mjs          # 灌入
//   node scripts/preview-seed-positions.mjs --clear  # 清空(恢复原状)

import Database from "better-sqlite3";

const db = new Database("data.sqlite");
const clear = process.argv.includes("--clear");

if (clear) {
  const n = db.prepare("DELETE FROM follow_positions").run().changes;
  console.log(`已清空 follow_positions（删除 ${n} 行），恢复到验收前状态`);
  process.exit(0);
}

const existing = db.prepare("SELECT COUNT(*) c FROM follow_positions").get().c;
if (existing > 0) {
  console.error(
    `拒绝执行：follow_positions 已有 ${existing} 行。这个脚本只为「表本来是空的」\n` +
      `这个前提设计（那样清空才等于恢复原状）。请先确认这些行的来源。`,
  );
  process.exit(1);
}

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

// 覆盖三种卡态:
//   1  保守   → normal(21 仓已结算,超过 LOW_SAMPLE_THRESHOLD=10)
//   2  激进   → normal(30 仓,故意做成亏损,验证 down 色调的 sparkline)
//   8  巨鲸   → low_sample(3 仓,验证 ⚠ 警示与小样本 Wilson 区间)
//  13  高分独狼 → 只有持仓无结算(验证 empty 态的「等待首次结算」文案)
//  其余 8 档   → 保持 0 仓(验证 empty 态的「等待信号命中」文案)
const PLAN = [
  { sid: 1, settled: 21, winRate: 0.62, drift: +20 },
  { sid: 2, settled: 30, winRate: 0.45, drift: -9 },
  { sid: 8, settled: 3, winRate: 0.67, drift: +32 },
];

const ins = db.prepare(
  `INSERT INTO follow_positions
     (strategy_id, condition_id, outcome, asset, outcome_index, title, event_slug,
      entry_ts, entry_price, smart_avg_price, size_usd, shares, status,
      exit_ts, exit_price, realized_pnl, formation_ts, formation_price, fee_usd)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
);

// 确定性伪随机（不用 Math.random，重跑结果一致，便于比对截图）
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

let total = 0;
for (const p of PLAN) {
  for (let i = 0; i < p.settled; i++) {
    const entryTs = now - (p.settled - i) * DAY * 1.5;
    const entry = 0.35 + rnd() * 0.4;
    const won = rnd() < p.winRate;
    const size = 500;
    const shares = size / entry;
    const exitPrice = won ? 1 : 0;
    ins.run(
      p.sid,
      `0xmock${p.sid}_${i}`,
      "Yes",
      `mockasset${p.sid}_${i}`,
      0,
      `[MOCK] 验收用市场 ${p.sid}-${i}`,
      `mock-event-${p.sid}`,
      Math.floor(entryTs),
      entry,
      entry - 0.01,
      size,
      shares,
      "settled",
      Math.floor(entryTs + DAY),
      exitPrice,
      shares * (exitPrice - entry),
      Math.floor(entryTs - 300),
      entry - 0.005,
      size * 0.02,
    );
    total++;
  }
}

// 13 高分独狼:只有持仓、零结算 → empty 态的「等待首次结算」分支
for (let i = 0; i < 2; i++) {
  const entry = 0.5;
  ins.run(
    13,
    `0xmock13_open_${i}`,
    "Yes",
    `mockasset13_${i}`,
    0,
    `[MOCK] 持仓中市场 ${i}`,
    "mock-event-13",
    now - DAY,
    entry,
    entry - 0.01,
    500,
    500 / entry,
    "open",
    null,
    null,
    null,
    now - DAY - 300,
    entry - 0.005,
    10,
  );
  total++;
}

console.log(`已灌入 ${total} 条 mock 仓位:`);
console.log("  策略 1 保守   → 21 结算(normal,盈利)");
console.log("  策略 2 激进   → 30 结算(normal,亏损 → 验 down 色调)");
console.log("  策略 8 巨鲸   → 3  结算(low_sample → 验 ⚠ 警示)");
console.log("  策略 13 高分独狼 → 2 持仓 0 结算(empty 的「等待首次结算」分支)");
console.log("  其余 8 档     → 0 仓(empty 的「等待信号命中」分支)");
console.log("\n看完请务必执行: node scripts/preview-seed-positions.mjs --clear");
