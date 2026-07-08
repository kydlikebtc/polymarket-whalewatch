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
    expect(v.candidates.find((c) => c.address === "0xdone")?.status).toBe(
      "admitted",
    );
    expect(v.candidates.find((c) => c.address === "0xbot")?.status).toBe("bot");

    // Program output: discovered + category rows, NOT the global-board row.
    expect(v.admitted.map((a) => a.address)).toEqual(["0xdone", "0xspec"]);
    expect(v.counts).toEqual({
      evidenceRows: 5,
      candidateWallets: 3,
      admitted: 2,
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
