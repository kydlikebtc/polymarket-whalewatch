import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import {
  detectConsensus,
  formatConsensusAlert,
  runConsensusCycle,
} from "./consensus";
import { TelegramPermanentError } from "./telegram";
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
  netPnl: 100_000,
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
    // Credential fields copied off the smart tag for the alert copy.
    expect(groups[0].wallets[0].score).toBe(80);
    expect(groups[0].wallets[0].winRate).toBe(0.7);
    // Token identity for the validation loop (all members fill the same token).
    expect(groups[0].asset).toBe("asset1");
    expect(groups[0].outcomeIndex).toBe(0);
  });

  it("drops hedgers that net-buy BOTH outcomes, so a hedger-only side is not a fake consensus", () => {
    // Live-bug repro: an O/U 2.5 market whose Under side was ENTIRELY the two
    // wallets that also bought Over. detectConsensus used to surface Under+Over
    // as two consensuses while detectDisagreement (which drops hedgers) never
    // flagged it contested — leaking a fake double-consensus onto the page.
    const trades = [
      // Two hedgers: each net-buys BOTH sides.
      mk({ proxyWallet: "0xH1", outcome: "Under", transactionHash: "0x1" }),
      mk({ proxyWallet: "0xH1", outcome: "Over", transactionHash: "0x2" }),
      mk({ proxyWallet: "0xH2", outcome: "Under", transactionHash: "0x3" }),
      mk({ proxyWallet: "0xH2", outcome: "Over", transactionHash: "0x4" }),
      // Two clean directional buyers on Over only.
      mk({ proxyWallet: "0xO1", outcome: "Over", transactionHash: "0x5" }),
      mk({ proxyWallet: "0xO2", outcome: "Over", transactionHash: "0x6" }),
    ];
    const groups = detectConsensus(
      trades,
      smartSet("0xH1", "0xH2", "0xO1", "0xO2"),
      { minWallets: 2, minPerWalletUsd: 5000 },
    );
    // Under (hedgers only) collapses; Over keeps only the 2 clean buyers.
    expect(groups).toHaveLength(1);
    expect(groups[0].outcome).toBe("Over");
    expect(groups[0].wallets.map((w) => w.wallet).sort()).toEqual([
      "0xo1",
      "0xo2",
    ]);
    expect(groups[0].totalNetUsd).toBe(20000); // hedger money excluded, not $40k
  });

  it("keeps BOTH sides when they are distinct clean buyers (genuine split — the mutual-exclusion layer, not detectConsensus, routes it to disagreement)", () => {
    const trades = [
      mk({ proxyWallet: "0xU1", outcome: "Under", transactionHash: "0x1" }),
      mk({ proxyWallet: "0xU2", outcome: "Under", transactionHash: "0x2" }),
      mk({ proxyWallet: "0xO1", outcome: "Over", transactionHash: "0x3" }),
      mk({ proxyWallet: "0xO2", outcome: "Over", transactionHash: "0x4" }),
    ];
    const groups = detectConsensus(
      trades,
      smartSet("0xU1", "0xU2", "0xO1", "0xO2"),
      { minWallets: 2, minPerWalletUsd: 5000 },
    );
    // No hedgers → both one-sided groups stand; excludeContestedFromConsensus
    // (a separate layer, driven by detectDisagreement) reclassifies the market.
    expect(groups.map((g) => g.outcome).sort()).toEqual(["Over", "Under"]);
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

  // ---- formationTs / qualifiedTs(P1 信号触发改造)---------------------------
  // 背景缺陷:lastTs 被组内任何白名单成交(含 SELL、含不达标非成员)刷新,follow 的
  // 新鲜度锚在 lastTs 上 → 5 小时前形成的老共识被一笔小额杂音"续命"成新鲜。修法:
  // 锚定「形成时刻」—— 第 minWallets 个合格钱包的累计净买最后一次从 <floor 升到
  // >=floor 的成交时间(last upward crossing,保持到窗口末尾)。
  describe("formationTs / qualifiedTs", () => {
    // price 0.5 ⇒ size = 2×USD,便于按美元构造净买轨迹。
    const buy = (w: string, ts: number, usdVal: number, hash: string) =>
      mk({
        proxyWallet: w,
        timestamp: ts,
        size: usdVal * 2,
        price: 0.5,
        transactionHash: hash,
      });
    const sell = (w: string, ts: number, usdVal: number, hash: string) =>
      mk({
        proxyWallet: w,
        timestamp: ts,
        size: usdVal * 2,
        price: 0.5,
        side: "SELL",
        transactionHash: hash,
      });

    it("买-卖-再买:qualifiedTs = last upward crossing(跌回后再跨线覆盖前次)", () => {
      const trades = [
        buy("0xA", 1000, 6000, "0xa1"), // net $6k ≥ $5k → 首次跨线 @1000
        sell("0xA", 2000, 3000, "0xa2"), // net $3k < $5k → 跌回
        buy("0xA", 3000, 4000, "0xa3"), // net $7k ≥ $5k → 再跨线 @3000(覆盖)
        buy("0xB", 1500, 10000, "0xb1"), // B 一笔跨线 @1500
      ];
      const [g] = detectConsensus(trades, smartSet("0xA", "0xB"), {
        minWallets: 2,
        minPerWalletUsd: 5000,
      });
      expect(g).toBeDefined();
      const byWallet = new Map(g.wallets.map((w) => [w.wallet, w]));
      expect(byWallet.get("0xa")?.qualifiedTs).toBe(3000);
      expect(byWallet.get("0xb")?.qualifiedTs).toBe(1500);
      // formationTs = qualifiedTs 升序第 minWallets(2)个 = max(1500, 3000)。
      expect(g.formationTs).toBe(3000);
    });

    it("formationTs = 第 minWallets 个钱包跨线时刻;qualified 数超过 minWallets 仍取第 minWallets 个", () => {
      const trades = [
        buy("0xA", 1000, 10000, "0xa1"), // 跨线 @1000
        buy("0xB", 5000, 10000, "0xb1"), // 跨线 @5000 → 第 2 人到位,共识成立
        buy("0xD", 7000, 10000, "0xd1"), // 后来者不改变「共识最早成立」时刻
      ];
      const [g] = detectConsensus(trades, smartSet("0xA", "0xB", "0xD"), {
        minWallets: 2,
        minPerWalletUsd: 5000,
      });
      expect(g.walletCount).toBe(3);
      expect(g.formationTs).toBe(5000);
    });

    it("卖单/不达标非成员刷新 lastTs 但不影响 formationTs(核心缺陷复现)", () => {
      const trades = [
        buy("0xA", 1000, 10000, "0xa1"),
        buy("0xB", 5000, 10000, "0xb1"),
        // C 白名单但只买 $1k,不达标 —— 旧实现里这笔照样刷新 lastTs"续命"。
        buy("0xC", 9000, 1000, "0xc1"),
        // A 卖一小笔(net 仍 $9k ≥ floor,crossing 不变)。
        sell("0xA", 10000, 1000, "0xa2"),
      ];
      const [g] = detectConsensus(trades, smartSet("0xA", "0xB", "0xC"), {
        minWallets: 2,
        minPerWalletUsd: 5000,
      });
      expect(g.walletCount).toBe(2); // C 不达标
      expect(g.formationTs).toBe(5000); // 杂音动不了形成时刻(lastTs 的既有语义不在此断言)
    });

    it("乱序入参(newest-first)与升序结果一致 —— 不依赖入参顺序契约", () => {
      const asc = [
        buy("0xA", 1000, 6000, "0xa1"),
        sell("0xA", 2000, 3000, "0xa2"),
        buy("0xA", 3000, 4000, "0xa3"),
        buy("0xB", 1500, 10000, "0xb1"),
      ];
      const desc = [...asc].reverse(); // getTradesWindowDeep 实际给 newest-first
      const opts = { minWallets: 2, minPerWalletUsd: 5000 };
      const [gAsc] = detectConsensus(asc, smartSet("0xA", "0xB"), opts);
      const [gDesc] = detectConsensus(desc, smartSet("0xA", "0xB"), opts);
      expect(gDesc.formationTs).toBe(gAsc.formationTs);
      expect(gDesc.formationTs).toBe(3000);
      const q = (g: typeof gAsc) =>
        g.wallets.map((w) => [w.wallet, w.qualifiedTs]).sort();
      expect(q(gDesc)).toEqual(q(gAsc));
    });
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
    // Formation push carries the time-span line; a NON-truncated window never
    // carries the coverage caveat.
    expect(send.mock.calls[0][0] as string).toContain("⏱ 集中于");
    expect(send.mock.calls[0][0] as string).not.toContain("窗口仅覆盖");

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

  it("stores the token fields the alert_outcomes validation loop needs in the payload", async () => {
    const db = openDb(":memory:");
    await runConsensusCycle(deps(db));
    const row = db
      .prepare("SELECT payload FROM alerts WHERE type = 'consensus'")
      .get() as { payload: string };
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    expect(p.asset).toBe("asset1");
    expect(p.outcomeIndex).toBe(0);
    expect(typeof p.avgBuyPrice).toBe("number");
    expect(typeof p.lastTs).toBe("number");
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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchWindow = vi.fn();
    const fired = await runConsensusCycle(
      deps(db, { getSmart: () => new Map(), fetchWindow }),
    );
    expect(fired).toBe(0);
    expect(fetchWindow).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("warns about an empty whitelist at most once an hour", async () => {
    const db = openDb(":memory:");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Far beyond any nowSec earlier tests used, so the module-level rate-limit
    // state can't mask the first warn.
    const base = 4_000_000_000;
    const empty = (nowSec: number) =>
      deps(db, { getSmart: () => new Map(), nowSec });
    await runConsensusCycle(empty(base));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("whitelist empty");
    // Within the hour: silent (the 5-min cadence must not spam the logs).
    await runConsensusCycle(empty(base + 600));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Past the hour: warns again.
    await runConsensusCycle(empty(base + 3601));
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("logs window coverage and the qualified-wallet min-fill distribution (pushes untouched)", async () => {
    const db = openDb(":memory:");
    const send = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nowSec = 100_000;
    // Truncated fetch that only reached back 3h of the requested 6h window.
    const fired = await runConsensusCycle(
      deps(db, {
        send,
        nowSec,
        windowSec: 6 * 3600,
        fetchWindow: async () => ({
          trades: [
            mk({ proxyWallet: "0xA", transactionHash: "0x1" }), // $10k BUY
            // 0xA's smaller second fill → its min single fill is $6k.
            mk({
              proxyWallet: "0xA",
              transactionHash: "0x1b",
              size: 12000,
              price: 0.5,
            }),
            mk({ proxyWallet: "0xB", transactionHash: "0x2" }),
          ],
          truncated: true,
          effectiveSinceSec: nowSec - 3 * 3600,
        }),
      }),
    );
    expect(fired).toBe(1);
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("coverage 3.0h/6.0h (50%)"))).toBe(
      true,
    );
    expect(
      lines.some((l) =>
        l.includes("qualified-wallet min single fill USD: [6000, 10000]"),
      ),
    ).toBe(true);
    // The truncated window is no longer a logs-only secret: the push itself
    // carries the honest lower-bound note (effectiveSinceSec passed through).
    expect(send.mock.calls[0][0] as string).toContain(
      "⚠️ 窗口仅覆盖 ~3.0h/6h，共识金额为下界",
    );
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("omits the coverage line when fetchWindow reports no effectiveSinceSec (legacy shape)", async () => {
    const db = openDb(":memory:");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runConsensusCycle(deps(db, { nowSec: 200_000 }));
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("coverage"))).toBe(false);
    logSpy.mockRestore();
  });

  it("claim lock: a group recently claimed by another process is not double-pushed", async () => {
    const db = openDb(":memory:");
    const send = vi.fn().mockResolvedValue(undefined);
    // The other process claimed this exact formation moments ago (its alerts
    // row is RECENT — well within the state TTL).
    db.prepare(
      "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES (?, ?, ?, ?)",
    ).run("consensus", "consensus:0xc:Yes:2", "{}", 9_990);

    const fired = await runConsensusCycle(deps(db, { send }));
    expect(fired).toBe(0);
    expect(send).not.toHaveBeenCalled();
    // State stays untouched — the claiming process owns the update.
    const state = db
      .prepare("SELECT COUNT(*) AS c FROM consensus_state")
      .get() as { c: number };
    expect(state.c).toBe(0);
  });

  it("rolls the alerts claim back when send fails, so the group retries", async () => {
    const db = openDb(":memory:");
    const failingSend = vi.fn().mockRejectedValue(new Error("telegram down"));

    await expect(
      runConsensusCycle(deps(db, { send: failingSend })),
    ).rejects.toThrow("telegram down");
    // Claim rolled back: no alerts row, no state row.
    const alerts = db.prepare("SELECT COUNT(*) AS c FROM alerts").get() as {
      c: number;
    };
    expect(alerts.c).toBe(0);
    const state = db
      .prepare("SELECT COUNT(*) AS c FROM consensus_state")
      .get() as { c: number };
    expect(state.c).toBe(0);

    // Next cycle with a healthy send delivers exactly once.
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await runConsensusCycle(deps(db, { send, nowSec: 10_100 }))).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a PERMANENT send failure keeps the claim + state so the group can't jam the loop", async () => {
    const db = openDb(":memory:");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const poisonSend = vi
      .fn()
      .mockRejectedValue(new TelegramPermanentError("tg 400"));

    // No throw; the formation is claimed, state written, counted as fired.
    expect(await runConsensusCycle(deps(db, { send: poisonSend }))).toBe(1);
    const alerts = db.prepare("SELECT COUNT(*) AS c FROM alerts").get() as {
      c: number;
    };
    expect(alerts.c).toBe(1);
    const state = db
      .prepare("SELECT COUNT(*) AS c FROM consensus_state")
      .get() as { c: number };
    expect(state.c).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("permanent send failure"),
      expect.anything(),
    );

    // Next cycle: same group is old news — no re-push (unlike transient).
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await runConsensusCycle(deps(db, { send, nowSec: 10_100 }))).toBe(0);
    expect(send).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("formatConsensusAlert", () => {
  const group = (overA: Partial<Trade> = {}, overB: Partial<Trade> = {}) => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1", ...overA }),
      mk({ proxyWallet: "0xB", transactionHash: "0x2", ...overB }),
    ];
    const [g] = detectConsensus(trades, smartSet("0xA", "0xB"), {
      minWallets: 2,
      minPerWalletUsd: 5000,
    });
    return g;
  };

  it("escapes HTML and lists the top wallets", () => {
    const g = group({ title: "A <b>&</b> B" }, { title: "A <b>&</b> B" });
    const html = formatConsensusAlert(g);
    expect(html).toContain("A &lt;b&gt;&amp;&lt;/b&gt; B");
    expect(html).toContain("2 个白名单钱包");
    expect(html).toContain("polymarket.com/profile/0xa");
  });

  it("bolds the total, prints prices in ¢, and credentials wallets with 评分·胜率", () => {
    const html = formatConsensusAlert(group(), { nowSec: 1060 });
    expect(html).toContain("合计净买入 <b>$20,000</b> · 均价 50¢");
    // smartSet's tag: score 80, winRate 0.7 — both ride the wallet line.
    expect(html).toContain("净买 $10,000 @50¢ (评分80·胜率70%)");
  });

  it("appends the time-span line computed from firstTs/lastTs (<60min in minutes)", () => {
    const g = group({ timestamp: 1000 }, { timestamp: 1900 });
    const html = formatConsensusAlert(g, { nowSec: 2080 });
    expect(html).toContain("⏱ 集中于 15 分钟内 · 最近一笔 3 分钟前");
  });

  it("switches the span to hours for a spread-out group", () => {
    const g = group({ timestamp: 1000 }, { timestamp: 1000 + 12600 }); // 3.5h apart
    const html = formatConsensusAlert(g, { nowSec: 1000 + 12600 + 120 });
    expect(html).toContain("⏱ 集中于 3.5 小时内 · 最近一笔 2 分钟前");
  });

  it("appends the coverage caveat only when a truncated window's coverage is passed", () => {
    const g = group();
    const withNote = formatConsensusAlert(g, {
      nowSec: 2000,
      coverage: { coveredSec: 1.5 * 3600, windowSec: 6 * 3600 },
    });
    expect(withNote).toContain("⚠️ 窗口仅覆盖 ~1.5h/6h，共识金额为下界");
    expect(formatConsensusAlert(g, { nowSec: 2000 })).not.toContain(
      "窗口仅覆盖",
    );
  });
});
