import type { DB } from "./db";
import type { Trade } from "./types";
import type { AlertConditions } from "./alertConditions";
import type { MarketMeta } from "./gamma";
import { tradeMarketContext } from "./gamma";
import { selectNewTrades } from "./poll";
import { dedupKey, notionalUsd } from "./trades";
import { formatLargeTradeAlert } from "./alert";
import {
  markSeen,
  markSeenBatch,
  recordAlert,
  seenKeySet,
  unmarkSeen,
} from "./seen";

export interface EngineDeps {
  db: DB;
  fetchTrades: () => Promise<Trade[]>;
  conditions: AlertConditions;
  // ageDays by lowercased wallet (null = unknown). Only called when an age cap is set.
  getAges: (wallets: string[]) => Promise<Record<string, number | null>>;
  // Smart-wallet tags by lowercased wallet (sync SQLite lookup). Absent entries
  // mean "not smart". When the dep itself is undefined, no tagging happens and
  // smartOnly matches nothing (there is no whitelist to match against).
  getSmart?: (
    wallets: string[],
  ) => Record<string, { score: number | null } | undefined>;
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
 *     wallets with a finite ageDays <= cap (unknown-age and older are dropped).
 *  5. for each match (oldest-first): CLAIM via markSeen (cross-process lock),
 *     then push to Telegram; a failed send rolls the claim back and rethrows so
 *     the trade retries next cycle (at-least-once). A lost claim skips the push
 *     — the other process owns it. With a cooldown configured, repeat matches
 *     for the same (wallet, market) inside the window are recorded WITHOUT a
 *     push (the first push of a same-cycle burst carries a "共 N 笔" summary).
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
    getSmart,
    getMarketMeta,
    send,
    minTimestamp,
    nowSec = Math.floor(Date.now() / 1000),
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
    survivors = survivors.filter((t) => smartTags[t.proxyWallet.toLowerCase()]);
  }

  // Address-age filter (network-bound) — only when a cap is set and survivors remain.
  if (conditions.maxAgeDays != null && survivors.length > 0) {
    const cap = conditions.maxAgeDays;
    const wallets = [
      ...new Set(survivors.map((t) => t.proxyWallet.toLowerCase())),
    ];
    const ages = await getAges(wallets);
    survivors = survivors.filter((t) => {
      const age = ages[t.proxyWallet.toLowerCase()];
      // Drop unknown-age (null/undefined) and wallets older than the cap.
      return typeof age === "number" && Number.isFinite(age) && age <= cap;
    });
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

  // Fire alerts for the final matches (already oldest-first from selectNewTrades).
  let fired = 0;
  for (const t of survivors) {
    const k = dedupKey(t);
    const smart = smartTags[t.proxyWallet.toLowerCase()];
    const ctx = tradeMarketContext(
      notionalUsd(t),
      metaByCid[t.conditionId],
      nowSec,
    );
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
      try {
        // The format function's output is untouched; the burst summary is a
        // cooldown-owned suffix composed here in the engine.
        let html = formatLargeTradeAlert(t, conditions.minUsd, smart, ctx);
        const burst = burstCount.get(cooldownKey(t)) ?? 1;
        if (burst > 1) {
          html += `\n⏳ 该钱包本轮在此市场共 ${burst} 笔，冷却 ${conditions.cooldownMinutes} 分钟内其余仅入库`;
        }
        await send(html);
      } catch (e) {
        // Roll back the claim so the trade retries next cycle (at-least-once).
        // Known tradeoff: a crash BETWEEN claim and send loses that one push.
        unmarkSeen(db, k);
        throw e;
      }
      pushedThisCycle.add(cooldownKey(t));
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

  // Mark every evaluated fresh trade seen in one transaction (matches were
  // claimed above; OR IGNORE makes re-marking them a no-op) so condition-
  // failing trades aren't re-evaluated next cycle.
  markSeenBatch(
    db,
    fresh.map((t) => ({ key: dedupKey(t), ts: t.timestamp })),
  );

  return fired;
}
