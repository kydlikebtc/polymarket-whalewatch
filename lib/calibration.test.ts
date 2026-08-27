import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import { recordAlert } from "./seen";
import { buildCalibration, CATEGORY_MIN_N } from "./calibration";

const NOW = Math.floor(Date.UTC(2026, 7, 27, 12) / 1000);

let n = 0;
function obs(
  db: DB,
  over: {
    price: number;
    side?: string;
    won: boolean;
    cid?: string;
    eventSlug?: string;
    type?: string;
  },
) {
  n++;
  recordAlert(
    db,
    over.type ?? "large",
    `k${n}`,
    JSON.stringify({
      conditionId: over.cid ?? `0xc${n}`,
      eventSlug: over.eventSlug ?? "e1",
      price: over.price,
      side: over.side ?? "BUY",
    }),
    NOW - 1000 - n,
  );
  const id = (
    db.prepare("SELECT id FROM alerts WHERE dedup_key = ?").get(`k${n}`) as {
      id: number;
    }
  ).id;
  db.prepare(
    "INSERT INTO alert_outcomes (alert_id, resolved, won, checked_at) VALUES (?,1,?,?)",
  ).run(id, over.won ? 1 : 0, NOW - 500);
}

describe("buildCalibration", () => {
  it("空库:零观察不炸,分带齐全但 n=0", () => {
    const db = openDb(":memory:");
    const r = buildCalibration(db, { nowSec: NOW });
    expect(r.totalN).toBe(0);
    expect(r.overall.bands).toHaveLength(10);
    expect(r.byCategory).toEqual([]);
    db.close();
  });

  it("方向约定:SELL@0.2 是市场说 80% 的观察,落 80–90¢ 带", () => {
    const db = openDb(":memory:");
    obs(db, { price: 0.2, side: "SELL", won: true });
    const r = buildCalibration(db, { nowSec: NOW });
    const band = r.overall.bands.find((b) => b.band === "80–90¢")!;
    expect(band.n).toBe(1);
    expect(band.implied).toBeCloseTo(0.8, 10);
    expect(r.overall.bands.find((b) => b.band === "20–30¢")!.n).toBe(0);
    db.close();
  });

  it("observed vs implied 的 gap:45¢ 买 10 次赢 8 次 → gap ≈ +0.35", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 10; i++) {
      obs(db, { price: 0.45, won: i < 8 });
    }
    const r = buildCalibration(db, { nowSec: NOW });
    const band = r.overall.bands.find((b) => b.band === "40–50¢")!;
    expect(band.n).toBe(10);
    expect(band.observed).toBeCloseTo(0.8, 10);
    expect(band.implied).toBeCloseTo(0.45, 10);
    expect(band.gap).toBeCloseTo(0.35, 10);
    db.close();
  });

  it("聚簇 CI:同市场 10 条是 1 个有效样本,区间必须比 10 市场宽", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 10; i++) {
      obs(db, { price: 0.55, won: true, cid: "0xsame" });
    }
    const one = buildCalibration(db, { nowSec: NOW }).overall.bands.find(
      (b) => b.band === "50–60¢",
    )!;
    db.close();
    const db2 = openDb(":memory:");
    for (let i = 0; i < 10; i++) {
      obs(db2, { price: 0.55, won: true });
    }
    const many = buildCalibration(db2, { nowSec: NOW }).overall.bands.find(
      (b) => b.band === "50–60¢",
    )!;
    db2.close();
    expect(one.markets).toBe(1);
    expect(many.markets).toBe(10);
    expect(one.ciHi - one.ciLo).toBeGreaterThan(many.ciHi - many.ciLo);
  });

  it("边界与脏数据:price 0/1 与缺 conditionId 的观察被剔除", () => {
    const db = openDb(":memory:");
    obs(db, { price: 1, won: true });
    obs(db, { price: 0, won: false });
    recordAlert(db, "large", "no-cid", JSON.stringify({ price: 0.5 }), NOW - 9);
    const id = (
      db.prepare("SELECT id FROM alerts WHERE dedup_key='no-cid'").get() as {
        id: number;
      }
    ).id;
    db.prepare(
      "INSERT INTO alert_outcomes (alert_id, resolved, won, checked_at) VALUES (?,1,1,?)",
    ).run(id, NOW - 5);
    const r = buildCalibration(db, { nowSec: NOW });
    expect(r.totalN).toBe(0);
    db.close();
  });

  it("分类分组:达到最小样本才成组,按样本量降序", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO event_category (event_slug, category, subcategory, fetched_at) VALUES ('esp','Sports','NBA',?)",
    ).run(NOW);
    db.prepare(
      "INSERT INTO event_category (event_slug, category, subcategory, fetched_at) VALUES ('epo','Politics',NULL,?)",
    ).run(NOW);
    for (let i = 0; i < CATEGORY_MIN_N; i++) {
      obs(db, { price: 0.5, won: true, eventSlug: "esp" });
    }
    for (let i = 0; i < CATEGORY_MIN_N - 1; i++) {
      obs(db, { price: 0.5, won: true, eventSlug: "epo" });
    }
    const r = buildCalibration(db, { nowSec: NOW });
    expect(r.byCategory.map((g) => g.key)).toEqual(["Sports"]);
    expect(r.byCategory[0].n).toBe(CATEGORY_MIN_N);
    db.close();
  });
});
