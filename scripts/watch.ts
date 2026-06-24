// Live console monitor — runs the real worker pipeline (cold-start seed + poll
// loop + runOnce) but prints alerts to the console instead of Telegram, so it
// needs NO credentials. Watches for NEW large trades in real time.
// Run forever:        npx tsx scripts/watch.ts
// Bounded demo (75s): WATCH_SECONDS=75 npx tsx scripts/watch.ts
// Stop after first hit (+30m safety cap): STOP_AFTER=1 WATCH_SECONDS=1800 npx tsx scripts/watch.ts
import { openDb } from "../lib/db";
import { getLargeTrades } from "../lib/polymarket";
import { runOnce, seedSeen } from "../worker/runOnce";

const THRESHOLDS = (process.env.LARGE_THRESHOLDS ?? "10000,50000")
  .split(",")
  .map(Number)
  .sort((a, b) => a - b);
const INTERVAL = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const WATCH_SECONDS = Number(process.env.WATCH_SECONDS ?? 0);
const STOP_AFTER = Number(process.env.STOP_AFTER ?? 0);
const DB_PATH = process.env.WATCH_DB ?? "watch.sqlite";

const db = openDb(DB_PATH);
const fetchTrades = () => getLargeTrades(THRESHOLDS[0]);

// Render the Telegram HTML alert as readable console text.
const toConsole = (html: string) =>
  html
    .replace(/<a href="([^"]+)">([^<]+)<\/a>/g, "$2 ($1)")
    .replace(/<\/?b>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

let total = 0;
const send = async (html: string) => {
  total++;
  console.log("\n" + toConsole(html));
};

const ts = () => new Date().toISOString().slice(11, 19);
let polls = 0;

async function loop() {
  const before = total;
  try {
    await runOnce({ db, send, fetchTrades, thresholds: THRESHOLDS });
  } catch (e) {
    console.error(`[${ts()}] poll error`, e);
  }
  polls++;
  const fresh = total - before;
  if (fresh > 0)
    console.log(
      `[${ts()}] poll #${polls} · ${fresh} new · ${total} since start`,
    );
  else if (polls % 6 === 0)
    console.log(
      `[${ts()}] poll #${polls} · watching ≥ $${THRESHOLDS[0].toLocaleString()} … (${total} so far)`,
    );
  if (STOP_AFTER > 0 && total >= STOP_AFTER) {
    console.log(
      `\n[watch] caught ${total} large trade(s) (STOP_AFTER=${STOP_AFTER}) — stopping.`,
    );
    db.close();
    return process.exit(0);
  }
  setTimeout(loop, INTERVAL);
}

async function start() {
  console.log(
    `[watch] thresholds=[${THRESHOLDS}] interval=${INTERVAL}ms db=${DB_PATH}`,
  );
  const seen = (
    db.prepare("SELECT COUNT(*) AS c FROM seen_trades").get() as { c: number }
  ).c;
  if (seen === 0) {
    const n = await seedSeen({ db, fetchTrades });
    console.log(
      `[watch] cold start: seeded ${n} existing trades silently. now watching for NEW large trades…`,
    );
  } else {
    console.log(`[watch] resuming with ${seen} trades already seen`);
  }
  if (WATCH_SECONDS > 0) {
    setTimeout(() => {
      console.log(
        `\n[watch] ${WATCH_SECONDS}s window elapsed — ${total} new large trade(s) caught. stopping.`,
      );
      db.close();
      process.exit(0);
    }, WATCH_SECONDS * 1000);
  }
  loop();
}

process.on("unhandledRejection", (e) =>
  console.error("[watch] unhandledRejection", e),
);
start().catch((e) => {
  console.error("[watch] start failed", e);
  process.exit(1);
});
