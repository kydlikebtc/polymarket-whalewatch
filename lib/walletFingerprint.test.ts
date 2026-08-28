import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import {
  buildPoolStyles,
  similarWallets,
  STYLE_MIN_ALERTS,
} from "./walletFingerprint";

// 行为指纹 · 限池内(第二梯队八件套):从本地告警台账一趟扫出池内钱包的
// 交易风格 —— 可解释规则型标签,拒绝黑盒聚类。零上游。

const T0 = 1_700_000_000;
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";
let seq = 0;

function seedPool(db: DB, addrs: string[]) {
  const ins = db.prepare(
    "INSERT OR REPLACE INTO smart_wallets (address, score, win_rate, is_whitelist, updated_at) VALUES (?, 80, 0.6, 1, ?)",
  );
  for (const a of addrs) ins.run(a, T0);
}

function insertAlert(
  db: DB,
  over: {
    wallet?: string;
    price?: number;
    usd?: number;
    side?: string;
    hoursToEnd?: number | null;
  } = {},
) {
  seq++;
  const usd = over.usd ?? 20_000;
  const price = over.price ?? 0.5;
  const payload = {
    proxyWallet: over.wallet ?? A,
    side: over.side ?? "BUY",
    asset: "tok",
    conditionId: `0xc${seq}`,
    size: usd / price,
    price,
    timestamp: T0,
    title: "M",
    slug: "m",
    eventSlug: "e",
    outcome: "Yes",
    outcomeIndex: 0,
    transactionHash: `h${seq}`,
    marketCtx: {
      hoursToEnd: over.hoursToEnd === undefined ? 24 : over.hoursToEnd,
    },
  };
  db.prepare(
    "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES ('smart', ?, ?, ?)",
  ).run(`k${seq}`, JSON.stringify(payload), T0);
}

describe("buildPoolStyles", () => {
  it("池内 ≥5 条告警才给风格;池外与不足样本的钱包没有条目", () => {
    const db = openDb(":memory:");
    seedPool(db, [A, B]);
    for (let i = 0; i < 6; i++) insertAlert(db, { wallet: A });
    for (let i = 0; i < 3; i++) insertAlert(db, { wallet: B }); // 不足
    for (let i = 0; i < 9; i++) insertAlert(db, { wallet: C }); // 池外
    const styles = buildPoolStyles(db, { nowSec: T0 + 1000 });
    expect(STYLE_MIN_ALERTS).toBe(5);
    expect(styles.has(A)).toBe(true);
    expect(styles.has(B)).toBe(false);
    expect(styles.has(C)).toBe(false);
    expect(styles.get(A)!.alerts).toBe(6);
  });

  it("标签轴:冷门猎手(中位 ≤35¢)+ 重锤(中位 ≥$50k)+ 临场(中位 ≤6h)+ 双向(SELL ≥30%)", () => {
    const db = openDb(":memory:");
    seedPool(db, [A]);
    for (let i = 0; i < 6; i++) {
      insertAlert(db, {
        wallet: A,
        price: 0.25,
        usd: 60_000,
        hoursToEnd: 3,
        side: i < 2 ? "SELL" : "BUY", // 2/6 = 33% SELL
      });
    }
    const s = buildPoolStyles(db, { nowSec: T0 + 1000 }).get(A)!;
    expect(s.medPriceCents).toBeCloseTo(25);
    expect(s.tags).toContain("longshot");
    expect(s.tags).toContain("hammer");
    expect(s.tags).toContain("lastcall");
    expect(s.tags).toContain("twoway");
  });

  it("热门守卫(≥65¢)与长线(>48h);hoursToEnd 全缺失时不给时钟标签", () => {
    const db = openDb(":memory:");
    seedPool(db, [A, B]);
    for (let i = 0; i < 5; i++) {
      insertAlert(db, { wallet: A, price: 0.8, hoursToEnd: 100 });
      insertAlert(db, { wallet: B, price: 0.5, hoursToEnd: null });
    }
    const styles = buildPoolStyles(db, { nowSec: T0 + 1000 });
    expect(styles.get(A)!.tags).toContain("favorite");
    expect(styles.get(A)!.tags).toContain("longhaul");
    const bTags = styles.get(B)!.tags;
    expect(bTags).not.toContain("lastcall");
    expect(bTags).not.toContain("intraday");
    expect(bTags).not.toContain("longhaul");
  });
});

describe("similarWallets", () => {
  it("按 z 分数特征距离取最近邻,排除自己,k 生效", () => {
    const db = openDb(":memory:");
    seedPool(db, [A, B, C]);
    // A 与 B 风格接近(低价小额),C 走高价重锤。
    for (let i = 0; i < 5; i++) {
      insertAlert(db, { wallet: A, price: 0.3, usd: 12_000 });
      insertAlert(db, { wallet: B, price: 0.32, usd: 15_000 });
      insertAlert(db, { wallet: C, price: 0.85, usd: 90_000 });
    }
    const styles = buildPoolStyles(db, { nowSec: T0 + 1000 });
    const sim = similarWallets(styles, A, 2);
    expect(sim.length).toBe(2);
    expect(sim[0].wallet).toBe(B);
    expect(sim.map((s) => s.wallet)).not.toContain(A);
  });
});
