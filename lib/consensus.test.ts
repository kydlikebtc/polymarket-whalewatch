import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import {
  detectConsensus,
  formatConsensusAlert,
  runConsensusCycle,
} from "./consensus";
import type { SmartTag } from "./smartWallets";
import type { Trade } from "./types";

const mk = (over: Partial<Trade> = {}): Trade =>
  ({
    transactionHash: `0xtx${Math.random().toString(36).slice(2, 8)}`,
    asset: "asset1",
    proxyWallet: "0xW1",
    side: "BUY",
    size: 20000,
    price: 0.5, // $10k notional by default
    timestamp: 1000,
    title: "Market",
    slug: "slug",
    eventSlug: "event",
    outcome: "Yes",
    outcomeIndex: 0,
    conditionId: "0xc",
    ...over,
  }) as Trade;

const tag = (score: number | null = 80): SmartTag => ({
  score,
  winRate: 0.7,
  realizedPnl: 100_000,
  isWhitelist: false,
});

const smartSet = (...wallets: string[]): Map<string, SmartTag> =>
  new Map(wallets.map((w) => [w.toLowerCase(), tag()]));

describe("detectConsensus", () => {
  it("surfaces a group when >=2 smart wallets each net-buy >= the floor", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1" }),
      mk({ proxyWallet: "0xB", transactionHash: "0x2" }),
      mk({ proxyWallet: "0xNOTSMART", transactionHash: "0x3" }),
    ];
    const groups = detectConsensus(trades, smartSet("0xA", "0xB"), {
      minWallets: 2,
      minPerWalletUsd: 5000,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].walletCount).toBe(2);
    expect(groups[0].totalNetUsd).toBe(20000);
    expect(groups[0].wallets.map((w) => w.wallet)).toEqual(["0xa", "0xb"]);
  });

  it("nets sells against buys per wallet (a flip-flopper doesn't qualify)", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1" }), // +$10k
      mk({ proxyWallet: "0xA", transactionHash: "0x2", side: "SELL" }), // -$10k
      mk({ proxyWallet: "0xB", transactionHash: "0x3" }),
      mk({ proxyWallet: "0xC", transactionHash: "0x4" }),
    ];
    const groups = detectConsensus(trades, smartSet("0xA", "0xB", "0xC"), {
      minWallets: 2,
      minPerWalletUsd: 5000,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].wallets.map((w) => w.wallet).sort()).toEqual([
      "0xb",
      "0xc",
    ]);
  });

  it("separates outcomes: opposite sides of a market are different groups", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1", outcome: "Yes" }),
      mk({ proxyWallet: "0xB", transactionHash: "0x2", outcome: "No" }),
    ];
    const groups = detectConsensus(trades, smartSet("0xA", "0xB"), {
      minWallets: 2,
      minPerWalletUsd: 5000,
    });
    expect(groups).toHaveLength(0); // one wallet per outcome — no consensus
  });

  it("dedups re-served rows so pagination overlap doesn't double-count", () => {
    const t = mk({ proxyWallet: "0xA", transactionHash: "0xsame" });
    const groups = detectConsensus(
      [t, { ...t }, mk({ proxyWallet: "0xB", transactionHash: "0xb" })],
      smartSet("0xA", "0xB"),
      { minWallets: 2, minPerWalletUsd: 5000 },
    );
    expect(groups[0].wallets.find((w) => w.wallet === "0xa")?.netUsd).toBe(
      10000,
    );
  });

  it("computes the usd-weighted average buy price", () => {
    const trades = [
      // 0xA: $10k at 0.5 (20k shares)
      mk({ proxyWallet: "0xA", transactionHash: "0x1" }),
      // 0xB: $10k at 0.25 (40k shares)
      mk({
        proxyWallet: "0xB",
        transactionHash: "0x2",
        size: 40000,
        price: 0.25,
      }),
    ];
    const [g] = detectConsensus(trades, smartSet("0xA", "0xB"), {
      minWallets: 2,
      minPerWalletUsd: 5000,
    });
    // $20k over 60k shares → 0.333…
    expect(g.avgBuyPrice).toBeCloseTo(20000 / 60000);
  });
});

describe("runConsensusCycle", () => {
  const deps = (
    db: ReturnType<typeof openDb>,
    over: Record<string, unknown> = {},
  ) => ({
    db,
    fetchWindow: async () => ({
      trades: [
        mk({ proxyWallet: "0xA", transactionHash: "0x1" }),
        mk({ proxyWallet: "0xB", transactionHash: "0x2" }),
      ],
      truncated: false,
    }),
    getSmart: () => smartSet("0xA", "0xB", "0xC"),
    nowSec: 10_000,
    ...over,
  });

  it("fires on formation, stays silent on repeat, fires again on escalation", async () => {
    const db = openDb(":memory:");
    const send = vi.fn().mockResolvedValue(undefined);

    expect(await runConsensusCycle(deps(db, { send }))).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0] as string).toContain("聪明钱共识");

    // Same group again → silent.
    expect(await runConsensusCycle(deps(db, { send, nowSec: 10_300 }))).toBe(0);

    // A third wallet joins → escalation fires.
    const escalated = deps(db, {
      send,
      nowSec: 10_600,
      fetchWindow: async () => ({
        trades: [
          mk({ proxyWallet: "0xA", transactionHash: "0x1" }),
          mk({ proxyWallet: "0xB", transactionHash: "0x2" }),
          mk({ proxyWallet: "0xC", transactionHash: "0x3" }),
        ],
        truncated: false,
      }),
    });
    expect(await runConsensusCycle(escalated)).toBe(1);
    const rows = db
      .prepare("SELECT type, dedup_key FROM alerts ORDER BY id")
      .all() as { type: string; dedup_key: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.type === "consensus")).toBe(true);
    expect(rows[1].dedup_key).toContain(":3"); // escalation level in the key
  });

  it("re-fires after the state TTL expires (group re-formed = news again)", async () => {
    const db = openDb(":memory:");
    const send = vi.fn().mockResolvedValue(undefined);
    await runConsensusCycle(deps(db, { send, nowSec: 10_000 }));
    // Past the 6h TTL → same group counts as news again.
    expect(
      await runConsensusCycle(deps(db, { send, nowSec: 10_000 + 7 * 3600 })),
    ).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("skips everything when the whitelist is empty (no seed yet)", async () => {
    const db = openDb(":memory:");
    const fetchWindow = vi.fn();
    const fired = await runConsensusCycle(
      deps(db, { getSmart: () => new Map(), fetchWindow }),
    );
    expect(fired).toBe(0);
    expect(fetchWindow).not.toHaveBeenCalled();
  });
});

describe("formatConsensusAlert", () => {
  it("escapes HTML and lists the top wallets", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1", title: "A <b>&</b> B" }),
      mk({ proxyWallet: "0xB", transactionHash: "0x2", title: "A <b>&</b> B" }),
    ];
    const [g] = detectConsensus(trades, smartSet("0xA", "0xB"), {
      minWallets: 2,
      minPerWalletUsd: 5000,
    });
    const html = formatConsensusAlert(g);
    expect(html).toContain("A &lt;b&gt;&amp;&lt;/b&gt; B");
    expect(html).toContain("2 个白名单钱包");
    expect(html).toContain("polymarket.com/profile/0xa");
  });
});
