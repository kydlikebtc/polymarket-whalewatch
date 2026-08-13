import type { DB } from "./db";
import { fetchWithRetry } from "./fetchWithRetry";
import { parseFeeSchedule, type FeeSchedule } from "./fees";

const GAMMA_API = "https://gamma-api.polymarket.com";

// The markets endpoint accepts repeated condition_ids params; keep chunks small
// so URLs stay short and one bad chunk fails independently.
const CHUNK = 20;

// Normalized market metadata for enrichment. Field-shape notes (verified live):
// `liquidity` is a STRING but `liquidityNum` is a number; `outcomes` and
// `outcomePrices` are stringified JSON arrays; `category` can be null.
export interface MarketMeta {
  conditionId: string;
  volume24hr: number | null;
  liquidity: number | null;
  endDate: string | null; // ISO
  closed: boolean;
  category: string | null;
  outcomes: string[];
  outcomePrices: number[];
  /**
   * 每个 outcome 对应的 CLOB token id,与 `outcomes` 同序对齐(同一响应里的
   * stringified JSON 数组,零新增上游调用 —— 与 fees 四件套同一论证)。反向
   * 对照档(lib/reverse.ts)靠它定位「对面 outcome」的 token 来取价/取盘口/
   * 回填 markout。坏形状/缺失 → [](消费方按元素数 fail-closed,见
   * reverseCandidate)。
   */
  clobTokenIds: string[];
  // Protocol fees. Rides along on the SAME response the enrichment already
  // fetches, so reading them costs zero extra upstream calls. See lib/fees.
  feesEnabled: boolean;
  feeType: string | null; // sports_fees_v2 / politics_fees / … (7 seen live)
  feeSchedule: FeeSchedule | null;
  /**
   * UMA resolution dispute state, or null when unknown. A disputed market's
   * `outcomePrices` can still be overturned, so settlement must not treat it
   * as final. Also free on the same response.
   */
  umaDisputed: boolean | null;
}

/**
 * Is this market's UMA resolution currently contested?
 *
 * gamma exposes TWO fields and only the SINGULAR one is authoritative:
 *   `umaResolutionStatus`   — "proposed" | "disputed" | "resolved"
 *   `umaResolutionStatuses` — a STRINGIFIED JSON array (not an array) of the
 *                             per-round history
 *
 * An earlier version of this function read the LAST element of the array,
 * reasoning that a dispute is always followed by a fresh proposal. **That is
 * wrong and it was verified wrong on live data.** When a second dispute
 * escalates to UMA's DVM vote, the arbitration result is NOT appended as
 * another "proposed" — the array stops at "disputed" forever while the
 * singular field flips to "resolved". Two live examples, both `closed:true`
 * with final `outcomePrices:["1","0"]`:
 *   0x99180dac… (over-3m-committed-to-the-infinex-public-sale)
 *   0x6f4f3632… (will-iran-close-its-airspace-by-december-31)
 * both carry `["proposed","disputed","proposed","disputed"]` + `"resolved"`.
 * Reading the array alone marks these permanently disputed, which blocks
 * settlement forever with no self-healing path.
 *
 * Sampled distribution (2026-08-04):
 *   300 closed markets → singular is "resolved" in 300/300
 *   100 open markets   → absent 88 · "proposed" 10 · "disputed" 2
 * So a genuine live dispute is `closed:false` + singular "disputed"; the
 * settlement gates all require `closed` first and therefore rarely fire. The
 * gate is kept anyway as cheap insurance against a closed-and-contested shape.
 *
 * Anything unrecognized returns null (unknown) and callers fail open.
 */
export function parseUmaDisputed(
  status: unknown,
  statuses?: unknown,
): boolean | null {
  // The singular field wins whenever present — it reflects arbitration.
  if (typeof status === "string") {
    if (status === "disputed") return true;
    if (status === "resolved" || status === "proposed") return false;
    return null; // unobserved value — don't guess
  }
  // Fallback for rows that predate / omit the singular field. Never overrides
  // it: the array cannot distinguish "in dispute" from "disputed then
  // arbitrated", which is exactly the bug above.
  if (statuses == null) return null;
  let arr: unknown;
  if (Array.isArray(statuses)) arr = statuses;
  else if (typeof statuses === "string") {
    try {
      arr = JSON.parse(statuses);
    } catch {
      return null;
    }
  } else return null;
  if (!Array.isArray(arr)) return null;
  // Mixed junk means the shape changed upstream — say unknown, don't guess.
  if (!arr.every((x) => typeof x === "string")) return null;
  if (arr.length === 0) return false; // nothing proposed yet
  const last = arr[arr.length - 1] as string;
  if (last === "disputed") return true;
  if (last === "proposed" || last === "resolved") return false;
  return null; // unobserved status value
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && Number.isFinite(Number(v))
      ? Number(v)
      : null;

const jsonArr = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

// Lenient row normalization — gamma rows vary across market types, so missing
// fields degrade to null instead of dropping the whole market.
function normalize(row: Record<string, unknown>): MarketMeta | null {
  const conditionId =
    typeof row.conditionId === "string" ? row.conditionId : null;
  if (!conditionId) return null;
  return {
    conditionId,
    volume24hr: num(row.volume24hr),
    liquidity: num(row.liquidityNum) ?? num(row.liquidity),
    endDate: typeof row.endDate === "string" ? row.endDate : null,
    closed: row.closed === true,
    category: typeof row.category === "string" ? row.category : null,
    outcomes: jsonArr(row.outcomes).map(String),
    outcomePrices: jsonArr(row.outcomePrices)
      .map((p) => num(p))
      .map((p) => p ?? NaN),
    clobTokenIds: jsonArr(row.clobTokenIds).map(String),
    feesEnabled: row.feesEnabled === true,
    feeType: typeof row.feeType === "string" ? row.feeType : null,
    feeSchedule: parseFeeSchedule(row.feeSchedule),
    umaDisputed: parseUmaDisputed(
      row.umaResolutionStatus,
      row.umaResolutionStatuses,
    ),
  };
}

// One chunked sweep over /markets with an optional extra query-string suffix,
// merging normalized rows into `out`. A failing chunk (transient 5xx /
// timeout) is skipped, not thrown: the markets it covered simply stay absent
// so callers retry them later, while every other chunk's results are kept.
async function sweepMarkets(
  ids: string[],
  extraQs: string,
  out: Record<string, MarketMeta>,
): Promise<void> {
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const qs =
      chunk.map((c) => `condition_ids=${encodeURIComponent(c)}`).join("&") +
      extraQs;
    try {
      // Shared transient-5xx retry: a chunk is only skipped once retries are
      // exhausted (or the failure is non-transient).
      const res = await fetchWithRetry(`${GAMMA_API}/markets?${qs}`, {
        timeoutMs: 10_000,
        headers: { "User-Agent": "polymarket-monitor" },
        label: "gamma",
      });
      if (!res.ok) {
        console.warn(
          `[gamma] chunk fetch failed (${res.status}), skipping ${chunk.length} ids`,
        );
        continue;
      }
      const raw = await res.json();
      if (!Array.isArray(raw)) continue;
      for (const row of raw) {
        const meta = normalize(row as Record<string, unknown>);
        if (meta) out[meta.conditionId] = meta;
      }
    } catch (e) {
      console.warn(
        `[gamma] chunk fetch error, skipping ${chunk.length} ids:`,
        e,
      );
    }
  }
}

export async function fetchMarketMeta(
  conditionIds: string[],
): Promise<Record<string, MarketMeta>> {
  const distinct = [...new Set(conditionIds.filter(Boolean))];
  const out: Record<string, MarketMeta> = {};
  // Verified live: /markets EXCLUDES closed markets unless closed=true is
  // passed explicitly — a settled market returns 0 rows on the plain query.
  // So: first sweep gets open markets, and whatever is still missing gets a
  // second closed=true sweep. Without this, settlement backfill (which needs
  // closed markets by definition) would never resolve anything.
  await sweepMarkets(distinct, "", out);
  const missing = distinct.filter((c) => !out[c]);
  if (missing.length > 0) {
    await sweepMarkets(missing, "&closed=true", out);
  }
  return out;
}

const DEFAULT_TTL_SEC = 3600;

// Cached-shape version. CLOSED markets never expire (that immutability is what
// lets settlement backfill treat gamma as a permanent resolution source), so a
// newly added field would stay NULL on those rows forever. Bumping this makes
// every stale-shaped row a cache miss exactly once.
//   1 → 2: feesEnabled / feeType / feeSchedule / umaDisputed
//   2 → 3: clobTokenIds(反向对照档翻边定位对面 token 用)
const META_V = 3;

// A closed-but-DISPUTED market is not final — UMA can overturn it — so it must
// keep refreshing instead of inheriting the permanent-cache rule.
const DISPUTED_TTL_SEC = 1800;

/**
 * SQLite-cached market metadata keyed by conditionId (market_meta table).
 * Open markets refresh hourly (volume/liquidity drift); CLOSED markets are
 * final — their cache never expires, which is what lets the settlement
 * backfill treat gamma as a permanent resolution source.
 * Fetch errors degrade to "missing" (absent key) so callers always get a map.
 */
export async function getMarketMeta(
  db: DB,
  conditionIds: string[],
  opts: {
    ttlSec?: number;
    fetcher?: typeof fetchMarketMeta;
    nowSec?: number;
  } = {},
): Promise<Record<string, MarketMeta>> {
  const {
    ttlSec = DEFAULT_TTL_SEC,
    fetcher = fetchMarketMeta,
    nowSec = Math.floor(Date.now() / 1000),
  } = opts;
  const distinct = [...new Set(conditionIds.filter(Boolean))];
  const sel = db.prepare(
    "SELECT meta_json, fetched_at FROM market_meta WHERE condition_id = ?",
  );
  const ins = db.prepare(
    "INSERT OR REPLACE INTO market_meta (condition_id, meta_json, fetched_at) VALUES (?, ?, ?)",
  );
  const out: Record<string, MarketMeta> = {};
  const misses: string[] = [];
  for (const cid of distinct) {
    const row = sel.get(cid) as
      { meta_json: string; fetched_at: number } | undefined;
    if (!row) {
      misses.push(cid);
      continue;
    }
    try {
      const meta = JSON.parse(row.meta_json) as MarketMeta & { v?: number };
      if (meta.v !== META_V) {
        misses.push(cid); // stale shape — refetch once, then it sticks
        continue;
      }
      const age = nowSec - row.fetched_at;
      // Closed = resolved = immutable, EXCEPT while a dispute is live: UMA can
      // still overturn it, so the permanent-cache shortcut must not apply.
      // Math.min, NOT a flat DISPUTED_TTL_SEC: a caller asking for a SHORTER
      // ttl must never be lengthened by this branch. /api/consensus passes
      // ttlSec=60 because it reads meta for CURRENT prices, and serving those
      // 30 minutes stale would misinform the 仍可跟 / 已跑 call.
      const fresh = meta.umaDisputed
        ? age < Math.min(ttlSec, DISPUTED_TTL_SEC)
        : meta.closed || age < ttlSec;
      if (fresh) {
        out[cid] = meta;
      } else {
        misses.push(cid);
      }
    } catch {
      misses.push(cid);
    }
  }
  if (misses.length > 0) {
    try {
      const fetched = await fetcher(misses);
      for (const [cid, meta] of Object.entries(fetched)) {
        ins.run(cid, JSON.stringify({ ...meta, v: META_V }), nowSec);
        out[cid] = meta;
      }
    } catch (e) {
      console.warn("[gamma] meta fetch failed (degrading to cached-only):", e);
    }
  }
  return out;
}

/* ------------------------------------------------------- Event categories */

// The `category` field on /markets rows is null for most modern markets — the
// real taxonomy lives in EVENT TAGS (verified live: /events?slug= returns
// tags like ["Soccer","Sports","FIFA World Cup"]). The first major label
// found in the tags becomes the market's category; niche tags fall through
// to the first label.
const PRIMARY_CATEGORIES = [
  "Politics",
  "Elections",
  "Sports",
  "Esports",
  "Crypto",
  "Economy",
  "Finance",
  "Business",
  "Tech",
  "Science",
  "Pop Culture",
  "Culture",
  "World",
  "Weather",
];

// 二级分类白名单(2026-08-13,设计见 docs/plans/2026-08-13-event-
// subcategory-design.md §1)。为什么是白名单而不是「取第一个非主类标签」:
// 真机实测 tags 顺序不可靠(MLB 是 ['Sports','Games','MLB','baseball'] 主类
// 反而在前)且噪音标签是开放集合('Games'/'Weekly'/'Recurring'/'Earn 4%'…),
// 黑名单挡不完 —— 只有精选白名单能保证二级永远是「读者认识的联盟/资产/
// 主题」。联赛级标签(UCL/FA Cup/Leagues Cup)刻意不进:让它落到
// 'Soccer',三级粒度在当前样本量下没有胜率解释力。派生规则:按 tags 原始
// 顺序扫描、跳过与一级同名的标签、命中白名单的第一个即二级;无命中 = ''
// (known-none,诚实置空,绝不落噪音)。税法随数据增长,补条目即可。
const SUBCATEGORIES = new Set([
  // 体育联盟/项目(用户点名的重灾区:NBA 与足球的胜率分布差异巨大)
  "NBA",
  "WNBA",
  "NFL",
  "MLB",
  "NHL",
  "Soccer",
  "Tennis",
  "Golf",
  "Boxing",
  "MMA",
  "UFC",
  "F1",
  "Formula 1",
  "Cricket",
  "Rugby",
  "College Football",
  "College Basketball",
  // 电竞(CS2 类事件的 primary 是 Sports —— PRIMARY_CATEGORIES 里 Sports
  // 先于 Esports;专名标签实测排在 Esports 前,单遍扫描自然取到最细的)
  "Esports",
  "CS2",
  "League of Legends",
  "Dota 2",
  "Valorant",
  // 加密资产
  "Bitcoin",
  "Ethereum",
  "Solana",
  "XRP",
  "Dogecoin",
  // 政治
  "Geopolitics",
]);

/** 事件税法:一级 + 二级。'' 与 null 语义见 getEventCategories 注释。 */
export interface EventTaxonomy {
  category: string | null;
  subcategory: string | null;
}

/**
 * Batched event-tag lookup: slug -> { 一级, 二级 } 标签。A slug covered by
 * a SUCCESSFUL chunk but lacking tags maps to { "", "" } (known-none) so
 * callers can cache the miss; slugs in failed chunks are simply absent
 * (retry later). 一级派生逻辑与二级上线前逐字相同(admission/筛选/集中度
 * 全依赖它的取值稳定);二级按 SUBCATEGORIES 白名单派生,见其注释。
 */
export async function fetchEventCategories(
  slugs: string[],
): Promise<Record<string, { category: string; subcategory: string }>> {
  const distinct = [...new Set(slugs.filter(Boolean))];
  const out: Record<string, { category: string; subcategory: string }> = {};
  for (let i = 0; i < distinct.length; i += CHUNK) {
    const chunk = distinct.slice(i, i + CHUNK);
    const qs = chunk.map((s) => `slug=${encodeURIComponent(s)}`).join("&");
    try {
      const res = await fetch(`${GAMMA_API}/events?${qs}`, {
        signal: AbortSignal.timeout(10_000),
        headers: { "User-Agent": "polymarket-monitor" },
      });
      if (!res.ok) {
        console.warn(
          `[gamma] events chunk failed (${res.status}), skipping ${chunk.length} slugs`,
        );
        continue;
      }
      const raw = await res.json();
      if (!Array.isArray(raw)) continue;
      // Successful chunk: every requested slug is now KNOWN (possibly "").
      for (const s of chunk) out[s] = { category: "", subcategory: "" };
      for (const ev of raw) {
        const slug = typeof ev?.slug === "string" ? ev.slug : null;
        if (!slug || !(slug in out)) continue;
        const labels: string[] = Array.isArray(ev?.tags)
          ? ev.tags
              .map((t: { label?: unknown }) => t?.label)
              .filter((l: unknown): l is string => typeof l === "string")
          : [];
        const primary =
          PRIMARY_CATEGORIES.find((c) => labels.includes(c)) ?? labels[0];
        if (!primary) continue; // tagless:保持 known-none
        const sub =
          labels.find((l) => l !== primary && SUBCATEGORIES.has(l)) ?? "";
        out[slug] = { category: primary, subcategory: sub };
      }
    } catch (e) {
      console.warn(
        `[gamma] events chunk error, skipping ${chunk.length} slugs:`,
        e,
      );
    }
  }
  return out;
}

/**
 * SQLite-cached event taxonomy (event_category table). Tags are effectively
 * immutable, so known results — including known-none ("") — cache permanently;
 * failed lookups stay uncached and retry. Returns slug -> EventTaxonomy
 * (每个请求的 slug 都有键;'' 哨兵在这里转成 null 供展示层消费)。
 *
 * 懒回填(2026-08-13 二级分类上线):subcategory 列是后加的,老缓存行该列
 * 为 NULL —— 读到 NULL 视为 miss、连同新 slug 一起重抓,两列同写、
 * fetched_at 刷新,老缓存随访问自动升级,不需要一次性迁移脚本。
 * NULL(未按新税法回填)与 ''(抓过但无二级)是两个状态:'' 行不重抓,
 * 与一级的 known-none 永久缓存同一纪律。重抓失败时降级供旧行的一级
 * (比 null 更接近事实 —— 一级本来就抓到过),二级保持 null 下次再试,
 * 不清空、不覆写旧行。
 */
export async function getEventCategories(
  db: DB,
  slugs: string[],
  opts: {
    fetcher?: typeof fetchEventCategories;
    nowSec?: number;
  } = {},
): Promise<Record<string, EventTaxonomy>> {
  const {
    fetcher = fetchEventCategories,
    nowSec = Math.floor(Date.now() / 1000),
  } = opts;
  const distinct = [...new Set(slugs.filter(Boolean))];
  const sel = db.prepare(
    "SELECT category, subcategory FROM event_category WHERE event_slug = ?",
  );
  const ins = db.prepare(
    "INSERT OR REPLACE INTO event_category (event_slug, category, subcategory, fetched_at) VALUES (?, ?, ?, ?)",
  );
  const out: Record<string, EventTaxonomy> = {};
  const misses: string[] = [];
  // 老行(subcategory 为 NULL)也进 misses 重抓,但记住旧一级 —— 重抓失败
  // 时降级用(见函数头注释)。
  const staleCategory = new Map<string, string | null>();
  for (const s of distinct) {
    const row = sel.get(s) as
      { category: string | null; subcategory: string | null } | undefined;
    if (row && row.subcategory != null) {
      out[s] = {
        category: row.category || null,
        subcategory: row.subcategory || null,
      };
    } else {
      if (row) staleCategory.set(s, row.category || null);
      misses.push(s);
    }
  }
  if (misses.length > 0) {
    const fetched = await fetcher(misses);
    for (const s of misses) {
      if (s in fetched) {
        ins.run(s, fetched[s].category, fetched[s].subcategory, nowSec);
        out[s] = {
          category: fetched[s].category || null,
          subcategory: fetched[s].subcategory || null,
        };
      } else {
        // chunk failed — uncached (或老行保持原样), retried next time。
        out[s] = {
          category: staleCategory.get(s) ?? null,
          subcategory: null,
        };
      }
    }
  }
  return out;
}

// Per-trade market context derived from meta — the "what does this money mean
// for THIS market" layer attached to alerts.
export interface TradeMarketContext {
  impact24h: number | null; // tradeUsd / 24h volume
  liquidityShare: number | null; // tradeUsd / market liquidity
  liquidity: number | null;
  volume24hr: number | null;
  hoursToEnd: number | null; // null when closed or endDate missing/past-unknown
  category: string | null;
}

export function tradeMarketContext(
  tradeUsd: number,
  meta: MarketMeta | undefined,
  nowSec: number,
): TradeMarketContext | null {
  if (!meta) return null;
  const endMs = meta.endDate ? Date.parse(meta.endDate) : NaN;
  const hoursToEnd =
    !meta.closed && Number.isFinite(endMs)
      ? Math.max(0, (endMs / 1000 - nowSec) / 3600)
      : null;
  return {
    impact24h:
      meta.volume24hr && meta.volume24hr > 0
        ? tradeUsd / meta.volume24hr
        : null,
    liquidityShare:
      meta.liquidity && meta.liquidity > 0 ? tradeUsd / meta.liquidity : null,
    liquidity: meta.liquidity,
    volume24hr: meta.volume24hr,
    hoursToEnd,
    category: meta.category,
  };
}
