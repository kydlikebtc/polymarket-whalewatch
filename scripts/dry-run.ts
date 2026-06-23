// End-to-end smoke test of the live pipeline WITHOUT Telegram.
// Replaces the Telegram send with console output, hits the real public
// data-api.polymarket.com feed, and exercises fetch -> validate -> select ->
// tier -> format -> sqlite dedup. Run: `npx tsx scripts/dry-run.ts`
import { openDb } from "../lib/db";
import { getLargeTrades } from "../lib/polymarket";
import { runOnce } from "../worker/runOnce";
import { notionalUsd } from "../lib/trades";

const THRESHOLDS = [10_000, 50_000];
const DB_PATH = "dry-run.sqlite";
const PRINT_LIMIT = 5;

async function main() {
  const db = openDb(DB_PATH);
  db.exec("DELETE FROM seen_trades; DELETE FROM alerts;"); // clean slate each run

  // 1. Live fetch + schema validation (a warning here = our Trade schema drifted from the API).
  const snapshot = await getLargeTrades(THRESHOLDS[0]);
  console.log(
    `fetched ${snapshot.length} trades >= $${THRESHOLDS[0].toLocaleString()}`,
  );
  if (snapshot.length > 0) {
    const newest = snapshot[0];
    const ageSec = Math.round(Date.now() / 1000 - newest.timestamp);
    console.log(
      `newest trade: age ${ageSec}s · $${Math.round(notionalUsd(newest)).toLocaleString()} · ${newest.side} · ${newest.title} / ${newest.outcome}`,
    );
  }

  let alerted = 0;
  const send = async (html: string) => {
    alerted++;
    if (alerted <= PRINT_LIMIT) console.log("\n" + html);
  };
  const fetchTrades = async () => snapshot; // same snapshot for both runs to isolate dedup

  console.log("\n--- run 1 (fresh: should alert) ---");
  await runOnce({ db, send, fetchTrades, thresholds: THRESHOLDS });
  const after1 = alerted;
  if (after1 > PRINT_LIMIT) console.log(`\n…and ${after1 - PRINT_LIMIT} more`);
  console.log(`run 1 alerted: ${after1}`);

  console.log("\n--- run 2 (same snapshot: dedup should yield 0 new) ---");
  await runOnce({ db, send, fetchTrades, thresholds: THRESHOLDS });
  console.log(`run 2 newly alerted: ${alerted - after1}`);

  const seen = db.prepare("SELECT COUNT(*) AS c FROM seen_trades").get() as {
    c: number;
  };
  const alerts = db.prepare("SELECT COUNT(*) AS c FROM alerts").get() as {
    c: number;
  };
  console.log(`\nsqlite: seen_trades=${seen.c} alerts=${alerts.c}`);
  console.log(
    seen.c === after1 && alerted - after1 === 0
      ? "\n✅ dedup + persistence verified"
      : "\n❌ unexpected counts",
  );
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
