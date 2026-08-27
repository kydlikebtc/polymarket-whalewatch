import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import {
  buildRecordCsv,
  csvField,
  DATASET_LICENSE_LINE,
} from "./datasetExport";

const NOW = Math.floor(Date.UTC(2026, 7, 27, 12) / 1000);

function seed(db: DB): { pushedId: number; silentId: number } {
  // openDb 会自动播种 19 个正式档位(名字占用),测试档必须用不会撞车的
  // 唯一名并按精确名取 id —— LIKE 前缀会捞到种子档。
  db.prepare(
    "INSERT INTO follow_strategies (name, enabled, params_json, created_at) VALUES ('测试逗号, 档', 1, '{}', ?)",
  ).run(NOW - 86_400);
  const stId = (
    db
      .prepare("SELECT id FROM follow_strategies WHERE name = '测试逗号, 档'")
      .get() as {
      id: number;
    }
  ).id;
  const ins = db.prepare(
    `INSERT INTO strategy_signals (strategy_id, condition_id, outcome, title, formation_ts,
       entry_price, emitted_at, settled, settled_ts, exit_price, won, realized_pnl)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  // 已发布 + 已结算(标题带逗号和引号,逼出转义路径)
  ins.run(
    stId,
    "0xc1",
    "Yes",
    'Fed cut, "September"?',
    NOW - 7200,
    0.41,
    NOW - 7000,
    1,
    NOW - 600,
    1,
    1,
    590,
  );
  const pushedId = (
    db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }
  ).id;
  db.prepare(
    "INSERT INTO signal_deliveries (signal_id, event, channel, delivered_at, status) VALUES (?,?,?,?,?)",
  ).run(pushedId, "entry", "tg", NOW - 6900, "sent");
  // 已发布 + 未结算(won 必须留空,不能填 0)
  ins.run(
    stId,
    "0xc2",
    "No",
    "Open one",
    NOW - 3600,
    0.6,
    NOW - 3500,
    0,
    null,
    null,
    null,
    null,
  );
  const openId = (
    db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }
  ).id;
  db.prepare(
    "INSERT INTO signal_deliveries (signal_id, event, channel, delivered_at, status) VALUES (?,?,?,?,?)",
  ).run(openId, "entry", "tg", NOW - 3400, "sent");
  // 从未发布(静默纸面账 —— 绝不能混进公开数据集)
  ins.run(
    stId,
    "0xc3",
    "Yes",
    "Silent one",
    NOW - 1800,
    0.5,
    NOW - 1700,
    1,
    NOW - 100,
    0,
    0,
    -500,
  );
  const silentId = (
    db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }
  ).id;
  return { pushedId, silentId };
}

describe("csvField", () => {
  it("含逗号/引号/换行才加引号,引号翻倍(RFC 4180)", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField('a,"b"')).toBe('"a,""b"""');
    expect(csvField("l1\nl2")).toBe('"l1\nl2"');
    expect(csvField(null)).toBe("");
    expect(csvField(0.41)).toBe("0.41");
  });
});

describe("buildRecordCsv", () => {
  it("只导出已发布信号 —— 静默纸面账混入公开数据集就是社会证明造假", () => {
    const db = openDb(":memory:");
    seed(db);
    const csv = buildRecordCsv(db, NOW);
    expect(csv).toContain("0xc1");
    expect(csv).toContain("0xc2");
    expect(csv).not.toContain("0xc3");
    expect(csv).not.toContain("Silent one");
    db.close();
  });

  it("头部:license 注释 + 生成时刻 + 行数 + 列头;行按 emitted_at 升序", () => {
    const db = openDb(":memory:");
    seed(db);
    const csv = buildRecordCsv(db, NOW);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(DATASET_LICENSE_LINE);
    expect(lines[1]).toContain("rows: 2");
    expect(lines[1]).toContain("2026-08-27T12:00:00.000Z");
    expect(lines[3]).toContain("emitted_at_utc,formation_at_utc,strategy_code");
    // 升序:先 0xc1(NOW-7000)后 0xc2(NOW-3500)
    expect(csv.indexOf("0xc1")).toBeLessThan(csv.indexOf("0xc2"));
    db.close();
  });

  it("未结算行 won 留空而非 0 —— 「没结果」不能写成「输了」", () => {
    const db = openDb(":memory:");
    seed(db);
    const csv = buildRecordCsv(db, NOW);
    const openRow = csv.split("\n").find((l) => l.includes("0xc2"))!;
    const cols = openRow.split(",");
    // settled 列与 won 列:settled=0,won 空串
    expect(cols).toContain("0");
    expect(openRow).toContain(",0,,");
    const settledRow = csv.split("\n").find((l) => l.includes("0xc1"))!;
    expect(settledRow).toContain(",true,");
    db.close();
  });

  it("标题与档位名里的逗号/引号被正确转义;未登记档位码留空不编造", () => {
    const db = openDb(":memory:");
    seed(db);
    const csv = buildRecordCsv(db, NOW);
    expect(csv).toContain('"Fed cut, ""September""?"');
    // 档位名本身含逗号 → 名列也要转义
    expect(csv).toContain('"测试逗号, 档"');
    // 手工建档没有冻结档位码 → code 列空串(相邻两个逗号),不发明一个
    const row = csv.split("\n").find((l) => l.includes("0xc1"))!;
    expect(row).toContain(',,"测试逗号, 档"');
    db.close();
  });

  it("空账:只有头部,行数 0 如实标注", () => {
    const db = openDb(":memory:");
    const csv = buildRecordCsv(db, NOW);
    expect(csv).toContain("rows: 0");
    expect(csv.trim().split("\n")).toHaveLength(4);
    db.close();
  });
});
