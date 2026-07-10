import { parseConfig } from "../lib/config";
import { openDb, type DB } from "../lib/db";
import { getLargeTrades, getTradesWindowDeep } from "../lib/polymarket";
import { maybePruneSeen, seenKeySet } from "../lib/seen";
import { dedupKey } from "../lib/trades";
import { sendMessage } from "../lib/telegram";
import { getWalletAges } from "../lib/walletAge";
import { getAlertConditions } from "../lib/alertConditions";
import { runAlertCycle } from "../lib/alertEngine";
import {
  getAllSmartTags,
  getSmartTags,
  isSeedInFlight,
  maybeDailySeed,
} from "../lib/smartWallets";
import { LEADERBOARD_CATEGORIES } from "../lib/leaderboard";
import { getMarketMeta } from "../lib/gamma";
import { runConsensusCycle } from "../lib/consensus";
import {
  backfillEvidenceMarketContext,
  collectFirehoseEvidence,
} from "../lib/discovery";
import { maybeDailyDiscovery } from "../lib/admission";
import { wrapSendWithHealth } from "../lib/telegramHealth";

// Guarded singleton PER PROCESS: instrumentation may call this more than once
// within a runtime, and the flag makes repeat calls no-ops. It does NOT guard
// across processes — running the Next app AND `npm run worker` concurrently
// gives two engines on the same db. Alert rows stay deduped (unique
// (type, dedup_key) index + INSERT OR IGNORE) and Telegram pushes are
// claim-locked (claim-then-send in runAlertCycle / runConsensusCycle), so the
// two-process setup no longer double-pushes — only consensus TTL reminders can
// still rarely overlap; prefer running one or the other regardless.
let started = false;

const SECONDS_PER_DAY = 86400;

// Startup backfill cap: on restart we resume from the last seen trade, but
// never further back than this — a long-dead engine must not replay hours of
// history (the single /trades page wouldn't reach much deeper anyway).
const BACKFILL_CAP_SEC = 30 * 60;

// Startup connectivity ping (opt-in via TELEGRAM_STARTUP_PING, default off):
// same "monitor online" idea as scripts/test-telegram, pushed through the
// health-wrapped send so a failed ping immediately lands in the telegramHealth
// counters. Fire-and-forget — must never delay the first poll cycle.
export const STARTUP_PING_HTML =
  "🟢 Polymarket 监控已上线 · Telegram 推送通道连通性验证";

export function maybeStartupPing(
  send: ((html: string) => Promise<void>) | undefined,
  enabled: boolean,
): void {
  if (!send || !enabled) return;
  send(STARTUP_PING_HTML).then(
    () => console.log("[engine] startup ping sent — Telegram channel OK"),
    (e) =>
      console.error(
        "[engine] startup ping FAILED — check TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID / bot channel permission:",
        e,
      ),
  );
}

// Startup replay boundary. Resume from the newest seen_trades.ts so a restart/
// deploy gap is backfilled instead of becoming a permanent blind window;
// clamped to [now - capSec, now] (cap long outages, ignore future ts from
// clock skew). A cold db (no seen rows) starts at "now" — no historical storm.
export function computeMinTimestamp(
  maxSeenTs: number | null,
  nowSec: number,
  capSec: number,
): number {
  if (maxSeenTs == null) return nowSec;
  return Math.min(nowSec, Math.max(maxSeenTs, nowSec - capSec));
}

/**
 * Start the continuously-running alert engine.
 *
 * - Writes to the SAME SQLite file the dashboard reads (openDb default
 *   `data.sqlite`, overridable via DASH_DB so engine + dashboard always agree).
 * - Telegram is OPTIONAL: push only when both creds are set (telegramEnabled);
 *   otherwise matches are still recorded to the `alerts` table.
 * - minTimestamp resumes from MAX(seen_trades.ts) capped at BACKFILL_CAP_SEC
 *   (see computeMinTimestamp): restart gaps are backfilled, deep history and
 *   cold-db starts are not replayed.
 * - Reads conditions fresh from the `config` table every cycle, so dashboard
 *   edits take effect on the next poll.
 */
export function startAlertEngine(): void {
  if (started) return;
  started = true;

  const cfg = parseConfig(process.env);
  const dbPath = process.env.DASH_DB || "data.sqlite";
  const db: DB = openDb(dbPath);
  const creds = {
    botToken: cfg.telegramBotToken,
    chatId: cfg.telegramChannelId,
  };
  const rawSend = cfg.telegramEnabled
    ? (html: string) => sendMessage(creds, html)
    : undefined;
  // Health-instrumented send, shared by the alert AND consensus loops:
  // consecutive-failure counters land in the config table (surfaced by
  // /api/alerts → alerts-page callout) and a rate-limited self-diagnostic
  // pushes after the threshold — see lib/telegramHealth. Errors rethrow
  // unchanged, so claim-rollback / poison semantics are untouched.
  const send = rawSend ? wrapSendWithHealth(db, rawSend) : undefined;
  // Backfill window: resume from the last seen trade (bounded by the cap) so a
  // restart/deploy gap no longer permanently swallows the trades that landed
  // during the downtime. The pre-window backlog is seeded as seen by the first
  // runAlertCycle, so the window only ever replays forward.
  const nowStartSec = Math.floor(Date.now() / 1000);
  const maxSeenTs = (
    db.prepare("SELECT MAX(ts) AS ts FROM seen_trades").get() as {
      ts: number | null;
    }
  ).ts;
  const minTimestamp = computeMinTimestamp(
    maxSeenTs,
    nowStartSec,
    BACKFILL_CAP_SEC,
  );
  console.log(
    `[engine] backfill window ${((nowStartSec - minTimestamp) / 60).toFixed(1)} min` +
      ` (maxSeenTs=${maxSeenTs ?? "none — cold db"}, minTimestamp=${minTimestamp}, cap=${BACKFILL_CAP_SEC / 60}min)`,
  );

  // walletAge.getWalletAges returns firstActivityTs (unix sec) | null per
  // wallet, with FAILED lookups ABSENT from the map. The engine needs ageDays,
  // so convert here; absent wallets stay absent (Object.entries skips them) so
  // runAlertCycle can defer those trades instead of dropping them for good.
  const getAges = async (
    wallets: string[],
  ): Promise<Record<string, number | null>> => {
    const firstTsByWallet = await getWalletAges(db, wallets);
    const now = Math.floor(Date.now() / 1000);
    const out: Record<string, number | null> = {};
    for (const [w, firstTs] of Object.entries(firstTsByWallet)) {
      out[w] =
        typeof firstTs === "number" ? (now - firstTs) / SECONDS_PER_DAY : null;
    }
    return out;
  };

  // Fetch at a SAFE floor, not the raw configured minUsd: the Data API's
  // server-side filterAmount is fast when matches are DENSE (low threshold) but
  // the origin times out (~5.75s → 408) when they're SPARSE (high threshold,
  // scanning deep history to fill a page). So we fetch at min(minUsd, SAFE_FLOOR)
  // — a superset of any higher configured minUsd — and let runAlertCycle apply
  // the exact (higher) minUsd in memory. The floor never EXCEEDS minUsd, so a
  // low-threshold config (e.g. $500) still sees its trades.
  const SAFE_FLOOR = 10_000;
  // Steady-state page size, downshifted from the old single 1000-row page: on
  // a 4s cadence the page is overwhelmingly already-seen rows, so 250 cuts
  // ~75% of the per-cycle bandwidth/parse cost. A genuinely hot cycle (a full
  // page of entirely-unseen in-window rows) tops up with offset pages back to
  // the old 1000-row depth instead of silently dropping the overflow.
  const POLL_PAGE_LIMIT = 250;
  const POLL_MAX_PAGES = 4; // 4 × 250 = the previous single-page depth
  // `conditions` is read fresh each cycle, so fetchTrades must take the floor as
  // an argument rather than closing over a startup value.
  const fetchTrades = (minUsd: number) =>
    getLargeTrades(Math.min(minUsd, SAFE_FLOOR), POLL_PAGE_LIMIT, {
      // Stop paginating at the startup backfill boundary — deeper rows are
      // pre-window backlog runAlertCycle would drop anyway.
      sinceSec: minTimestamp,
      maxPages: POLL_MAX_PAGES,
      // Batched seen probe, one indexed IN(...) query per full page (the
      // all-time feed always fills page 0, so this runs ~once per cycle —
      // sub-ms): once a page touches already-processed trades, deeper pages
      // are old news and the top-up stops.
      hasSeenAny: (rows) =>
        seenKeySet(
          db,
          rows.map((t) => dedupKey(t)),
        ).size > 0,
    });

  console.log(
    `[engine] starting · db=${dbPath} · telegram=${
      cfg.telegramEnabled ? "on" : "off (records to SQLite only)"
    } · interval=${cfg.pollIntervalMs}ms`,
  );

  maybeStartupPing(send, cfg.telegramStartupPing);

  async function loop() {
    try {
      // Daily (UTC) smart-wallet seeding from the official leaderboards —
      // global boards plus the six category boards (channel ③: specialists
      // the global top-100 structurally misses). Fire and forget: seeding can
      // take a while (per-wallet /closed-positions enrichment) and must never
      // delay the 4s alert cycle.
      maybeDailySeed(db, { categories: [...LEADERBOARD_CATEGORIES] })
        ?.then((r) =>
          console.log(
            `[engine] smart-wallet seed: ${r.seeded} wallets (${r.enriched} enriched)`,
          ),
        )
        .catch((e) => console.error("[engine] smart-wallet seed failed", e));

      // Daily (UTC) discovery run: the early-winner settled-market sweep
      // (channel ②) followed by the admission gate that graduates recurrent,
      // quality-checked candidates into the pool. Same fire-and-forget
      // posture as seeding, but SERIALIZED behind it: both gates open on the
      // same UTC-midnight tick, and stacking the seed's enrichment fan-out
      // with the settled-market sweep would slam data-api's rate budget while
      // the 4s alert loop shares it. Discovery starts on the first tick after
      // the seed lands.
      if (!isSeedInFlight()) {
        maybeDailyDiscovery(db)
          ?.then((r) =>
            console.log(
              `[engine] discovery: ${r.scan.scanned} settled market(s) swept · ` +
                `${r.admission.admitted} admitted / ${r.admission.evaluated} evaluated`,
            ),
          )
          .catch((e) => console.error("[engine] discovery run failed", e));
      }

      // Daily seen_trades retention prune (synchronous, day-gated, sub-ms on
      // the steady-state table): the dedup ledger otherwise grows without
      // bound and every seenKeySet IN(...) probe and startup MAX(ts) scan
      // pays for it. 7d retention dwarfs every fetch window (see
      // maybePruneSeen), so this can never resurrect a duplicate alert.
      maybePruneSeen(db);

      const conditions = getAlertConditions(db);
      const fired = await runAlertCycle({
        db,
        fetchTrades: () => fetchTrades(conditions.minUsd),
        conditions,
        getAges,
        getSmart: (wallets) => getSmartTags(db, wallets),
        getMarketMeta: (conditionIds) => getMarketMeta(db, conditionIds),
        send,
        minTimestamp,
      });
      if (fired > 0) console.log(`[engine] cycle fired ${fired} alert(s)`);
    } catch (e) {
      console.error("[engine] cycle error", e);
    }
    setTimeout(loop, cfg.pollIntervalMs);
  }

  loop();

  // --- Smart-money consensus loop ---------------------------------------
  // Every 5 minutes: pull a 6h window at a $2k floor and alert when >=2
  // whitelist wallets have each net-bought >=$5k of the SAME outcome. Runs on
  // its own cadence because the window fetch (up to 20 pages) is far heavier
  // than the 4s tick; state-table dedup means only formations/escalations push.
  const CONSENSUS_INTERVAL_MS = 5 * 60_000;
  const CONSENSUS_WINDOW_SEC = 6 * 3600;
  const CONSENSUS_FLOOR_USD = 2000;

  async function consensusLoop() {
    try {
      // ONE deep window fetch per cycle, shared by consensus detection and
      // the firehose discovery pass — the discovery channels ride the fetch
      // the consensus loop was already paying for.
      const win = await getTradesWindowDeep({
        minUsd: CONSENSUS_FLOOR_USD,
        sinceSec: Math.floor(Date.now() / 1000) - CONSENSUS_WINDOW_SEC,
      });
      const smart = getAllSmartTags(db);
      const fired = await runConsensusCycle({
        db,
        fetchWindow: async () => win,
        getSmart: () => smart,
        send,
        // Coverage-log denominator: fetchWindow's effectiveSinceSec is
        // measured against this requested window.
        windowSec: CONSENSUS_WINDOW_SEC,
      });
      if (fired > 0) {
        console.log(`[engine] consensus cycle fired ${fired} alert(s)`);
      }
      // Channel ① (echo / splitter / insider) over the same window. Fire and
      // forget: a discovery failure must never disturb the consensus cadence.
      collectFirehoseEvidence(db, win.trades, smart).catch((e) =>
        console.error("[discovery] firehose collection failed", e),
      );
    } catch (e) {
      console.error("[engine] consensus cycle error", e);
    }
    setTimeout(consensusLoop, CONSENSUS_INTERVAL_MS);
  }

  // First pass shortly after start (gives the daily seed a head start on a
  // fresh install; an empty whitelist just skips the cycle).
  setTimeout(consensusLoop, 30_000);

  // --- Legacy-evidence market-context backfill ---------------------------
  // Evidence rows written before wallet_candidates gained title/slug/
  // event_slug can't all self-heal through the upsert (early_winner markets
  // are scanned exactly once; firehose rows only refresh when the behavior
  // recurs) — so heal them directly from gamma. One pass right after start
  // fixes the /discovery detail view within a minute of deploying the
  // migration; afterwards the pass is a free no-op (SELECT finds no NULL-title
  // rows), and the slow 6h cadence only serves gamma-transient retries.
  const BACKFILL_INTERVAL_MS = 6 * 3600_000;
  async function evidenceBackfillLoop() {
    try {
      await backfillEvidenceMarketContext(db);
    } catch (e) {
      console.error("[discovery] evidence market-context backfill failed", e);
    }
    setTimeout(evidenceBackfillLoop, BACKFILL_INTERVAL_MS);
  }
  setTimeout(evidenceBackfillLoop, 60_000);
}
