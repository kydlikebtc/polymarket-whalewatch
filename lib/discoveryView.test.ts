import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { buildDiscoveryView } from "./discoveryView";
import { recordEvidence, type CandidateEvidence } from "./discovery";

const ev = (
  address: string,
  channel: CandidateEvidence["channel"],
  conditionId: string,
  ts = 1_000,
): CandidateEvidence => ({
  address,
  channel,
  conditionId,
  ts,
  usd: 6_000,
  price: 0.5,
  note: `note-${channel}-${conditionId}`,
});

describe("buildDiscoveryView", () => {
  it("aggregates evidence per wallet, derives status, and lists program output", () => {
    const db = openDb(":memory:");
    recordEvidence(
      db,
      [
        ev("0xcand", "echo", "0xm1", 100),
        ev("0xcand", "echo", "0xm2", 200),
        ev("0xcand", "splitter", "0xm1", 300), // same market, second channel: counts again
        ev("0xdone", "early_winner", "0xm9", 400),
        ev("0xbot", "insider", "0xm5", 500),
      ],
      1_000,
    );
    // 0xdone graduated; a category specialist exists with no evidence rows.
    db.prepare(
      `INSERT INTO smart_wallets (address, score, win_rate, realized_pnl, updated_at, source)
       VALUES ('0xdone', 61, 0.6, 12000, 900, 'discovered:early_winner'),
              ('0xspec', 22, NULL, NULL, 800, 'category:politics'),
              ('0xboard', 90, 0.7, 900000, 700, 'leaderboard')`,
    ).run();
    // 0xbot is a classified market maker.
    db.prepare(
      "INSERT INTO wallet_stats (wallet, markets_traded, fetched_at) VALUES ('0xbot', 5000, 900)",
    ).run();

    const v = buildDiscoveryView(db, 2_000);

    const cand = v.candidates.find((c) => c.address === "0xcand");
    expect(cand?.status).toBe("candidate");
    expect(cand?.totalMarkets).toBe(3); // echo 2 + splitter 1
    expect(cand?.channels[0]).toEqual({ channel: "echo", markets: 2 });
    expect(cand?.latestNote).toBe("note-splitter-0xm1"); // newest evidence_ts wins
    // Pool members never appear in the funnel — they graduated to `members`
    // and their evidence rides along there.
    expect(v.candidates.find((c) => c.address === "0xdone")).toBeUndefined();
    expect(v.candidates.find((c) => c.address === "0xbot")?.status).toBe("bot");

    // Per-row derived tags + full evidence detail (newest first).
    expect(cand?.tags.map((t) => t.key)).toEqual(["ch:echo", "ch:splitter"]);
    expect(cand?.evidence).toHaveLength(3);
    expect(cand?.evidence[0].note).toBe("note-splitter-0xm1");
    const bot = v.candidates.find((c) => c.address === "0xbot");
    expect(bot?.tags.some((t) => t.key === "bot")).toBe(true);

    // The pool in FULL — global-board members included, score-desc ordering.
    expect(v.members.map((m) => m.address)).toEqual([
      "0xboard", // score 90
      "0xdone", // score 61
      "0xspec", // score 22
    ]);
    const done = v.members.find((m) => m.address === "0xdone")!;
    expect(done.tags.some((t) => t.key === "src:discovered:early_winner")).toBe(
      true,
    );
    // Upstream funnel evidence rides along on the member row.
    expect(done.evidence).toHaveLength(1);
    expect(done.evidence[0].channel).toBe("early_winner");
    const board = v.members.find((m) => m.address === "0xboard")!;
    expect(board.tags.some((t) => t.key === "src:leaderboard")).toBe(true);
    expect(board.evidence).toHaveLength(0);
    expect(v.counts).toEqual({
      evidenceRows: 5,
      candidateWallets: 2, // 0xcand + 0xbot — 0xdone counts in the pool, not the funnel
      poolTotal: 3,
      poolGlobal: 1,
      poolDiscovery: 2,
    });
  });

  it("ignores evidence outside the 30-day window", () => {
    const db = openDb(":memory:");
    recordEvidence(db, [ev("0xold", "echo", "0xm1")], 1_000);
    const v = buildDiscoveryView(db, 1_000 + 31 * 86_400);
    expect(v.candidates).toHaveLength(0);
    expect(v.counts.evidenceRows).toBe(0);
  });
});
