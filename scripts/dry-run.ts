// End-to-end smoke test of the live pipeline WITHOUT Telegram, mirroring the
// worker's real cold-start behavior. Hits the public data-api.polymarket.com
// feed and exercises fetch -> validate -> cold-start seed -> select -> tier ->
// format -> sqlite dedup. Run: `npx tsx scripts/dry-run.ts`
import { openDb } from "../lib/db";
import { getLargeTrades } from "../lib/polymarket";
import { runOnce, seedSeen } from "../worker/runOnce";
import { notionalUsd } from "../lib/trades";

const THRESHOLDS = [10_000, 50_000];
const DB_PATH = "dry-run.sqlite";

async function main() {
  const db = openDb(DB_PATH);
  db.exec("DELETE FROM seen_trades; DELETE FROM alerts;"); // simulate a fresh/cold db

  // 1. Live fetch + schema validation (a warning here = our Trade schema drifted from the API).
  const snapshot = await getLargeTrades(THRESHOLDS[0]);
  console.log(
    `fetched ${snapshot.length} live trades >= $${THRESHOLDS[0].toLocaleString()}`,
  );
  if (snapshot.length === 0) {
    console.log("no trades to demo right now");
    db.close();
    return;
  }
  const newest = snapshot[0];
  const ageSec = Math.round(Date.now() / 1000 - newest.timestamp);
  console.log(
    `newest: age ${ageSec}s · $${Math.round(notionalUsd(newest)).toLocaleString()} · ${newest.side} · ${newest.title} / ${newest.outcome}`,
  );

  let alerted = 0;
  const send = async (html: string) => {
    alerted++;
    console.log("\n" + html);
  };

  // 2. Cold start: seed the backlog silently (no alerts) — the production behavior.
  const seeded = await seedSeen({ db, fetchTrades: async () => snapshot });
  console.log(`\ncold start: seeded ${seeded} trades silently (no alert)`);

  // 3. Poll the same backlog: all seen → zero alerts (no startup storm).
  await runOnce({
    db,
    send,
    fetchTrades: async () => snapshot,
    thresholds: THRESHOLDS,
  });
  console.log(`backlog poll alerted: ${alerted} (expect 0)`);

  // 4. A genuinely new large trade arrives → exactly one fully-formatted alert.
  const fresh = {
    ...newest,
    transactionHash: "0xDRYRUNNEWTRADE",
    timestamp: Math.floor(Date.now() / 1000),
  };
  await runOnce({
    db,
    send,
    fetchTrades: async () => [fresh],
    thresholds: THRESHOLDS,
  });
  console.log(`\nnew-trade poll alerted: ${alerted} (expect 1)`);

  const seen = db.prepare("SELECT COUNT(*) AS c FROM seen_trades").get() as {
    c: number;
  };
  const alerts = db.prepare("SELECT COUNT(*) AS c FROM alerts").get() as {
    c: number;
  };
  console.log(`\nsqlite: seen_trades=${seen.c} alerts=${alerts.c}`);
  const ok = alerted === 1 && alerts.c === 1 && seen.c === seeded + 1;
  console.log(
    ok
      ? "\n✅ cold-start seed + alert-only-new + persistence verified"
      : "\n❌ unexpected counts",
  );
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
