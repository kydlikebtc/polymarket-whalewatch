import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { getWalletTagsBatch, getWalletTags } from "./walletTags";
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
  note: "n",
});

describe("getWalletTagsBatch", () => {
  it("derives status, source, and channel tags from the existing tables", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO smart_wallets (address, source, is_whitelist) VALUES
       ('0xboard', 'leaderboard', 0),
       ('0xspec', 'category:tech', 0),
       ('0xdisc', 'discovered:splitter', 0),
       ('0xmanual', NULL, 1)`,
    ).run();
    db.prepare(
      "INSERT INTO wallet_stats (wallet, markets_traded, fetched_at) VALUES ('0xbot', 5000, 1)",
    ).run();
    recordEvidence(
      db,
      [
        ev("0xcand", "echo", "0xm1", 900),
        ev("0xcand", "echo", "0xm2", 950),
        ev("0xcand", "early_winner", "0xm3", 900),
      ],
      1_000,
    );

    const tags = getWalletTagsBatch(
      db,
      ["0xboard", "0xSPEC", "0xdisc", "0xmanual", "0xbot", "0xcand", "0xnone"],
      1_000,
    );
    expect(tags.get("0xboard")!.map((t) => t.key)).toEqual(["src:leaderboard"]);
    expect(tags.get("0xspec")![0]).toMatchObject({
      key: "src:category:tech",
      label: "🏅 分类榜·tech",
      kind: "source",
    });
    expect(tags.get("0xdisc")![0].label).toContain("发现入池·拆单建仓");
    expect(tags.get("0xmanual")!.map((t) => t.key)).toEqual(["whitelist"]);
    expect(tags.get("0xbot")![0]).toMatchObject({ key: "bot", kind: "status" });
    // Channel tags sorted by breadth, with distinct-market counts.
    expect(tags.get("0xcand")!.map((t) => t.key)).toEqual([
      "ch:echo",
      "ch:early_winner",
    ]);
    expect(tags.get("0xcand")![0].count).toBe(2);
    expect(tags.get("0xnone")).toEqual([]);
  });

  it("ignores evidence outside the 30-day window and stacks bot+pool tags", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO smart_wallets (address, source, is_whitelist) VALUES ('0xw', 'leaderboard', 1)",
    ).run();
    db.prepare(
      "INSERT INTO wallet_stats (wallet, markets_traded, fetched_at) VALUES ('0xw', 2000, 1)",
    ).run();
    recordEvidence(db, [ev("0xw", "echo", "0xm1", 1_000)], 1_000);
    const nowSec = 1_000 + 31 * 86_400;
    const tags = getWalletTags(db, "0xw", nowSec);
    // bot (unshifted first) + whitelist + source; the stale channel tag gone.
    expect(tags.map((t) => t.key)).toEqual([
      "bot",
      "whitelist",
      "src:leaderboard",
    ]);
  });
});
