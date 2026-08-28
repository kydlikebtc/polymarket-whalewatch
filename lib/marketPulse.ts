import type { DB } from "./db";

// /pulse 的读取层:异常市场日榜 + 散户vs鲸鱼分歧,全部从 market_daily 现算
// (docs/plans/2026-08-27-content-engine-design.md §1-2)。评分刻意不落库 ——
// 公式还会演化,落库就要背回填;分量逐项返回,UI 必须能展开「为什么它异常」
// (战略总纲 §4.4:任何总分必须允许查看组成)。

export interface PulseComponents {
  /** 量能异动 0..1:基线 ≥3 天用 log10(今日/基线均值),否则横截面分位。 */
  volSurge: number;
  /** 单边度 0..1:顶结果 |净流| ÷ 总量。 */
  oneSided: number;
  /** 鲸鱼占比 0..1:≥$50k 单毛量 ÷ 总量。 */
  whaleShare: number;
  /** 日内价移 0..1:顶结果 |末−首| ÷ 20¢ 封顶。 */
  priceMove: number;
}

export interface PulseMarket {
  conditionId: string;
  title: string | null;
  slug: string | null;
  eventSlug: string | null;
  category: string | null;
  subcategory: string | null;
  volumeUsd: number;
  trades: number;
  walletCount: number;
  topOutcome: string | null;
  priceFirst: number | null;
  priceLast: number | null;
  score: number;
  components: PulseComponents;
  /** 量能基线天数(<3 = volSurge 用的是横截面分位,不是自身基线)。 */
  volBaselineDays: number;
  /** 今日量 ÷ 基线均值;基线不足为 null。 */
  volRatio: number | null;
  /**
   * 洗量占比(2026-08-28 八件套):2·wash_usd/volume_usd(库存单腿配对量,
   * 展示双腿口径)。列上线前的老日份为 null —— 不知道不显示 0。
   */
  washRatio: number | null;
}

/** 无鲸异动:价格大动却没有任何大单付账 = 薄簿或蚂蚁搬家。 */
export interface GhostRow {
  conditionId: string;
  title: string | null;
  slug: string | null;
  eventSlug: string | null;
  category: string | null;
  subcategory: string | null;
  volumeUsd: number;
  priceFirst: number;
  priceLast: number;
  moveCents: number;
  /** 当日单笔最大名义额(判定材料,≤ GHOST_MAX_FILL_USD 才算无鲸)。 */
  maxFillUsd: number;
  washRatio: number | null;
}

export interface WashRow {
  conditionId: string;
  title: string | null;
  slug: string | null;
  category: string | null;
  subcategory: string | null;
  volumeUsd: number;
  /** 单腿配对量(库存口径)。 */
  washUsd: number;
  /** 双腿口径占比 = 2·washUsd/volumeUsd。 */
  washRatio: number;
}

export interface DivergenceRow {
  conditionId: string;
  title: string | null;
  slug: string | null;
  category: string | null;
  subcategory: string | null;
  smallTopOutcome: string;
  smallNetUsd: number;
  whaleTopOutcome: string;
  whaleNetUsd: number;
  /** min(|小单净|, |鲸鱼净|) —— 两边都得有真金白银才算真分歧。 */
  strength: number;
}

export interface PulseReport {
  latestDay: string | null;
  /** 底座已积累的天数 —— 榜从部署日开始变厚,进度对外自述。 */
  dayCount: number;
  truncated: boolean;
  coveredFromSec: number | null;
  top: PulseMarket[];
  divergences: DivergenceRow[];
  /** 无鲸异动榜(2026-08-28 起,老日份缺判定材料不进榜)。按价移降序。 */
  ghosts: GhostRow[];
  /** 洗量榜:占比 ≥20% 且量 ≥$10k,占比降序。中性结构描述,非指控。 */
  washTop: WashRow[];
}

/** 材料性门槛:总量低于它的市场不进日榜(1 笔 $2k 单边度也是 1.0)。 */
export const PULSE_MIN_VOLUME_USD = 10_000;
export const DIVERGENCE_SMALL_MIN_USD = 5_000;
export const DIVERGENCE_WHALE_MIN_USD = 50_000;
/** 无鲸判定:价移下限(¢)与「没有任何一笔够大」的单笔上限。 */
export const GHOST_MIN_MOVE_CENTS = 10;
export const GHOST_MAX_FILL_USD = 10_000;
/** 洗量榜入榜占比下限(双腿口径)。 */
export const WASH_MIN_RATIO = 0.2;
const BASELINE_DAYS = 14;
const MIN_BASELINE_DAYS = 3;

interface DailyRow {
  condition_id: string;
  title: string | null;
  slug: string | null;
  event_slug: string | null;
  category: string | null;
  subcategory: string | null;
  trades: number;
  volume_usd: number;
  wallet_count: number;
  top_outcome: string | null;
  one_sided: number | null;
  small_usd: number | null;
  small_net_usd: number | null;
  small_top_outcome: string | null;
  whale_usd: number | null;
  whale_net_usd: number | null;
  whale_top_outcome: string | null;
  price_first: number | null;
  price_last: number | null;
  covered_from_sec: number | null;
  truncated: number | null;
  wash_usd: number | null;
  max_fill_usd: number | null;
}

/** 双腿口径洗量占比;原料缺失(老日份)或零量 → null。 */
const washRatioOf = (r: DailyRow): number | null =>
  r.wash_usd != null && r.volume_usd > 0
    ? clamp01((2 * r.wash_usd) / r.volume_usd)
    : null;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export function buildPulse(
  db: DB,
  opts: { day?: string; topN?: number } = {},
): PulseReport {
  const topN = opts.topN ?? 10;
  const latest =
    opts.day ??
    (
      db.prepare("SELECT MAX(day) AS d FROM market_daily").get() as {
        d: string | null;
      }
    ).d ??
    null;
  const dayCount = (
    db.prepare("SELECT COUNT(DISTINCT day) AS n FROM market_daily").get() as {
      n: number;
    }
  ).n;
  if (latest == null) {
    return {
      latestDay: null,
      dayCount,
      truncated: false,
      coveredFromSec: null,
      top: [],
      divergences: [],
      ghosts: [],
      washTop: [],
    };
  }

  const rows = db
    .prepare("SELECT * FROM market_daily WHERE day = ?")
    .all(latest) as DailyRow[];

  // 同市场 ≤14 天基线(不含当日)。day 是 yyyy-mm-dd 文本,字典序即时间序。
  const cutoff = new Date(
    new Date(`${latest}T00:00:00Z`).getTime() - BASELINE_DAYS * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  const baselines = new Map<string, { n: number; mean: number }>();
  for (const b of db
    .prepare(
      `SELECT condition_id, COUNT(*) AS n, AVG(volume_usd) AS mean
       FROM market_daily WHERE day < ? AND day >= ? GROUP BY condition_id`,
    )
    .all(latest, cutoff) as {
    condition_id: string;
    n: number;
    mean: number;
  }[]) {
    baselines.set(b.condition_id, { n: b.n, mean: b.mean });
  }

  // 横截面分位备胎:自身基线不足 3 天时,用「当日在所有市场里的量能排位」。
  const volsAsc = rows.map((r) => r.volume_usd).sort((a, b) => a - b);
  const percentile = (v: number): number => {
    if (volsAsc.length <= 1) return 0.5;
    let below = 0;
    for (const x of volsAsc) if (x < v) below++;
    return below / (volsAsc.length - 1);
  };

  const scored: PulseMarket[] = rows
    .filter((r) => r.volume_usd >= PULSE_MIN_VOLUME_USD)
    .map((r) => {
      const base = baselines.get(r.condition_id);
      const volBaselineDays = base?.n ?? 0;
      const volRatio =
        base != null && base.n >= MIN_BASELINE_DAYS && base.mean > 0
          ? r.volume_usd / base.mean
          : null;
      const volSurge =
        volRatio != null
          ? clamp01(Math.log10(Math.max(volRatio, 1)))
          : percentile(r.volume_usd);
      const oneSided = clamp01(r.one_sided ?? 0);
      const whaleShare =
        r.volume_usd > 0 ? clamp01((r.whale_usd ?? 0) / r.volume_usd) : 0;
      const priceMove =
        r.price_first != null && r.price_last != null
          ? clamp01(Math.abs(r.price_last - r.price_first) / 0.2)
          : 0;
      const components = { volSurge, oneSided, whaleShare, priceMove };
      const score = Math.round(
        100 *
          (0.35 * volSurge +
            0.25 * oneSided +
            0.2 * whaleShare +
            0.2 * priceMove),
      );
      return {
        conditionId: r.condition_id,
        title: r.title,
        slug: r.slug,
        eventSlug: r.event_slug,
        category: r.category,
        subcategory: r.subcategory,
        volumeUsd: r.volume_usd,
        trades: r.trades,
        walletCount: r.wallet_count,
        topOutcome: r.top_outcome,
        priceFirst: r.price_first,
        priceLast: r.price_last,
        score,
        components,
        volBaselineDays,
        volRatio,
        washRatio: washRatioOf(r),
      };
    })
    .sort((a, b) => b.score - a.score || b.volumeUsd - a.volumeUsd)
    .slice(0, topN);

  const divergences: DivergenceRow[] = rows
    .filter(
      (r) =>
        r.small_top_outcome != null &&
        r.whale_top_outcome != null &&
        r.small_top_outcome !== r.whale_top_outcome &&
        (r.small_net_usd ?? 0) >= DIVERGENCE_SMALL_MIN_USD &&
        (r.whale_net_usd ?? 0) >= DIVERGENCE_WHALE_MIN_USD,
    )
    .map((r) => ({
      conditionId: r.condition_id,
      title: r.title,
      slug: r.slug,
      category: r.category,
      subcategory: r.subcategory,
      smallTopOutcome: r.small_top_outcome!,
      smallNetUsd: r.small_net_usd!,
      whaleTopOutcome: r.whale_top_outcome!,
      whaleNetUsd: r.whale_net_usd!,
      strength: Math.min(r.small_net_usd!, r.whale_net_usd!),
    }))
    .sort((a, b) => b.strength - a.strength);

  // 无鲸异动:价移剧烈 + 当日没有任何一笔够大。max_fill_usd 为 null 的老
  // 日份不进榜 —— 「不知道有没有鲸」不等于「无鲸」。
  const ghosts: GhostRow[] = rows
    .filter(
      (r) =>
        r.volume_usd >= PULSE_MIN_VOLUME_USD &&
        r.price_first != null &&
        r.price_last != null &&
        Math.abs(r.price_last - r.price_first) * 100 >= GHOST_MIN_MOVE_CENTS &&
        r.max_fill_usd != null &&
        r.max_fill_usd < GHOST_MAX_FILL_USD,
    )
    .map((r) => ({
      conditionId: r.condition_id,
      title: r.title,
      slug: r.slug,
      eventSlug: r.event_slug,
      category: r.category,
      subcategory: r.subcategory,
      volumeUsd: r.volume_usd,
      priceFirst: r.price_first!,
      priceLast: r.price_last!,
      moveCents: Math.abs(r.price_last! - r.price_first!) * 100,
      maxFillUsd: r.max_fill_usd!,
      washRatio: washRatioOf(r),
    }))
    .sort((a, b) => b.moveCents - a.moveCents);

  const washTop: WashRow[] = rows
    .map((r) => ({ r, ratio: washRatioOf(r) }))
    .filter(
      (x): x is { r: DailyRow; ratio: number } =>
        x.ratio != null &&
        x.ratio >= WASH_MIN_RATIO &&
        x.r.volume_usd >= PULSE_MIN_VOLUME_USD,
    )
    .map(({ r, ratio }) => ({
      conditionId: r.condition_id,
      title: r.title,
      slug: r.slug,
      category: r.category,
      subcategory: r.subcategory,
      volumeUsd: r.volume_usd,
      washUsd: r.wash_usd!,
      washRatio: ratio,
    }))
    .sort((a, b) => b.washRatio - a.washRatio);

  const truncated = rows.some((r) => (r.truncated ?? 0) === 1);
  const coveredFromSec = rows.length > 0 ? rows[0].covered_from_sec : null;

  return {
    latestDay: latest,
    dayCount,
    truncated,
    coveredFromSec,
    top: scored,
    divergences,
    ghosts,
    washTop,
  };
}
