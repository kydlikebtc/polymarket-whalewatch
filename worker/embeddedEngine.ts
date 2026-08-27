import { parseConfig } from "../lib/config";
import { openDb, type DB } from "../lib/db";
import { getLargeTrades, getTradesWindowDeep } from "../lib/polymarket";
import { maybePruneSeen, seenKeySet } from "../lib/seen";
import { prunePersistedWindows } from "../lib/marketWindowStore";
import { dedupKey } from "../lib/trades";
import { sendMessage } from "../lib/telegram";
import {
  makeKindSender,
  markSendResult,
  resolveTargets,
  type TgKind,
} from "../lib/tgTargets";
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
import { runFollowCycle } from "../lib/follow";
import { fetchAskBook } from "../lib/orderBook";
import { fetchPriceAt, fetchPriceSeries } from "../lib/priceHistory";
import { runExitSimBackfill } from "../lib/exitCounterfactual";
import { runMarketDailyCycle, SMALL_MIN_USD } from "../lib/marketDaily";
import { wrapSendWithHealth } from "../lib/telegramHealth";
import {
  createBackfillState,
  runOutcomeBackfillCycle,
} from "../lib/outcomeBackfill";
import {
  beat,
  getEngineStart,
  getHeartbeats,
  markEngineStart,
  maybeDailySelfCheck,
} from "../lib/heartbeat";
import { createBackupState, maybeDailyBackup } from "../lib/dbBackup";
import { evaluateHealth } from "../lib/health";
import { runDeliveryCycle, type DeliveryChannel } from "../lib/signalDelivery";
import { maybeDailySignalDigest } from "../lib/signalDigest";
import {
  listActiveWebhooks,
  makeWebhookChannel,
  webhookWantsType,
} from "../lib/webhookDelivery";
import { runBusWebhookCycle } from "../lib/busWebhook";
import { runBotCycle, type BotUpdate } from "../lib/botCommands";
import { buildMarketCard, resolveMarketInput } from "../lib/marketCard";
import { createXClient } from "../lib/xPublisher";
import { markPosted, resolveXCreds } from "../lib/xAccounts";
import { getXKindSwitches } from "../lib/xSettings";
import { getXBroadcastParams } from "../lib/xParams";
import { getXTemplates } from "../lib/xTemplates";
import { projectBusSignals } from "../lib/signalBus";
import { runXBroadcastCycle } from "../lib/xBroadcast";
import { runPregameCycle } from "../lib/xPregame";
import { runSettledCycle } from "../lib/xSettled";
import { maybeWeeklyPost } from "../lib/xWeekly";

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
  // TG 投递目标:后台可管理的「bot + 频道」行,库里一行都没有时回退到
  // env 的 TELEGRAM_BOT_TOKEN/CHANNEL_ID(见 lib/tgTargets.resolveTargets
  // —— 这条回退是生产安全线,升级不能让现网静默停推)。
  const tgEnv = {
    botToken: cfg.telegramBotToken,
    alertChatId: cfg.telegramChannelId,
    signalChatId: cfg.telegramSignalChannelId,
    publicDelayMin: cfg.signalPublicDelayMin,
  };
  // 按类型建 sender:每类只发给勾选了它的目标,一个频道挂了不拖累其他。
  // 每次调用重新解析,所以后台改完开关下一条消息就生效,无需重启。
  // undefined = 当前没有目标要这一类 → 调用方整段跳过(沿用既有的
  // `send?: ...` 可选语义)。
  const kindSender = (kind: TgKind) => {
    const raw = makeKindSender(db, tgEnv, kind);
    // Health-instrumented:连续失败计数落 config 表(/api/alerts →
    // alerts 页红条),超阈值推一条自诊断。错误原样 rethrow,claim 回滚 /
    // 毒帖语义不变 —— 见 lib/telegramHealth。
    return raw ? wrapSendWithHealth(db, raw) : undefined;
  };
  // 大单与共识分别走自己的类型:以前两者共用一个 send,后台无法只关其一。
  const sendLarge = kindSender("large");
  const sendConsensus = kindSender("consensus");
  // 运维通知(日报自检 / 断更 / 熔断通报 / 存证摘要 / 启动 ping)。
  const sendOps = kindSender("ops");
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

  // Start marker for the health grace period: a loop that throws on EVERY
  // pass never writes a heartbeat row, so "rows we have are fresh" would rate
  // the worst failure as healthy. evaluateHealth compares this against the
  // per-loop thresholds to call an expected-but-absent loop stale.
  markEngineStart(db, nowStartSec);

  maybeStartupPing(sendOps, cfg.telegramStartupPing);

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
        send: sendLarge,
        minTimestamp,
        publicUrl: cfg.publicUrl,
      });
      if (fired > 0) console.log(`[engine] cycle fired ${fired} alert(s)`);
      // Liveness: beat AFTER a successful cycle (a beat means "this loop
      // completed", not "this loop was scheduled"), then the day-gated
      // self-check digest — cheap config read per tick, same pattern as
      // maybeDailySeed above.
      beat(db, "alert");
      maybeDailySelfCheck(db, sendOps, undefined, {
        publicUrl: cfg.publicUrl,
      }).catch((e) => console.error("[heartbeat] self-check push failed", e));
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
        send: sendConsensus,
        // Coverage-log denominator: fetchWindow's effectiveSinceSec is
        // measured against this requested window.
        windowSec: CONSENSUS_WINDOW_SEC,
        publicUrl: cfg.publicUrl,
      });
      if (fired > 0) {
        console.log(`[engine] consensus cycle fired ${fired} alert(s)`);
      }
      // Channel ① (echo / splitter / insider) over the same window. Fire and
      // forget: a discovery failure must never disturb the consensus cadence.
      collectFirehoseEvidence(db, win.trades, smart).catch((e) =>
        console.error("[discovery] firehose collection failed", e),
      );
      // Consensus follow (paper) over the SAME window — it used to run its
      // own 5-minute loop with an identical getTradesWindowDeep, doubling the
      // deep-fetch load (2 sweeps × 20 pages, twice per 5 min) with a stagger
      // that drifted with cycle duration. Sharing the fetch halves the load,
      // pins follow to the exact rows consensus/firehose saw, and hands
      // `truncated` through so runFollowCycle can refuse to open positions on
      // an untrustworthy (shortened) window. Own try/catch: a follow failure
      // must never disturb the consensus cadence either.
      try {
        const { opened, settled } = await runFollowCycle({
          db,
          fetchWindow: async () => ({
            trades: win.trades,
            truncated: win.truncated,
          }),
          getSmart: () => smart,
          fetchPrice: (asset, tsSec) => fetchPriceAt(asset, tsSec),
          // 形成价:只取 ≤formationTs 的历史点(atOrBefore)防前视偏差 —— 形成后
          // 价格通常朝进场方向移动,取"之后的最近点"会系统性低估延迟成本。
          fetchFormationPrice: (asset, tsSec) =>
            fetchPriceAt(asset, tsSec, { atOrBefore: true }),
          // 执行层归因:开仓瞬间盘口快照模拟吃单(exec_*)。每轮新开仓通常
          // 0~5 笔,一仓一次 /book 请求,失败落 null 不阻塞开仓。
          fetchBook: (asset) => fetchAskBook(asset),
          getMeta: (cids) => getMarketMeta(db, cids),
        });
        if (opened > 0 || settled > 0) {
          console.log(
            `[engine] follow cycle: opened ${opened}, settled ${settled}`,
          );
        }
      } catch (e) {
        console.error("[engine] follow cycle error", e);
      }
      // 市场深度卡的窗口存档清理。存档表**不受内存 LRU 约束** —— 内存工作集
      // 封顶 200 个市场,但库里每个被访问过的市场都会留一行,不清就随访问过的
      // 市场数无限涨。超过 24h 的行整个窗口都已滚出下界,读回来也是骗人。
      // 由引擎做而非请求侧:清理是运维动作,不该让某个倒霉的用户请求付这笔钱。
      try {
        const dropped = prunePersistedWindows(
          db,
          Math.floor(Date.now() / 1000),
        );
        if (dropped > 0) {
          console.log(
            `[marketWindow] pruned ${dropped} stale window archive(s)`,
          );
        }
      } catch (e) {
        console.error("[marketWindow] prune failed", e);
      }

      // 统一信号总线:把本轮刚落库的告警/新入池成员投影进 bus_signals。
      // 纯本地读写(有测试钉死无网络),失败不得扰动共识节奏。
      try {
        projectBusSignals(db, Math.floor(Date.now() / 1000));
      } catch (e) {
        console.error("[signalBus] projection failed", e);
      }
      beat(db, "consensus");
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

  // --- Alert-outcome backfill loop ---------------------------------------
  // The validation loop's 1h/24h follow-through + settlement backfill used to
  // run only when someone VIEWED the alerts page (/api/alert-outcomes), so
  // the hit-rate statistics covered a biased "was looked at" sample and went
  // dark whenever nobody opened the dashboard. This loop makes the worker
  // sweep every non-terminal alert itself — the win-rate denominator is the
  // full alert history, watched or not. Per-alert cost is bounded by
  // computeAlertOutcomes' own semantics (immutable-price caching, 6h
  // null-retry backoff, cached gamma meta); the cycle only picks candidates.
  const OUTCOME_BACKFILL_INTERVAL_MS = 10 * 60_000;
  const outcomeBackfillState = createBackfillState();
  const backupState = createBackupState();
  async function outcomeBackfillLoop() {
    try {
      const r = await runOutcomeBackfillCycle(db, outcomeBackfillState, {
        outcomes: { getMeta: (cids) => getMarketMeta(db, cids) },
      });
      if (r.processed > 0) {
        console.log(
          `[engine] outcome backfill: ${r.processed} processed · ` +
            `${r.updated} tracked · ${r.pending} pending` +
            (r.newlyUntrackable > 0
              ? ` · ${r.newlyUntrackable} untrackable skipped`
              : "") +
            (r.wrapped ? " · sweep complete" : " · sweep continues next cycle"),
        );
      }
      beat(db, "outcome_backfill");
      // Daily SQLite snapshot rides this 10-minute carrier (same piggyback
      // pattern as the self-check on the alert loop). Fire and forget: the
      // online-backup API never blocks the engine's writes, and a backup
      // failure must never disturb the backfill cadence.
      // 反事实退出路径回填(2026-08-16):骑同一 10min 载波,每轮 ≤5 次上游
      // 请求;存量排空后稳态 ≈ 每天新结算的几仓。失败只 warn,不扰载波节奏。
      try {
        const es = await runExitSimBackfill(db, {
          fetchSeries: fetchPriceSeries,
        });
        if (es.processed > 0 || es.failed > 0) {
          console.log(
            `[exit-sim] backfilled ${es.processed}, failed ${es.failed}, pending ${es.pending}`,
          );
        }
      } catch (e) {
        console.error("[exit-sim] backfill cycle error", e);
      }
      maybeDailyBackup(db, backupState)
        .then((r) => {
          if (r) {
            console.log(
              `[backup] daily snapshot ${r.file}` +
                (r.pruned.length ? ` · pruned ${r.pruned.length} old` : ""),
            );
          }
        })
        .catch((e) => console.error("[backup] daily snapshot failed", e));
    } catch (e) {
      console.error("[engine] outcome backfill failed", e);
    }
    setTimeout(outcomeBackfillLoop, OUTCOME_BACKFILL_INTERVAL_MS);
  }
  // First pass at 90s: staggered behind the consensus loop (30s, which now
  // also carries firehose + follow on its shared window) and the evidence
  // backfill (60s) so startup doesn't stack fetches.
  setTimeout(outcomeBackfillLoop, 90_000);

  // --- Market-daily aggregation (内容引擎共享底座) ------------------------
  // UTC 午夜后把昨天的 24h 窗口一次性聚合进 market_daily(/pulse 的数据层)。
  // 30min 轮询只是「查一下昨天做了没」,真正的抓取每天至多一次;抓取失败不写
  // 日标记、下一轮重试(lib/marketDaily.ts 的裁决)。刻意不 beat 心跳:日节拍
  // 配 1h 默认停跳阈值必然假警报,新鲜度由 /api/pulse 的 latestDay 自述。
  const MARKET_DAILY_INTERVAL_MS = 30 * 60_000;
  async function marketDailyLoop() {
    try {
      await runMarketDailyCycle(db, {
        fetchWindow: (sinceSec) =>
          getTradesWindowDeep({
            minUsd: SMALL_MIN_USD,
            sinceSec,
            maxPages: 20,
          }),
      });
    } catch (e) {
      console.error("[engine] market-daily aggregation failed", e);
    }
    setTimeout(marketDailyLoop, MARKET_DAILY_INTERVAL_MS);
  }
  // 150s 首跑:错峰在共识(30s)/证据回填(60s)/结算回填(90s)之后。
  setTimeout(marketDailyLoop, 150_000);

  // --- Bot query loop (🎯 市场信号卡) ------------------------------------
  // DM the bot a Polymarket link / slug / conditionId → the market signal
  // card comes back as a reply (composition shared with /api/market, so bot
  // and dashboard can never disagree). Long-poll getUpdates; replies are
  // best-effort. SINGLE-POLLER: Telegram 409s a second concurrent getUpdates
  // consumer per token — in the documented dual-engine deployment run the
  // bot in ONE process only (same caution as the startup ping).
  if (cfg.telegramEnabled) {
    const BOT_POLL_GAP_MS = 2000;
    // Register the bot's menu commands (the ☰ button next to the input box)
    // — idempotent, fire-and-forget: a registration failure only costs the
    // menu, DM'ing the bot still works.
    fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commands: [
          { command: "card", description: "🎯 市场信号卡：查询任意市场" },
          { command: "help", description: "使用说明" },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`setMyCommands ${r.status}`);
        console.log("[bot] menu commands registered (/card /help)");
      })
      .catch((e) => console.error("[bot] setMyCommands failed:", e));
    const getUpdatesFn = async (offset: number): Promise<BotUpdate[]> => {
      const url =
        `https://api.telegram.org/bot${cfg.telegramBotToken}/getUpdates` +
        `?offset=${offset}&timeout=20&allowed_updates=%5B%22message%22%5D`;
      const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
      if (!res.ok) throw new Error(`getUpdates ${res.status}`);
      const j = (await res.json()) as { ok: boolean; result?: BotUpdate[] };
      return j.ok && Array.isArray(j.result) ? j.result : [];
    };
    async function botLoop() {
      try {
        const r = await runBotCycle(db, {
          getUpdatesFn,
          // Reply goes to the ASKING chat, not the alert channel — fresh
          // creds per send with the chat id swapped in.
          send: (chatId, html) =>
            sendMessage(
              { botToken: cfg.telegramBotToken, chatId: String(chatId) },
              html,
            ),
          buildCard: (cid) => buildMarketCard(db, cid),
          resolve: (input) => resolveMarketInput(input),
          publicUrl: cfg.publicUrl,
        });
        if (r.cards > 0) {
          console.log(`[bot] answered ${r.cards} market-card query(ies)`);
        }
      } catch (e) {
        console.error("[bot] cycle error", e);
      }
      setTimeout(botLoop, BOT_POLL_GAP_MS);
    }
    setTimeout(botLoop, 10_000);
  }

  // --- X (Twitter) auto-broadcast loop ------------------------------------
  // alerts 表即队列的纯消费侧(lib/xBroadcast 文件头有完整架构论证):
  // 60s 一轮消费大单/共识告警,10 分钟一次赛前聚合扫描,周一 13:00 UTC 后
  // 发一条周报图卡。X 侧任何失败只记日志 —— 与 Telegram 主链路物理隔离。
  // 预算:本地 $X_MONTHLY_BUDGET_USD 台账 fail-closed(xQuota),X 后台的
  // spending cap 是第二道保险。
  if (cfg.xAppConfigured) {
    const X_LOOP_MS = 60_000;
    const PREGAME_GAP_MS = 10 * 60_000;
    let lastPregameAt = 0;
    // 发帖凭据每轮解析(不缓存):/manage 里切换授权账号后,下一轮 ≤60s
    // 自动改用新账号,无需重启引擎。client 按凭据缓存,凭据没变就复用同一个。
    let cached: {
      token: string;
      client: ReturnType<typeof createXClient>;
    } | null = null;
    let warnedNoCreds = false;
    async function xLoop() {
      try {
        const creds = resolveXCreds(db, cfg);
        if (!creds) {
          // 没有任何可用账号:静默待命(只提示一次,不刷屏)。授权一个账号
          // 或补上 .env 的 access token 后,下一轮自动开工。
          if (!warnedNoCreds) {
            warnedNoCreds = true;
            console.log(
              "[engine] X broadcast idle — no authorized account yet (授权入口:/manage 的「𝕏 播报账号」区)",
            );
          }
          beat(db, "x_broadcast");
          setTimeout(xLoop, X_LOOP_MS);
          return;
        }
        warnedNoCreds = false;
        if (!cached || cached.token !== creds.accessToken) {
          cached = {
            token: creds.accessToken,
            client: createXClient({
              apiKey: cfg.xApiKey,
              apiSecret: cfg.xApiSecret,
              accessToken: creds.accessToken,
              accessSecret: creds.accessSecret,
            }),
          };
          console.log(
            `[engine] X broadcast posting as ${creds.screenName ? `@${creds.screenName}` : "(env token)"} (${creds.source})`,
          );
        }
        const xClient = cached.client;
        // 内容类型开关、数字参数与文案模板每轮读一次(与凭据同款即时性):
        // /manage 上关掉某类/改了上限、预算或文案,下一轮就按新值执行,
        // 无需重启。
        const kinds = getXKindSwitches(db);
        const params = getXBroadcastParams(db, {
          budgetUsd: cfg.xMonthlyBudgetUsd,
          whaleMinTradeUsd: cfg.xMinTradeUsd,
        });
        const templates = getXTemplates(db);
        const spendCaps = {
          dailySpendCapUsd: params.dailySpendCapUsd,
          weeklySpendCapUsd: params.weeklySpendCapUsd,
        };
        const posted = await runXBroadcastCycle({
          db,
          client: xClient,
          budgetUsd: params.budgetUsd,
          minTradeUsd: params.whaleMinTradeUsd,
          whaleDailyCap: params.whaleDailyCap,
          consensusDailyCap: params.consensusDailyCap,
          whaleSirenUsd: params.whaleSirenUsd,
          templates,
          ...spendCaps,
          kinds,
        });
        if (kinds.pregame && Date.now() - lastPregameAt >= PREGAME_GAP_MS) {
          lastPregameAt = Date.now();
          await runPregameCycle({
            db,
            client: xClient,
            getMeta: (cids) => getMarketMeta(db, cids),
            budgetUsd: params.budgetUsd,
            dailyCap: params.pregameDailyCap,
            minH: params.pregameMinH,
            maxH: params.pregameMaxH,
            template: templates.pregame,
            ...spendCaps,
          });
        }
        const weekly = kinds.weekly
          ? await maybeWeeklyPost({
              db,
              client: xClient,
              ogOrigin: cfg.xOgOrigin,
              publicUrl: cfg.publicUrl,
              budgetUsd: params.budgetUsd,
              postUtcHour: params.weeklyUtcHour,
              template: templates.weekly,
              ...spendCaps,
            })
          : false;
        // 结算战报(默认关):给已发过的信号帖 self-reply 补结果。放在
        // 播报之后 —— 新信号的时效性永远优先于回顾旧信号。
        const settled = kinds.settled
          ? await runSettledCycle({
              db,
              client: xClient,
              budgetUsd: params.budgetUsd,
              dailyCap: params.settledDailyCap,
              template: templates.settled,
              ...spendCaps,
            })
          : 0;
        // 账号活跃度打点(/manage 据此显示「最近发帖」)。只对库里的授权
        // 账号打点 —— env 回退模式没有对应的行。
        if (
          creds.source === "db" &&
          creds.userId &&
          (posted > 0 || weekly || settled > 0)
        ) {
          markPosted(db, creds.userId, Math.floor(Date.now() / 1000));
        }
        // 心跳:beat 表示"这轮跑完了"。x_broadcast 不在 health 的期望清单里
        // (可选功能,未配置的部署不该因它报 stale),有 beat 时按默认阈值判活。
        beat(db, "x_broadcast");
      } catch (e) {
        console.error("[engine] x broadcast cycle error", e);
      }
      setTimeout(xLoop, X_LOOP_MS);
    }
    // 错峰启动:consensus 30s / evidence 60s / backfill 90s 之间。
    setTimeout(xLoop, 45_000);
    // 启动日志打的是**生效值**(库里的后台配置优先,env 只是默认):值本身
    // 每轮可变,这行只描述开工时刻的状态。
    const bootParams = getXBroadcastParams(db, {
      budgetUsd: cfg.xMonthlyBudgetUsd,
      whaleMinTradeUsd: cfg.xMinTradeUsd,
    });
    console.log(
      `[engine] X broadcast enabled · 60s cadence · budget $${bootParams.budgetUsd}/mo · whale floor $${bootParams.whaleMinTradeUsd} · params live-tunable via /manage`,
    );
  }

  // --- 对外信号投递循环(第七个循环,批次 1) -----------------------------
  // 消费 strategy_signals 台账、扇出到已配置的通道。信号产生(followCycle)
  // 与投递在此彻底解耦:通道一个都没配时循环整个不启动(fail-closed),
  // 引擎其余六个循环零感知。幂等/失败语义见 lib/signalDelivery.ts 文件头。
  {
    const DELIVERY_INTERVAL_MS = 30_000;
    // 策略信号通道 = 每个勾了 strategy 的投递目标一条。延迟(免费/付费分层
    // 的唯一杠杆)从全局配置下沉成了目标自己的属性 —— 同一批信号可以既
    // 实时发 VIP 群、又延迟 15 分钟发公开频道,后台随时改。
    //
    // ⚠️ key 取 target.deliveryKey 而不是现编:signal_deliveries 主键含
    // channel,换键会把历史上投过的信号全部重投一遍。env 回退目标因此
    // 沿用现网原键(tg_paid / tg_public),详见 lib/tgTargets。
    const buildTgChannels = (): DeliveryChannel[] =>
      resolveTargets(db, tgEnv)
        .filter((t) => t.kinds.strategy)
        .map((t) => ({
          key: t.deliveryKey,
          minEmitAgeSec: t.delayMin * 60,
          send: async (html: string) => {
            try {
              await sendMessage(t.creds, html);
              if (t.id != null) markSendResult(db, t.id, { ok: true });
            } catch (e) {
              if (t.id != null) {
                markSendResult(db, t.id, {
                  ok: false,
                  error: e instanceof Error ? e.message : String(e),
                });
              }
              // 原样抛:signalDelivery 自己有 claim 回滚 / 毒消息语义,
              // 这里只负责记账,不改变它的失败处理。
              throw e;
            }
          },
        }));
    // 循环无条件启动:webhook 端点是运行时经 admin API 登记的 DB 行,每轮
    // 重新拉取 —— 新登记的端点 30s 内生效,零重启。TG 通道一个没配且当轮
    // 也无 webhook 时,runDeliveryCycle 对空通道数组是纯 no-op。
    async function deliveryLoop() {
      try {
        // 熔断通报走运营者告警频道(best-effort):订户端点死了,沉默是
        // 最贵的故障形态。策略投递与 bus 分流共用这一个通报口。
        const notifyDisabled = (
          endpoint: { id: number; url: string },
          error: string,
        ) => {
          sendOps?.(
            `⚠️ webhook 端点 #${endpoint.id} 连续失败已熔断停用(${error})\n${endpoint.url}`,
          ).catch(() => {});
        };
        const checkHealth = () => ({
          ok: evaluateHealth(
            getHeartbeats(db),
            Math.floor(Date.now() / 1000),
            getEngineStart(db),
          ).ok,
        });
        const webhookChannels = listActiveWebhooks(db)
          // 策略投递只给「想要 strategy」的端点:key 授权 ∧ 端点勾选
          // (存量端点勾选为 NULL = 仅策略,行为不变)。bus 类型走下方
          // runBusWebhookCycle 按 sourceType 分流 —— 2026-08-19 起两条轨并行。
          .filter((ep) => webhookWantsType(ep, "strategy"))
          .map((ep) =>
            makeWebhookChannel(db, ep, {
              onDisabled: notifyDisabled,
            }),
          );
        // 每轮重建:后台改了目标/开关/延迟,30s 内自动生效 —— 与
        // webhook 端点每轮重新拉取同一套即时性承诺。
        const channels = [...buildTgChannels(), ...webhookChannels];
        if (channels.length > 0) {
          const r = await runDeliveryCycle({
            db,
            channels,
            publicUrl: cfg.publicUrl,
            // 引擎停跳时冻结投递(宁静默不误导)。delivery 自己的 beat 在
            // 循环末尾无条件打点,冻结轮也算活着 —— 停跳判定只由其余循环触发。
            checkHealth,
          });
          if (r.sent > 0) {
            console.log(`[delivery] pushed ${r.sent} message(s)`);
          }
          if (r.skippedStale > 0) {
            console.warn(
              `[delivery] ${r.skippedStale} stale signal(s) skipped (never pushed — too old to act on)`,
            );
          }
          // 每日存证 digest 搭投递载波(day-gated,claim-first),发公开频道。
          // fire-and-forget:存证失败绝不扰动投递节奏。
          maybeDailySignalDigest(db, sendOps)
            .then((d) => {
              if (d?.sent) {
                console.log(
                  `[digest] 存证 ${d.day} · ${d.count} 条 · ${d.digest.slice(0, 16)}…`,
                );
              }
            })
            .catch((e) => console.error("[digest] 存证推送失败", e));
        }
        // bus 类型的 webhook 分流(独立于 TG/策略通道,勾了类型才投;
        // 冻结纪律同上,内部自吞失败,永不抛)。
        const busR = await runBusWebhookCycle(db, {
          checkHealth,
          onDisabled: notifyDisabled,
        });
        if (busR.sent > 0) {
          console.log(`[delivery] webhook bus pushed ${busR.sent} event(s)`);
        }
        beat(db, "delivery");
      } catch (e) {
        console.error("[delivery] cycle error", e);
      }
      setTimeout(deliveryLoop, DELIVERY_INTERVAL_MS);
    }
    // 45s 首跑:错开 consensus(30s)/evidence(60s),且首轮 followCycle
    // (最早 30s+)落台账前投递本来就无事可做。
    setTimeout(deliveryLoop, 45_000);
    const bootTg = buildTgChannels();
    console.log(
      bootTg.length > 0
        ? `[delivery] signal delivery loop enabled (${bootTg
            .map((c) => `${c.key}@${c.minEmitAgeSec / 60}min`)
            .join(", ")} + runtime webhooks)`
        : "[delivery] delivery loop running (无 TG 策略信号目标 — 仅 webhook;在 /manage 的「TG 推送」里添加目标并勾选「策略信号」即可启用)",
    );
  }

  // --- Dead-man's switch: outbound health ping ---------------------------
  // The heartbeat digest and /api/health both go SILENT when the engine dies
  // — by design an external service must notice the silence. With
  // HEALTHCHECK_PING_URL set (healthchecks.io / Uptime Kuma push monitor),
  // the engine GETs the URL every minute while every loop is fresh; a hang or
  // death stops the pings and the service alerts the operator through a
  // channel independent of this process AND of Telegram. Skipping the ping on
  // stale loops (instead of pinging "I'm half alive") is what turns a silent
  // loop hang into the same alarm as full process death.
  if (cfg.healthcheckPingUrl) {
    const HEALTH_PING_INTERVAL_MS = 60_000;
    async function healthPingLoop() {
      try {
        const report = evaluateHealth(
          getHeartbeats(db),
          Math.floor(Date.now() / 1000),
          getEngineStart(db),
        );
        if (report.ok) {
          const res = await fetch(cfg.healthcheckPingUrl, {
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`ping ${res.status}`);
        } else {
          console.warn(
            `[health] skip external ping — ${
              report.staleLoops.length
                ? `stale loops: ${report.staleLoops.join(",")}`
                : (report.reason ?? "unhealthy")
            }`,
          );
        }
      } catch (e) {
        console.error("[health] external ping failed", e);
      }
      setTimeout(healthPingLoop, HEALTH_PING_INTERVAL_MS);
    }
    // First ping after the startup stagger (consensus 30s, backfill 90s) so a
    // fresh boot doesn't spend its first minutes "unhealthy" for no reason.
    setTimeout(healthPingLoop, 120_000);
    console.log("[health] dead-man's switch ping enabled (60s cadence)");
  }
}
