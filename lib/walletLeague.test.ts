import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { buildWalletLeague, codenameOf } from "./walletLeague";

// 名人堂 + 反指名单(第二梯队八件套):逐钱包前向战绩,记分卡同一套机器
// (CRVE + 扣费 + nc≥10 lowN 线)。反指 = 净 edge 上界 < 0 —— 逆势少数边
// 从孤例变一类;多重比较只披露不校正(记分卡先例),页脚写明检验钱包数。

type DB = ReturnType<typeof openDb>;
const HALL_W = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FADE_W = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LOWN_W = "0xcccccccccccccccccccccccccccccccccccccccc";

let alertSeq = 0;
function seedGraded(
  db: DB,
  wallet: string,
  cid: string,
  won: boolean,
  over: { title?: string; price?: number } = {},
) {
  alertSeq++;
  const payload = {
    proxyWallet: wallet,
    side: "BUY",
    price: over.price ?? 0.5,
    size: 20_000,
    conditionId: cid,
    title: over.title ?? `M-${cid}`,
  };
  const res = db
    .prepare(
      "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES ('smart', ?, ?, ?)",
    )
    .run(`k${alertSeq}`, JSON.stringify(payload), 1_000 + alertSeq);
  db.prepare(
    "INSERT INTO alert_outcomes (alert_id, resolved, resolution_price, won, checked_at) VALUES (?, 1, ?, ?, 1)",
  ).run(Number(res.lastInsertRowid), won ? 1 : 0, won ? 1 : 0);
  db.prepare(
    "INSERT OR IGNORE INTO market_meta (condition_id, meta_json, fetched_at) VALUES (?, ?, 1)",
  ).run(cid, JSON.stringify({ feesEnabled: false }));
}

function seedPool(db: DB, addr: string) {
  db.prepare(
    "INSERT OR REPLACE INTO smart_wallets (address, score, is_whitelist, updated_at, source) VALUES (?, 80, 0, 1, 'leaderboard')",
  ).run(addr);
}

describe("codenameOf", () => {
  it("确定性代号:同地址恒同名,不同地址(该样本)不同名;地址仍是第一标识", () => {
    expect(codenameOf(HALL_W)).toBe(codenameOf(HALL_W));
    expect(codenameOf(HALL_W)).not.toBe(codenameOf(FADE_W));
    expect(codenameOf(HALL_W)).toMatch(/.+·.+/);
  });
});

describe("buildWalletLeague", () => {
  function seedAll(db: DB) {
    seedPool(db, HALL_W);
    seedPool(db, FADE_W);
    seedPool(db, LOWN_W);
    for (let i = 0; i < 12; i++) {
      seedGraded(db, HALL_W, `hm${i}`, true, {
        title: i === 0 ? "最佳战役" : undefined,
      });
      seedGraded(db, FADE_W, `fm${i}`, false);
    }
    for (let i = 0; i < 5; i++) seedGraded(db, LOWN_W, `lm${i}`, true);
  }

  it("净 edge 下界 >0 进名人堂,上界 <0 进反指;lowN 两边都不进", () => {
    const db = openDb(":memory:");
    seedAll(db);
    const lg = buildWalletLeague(db);
    expect(lg.hall.map((r) => r.wallet)).toContain(HALL_W);
    expect(lg.fade.map((r) => r.wallet)).toContain(FADE_W);
    const everyone = [...lg.hall, ...lg.fade].map((r) => r.wallet);
    expect(everyone).not.toContain(LOWN_W);
    // BUY@0.5 全胜:净 edge = 1−0.5 = +0.5;全败 = −0.5。
    const hall = lg.hall.find((r) => r.wallet === HALL_W)!;
    expect(hall.netEdge).toBeCloseTo(0.5);
    expect(hall.markets).toBe(12);
    expect(hall.codename).toBe(codenameOf(HALL_W));
    expect(hall.channel).toBe("leaderboard");
  });

  it("最佳/最惨单条带标题与时间(展示用),贡献 = won−q−fee 同式", () => {
    const db = openDb(":memory:");
    seedAll(db);
    const hall = buildWalletLeague(db).hall.find((r) => r.wallet === HALL_W)!;
    expect(hall.best).not.toBeNull();
    expect(hall.best!.contrib).toBeCloseTo(0.5);
    expect(hall.best!.title).toBeTruthy();
    expect(hall.worst!.contrib).toBeCloseTo(0.5); // 全胜档的最惨也是 +0.5
  });

  it("多重比较披露:testedWallets 只数过了 nc≥10 线的钱包", () => {
    const db = openDb(":memory:");
    seedAll(db);
    const lg = buildWalletLeague(db);
    expect(lg.testedWallets).toBe(2); // HALL_W 与 FADE_W;LOWN_W 不足线
  });

  it("离池钱包照样进榜(channel=departed)—— 幸存者偏差防线延续", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 12; i++) seedGraded(db, FADE_W, `dm${i}`, false);
    const lg = buildWalletLeague(db);
    const row = lg.fade.find((r) => r.wallet === FADE_W)!;
    expect(row.channel).toBe("departed");
  });
});
