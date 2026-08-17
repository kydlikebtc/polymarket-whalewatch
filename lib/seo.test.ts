import { describe, it, expect, vi, afterEach } from "vitest";
import { openDb, type DB } from "./db";
import {
  siteBase,
  isValidWalletAddress,
  isValidConditionId,
  buildWalletSeoSummary,
  buildMarketSeoSummary,
  sitemapWalletEntries,
  sitemapMarketEntries,
  llmsTxt,
} from "./seo";

const NOW = Math.floor(Date.UTC(2026, 7, 17, 12) / 1000);
const ADDR = "0x" + "ab".repeat(20);
const CID = "0x" + "cd".repeat(32);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("siteBase / validators", () => {
  it("defaults to production and strips trailing slashes from PUBLIC_URL", () => {
    expect(siteBase()).toBe("https://whalewatch.wired.fund");
    vi.stubEnv("PUBLIC_URL", "http://my.host:3000/");
    expect(siteBase()).toBe("http://my.host:3000");
  });
  it("address/conditionId 严格校验 —— 无限 URL 空间不可交给爬虫", () => {
    expect(isValidWalletAddress(ADDR)).toBe(true);
    expect(isValidWalletAddress(ADDR.toUpperCase().replace("0X", "0x"))).toBe(
      true,
    );
    expect(isValidWalletAddress("0x123")).toBe(false);
    expect(isValidWalletAddress(ADDR + "ff")).toBe(false);
    expect(isValidConditionId(CID)).toBe(true);
    expect(isValidConditionId(ADDR)).toBe(false);
  });
});

function insertAlert(
  db: DB,
  key: string,
  payload: unknown,
  ts: number,
  type = "large",
) {
  db.prepare(
    "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES (?,?,?,?)",
  ).run(type, key, JSON.stringify(payload), ts);
}

describe("buildWalletSeoSummary", () => {
  it("merges wallet_stats / smart_wallets / wallet_age / 30d alerts, hasData=true", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO wallet_stats (wallet, win_rate, realized_pnl, roi, settled_count, fetched_at) VALUES (?, 0.62, 48000, 0.12, 34, ?)",
    ).run(ADDR, NOW);
    db.prepare(
      "INSERT INTO smart_wallets (address, score, is_whitelist, source, updated_at) VALUES (?, 88.5, 1, 'leaderboard:all', ?)",
    ).run(ADDR, NOW);
    db.prepare(
      "INSERT INTO wallet_age (wallet, first_ts, fetched_at) VALUES (?, ?, ?)",
    ).run(ADDR, NOW - 90 * 86400, NOW);
    insertAlert(
      db,
      "a1",
      { proxyWallet: ADDR, conditionId: CID, title: "M" },
      NOW - 86400,
    );
    insertAlert(
      db,
      "a2",
      { proxyWallet: ADDR, conditionId: CID, title: "M" },
      NOW - 40 * 86400,
    ); // 窗口外
    const s = buildWalletSeoSummary(
      db,
      ADDR.toUpperCase().replace("0X", "0x"),
      NOW,
    );
    expect(s.hasData).toBe(true);
    expect(s.address).toBe(ADDR); // 归一小写
    expect(s.winRatePct).toBeCloseTo(62, 6);
    expect(s.realizedPnlUsd).toBe(48000);
    expect(s.settledCount).toBe(34);
    expect(s.isWhitelist).toBe(true);
    expect(s.score).toBeCloseTo(88.5, 6);
    expect(s.alerts30d).toBe(1);
    expect(s.firstSeenTs).toBe(NOW - 90 * 86400);
  });
  it("unknown wallet → hasData=false（页面 noindex 门）", () => {
    const db = openDb(":memory:");
    const s = buildWalletSeoSummary(db, ADDR, NOW);
    expect(s.hasData).toBe(false);
    expect(s.alerts30d).toBe(0);
  });
});

describe("buildMarketSeoSummary", () => {
  it("merges market_meta / token_map title / 30d alert aggregate / consensus_state", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO market_meta (condition_id, meta_json, fetched_at) VALUES (?,?,?)",
    ).run(
      CID,
      JSON.stringify({
        conditionId: CID,
        volume24hr: 500000,
        liquidity: 229000,
        endDate: new Date((NOW + 5 * 3600) * 1000).toISOString(),
        closed: false,
        category: "Sports",
        outcomes: ["Yes", "No"],
        outcomePrices: [0.61, 0.39],
      }),
      NOW,
    );
    db.prepare(
      "INSERT INTO token_map (token_id, condition_id, question, outcome, slug, event_slug, updated_at) VALUES ('t1', ?, 'Chiefs win Super Bowl LX?', 'Yes', 'chiefs-sb', 'sb-lx', ?)",
    ).run(CID, NOW);
    insertAlert(
      db,
      "m1",
      {
        proxyWallet: ADDR,
        conditionId: CID,
        title: "Chiefs win Super Bowl LX?",
        size: 100000,
        price: 0.6,
      },
      NOW - 3600,
    );
    insertAlert(
      db,
      "m2",
      {
        conditionId: CID,
        title: "Chiefs win Super Bowl LX?",
        outcome: "Yes",
        walletCount: 3,
        totalNetUsd: 92000,
      },
      NOW - 7200,
      "consensus",
    );
    db.prepare(
      "INSERT INTO consensus_state (condition_id, outcome, wallet_count, total_usd, last_alert_ts) VALUES (?, 'Yes', 3, 92000, ?)",
    ).run(CID, NOW - 7200);
    const s = buildMarketSeoSummary(db, CID, NOW);
    expect(s.hasData).toBe(true);
    expect(s.title).toBe("Chiefs win Super Bowl LX?");
    expect(s.category).toBe("Sports");
    expect(s.outcomes).toEqual(["Yes", "No"]);
    expect(s.alerts30d).toBe(2);
    expect(s.alertUsd30d).toBeCloseTo(100000 * 0.6 + 92000, 6);
    expect(s.consensus).toEqual([
      { outcome: "Yes", walletCount: 3, totalUsd: 92000 },
    ]);
  });
  it("title falls back to the latest alert payload when token_map is empty", () => {
    const db = openDb(":memory:");
    insertAlert(
      db,
      "m1",
      {
        conditionId: CID,
        title: "Fallback title",
        size: 1000,
        price: 0.5,
        proxyWallet: ADDR,
      },
      NOW - 100,
    );
    const s = buildMarketSeoSummary(db, CID, NOW);
    expect(s.title).toBe("Fallback title");
    expect(s.hasData).toBe(true);
  });
  it("unknown market → hasData=false", () => {
    expect(buildMarketSeoSummary(openDb(":memory:"), CID, NOW).hasData).toBe(
      false,
    );
  });
});

describe("sitemap entries", () => {
  it("wallets = smart_wallets ∪ wallet_stats(settled≥5)，去重小写、格式校验、带 lastModified", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO smart_wallets (address, score, updated_at) VALUES (?, 90, ?)",
    ).run(ADDR, NOW);
    // 同一钱包大小写混写:去重。
    db.prepare(
      "INSERT INTO wallet_stats (wallet, settled_count, fetched_at) VALUES (?, 10, ?)",
    ).run(ADDR, NOW - 100);
    const thin = "0x" + "11".repeat(20);
    db.prepare(
      "INSERT INTO wallet_stats (wallet, settled_count, fetched_at) VALUES (?, 2, ?)",
    ).run(thin, NOW);
    const junk = "not-an-address";
    db.prepare(
      "INSERT INTO smart_wallets (address, score, updated_at) VALUES (?, 50, ?)",
    ).run(junk, NOW);
    const entries = sitemapWalletEntries(db, "https://x.example", NOW);
    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe(`https://x.example/wallet/${ADDR}`);
    expect(entries[0].lastModified).toBeInstanceOf(Date);
  });
  it("markets = 近180天有告警的市场，按最近告警排序", () => {
    const db = openDb(":memory:");
    const cid2 = "0x" + "ef".repeat(32);
    insertAlert(
      db,
      "a",
      { conditionId: CID, title: "A", proxyWallet: ADDR },
      NOW - 100,
    );
    insertAlert(
      db,
      "b",
      { conditionId: cid2, title: "B", proxyWallet: ADDR },
      NOW - 50,
    );
    insertAlert(
      db,
      "c",
      { conditionId: CID, title: "A", proxyWallet: ADDR },
      NOW - 200 * 86400,
    ); // 窗口外仍有窗口内的 a
    insertAlert(
      db,
      "junk",
      { conditionId: "bad", title: "J", proxyWallet: ADDR },
      NOW - 10,
    );
    const entries = sitemapMarketEntries(db, "https://x.example", NOW);
    expect(entries.map((e) => e.url)).toEqual([
      `https://x.example/market/${cid2}`,
      `https://x.example/market/${CID}`,
    ]);
  });
});

describe("llmsTxt", () => {
  it("emits spec-shaped markdown with live counts and key links", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO smart_wallets (address, score, updated_at) VALUES (?, 90, ?)",
    ).run(ADDR, NOW);
    insertAlert(
      db,
      "a",
      { conditionId: CID, title: "A", proxyWallet: ADDR },
      NOW - 100,
    );
    const txt = llmsTxt(db, "https://x.example");
    expect(txt.startsWith("# WhaleWatch")).toBe(true);
    expect(txt).toContain("> ");
    expect(txt).toContain("https://x.example/follow");
    expect(txt).toContain("https://x.example/glossary");
    expect(txt).toContain("1 tracked smart-money wallets");
    expect(txt).toContain("Not financial advice");
  });
});
