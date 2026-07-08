import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import type { Trade } from "./types";
import type { SmartTag } from "./smartWallets";
import {
  detectEchoEvidence,
  detectSplitterEvidence,
  detectInsiderPending,
  recordEvidence,
  collectFirehoseEvidence,
  type CandidateEvidence,
} from "./discovery";

let txSeq = 0;
const trade = (over: Partial<Trade> = {}): Trade => ({
  proxyWallet: "0xwallet",
  side: "BUY",
  asset: "tok1",
  conditionId: "0xc1",
  size: 10_000,
  price: 0.5,
  timestamp: 1_000,
  title: "Test Market",
  slug: "test-market",
  eventSlug: "test-event",
  outcome: "Yes",
  outcomeIndex: 0,
  transactionHash: `0xtx${txSeq++}`,
  ...over,
});

const tag = (): SmartTag => ({
  score: 80,
  winRate: 0.7,
  netPnl: 100_000,
  isWhitelist: false,
});

// Two whitelist wallets forming a consensus on (0xc1, Yes), which the
// detectors receive as the group context.
const smartTags = new Map<string, SmartTag>([
  ["0xsmart1", tag()],
  ["0xsmart2", tag()],
]);
const consensusTrades = [
  trade({ proxyWallet: "0xsmart1", size: 12_000, price: 0.5, timestamp: 100 }),
  trade({ proxyWallet: "0xsmart2", size: 12_000, price: 0.5, timestamp: 200 }),
];

describe("detectEchoEvidence", () => {
  it("surfaces a non-pool wallet net-buying the same outcome as a consensus group", () => {
    const trades = [
      ...consensusTrades,
      // echoer: $6k net buy on the consensus outcome
      trade({
        proxyWallet: "0xEcho",
        size: 12_000,
        price: 0.5,
        timestamp: 300,
      }),
    ];
    const out = detectEchoEvidence(trades, smartTags, {
      groups: [{ conditionId: "0xc1", outcome: "Yes" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].address).toBe("0xecho");
    expect(out[0].channel).toBe("echo");
    expect(out[0].conditionId).toBe("0xc1");
    expect(out[0].usd).toBe(6_000);
    expect(out[0].ts).toBe(300);
  });

  it("ignores pool wallets, sub-floor echoers, and non-consensus outcomes", () => {
    const trades = [
      ...consensusTrades,
      // pool wallet — not a discovery
      trade({ proxyWallet: "0xsmart1", size: 20_000, timestamp: 300 }),
      // $1k net buy — under the echo floor
      trade({ proxyWallet: "0xtiny", size: 2_000, price: 0.5, timestamp: 300 }),
      // big buy on the OTHER outcome — not echoing the consensus
      trade({
        proxyWallet: "0xother",
        size: 20_000,
        price: 0.5,
        outcome: "No",
        outcomeIndex: 1,
        timestamp: 300,
      }),
    ];
    const out = detectEchoEvidence(trades, smartTags, {
      groups: [{ conditionId: "0xc1", outcome: "Yes" }],
    });
    expect(out).toHaveLength(0);
  });

  it("nets sells against buys and drops hedgers who net-buy both outcomes", () => {
    const trades = [
      ...consensusTrades,
      // seller-heavy echoer: 6k buy − 4.5k sell = 1.5k net < the $2k floor
      trade({
        proxyWallet: "0xnetted",
        size: 12_000,
        price: 0.5,
        timestamp: 300,
      }),
      trade({
        proxyWallet: "0xnetted",
        side: "SELL",
        size: 9_000,
        price: 0.5,
        timestamp: 310,
      }),
      // hedger: net-buys BOTH outcomes of the market
      trade({
        proxyWallet: "0xhedge",
        size: 12_000,
        price: 0.5,
        timestamp: 300,
      }),
      trade({
        proxyWallet: "0xhedge",
        size: 12_000,
        price: 0.5,
        outcome: "No",
        outcomeIndex: 1,
        timestamp: 310,
      }),
    ];
    const out = detectEchoEvidence(trades, smartTags, {
      groups: [{ conditionId: "0xc1", outcome: "Yes" }],
    });
    expect(out).toHaveLength(0);
  });
});

describe("detectSplitterEvidence", () => {
  it("surfaces a clean non-pool split accumulator and skips pool wallets", () => {
    const splits = (wallet: string) =>
      [0, 1, 2].map((i) =>
        trade({
          proxyWallet: wallet,
          size: 4_000, // $2k per fill at 0.5 → under the split ceiling
          price: 0.5,
          timestamp: 100 + i,
        }),
      );
    const out = detectSplitterEvidence(
      [...splits("0xsplit"), ...splits("0xsmart1")],
      smartTags,
    );
    expect(out).toHaveLength(1);
    expect(out[0].address).toBe("0xsplit");
    expect(out[0].channel).toBe("splitter");
    expect(out[0].usd).toBe(6_000);
  });

  it("drops hedge/mm-suspect groups (no directional conviction)", () => {
    // Qualifies on every split threshold (4 buys × $4k, net $14k) but the
    // B/S/B/S/B/B sequence flips 4/5 times → mmSuspect → dropped.
    const sides: Array<"BUY" | "SELL"> = [
      "BUY",
      "SELL",
      "BUY",
      "SELL",
      "BUY",
      "BUY",
    ];
    const pingPong = sides.map((side, i) =>
      trade({
        proxyWallet: "0xmm",
        side,
        size: side === "BUY" ? 8_000 : 2_000,
        price: 0.5,
        timestamp: 100 + i,
      }),
    );
    expect(detectSplitterEvidence(pingPong, smartTags)).toHaveLength(0);
  });
});

describe("detectInsiderPending", () => {
  it("flags big favorite-odds buys from non-pool wallets for the age check", () => {
    const trades = [
      // $7k BUY at 0.7 — insider-shaped, pending age verification
      trade({ proxyWallet: "0xNew", size: 10_000, price: 0.7, timestamp: 500 }),
      // price outside the 0.5–0.9 band
      trade({ proxyWallet: "0xcheap", size: 20_000, price: 0.3 }),
      // under the notional floor
      trade({ proxyWallet: "0xsmall", size: 2_000, price: 0.7 }),
      // pool wallet
      trade({ proxyWallet: "0xsmart1", size: 10_000, price: 0.7 }),
      // SELL side — not a conviction entry
      trade({
        proxyWallet: "0xseller",
        side: "SELL",
        size: 10_000,
        price: 0.7,
      }),
    ];
    const out = detectInsiderPending(trades, smartTags);
    expect(out).toHaveLength(1);
    expect(out[0].address).toBe("0xnew");
    expect(out[0].usd).toBe(7_000);
  });

  it("keeps one row per (wallet, market) — the largest fill", () => {
    const trades = [
      trade({ proxyWallet: "0xnew", size: 10_000, price: 0.7, timestamp: 500 }),
      trade({ proxyWallet: "0xnew", size: 16_000, price: 0.6, timestamp: 600 }),
    ];
    const out = detectInsiderPending(trades, smartTags);
    expect(out).toHaveLength(1);
    expect(out[0].usd).toBeCloseTo(9_600);
    expect(out[0].ts).toBe(600);
  });
});

describe("recordEvidence", () => {
  it("dedups on the (address, channel, market) key but refreshes on newer evidence", () => {
    const db = openDb(":memory:");
    const ev: CandidateEvidence = {
      address: "0xa",
      channel: "echo",
      conditionId: "0xc1",
      ts: 100,
      usd: 6000,
      price: 0.5,
      note: "n",
    };
    expect(recordEvidence(db, [ev], 1000)).toBe(1);
    expect(recordEvidence(db, [ev], 2000)).toBe(0); // same observation — no-op
    // A strictly newer observation refreshes evidence_ts (keeps the wallet
    // inside the 30-day recurrence window) without minting a second row;
    // created_at stays frozen at first discovery.
    expect(recordEvidence(db, [{ ...ev, ts: 500, usd: 9000 }], 3000)).toBe(1);
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c, MAX(evidence_ts) AS ts, MAX(created_at) AS created FROM wallet_candidates",
      )
      .get() as { c: number; ts: number; created: number };
    expect(row.c).toBe(1);
    expect(row.ts).toBe(500);
    expect(row.created).toBe(1000);
  });
});

describe("collectFirehoseEvidence", () => {
  it("runs all three detectors over the window and persists evidence", async () => {
    const db = openDb(":memory:");
    const nowSec = 10_000;
    const trades = [
      ...consensusTrades,
      // echoer
      trade({
        proxyWallet: "0xecho",
        size: 12_000,
        price: 0.5,
        timestamp: 300,
      }),
      // insider-shaped fill in ANOTHER market, wallet aged 2 days
      trade({
        proxyWallet: "0xinsider",
        conditionId: "0xc2",
        asset: "tok2",
        size: 10_000,
        price: 0.7,
        timestamp: 400,
      }),
    ];
    const getAges = vi.fn(async (_db: unknown, wallets: string[]) =>
      Object.fromEntries(
        wallets.map((w) => [w, nowSec - 2 * 86_400]), // first activity 2d ago
      ),
    );
    const r = await collectFirehoseEvidence(db, trades, smartTags, {
      nowSec,
      agesFetcher: getAges as never,
    });
    expect(r.inserted).toBeGreaterThanOrEqual(2);
    const rows = db
      .prepare(
        "SELECT address, channel FROM wallet_candidates ORDER BY address",
      )
      .all() as { address: string; channel: string }[];
    expect(rows).toContainEqual({ address: "0xecho", channel: "echo" });
    expect(rows).toContainEqual({ address: "0xinsider", channel: "insider" });
  });

  it("drops insider-pending wallets that are older than the age cap or unresolved", async () => {
    const db = openDb(":memory:");
    const nowSec = 10_000;
    const trades = [
      trade({ proxyWallet: "0xold", size: 10_000, price: 0.7, timestamp: 400 }),
      trade({
        proxyWallet: "0xunknown",
        conditionId: "0xc2",
        size: 10_000,
        price: 0.7,
        timestamp: 400,
      }),
    ];
    const getAges = vi.fn(async () => ({
      "0xold": nowSec - 400 * 86_400, // 400 days old — not a fresh wallet
      // 0xunknown ABSENT — lookup failed; retried next cycle via the PK no-op
    }));
    const r = await collectFirehoseEvidence(db, trades, smartTags, {
      nowSec,
      agesFetcher: getAges as never,
    });
    expect(r.inserted).toBe(0);
  });
});
