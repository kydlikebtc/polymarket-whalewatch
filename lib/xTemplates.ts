// 𝕏 播报的自定义文案模板 —— /manage 可配,空 = 用内置文案。
//
// 存储与 xSettings/xParams 同一套纪律:config 表 JSON 一行、逐键校验、
// 坏值降级默认(null=内置)、真实变更才写 config_history、引擎每轮重读。
//
// 校验哲学:写侧尽量拦(未知占位符/缺 {title}/夹带 URL/底座超长都是 400),
// 运行侧仍有 composer 的回退安全网(结构坏/渲染出 URL/超 280 → 内置文案)
// —— 模板永远只能影响「怎么说」,不能打破 280 与成本两条硬不变量。
import type { DB } from "./db";
import type { XPostKind } from "./xSettings";
import {
  SETTLE_PROMISE_LINE,
  TEMPLATE_VOCAB,
  X_POST_MAX_CHARS,
  collapseBlank,
  renderTemplate,
  weightedLength,
} from "./xComposer";

export type XTemplates = Record<XPostKind, string | null>;

export const DEFAULT_X_TEMPLATES: XTemplates = {
  whale: null,
  consensus: null,
  pregame: null,
  weekly: null,
  settled: null,
  scorecard: null,
  pulse: null,
  divergence: null,
};

/**
 * 没有单一市场标题的 kind —— 校验时不要求 {title},也不走 fitPost 的截断
 * 保护(它们的变量都是短量,composer 自带长度阶梯)。
 *   · weekly:全站周汇总,还是唯一允许 {url} 的一类;
 *   · scorecard:全日战果汇总。
 */
const TITLELESS_KINDS = new Set<XPostKind>(["weekly", "scorecard"]);

const CONFIG_KEY = "x_broadcast_templates";

export function getXTemplates(db: DB): XTemplates {
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(CONFIG_KEY) as { value: string | null } | undefined;
  if (!row || !row.value) return { ...DEFAULT_X_TEMPLATES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    console.warn(
      `[xTemplates] corrupt JSON for '${CONFIG_KEY}', using defaults`,
    );
    return { ...DEFAULT_X_TEMPLATES };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...DEFAULT_X_TEMPLATES };
  }
  const p = parsed as Record<string, unknown>;
  const out = { ...DEFAULT_X_TEMPLATES };
  for (const k of Object.keys(DEFAULT_X_TEMPLATES) as XPostKind[]) {
    const v = p[k];
    // 只接受非空字符串;空串/null/坏类型一律回落 null(内置文案)。
    if (typeof v === "string" && v.trim() !== "") out[k] = v;
  }
  return out;
}

export function setXTemplates(db: DB, t: XTemplates): void {
  const next = JSON.stringify(t);
  const prev = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(CONFIG_KEY) as { value: string | null } | undefined;
  if (prev?.value !== next) {
    db.prepare(
      "INSERT INTO config_history (key, value, changed_at) VALUES (?, ?, ?)",
    ).run(CONFIG_KEY, next, Math.floor(Date.now() / 1000));
  }
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    CONFIG_KEY,
    next,
  );
}

// 校验用样本值:代表性【长度】(偏富的一档),不要求与 composer 输出逐字
// 一致 —— 用途只有两个:底座长度估算与 UI 预览。真实渲染以 composer 为准。
const SAMPLE_VARS: Record<XPostKind, Record<string, string>> = {
  whale: {
    icon: "🏆",
    label: "SMART MONEY",
    amount: "$204K",
    verb: "says",
    outcome: "YES",
    price: "67¢",
    impact: "more than this market's entire 24h volume",
    track: "Track record: 74% win rate · +$1.2M PnL",
    facts: "📊 94% of 24h vol · 💧 $186K liq · ⏳ 136d to settle",
    promise: SETTLE_PROMISE_LINE,
    tags: "#Polymarket #Sports #SuperBowl",
  },
  consensus: {
    walletCount: "3",
    outcome: "Nongshim Red Force",
    avgPrice: "49¢",
    money: "$33.9K within 14 min",
    receipts:
      "🏆 $12.5K @ 64¢ · 74% win rate\n🏆 $9.6K @ 45¢ · 57% win rate\n🏆 $8.1K @ 51¢ · 61% win rate",
    rates: "74% · 57% · 61%",
    tags: "#Polymarket #Esports #LeagueOfLegends",
  },
  pregame: {
    countdown: "3H",
    stance: "smart money is 7-to-1 on Los Angeles Lakers",
    lean: "Los Angeles Lakers @ 61¢",
    signals: "12 signals in 24h",
    money: "$310K on Los Angeles Lakers vs $42K on Boston Celtics",
    tags: "#Polymarket #Sports",
  },
  settled: {
    result: "✅ CALLED IT",
    priceMove: "40¢ → $1.00 (+150%)",
    signal: "Consensus signal",
    outcome: "Baltimore Orioles",
    ago: "2d ago",
    stance: "We post every result, wins and losses.",
    tags: "#Polymarket #MLB",
  },
  scorecard: {
    day: "Aug 30 (UTC)",
    settled: "12",
    wins: "8",
    hitRate: "67%",
    rows:
      "✅ +138% Will Sunderland AFC win on 2026-08-30?\n" +
      "❌ Will SSC Napoli win on 2026-08-30?",
    stance: "Win or lose, every call gets its receipt.",
    tags: "#Polymarket #PredictionMarkets",
  },
  weekly: {
    week: "Aug 10–16",
    settled: "42",
    winRate: "55%",
    pnl: "+$1.2K",
    best: "Mega Whale",
    bestRoi: "+12.3%",
    url: "https://whalewatch.wired.fund/follow?utm_source=x",
    tags: "#Polymarket #PredictionMarkets",
  },
  pulse: {
    day: "Aug 26 (UTC)",
    score: "84",
    why: "10.7× its volume baseline · 70% one-sided · whales 56% of flow",
    runners: "#2 Fed cuts in September? (45) · #3 US Open WTA qualifier (41)",
    tags: "#Polymarket #Sports #NBA",
  },
  divergence: {
    smallOutcome: "UNDER",
    smallUsd: "$33.7K",
    whaleOutcome: "OVER",
    whaleUsd: "$473K",
    kicker: "One side is wrong.",
    tags: "#Polymarket #Sports",
  },
};

/** 模板渲染预览(样本数据)。UI 展示用,与保存校验同一份样本。 */
export function previewXTemplate(kind: XPostKind, tpl: string): string {
  const vars = TITLELESS_KINDS.has(kind)
    ? SAMPLE_VARS[kind]
    : { ...SAMPLE_VARS[kind], title: "Will Bitcoin hit $150,000 by Dec 31?" };
  return collapseBlank(renderTemplate(tpl, vars));
}

export function validateXTemplate(
  kind: XPostKind,
  tpl: string,
): { ok: true } | { ok: false; error: string } {
  const vocab = new Set<string>(TEMPLATE_VOCAB[kind]);
  const unknown = new Set<string>();
  for (const m of tpl.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
    if (!vocab.has(m[1])) unknown.add(m[1]);
  }
  if (unknown.size > 0) {
    return {
      ok: false,
      error: `未知占位符 {${[...unknown].join("} {")}} —— ${kind} 可用:{${TEMPLATE_VOCAB[kind].join("} {")}}`,
    };
  }
  // URL 闸独立于「有没有 {title}」:唯一的例外是 weekly(那是刻意的
  // $0.20 导流帖)。scorecard 同属无标题一类,但绝不能因此顺带拿到带链接
  // 的许可 —— 成本口子的边界是 kind,不是「有没有标题锚点」。
  if (kind !== "weekly" && /https?:\/\//i.test(tpl)) {
    return {
      ok: false,
      error:
        "模板不能包含链接:带链接帖 $0.20/条(无链接的 13 倍),成本口子在模板层焊死;只有周报允许 {url}",
    };
  }
  if (!TITLELESS_KINDS.has(kind)) {
    const titles = (tpl.match(/\{title\}/g) ?? []).length;
    if (titles !== 1) {
      return {
        ok: false,
        error: `模板必须恰好包含一个 {title}(当前 ${titles} 个)—— 它是超长标题截断保护的锚点`,
      };
    }
    // 底座(除标题外的固定部分)≤278 加权:fitPost 截标题的前提,超了连
    // 省略号都放不下。样本取偏富的一档,故这是偏保守的估算。
    const base = weightedLength(
      collapseBlank(renderTemplate(tpl, { ...SAMPLE_VARS[kind], title: "" })),
    );
    if (base > X_POST_MAX_CHARS - 2) {
      return {
        ok: false,
        error: `模板固定部分约 ${base} 加权字符,超过 ${X_POST_MAX_CHARS - 2} 上限(X 以 280 加权字符折叠/拒发,还要给标题留位)`,
      };
    }
  } else {
    const full = weightedLength(previewXTemplate(kind, tpl));
    if (full > X_POST_MAX_CHARS) {
      return {
        ok: false,
        error: `渲染约 ${full} 加权字符,超过 ${X_POST_MAX_CHARS} 上限`,
      };
    }
  }
  return { ok: true };
}
