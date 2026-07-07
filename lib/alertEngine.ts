import type { DB } from "./db";
import type { Trade } from "./types";
import type { AlertConditions } from "./alertConditions";
import type { MarketMeta } from "./gamma";
import { tradeMarketContext } from "./gamma";
import { selectNewTrades } from "./poll";
import { dedupKey, notionalUsd } from "./trades";
import { formatLargeTradeAlert, type SmartTagLabel } from "./alert";
import { esc, usd } from "./tgFormat";
import { isPermanentSendError } from "./telegram";
import {
  markSeen,
  markSeenBatch,
  recordAlert,
  seenKeySet,
  unmarkSeen,
} from "./seen";

// A trade whose wallet-age lookup keeps FAILING is deferred (retried next
// cycle, not marked seen) for this many consecutive cycles before being given
// up with a warn — a persistent /activity outage must not pin the same trades
// in the retry path forever.
export const MAX_AGE_LOOKUP_CYCLES = 5;

// Telegram channel throttle: minimum gap between pushes inside one cycle
// (~18 msgs/min leaves margin under Telegram's ~20/min channel limit) and the
// per-cycle push cap. Pushes beyond the cap are folded into ONE summary
// message — every folded match is still recorded to `alerts`, so no detail is
// lost, only the individual push.
export const SEND_MIN_GAP_MS = 3200;
export const MAX_PUSHES_PER_CYCLE = 15;

// Cross-cycle retry ledger for the age-deferred path: dedupKey -> consecutive
// cycles the wallet-age lookup has failed. Module-level because runAlertCycle
// itself is stateless between cycles; injectable per-call for tests. Entries
// are removed on resolution or give-up, so the map stays tiny.
const defaultAgeRetries = new Map<string, number>();

export interface EngineDeps {
  db: DB;
  fetchTrades: () => Promise<Trade[]>;
  conditions: AlertConditions;
  // ageDays by lowercased wallet. Semantics: number = known age; null =
  // VERIFIED "no activity yet" (deterministic drop); ABSENT = the lookup
  // FAILED (trade is deferred and re-evaluated next cycle, see the age
  // filter). Only called when an age cap is set.
  getAges: (wallets: string[]) => Promise<Record<string, number | null>>;
  // Retry ledger for failed age lookups (see defaultAgeRetries above).
  ageRetries?: Map<string, number>;
  // Smart-wallet tags by lowercased wallet (sync SQLite lookup). Absent entries
  // mean "not smart". When the dep itself is undefined, no tagging happens and
  // smartOnly matches nothing (there is no whitelist to match against).
  // SmartTagLabel is the label-facing slice (score/winRate/netPnl) —
  // smartWallets.getSmartTags already returns a superset, zero extra queries.
  getSmart?: (wallets: string[]) => Record<string, SmartTagLabel | undefined>;
  // Batched, cached market metadata by conditionId (gamma). Powers the
  // maxHoursToEnd condition and the context line on fired alerts. Optional:
  // without it alerts fire un-enriched and maxHoursToEnd matches nothing.
  getMarketMeta?: (
    conditionIds: string[],
  ) => Promise<Record<string, MarketMeta>>;
  // Optional Telegram push; when undefined, matches are still recorded to SQLite.
  send?: (html: string) => Promise<void>;
  // Only consider trades with timestamp >= this (prevents replaying historical backlog).
  minTimestamp: number;
  // Injectable clock (unix sec) for hoursToEnd math; defaults to Date.now().
  nowSec?: number;
  // Push-throttle knobs (defaults SEND_MIN_GAP_MS / MAX_PUSHES_PER_CYCLE) and
  // an injectable sleep — tests override these to avoid real multi-second waits.
  sendMinGapMs?: number;
  maxPushesPerCycle?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One conditional matching cycle. Returns the number of alerts fired.
 *
 * Pipeline (cheap filters first, then the network-bound age filter):
 *  1. disabled → 0.
 *  2. fetch → drop already-seen (batched IN(...) check) → seed pre-window
 *     backlog (< minTimestamp) as seen ONCE instead of re-checking it forever.
 *  3. amount / side / price-band filters (pure, no I/O).
 *  4. age filter (only if maxAgeDays set): fetch ages for survivor wallets, keep
 *     wallets with a finite ageDays <= cap. Verified-empty (null) and older
 *     wallets are dropped; FAILED lookups (absent) are DEFERRED — excluded from
 *     this cycle and the seen sweep, retried next cycle, given up with a warn
 *     after MAX_AGE_LOOKUP_CYCLES consecutive failures.
 *  5. for each match (oldest-first): CLAIM via markSeen (cross-process lock),
 *     then push to Telegram; a TRANSIENT send failure (5xx/network/429
 *     exhausted) rolls the claim back and rethrows so the trade retries next
 *     cycle (at-least-once), while a PERMANENT failure (non-429 4xx even after
 *     the plain-text downgrade) KEEPS the claim and records without a push so
 *     a poison message can't jam the pipeline. A lost claim skips the push —
 *     the other process owns it. With a cooldown configured, repeat matches
 *     for the same (wallet, market) inside the window are recorded WITHOUT a
 *     push (the first push of a same-cycle burst carries a "共 N 笔" summary).
 *     Pushes are throttled (SEND_MIN_GAP_MS apart, at most MAX_PUSHES_PER_CYCLE
 *     per cycle); over-cap matches fold into one summary push.
 *  6. mark EVERY evaluated `fresh` trade seen (one transaction) so it isn't
 *     re-evaluated next cycle.
 *
 * NOTE: condition changes apply only to trades arriving AFTER the change — trades
 * already marked seen are never re-evaluated against new conditions.
 */
export async function runAlertCycle(deps: EngineDeps): Promise<number> {
  const {
    db,
    fetchTrades,
    conditions,
    getAges,
    ageRetries = defaultAgeRetries,
    getSmart,
    getMarketMeta,
    send,
    minTimestamp,
    nowSec = Math.floor(Date.now() / 1000),
    sendMinGapMs = SEND_MIN_GAP_MS,
    maxPushesPerCycle = MAX_PUSHES_PER_CYCLE,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  } = deps;

  if (!conditions.enabled) return 0;

  const fetched = await fetchTrades();
  // Batched seen check (one IN(...) query per ~900 keys instead of a point
  // query per row); selectNewTrades then drops seen rows and sorts oldest-first.
  const seenKeys = seenKeySet(
    db,
    fetched.map((t) => dedupKey(t)),
  );
  let fresh = selectNewTrades(fetched, (k) => seenKeys.has(k));
  // Timestamp gate: trades older than minTimestamp are historical backlog —
  // never alerted, but seeded as seen ONCE. Without the seed the same backlog
  // rows would be re-fetched and re-checked every cycle until they age out of
  // the /trades page.
  const backlog = fresh.filter((t) => t.timestamp < minTimestamp);
  fresh = fresh.filter((t) => t.timestamp >= minTimestamp);
  if (backlog.length > 0) {
    markSeenBatch(
      db,
      backlog.map((t) => ({ key: dedupKey(t), ts: t.timestamp })),
    );
    console.log(
      `[alertEngine] seeded ${backlog.length} pre-window trade(s) as seen (minTimestamp=${minTimestamp})`,
    );
  }

  const minPrice = conditions.minPrice ?? 0;
  const maxPrice = conditions.maxPrice ?? 1;

  // Cheap, pure filters first.
  let survivors = fresh.filter((t) => {
    if (notionalUsd(t) < conditions.minUsd) return false;
    if (conditions.side !== "ALL" && t.side !== conditions.side) return false;
    if (t.price < minPrice || t.price > maxPrice) return false;
    return true;
  });

  // Smart-wallet tagging (cheap sync SQLite lookup) — used both for the
  // smartOnly filter and for the 🏆 tag / type='smart' on fired alerts.
  const smartTags = getSmart
    ? getSmart([...new Set(survivors.map((t) => t.proxyWallet.toLowerCase()))])
    : {};
  if (conditions.smartOnly) {
    const evaluated = survivors.length;
    survivors = survivors.filter((t) => smartTags[t.proxyWallet.toLowerCase()]);
    // smartOnly's failure mode is SILENCE (empty whitelist, or thresholds
    // starving the whitelist∩large-trade intersection to zero), which looks
    // exactly like "no signal". Log the hit ratio whenever there were
    // candidates so the two cases are tellable apart from the engine logs.
    if (evaluated > 0) {
      console.log(
        `[alertEngine] smartOnly: ${survivors.length}/${evaluated} candidate trade(s) from whitelist wallets` +
          ` (whitelist-tagged wallets in batch: ${Object.keys(smartTags).length})`,
      );
    }
  }

  // Address-age filter (network-bound) — only when a cap is set and survivors
  // remain. maxAgeDays exists to catch NEW wallets, exactly the ones that are
  // always a cold-cache live /activity fetch — so a wallet ABSENT from `ages`
  // (lookup FAILED: timeout/5xx, walletAge leaves failures uncached and
  // unreported) must not be a permanent drop. Those trades are DEFERRED like
  // missing market meta below: excluded from this cycle AND from the markSeen
  // sweep so they re-evaluate next cycle; after MAX_AGE_LOOKUP_CYCLES
  // consecutive failures the trade is given up (falls through to the sweep)
  // with a warn. `null` = VERIFIED no activity → deterministic drop.
  if (conditions.maxAgeDays != null && survivors.length > 0) {
    const cap = conditions.maxAgeDays;
    const wallets = [
      ...new Set(survivors.map((t) => t.proxyWallet.toLowerCase())),
    ];
    const ages = await getAges(wallets);
    const ageDeferred = new Set<string>();
    survivors = survivors.filter((t) => {
      const w = t.proxyWallet.toLowerCase();
      const k = dedupKey(t);
      const age = ages[w];
      if (age === undefined) {
        const attempts = (ageRetries.get(k) ?? 0) + 1;
        if (attempts >= MAX_AGE_LOOKUP_CYCLES) {
          ageRetries.delete(k);
          console.warn(
            `[alertEngine] age lookup failed ${attempts} cycle(s) for ${k} (wallet=${w}) — giving up, trade dropped`,
          );
          return false; // stays in `fresh` → the sweep marks it seen for good
        }
        ageRetries.set(k, attempts);
        ageDeferred.add(k);
        return false;
      }
      ageRetries.delete(k); // resolved (real ts or verified-empty)
      // Drop verified-no-activity (null) and wallets older than the cap.
      return typeof age === "number" && Number.isFinite(age) && age <= cap;
    });
    if (ageDeferred.size > 0) {
      fresh = fresh.filter((t) => !ageDeferred.has(dedupKey(t)));
      console.log(
        `[alertEngine] age lookup failed for ${ageDeferred.size} trade(s) — deferred to next cycle (not marked seen)`,
      );
    }
  }

  // Market-context enrichment (batched + cached upstream). Fetched once for
  // the surviving conditionIds; failures degrade to an empty map so alerts
  // still fire un-enriched.
  let metaByCid: Record<string, MarketMeta> = {};
  if (getMarketMeta && survivors.length > 0) {
    try {
      metaByCid = await getMarketMeta([
        ...new Set(survivors.map((t) => t.conditionId)),
      ]);
    } catch (e) {
      console.warn("[alertEngine] market meta enrichment failed:", e);
    }
  }

  // Pre-settlement-rush condition: only fire within N hours of market end.
  // KNOWN meta with no usable end time (closed market / missing endDate) is a
  // deterministic drop. MISSING meta (cold cache + transient gamma failure) is
  // DEFERRED instead: the trade is excluded from this cycle AND from the
  // markSeen sweep below, so it re-evaluates next cycle once meta resolves —
  // a transient gamma blip must not permanently swallow a matching trade.
  if (conditions.maxHoursToEnd != null) {
    const cap = conditions.maxHoursToEnd;
    const deferred = new Set<string>();
    survivors = survivors.filter((t) => {
      const meta = metaByCid[t.conditionId];
      if (!meta) {
        deferred.add(dedupKey(t));
        return false;
      }
      const ctx = tradeMarketContext(notionalUsd(t), meta, nowSec);
      return ctx?.hoursToEnd != null && ctx.hoursToEnd <= cap;
    });
    if (deferred.size > 0) {
      fresh = fresh.filter((t) => !deferred.has(dedupKey(t)));
    }
  }

  // --- Per-(wallet, market) push cooldown --------------------------------
  // Production-measured noise: one wallet re-firing on one market was 14.2%
  // of all pushes. Inside the cooldown window only the FIRST match pushes;
  // later matches are still claimed + recorded (they ARE alerts), just not
  // sent. The recent-alert probe walks the created_at index over the small
  // window and matches wallet/market via json_extract — payload has no
  // dedicated columns, but the window keeps the scan tiny. Push-only concern:
  // without a `send` there is nothing to suppress.
  const cooldownSec = Math.max(0, conditions.cooldownMinutes ?? 0) * 60;
  const cooldownActive = cooldownSec > 0 && !!send;
  const cooldownKey = (t: Trade) =>
    `${t.proxyWallet.toLowerCase()}:${t.conditionId}`;
  // Burst size per key among THIS cycle's matches: the one pushed message
  // carries a "共 N 笔" summary for the siblings suppressed below it.
  const burstCount = new Map<string, number>();
  if (cooldownActive) {
    for (const t of survivors) {
      const ck = cooldownKey(t);
      burstCount.set(ck, (burstCount.get(ck) ?? 0) + 1);
    }
  }
  const recentAlertStmt = cooldownActive
    ? db.prepare(
        `SELECT COUNT(*) AS n FROM alerts
          WHERE created_at >= ?
            AND type IN ('large','smart')
            AND lower(json_extract(payload, '$.proxyWallet')) = ?
            AND json_extract(payload, '$.conditionId') = ?`,
      )
    : null;
  const pushedThisCycle = new Set<string>();
  let suppressedCount = 0;

  // --- Push throttle state (one cycle's scope) ----------------------------
  // Attempts (not just successes) are what consume Telegram API budget, so the
  // cap counts every push try. The gap sleep sits between claim and send —
  // the claim rollback on transient failure still works; the documented
  // crash-between-claim-and-send tradeoff merely widens by the gap. The final
  // markSeenBatch sweep runs after the loop regardless (transient send errors
  // rethrow, everything else falls through).
  let lastPushAtMs = 0;
  let pushAttempts = 0;
  const overflow: { usd: number; title: string }[] = [];
  const throttledSend = async (html: string) => {
    if (!send) return;
    const wait =
      lastPushAtMs === 0 ? 0 : sendMinGapMs - (Date.now() - lastPushAtMs);
    if (wait > 0) await sleep(wait);
    try {
      await send(html);
    } finally {
      lastPushAtMs = Date.now();
      pushAttempts++;
    }
  };

  // Fire alerts for the final matches (already oldest-first from selectNewTrades).
  let fired = 0;
  for (const t of survivors) {
    const k = dedupKey(t);
    const n = notionalUsd(t);
    const smart = smartTags[t.proxyWallet.toLowerCase()];
    const ctx = tradeMarketContext(n, metaByCid[t.conditionId], nowSec);
    // Claim-then-send: markSeen's INSERT OR IGNORE is the cross-process
    // preemption lock — with the embedded engine AND the standalone worker on
    // one db, both pass their seen check for the same trade and would each
    // push without it. changes === 0 → the other process claimed first.
    if (markSeen(db, k, t.timestamp).changes === 0) {
      console.log(`[alertEngine] skip ${k}: claimed by another process`);
      continue;
    }
    // Cooldown disposition BEFORE the push: a suppressed match is recorded
    // below exactly like a pushed one — only the Telegram send is skipped.
    let suppress = false;
    if (recentAlertStmt) {
      const ck = cooldownKey(t);
      if (pushedThisCycle.has(ck)) {
        suppress = true;
      } else {
        const { n } = recentAlertStmt.get(
          nowSec - cooldownSec,
          t.proxyWallet.toLowerCase(),
          t.conditionId,
        ) as { n: number };
        suppress = n > 0;
      }
      if (suppress) {
        suppressedCount++;
        console.log(
          `[alertEngine] cooldown: record-only for ${k} (wallet=${t.proxyWallet.toLowerCase()} market=${t.conditionId} window=${conditions.cooldownMinutes}min)`,
        );
      }
    }
    if (send && !suppress) {
      if (pushAttempts >= maxPushesPerCycle) {
        // Cap hit: fold into the one summary push below. The match is still
        // claimed + recorded like every other — only the individual push is
        // replaced.
        overflow.push({ usd: n, title: t.title });
      } else {
        try {
          // The format function's output is untouched; the burst summary is a
          // cooldown-owned suffix composed here in the engine.
          let html = formatLargeTradeAlert(t, smart, ctx);
          const burst = burstCount.get(cooldownKey(t)) ?? 1;
          if (burst > 1) {
            html += `\n⏳ 该钱包本轮在此市场共 ${burst} 笔，冷却 ${conditions.cooldownMinutes} 分钟内其余仅入库`;
          }
          await throttledSend(html);
          pushedThisCycle.add(cooldownKey(t));
        } catch (e) {
          if (isPermanentSendError(e)) {
            // Poison message (Telegram 4xx after the plain-text downgrade):
            // retrying can never succeed, so KEEP the claim, record the alert
            // below and keep the pipeline moving — rolling back would pin this
            // oldest-first head trade in front of every later alert forever.
            console.error(
              `[alertEngine] permanent send failure for ${k} — keeping claim, recorded without push:`,
              e,
            );
          } else {
            // Transient (5xx/network/429 exhausted): roll back the claim so
            // the trade retries next cycle (at-least-once). Known tradeoff: a
            // crash BETWEEN claim and send loses that one push.
            unmarkSeen(db, k);
            throw e;
          }
        }
      }
    }
    recordAlert(
      db,
      smart ? "smart" : "large",
      k,
      JSON.stringify(ctx ? { ...t, marketCtx: ctx } : t),
      t.timestamp,
    );
    fired++;
  }

  if (suppressedCount > 0) {
    console.log(
      `[alertEngine] cooldown suppressed ${suppressedCount}/${survivors.length} push(es) this cycle (window=${conditions.cooldownMinutes}min) — all recorded to alerts`,
    );
  }

  // Over-cap matches collapse into ONE summary push (details are all in the
  // alerts table already). Best-effort: every folded match is claimed +
  // recorded above, so a failed summary is logged and dropped — it must never
  // roll anything back or block the seen sweep below.
  if (overflow.length > 0) {
    const top = overflow.reduce((a, b) => (b.usd > a.usd ? b : a));
    console.log(
      `[alertEngine] push cap ${maxPushesPerCycle} hit — folding ${overflow.length} push(es) into one summary (max ${Math.round(top.usd)})`,
    );
    try {
      await throttledSend(
        `📦 本轮另有 ${overflow.length} 笔 ≥${usd(conditions.minUsd)} 成交，最大 ${usd(top.usd)}（${esc(top.title)}），明细已全部入库`,
      );
    } catch (e) {
      console.error(
        `[alertEngine] overflow summary send failed (${overflow.length} folded, all recorded):`,
        e,
      );
    }
  }

  // Mark every evaluated fresh trade seen in one transaction (matches were
  // claimed above; OR IGNORE makes re-marking them a no-op) so condition-
  // failing trades aren't re-evaluated next cycle.
  markSeenBatch(
    db,
    fresh.map((t) => ({ key: dedupKey(t), ts: t.timestamp })),
  );

  return fired;
}
