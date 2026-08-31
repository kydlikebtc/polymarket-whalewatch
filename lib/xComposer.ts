// X (Twitter) 帖文模板 —— 全部纯函数,无 I/O。
//
// 两条硬不变量(都有测试钉住):
//  1. ≤280 加权字符(weightedLength,X 的尺子)= 蓝V时间线的折叠位:蓝V下
//     超发不吃 400,而是静默折进 "Show more";非蓝V账号(/manage 可切换)
//     下仍是 API 硬限。降级走 fitPost 变体阶梯:先丢可选行,标题最后才截。
//  2. 除 weekly 外输出不得含 URL:X 按量付费对带链接帖收 $0.20/条(无链接
//     $0.015 的 13 倍),市场标题里混入的链接也要剥掉 —— 成本口子在模板层
//     就焊死,而不是指望上游数据干净。
// 语言:纯英文(设计定稿:X 面向全球用户,TG 频道继续服务中文用户)。

export const X_POST_MAX_CHARS = 280;

// X 的加权计数(twitter-text v3 口径):下列码点区间计 1,其余(emoji、└、…、
// ⏱ 等)计 2。旧实现用 [...s].length 数码点,每帖比 X 的算法少算 3~5 —— 填满
// 280 额度后这个差值就是折叠事故,必须按 X 的尺子量。
// 已知偏差:复合 emoji(VS16/旗帜/ZWJ 序列)按码点累加会比 X 实际多算,但
// 方向安全 —— 只会提前降档,不会折叠;当前模板 emoji 全是单码点,与 X 一致。
const WEIGHT_1_RANGES: [number, number][] = [
  [0, 4351], // 拉丁/西里尔/希腊等基本区
  [8192, 8205], // 常用空白与零宽
  [8208, 8223], // 连字符/引号/em dash
  [8242, 8247], // prime marks
];

export function weightedLength(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    w += WEIGHT_1_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return w;
}

// 大单帖的告警级前缀分档:🚨 是"停下来看"级别,与 TG 的 🐳/💰 分层同思路。
export const WHALE_SIREN_USD = 250_000;

/**
 * 抬头追加「超过全市场全天成交量」断言的门槛(百分数)。
 *
 * $121K 在 Polymarket 上不算罕见,但「一笔单子就等于该市场全天所有人的
 * 成交量」很罕见。时间线上读者只扫首行,最稀奇的那个事实必须放在那里,
 * 否则它躺在第三行佐证段中间等于没说。
 *
 * 门槛取 100% 而不是更低:低于 100% 的"80% of 24h volume"要读者自己换算
 * 才知道稀不稀奇,而"超过全天成交量"是一句不需要基准就成立的断言。
 */
export const IMPACT_HEADLINE_PCT = 100;

/** $184K / $1.25M / $900 —— X 上寸字寸金,K/M 压缩 + 去尾零。 */
export function usdCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 1000) return `${sign}$${Math.round(abs)}`;
  if (abs < 1_000_000) {
    const k = abs / 1000;
    const s = k >= 100 ? k.toFixed(0) : (Math.round(k * 10) / 10).toString();
    return `${sign}$${s}K`;
  }
  const m = Math.round((abs / 1_000_000) * 100) / 100;
  return `${sign}$${m}M`;
}

// Yes/No 大写成 YES/NO 是行业惯例(读者扫一眼就知道方向);球队/人名等长
// outcome 保持原样 —— 全大写长词是喊叫不是强调。
function outcomeDisplay(outcome: string): string {
  return outcome.length <= 3 ? outcome.toUpperCase() : outcome;
}

// ---- 话题标签 ----------------------------------------------------------
//
// 标签是 X 上的可发现性入口:不带标签的帖子只有关注者看得到,带了就能进
// 话题流。但标签也吃字符(280 硬上限),所以规则是「少而准」:
//   · #Polymarket 恒定 —— 这是账号赖以被找到的根标签;
//   · 赛道标签取二级优先(#NFL 比 #Sports 精准得多,受众也更集中),
//     没有二级才退到一级。
// 未知/脏值一律丢弃 —— 宁可少一个标签,也不要 #undefined 这种废标签。
//
// 2026-08-18 去掉了 #SmartMoney:它在加密圈已被营销号用滥,引来的是垃圾
// 流量而非目标读者;X 又对多标签帖降权。两个精准标签好过三个含泛滥词的。
const ROOT_TAG = "#Polymarket";

// 一级类别到标签的映射。gamma 给的是英文原文,多数可直接当标签;这里只
// 修正少数不适合做标签的写法,其余透传。
const CATEGORY_TAG: Record<string, string> = {
  Politics: "Politics",
  Elections: "Elections",
  Sports: "Sports",
  Esports: "Esports",
  Crypto: "Crypto",
  Economy: "Economy",
  Finance: "Finance",
  Business: "Business",
  Tech: "Tech",
  Science: "Science",
  Culture: "Culture",
  World: "World",
  Weather: "Weather",
  Games: "Gaming",
  Geopolitics: "Geopolitics",
};

/** 合法标签体:只留字母数字,首字符非数字。产不出就返回 null。 */
function toTag(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const body = raw.replace(/[^A-Za-z0-9]/g, "");
  if (!body || /^[0-9]/.test(body)) return null;
  return `#${body}`;
}

/**
 * 实体标签白名单:标题里出现这些主体时,补一个它自己的标签(币种为
 * cashtag,其余为话题标签)。
 *
 * 为什么用白名单而不是从标题自动抽词:自动抽必然产出 #Will / #June /
 * #Group 这类废标签,而废标签既稀释相关性权重又显得像机器人。名单驱动
 * 意味着「宁可不加」。
 *
 * 选词依据是本地告警标题的实际词频 + 该标签在 X 上是否真有活跃的流
 * (话题页或 cashtag 流):
 *   · 加密币种 —— $BTC 等 cashtag 流持续活跃,本地标题里也最高频(76)
 *   · 重大赛事 —— World Cup(86) / Wimbledon(42) 等赛期内流量极大
 *   · 电竞项目 —— LoL(37) / Dota(29) 各有稳定社区
 *   · 宏观政治 —— Fed / Trump / Election
 * 刻意不收的:国家名(#France 这类泛地理标签,绝大多数内容与预测市场无关)
 * 和具体球队名(写法不统一、单队标签流量低)。
 *
 * 顺序即优先级,只取第一个命中。全部用词边界,避免 Fed 误伤 Federer。
 *
 * ⚠️ 排序原则:**具体项目优先于泛赛事名**。实测踩过的坑 ——
 * "Counter-Strike: Team Falcons vs K27 — Esports World Cup" 若让 world cup
 * 先命中就会标成 #WorldCup,而那个标签在足球世界杯赛期会被足球内容彻底
 * 淹没,精准度反而不如不加。电竞项目、币种这类"标的本身"因此排在前面。
 */
const ENTITY_TAGS: [RegExp, string][] = [
  // 币种:标的即主体,最具体。用 cashtag 而非话题标签 —— cashtag 流是
  // 交易员真在监控的频道,受众比 #Bitcoin 话题页精准(2026-08-19 拍板)。
  [/\bbitcoin\b|\bbtc\b/i, "$BTC"],
  [/\bethereum\b|\beth\b/i, "$ETH"],
  [/\bsolana\b|\bsol\b/i, "$SOL"],
  [/\bxrp\b|\bripple\b/i, "$XRP"],
  [/\bdogecoin\b|\bdoge\b/i, "$DOGE"],
  // 电竞项目:必须排在 world cup 之前(Esports World Cup 是电竞赛事)。
  [/\bcounter-?strike\b|\bcs2\b/i, "#CS2"],
  [/\bleague of legends\b|\blol\b/i, "#LeagueOfLegends"],
  [/\bdota\b/i, "#Dota2"],
  [/\bvalorant\b/i, "#Valorant"],
  // 泛赛事名:只在没有更具体标的时才用。
  [/\bwimbledon\b/i, "#Wimbledon"],
  [/\bus open\b/i, "#USOpen"],
  [/\bsuper bowl\b/i, "#SuperBowl"],
  [/\bworld cup\b/i, "#WorldCup"],
  [/\bolympics?\b/i, "#Olympics"],
  // 宏观/政治。
  [/\btrump\b/i, "#Trump"],
  [/\bfederal reserve\b|\bfed\b/i, "#Fed"],
  [/\belections?\b/i, "#Election"],
];

/** 标题命中的实体标签,没有就 null。 */
export function entityTag(title: string | null | undefined): string | null {
  if (!title) return null;
  for (const [re, tag] of ENTITY_TAGS) if (re.test(title)) return tag;
  return null;
}

export interface TagInput {
  category?: string | null;
  subcategory?: string | null;
  /** 市场标题 —— 用于匹配实体标签(第三个标签)。 */
  title?: string | null;
}

/**
 * 组装标签行:#Polymarket + 赛道(二级优先) + 实体,去重且顺序稳定。
 *
 * 上限 3 个是刻意的:标签越多,每个标签上的相关性权重越稀释,而 X 对
 * 堆标签的帖子本就降权。三个的构成是「平台 + 赛道 + 主体」,彼此不重叠。
 */
export function buildTags(i: TagInput): string {
  const out: string[] = [ROOT_TAG];
  const track =
    toTag(i.subcategory) ??
    toTag(i.category ? (CATEGORY_TAG[i.category] ?? i.category) : null);
  if (track && !out.includes(track)) out.push(track);
  const entity = entityTag(i.title);
  if (entity && !out.includes(entity)) out.push(entity);
  return out.join(" ");
}

// 剥掉标题里的 URL(见文件头不变量 2)并收敛空白。
function sanitizeTitle(title: string): string {
  return title
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// 倒计时短格式,给结构化布局的佐证段用(那里已有 ⏳ 图标点题)。
function settleShort(hoursToEnd: number): string {
  if (hoursToEnd < 1) return "<1h to settle";
  if (hoursToEnd < 48) return `${Math.round(hoursToEnd)}h to settle`;
  return `${Math.round(hoursToEnd / 24)}d to settle`;
}

/**
 * 变体阶梯限长:variants 从最富到最简排列(每个 build 把 title 恰好嵌入一次),
 * 取第一个 ≤280 加权的;全超才截标题 —— 降级顺序从「砍标题」反转成「先丢可选
 * 事实行」:市场标题是读者判断"这事关不关我"的唯一依据,最后才动。
 *
 * 前提:最简变体底座须 ≤278 加权(留 2 给省略号)—— 由各模板的超长标题
 * 测试钉住。每个 build 必须把 title 恰好嵌入一次:嵌两次会少扣预算截不
 * 干净,嵌零次则标题无声丢失;底座超限时截断不收敛,输出仍超 280。
 */
export function fitPost(
  variants: ((title: string) => string)[],
  title: string,
): string {
  for (const build of variants) {
    const full = build(title);
    if (weightedLength(full) <= X_POST_MAX_CHARS) return full;
  }
  // 全部梯级超限:用最简梯级截标题。预算 = 280 − 模板底座 − 2("…"权 2);
  // 按字符逐个累权装入,一次收敛无过冲(加权下"超 N 砍 N 码点"会砍错量)。
  const lean = variants[variants.length - 1];
  const budget = X_POST_MAX_CHARS - weightedLength(lean("")) - 2;
  let used = 0;
  let keep = 0;
  const chars = [...title];
  for (const ch of chars) {
    const cw = weightedLength(ch);
    if (used + cw > budget) break;
    used += cw;
    keep++;
  }
  return lean(chars.slice(0, keep).join("") + "…");
}

// ---- 可配置文案模板(/manage「文案模板」区) ------------------------------
//
// {var} 占位符替换;值缺失渲染成空串,随后折叠多余空行 —— 操作者的模板不必
// 关心某段数据缺失。保存侧(lib/xTemplates.validateXTemplate)已做词表/
// 结构/URL/底座长度校验;这里仍留运行时安全网(手改库可绕过保存校验):
//   · {title} 必须恰好出现一次(fitPost 截断保护的前提),否则回退内置;
//   · 非 weekly 渲染出 URL → 回退内置($0.20 成本口子在模板层焊死);
//   · 渲染结果仍超 280 加权 → 回退内置(宁可用内置文案也不发折叠帖)。
export function renderTemplate(
  tpl: string,
  vars: Record<string, string>,
): string {
  return tpl.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, k: string) => vars[k] ?? "");
}

export function collapseBlank(s: string): string {
  return s
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderCustom(
  tpl: string,
  vars: Record<string, string>,
  title: string,
  allowUrl: boolean,
): string | null {
  if ((tpl.match(/\{title\}/g) ?? []).length !== 1) return null;
  const build = (t: string) =>
    collapseBlank(renderTemplate(tpl, { ...vars, title: t }));
  const out = fitPost([build], sanitizeTitle(title));
  if (!allowUrl && /https?:\/\//i.test(out)) return null;
  if (weightedLength(out) > X_POST_MAX_CHARS) return null;
  return out;
}

export interface WhalePostInput {
  usd: number;
  side: "BUY" | "SELL";
  outcome: string;
  title: string;
  priceCents: number;
  pct24h?: number | null;
  liquidityUsd?: number | null;
  hoursToEnd?: number | null;
  category?: string | null;
  subcategory?: string | null;
  /**
   * type='smart'(白名单聪明钱)时传入:凭证行数据。null 段省略,全 null 时
   * 凭证行整行不出但 🏆 抬头保留(「当时是白名单钱包」是告警时刻的事实)。
   * 不传/null = 匿名大单(type='large'),沿用 🐳/🚨 抬头。
   */
  smart?: { winRate?: number | null; netPnl?: number | null } | null;
  /**
   * 承诺行开关。调用方按双闸门判定(见 xBroadcast):hoursToEnd ≤144h
   * (xSettled 只补发 7 天内原帖,超过就是空头支票)且 settled 功能开着。
   */
  promiseSettled?: boolean;
  /** 🚨 警报级抬头分档线覆盖(/manage 可配):省略 = 出厂 WHALE_SIREN_USD。 */
  sirenUsd?: number;
  /** 自定义文案模板(/manage 可配):null/省略 = 内置文案。 */
  template?: string | null;
}

export const SETTLE_PROMISE_LINE = "Result posted at settlement — win or lose.";

const IMPACT_CLAIM = "more than this market's entire 24h volume";

/**
 * 模板词表:各 kind 的 {占位符} 全集(title 是特殊位,fitPost 截断保护的
 * 锚点)。保存侧用它拦未知占位符;composer 测试用「全词表模板」钉住
 * vars 构建与词表不漂移。值语义:数据缺失的段渲染为空串,模板不必设防。
 */
export const TEMPLATE_VOCAB: Record<
  | "whale"
  | "consensus"
  | "pregame"
  | "settled"
  | "scorecard"
  | "weekly"
  | "pulse"
  | "divergence",
  readonly string[]
> = {
  whale: [
    "title",
    "icon",
    "label",
    "amount",
    "verb",
    "outcome",
    "price",
    "impact",
    "track",
    "facts",
    "promise",
    "tags",
  ],
  consensus: [
    "title",
    "walletCount",
    "outcome",
    "avgPrice",
    "money",
    "receipts",
    "rates",
    "tags",
  ],
  pregame: ["title", "countdown", "stance", "lean", "signals", "money", "tags"],
  settled: [
    "title",
    "result",
    "priceMove",
    "signal",
    "outcome",
    "ago",
    "stance",
    "tags",
  ],
  // scorecard 无 {title}(全日汇总,没有单一市场)—— 与 weekly 同属
  // 「无标题锚点」的一类,见 xTemplates.TITLELESS_KINDS。
  scorecard: ["day", "settled", "wins", "hitRate", "rows", "stance", "tags"],
  weekly: [
    "week",
    "settled",
    "winRate",
    "pnl",
    "best",
    "bestRoi",
    "url",
    "tags",
  ],
  pulse: ["title", "day", "score", "why", "runners", "tags"],
  divergence: [
    "title",
    "smallOutcome",
    "smallUsd",
    "whaleOutcome",
    "whaleUsd",
    "kicker",
    "tags",
  ],
};

/**
 * 断言式抬头(v2):`$200K says NO @ 80¢` 是一句有立场的人话 —— quote-tweet
 * 的饵;`says {outcome}` 对任意 outcome 语法成立(says YES / says Lakers)。
 * BUY→says,SELL→sells(卖出≠看反,不硬造方向)。旧抬头 `🐳 WHALE BUY ·
 * $200K` 是类目标签,每条一样,读者视觉免疫;outcome+价格并入首行后,
 * 通知预览一行就能读完整个信号。
 *
 *   🐳 WHALE: $200K says NO @ 80¢
 *
 *   Will Bitcoin dip to $45,000 by December 31, 2026?
 *
 *   📊 94% of 24h vol · 💧 $186K liq · ⏳ 136d to settle
 *
 *   #Polymarket $BTC
 *
 * 佐证段哪项缺就省哪项,整段都没有就整行不要 —— 绝不用 0/N-A 占位。
 * 降级阶梯:丢承诺行 → 丢佐证行 → 丢凭证行 → 截标题。
 */
export function composeWhalePost(i: WhalePostInput): string {
  const isSmart = i.smart != null;
  const siren = i.sirenUsd ?? WHALE_SIREN_USD;
  const icon = isSmart ? "🏆" : i.usd >= siren ? "🚨" : "🐳";
  const label = isSmart ? "SMART MONEY" : "WHALE";
  const verb = i.side === "SELL" ? "sells" : "says";
  const headline = i.pct24h != null && i.pct24h >= IMPACT_HEADLINE_PCT;
  const head =
    `${icon} ${label}: ${usdCompact(i.usd)} ${verb} ` +
    `${outcomeDisplay(i.outcome)} @ ${i.priceCents}¢` +
    (headline ? ` — ${IMPACT_CLAIM}` : "");
  // Track record 凭证行(仅聪明钱)。
  const cred: string[] = [];
  if (isSmart) {
    const seg: string[] = [];
    const wr = i.smart?.winRate;
    if (wr != null) seg.push(`${Math.round(wr * 100)}% win rate`);
    const pnl = i.smart?.netPnl;
    // usdCompact 负数自带 - 号,只在 ≥0 时补 +。
    if (pnl != null) seg.push(`${pnl >= 0 ? "+" : ""}${usdCompact(pnl)} PnL`);
    if (seg.length > 0) cred.push(`Track record: ${seg.join(" · ")}`);
  }
  const facts: string[] = [];
  // 抬头已讲占比就不再在佐证段重复,把字符让给流动性/倒计时。
  if (i.pct24h != null && !headline)
    facts.push(`📊 ${Math.round(i.pct24h)}% of 24h vol`);
  if (i.liquidityUsd != null)
    facts.push(`💧 ${usdCompact(i.liquidityUsd)} liq`);
  if (i.hoursToEnd != null) facts.push(`⏳ ${settleShort(i.hoursToEnd)}`);
  // 实体标签按【原始标题】匹配,而不是可能被截断的展示标题 —— 否则
  // 长标题被截后会丢标签,同一个市场的帖子标签还会时有时无。
  const tags = buildTags({
    category: i.category,
    subcategory: i.subcategory,
    title: i.title,
  });
  if (i.template) {
    const out = renderCustom(
      i.template,
      {
        icon,
        label,
        amount: usdCompact(i.usd),
        verb,
        outcome: outcomeDisplay(i.outcome),
        price: `${i.priceCents}¢`,
        impact: headline ? IMPACT_CLAIM : "",
        track: cred.join("\n"),
        facts: facts.join(" · "),
        promise: i.promiseSettled === true ? SETTLE_PROMISE_LINE : "",
        tags,
      },
      i.title,
      false,
    );
    if (out != null) return out;
    // 模板不可用(结构坏/渲染出 URL/超长):回退内置,拒绝哑火。
  }
  const variant =
    (o: { facts?: boolean; cred?: boolean; promise?: boolean }) =>
    (title: string) => {
      const mid = [
        ...(o.cred ? cred : []),
        ...(o.facts && facts.length > 0 ? [facts.join(" · ")] : []),
      ];
      return (
        `${head}\n\n${title}` +
        (mid.length > 0 ? `\n\n${mid.join("\n")}` : "") +
        (o.promise ? `\n\n${SETTLE_PROMISE_LINE}` : "") +
        `\n\n${tags}`
      );
    };
  const promise = i.promiseSettled === true;
  const ladder = [variant({ facts: true, cred: true, promise })];
  if (promise) ladder.push(variant({ facts: true, cred: true }));
  ladder.push(variant({ cred: true }));
  if (cred.length > 0) ladder.push(variant({}));
  return fitPost(ladder, sanitizeTitle(i.title));
}

export interface ConsensusWalletReceipt {
  netUsd: number;
  avgPriceCents: number;
  winRate?: number | null; // 0-1
}

export interface ConsensusPostInput {
  walletCount: number;
  outcome: string;
  title: string;
  totalUsd: number;
  /** 聚钱的金额加权买入均价(¢)。缺失整段省略(老告警行没有,0¢ 像白送)。 */
  priceCents?: number | null;
  /** lastTs − firstTs。>60min 不讲(不稀奇就删句,以保诚实)。 */
  spanSec?: number | null;
  /** 逐钱包回执,netUsd 降序(payload 里本就有序)。老 payload 缺失 → 无回执。 */
  wallets?: ConsensusWalletReceipt[];
  category?: string | null;
  subcategory?: string | null;
  /** 自定义文案模板(/manage 可配):null/省略 = 内置文案。 */
  template?: string | null;
}

/**
 * 品牌抬头保持恒定(识别度即品牌),叙事下沉到 └ 行一句讲完,正文主体是
 * 逐钱包回执 —— 截图传播的主体,别家给不出:
 *
 *   🔥 SMART-MONEY CONSENSUS
 *
 *   LoL: Nongshim Red Force vs DN SOOPers - Game 2 Winner
 *   └ 2 top-PnL wallets → Nongshim Red Force @ 49¢ avg · $33.9K within 14 min
 *
 *   🏆 $12.5K @ 64¢ · 74% win rate
 *   🏆 $9.6K @ 45¢ · 57% win rate
 *
 *   #Polymarket #Esports #LeagueOfLegends
 *
 * 明确不放:钱包 PnL(装不下,小 PnL 反削弱说服力)、last fill Xm ago
 * (播报 ≤60s 一轮,发帖时刻≈最后一笔时刻,废字符)。
 * 降级阶梯:丢金额最小的回执行 → 坍缩成聚合胜率行 → 无凭证块 → 截标题。
 */
export function composeConsensusPost(i: ConsensusPostInput): string {
  const at = i.priceCents != null ? ` @ ${i.priceCents}¢ avg` : "";
  const within =
    i.spanSec != null && i.spanSec >= 0 && i.spanSec <= 3600
      ? ` within ${Math.max(1, Math.round(i.spanSec / 60))} min`
      : "";
  const money = within
    ? `${usdCompact(i.totalUsd)}${within}`
    : `${usdCompact(i.totalUsd)} combined`;
  // 回执行与聚合胜率行同源:前 3 个钱包(payload 本就按 netUsd 降序)——
  // 聚合行是回执的坍缩形态,口径不同则降档瞬间会凭空多出数字。
  const top3 = (i.wallets ?? []).slice(0, 3);
  const receipts = top3.map((w) => {
    const wr =
      w.winRate != null ? ` · ${Math.round(w.winRate * 100)}% win rate` : "";
    return `🏆 ${usdCompact(w.netUsd)} @ ${w.avgPriceCents}¢${wr}`;
  });
  const rates = top3
    .map((w) => w.winRate)
    .filter((r): r is number => r != null)
    .map((r) => `${Math.round(r * 100)}%`);
  const tags = buildTags({
    category: i.category,
    subcategory: i.subcategory,
    title: i.title,
  });
  if (i.template) {
    const out = renderCustom(
      i.template,
      {
        walletCount: String(i.walletCount),
        outcome: outcomeDisplay(i.outcome),
        avgPrice: i.priceCents != null ? `${i.priceCents}¢` : "",
        money,
        receipts: receipts.join("\n"),
        rates: rates.join(" · "),
        tags,
      },
      i.title,
      false,
    );
    if (out != null) return out;
  }
  // 恒定部分:抬头 + 标题 + 叙事 └ 行 —— 每个梯级都以它开场。
  const story = (title: string) =>
    `🔥 SMART-MONEY CONSENSUS\n\n${title}\n` +
    `└ ${i.walletCount} top-PnL wallets → ${outcomeDisplay(i.outcome)}${at} · ${money}`;
  const variant = (cred: string[]) => (title: string) =>
    story(title) +
    (cred.length > 0 ? `\n\n${cred.join("\n")}` : "") +
    `\n\n${tags}`;
  const ladder: ((t: string) => string)[] = [];
  if (receipts.length > 0) {
    // 下界 2:单行回执不成"共识"阵形 —— 两行起才是「多个钱包同向」的画面,
    // 只剩一行时直接坍缩到聚合行更诚实。N<2 时下界即 N(单钱包组仍给一级)。
    const floor = Math.min(2, receipts.length);
    for (let k = receipts.length; k >= floor; k--)
      ladder.push(variant(receipts.slice(0, k)));
  }
  if (rates.length > 0)
    ladder.push(variant([`🏆 Win rates: ${rates.join(" · ")}`]));
  ladder.push(variant([]));
  return fitPost(ladder, sanitizeTitle(i.title));
}

export interface PregameSide {
  name: string;
  usd: number; // 该结果上的 BUY 金额(24h)
}

export interface PregamePostInput {
  title: string;
  hoursToEnd: number;
  alertCount: number;
  /** sides[0] 的现价(¢),取不到就省略。 */
  topSidePriceCents?: number | null;
  /** 按 BUY 金额降序,composer 用前两个。空数组 = 无方向可讲。 */
  sides?: PregameSide[];
  category?: string | null;
  subcategory?: string | null;
  /** 自定义文案模板(/manage 可配):null/省略 = 内置文案。 */
  template?: string | null;
}

/**
 * 三种局面三种讲法(buyUsdByOutcome 存了两边,旧模板只讲 Leaning 一边):
 *   比例 ≥2   ⏰ SETTLES IN 3H — smart money is 7-to-1 on Lakers
 *   对面为 0  ⏰ SETTLES IN 6H — every signal is on Nongshim Red Force
 *   比例 <2   ⏰ SETTLES IN 2H — smart money is SPLIT on this one
 * 资金行:$310K on Lakers vs $42K on Celtics / all $13.1K on one side。
 * 分歧不硬讲成 Leaning —— SPLIT 本身就是好故事。
 */
export function composePregamePost(i: PregamePostInput): string {
  const hh = settleShort(i.hoursToEnd).replace(" to settle", "").toUpperCase();
  const s0 = i.sides?.[0];
  const s1 = i.sides?.[1];
  // 干净片段(无前缀/接缝),内置拼装与模板 vars 同源。
  let stanceClean = "";
  let leanPrefix = "";
  if (s0 && s0.usd > 0) {
    if (s1 && s1.usd > 0) {
      const ratio = s0.usd / s1.usd;
      if (ratio >= 2) {
        // floor 不是 round:2.5 说 3-to-1 是凭空夸大 20%,floor 永不夸大 ——
        // 「不编数字」是这个账号的品牌立场。
        stanceClean = `smart money is ${Math.floor(ratio)}-to-1 on ${outcomeDisplay(s0.name)}`;
      } else {
        stanceClean = "smart money is SPLIT on this one";
        leanPrefix = "Slight lean ";
      }
    } else {
      stanceClean = `every signal is on ${outcomeDisplay(s0.name)}`;
    }
  }
  const head = `⏰ SETTLES IN ${hh}${stanceClean ? ` — ${stanceClean}` : ""}`;
  const leanClean = s0
    ? `${leanPrefix}${outcomeDisplay(s0.name)}` +
      (i.topSidePriceCents != null ? ` @ ${i.topSidePriceCents}¢` : "")
    : "";
  const lean = leanClean ? `\n└ ${leanClean}` : "";
  const sigClean = `${i.alertCount} signal${i.alertCount === 1 ? "" : "s"} in 24h`;
  const sig = `📡 ${sigClean}`;
  const moneyClean =
    s0 && s0.usd > 0
      ? s1 && s1.usd > 0
        ? `${usdCompact(s0.usd)} on ${outcomeDisplay(s0.name)} vs ${usdCompact(s1.usd)} on ${outcomeDisplay(s1.name)}`
        : `all ${usdCompact(s0.usd)} on one side`
      : "";
  const moneyClause = moneyClean ? ` · ${moneyClean}` : "";
  const tags = buildTags({
    category: i.category,
    subcategory: i.subcategory,
    title: i.title,
  });
  if (i.template) {
    const out = renderCustom(
      i.template,
      {
        countdown: hh,
        stance: stanceClean,
        lean: leanClean,
        signals: sigClean,
        money: moneyClean,
        tags,
      },
      i.title,
      false,
    );
    if (out != null) return out;
  }
  const variant = (withMoney: boolean) => (title: string) =>
    `${head}\n\n${title}${lean}\n\n${sig}${withMoney ? moneyClause : ""}\n\n${tags}`;
  return fitPost(
    moneyClause ? [variant(true), variant(false)] : [variant(false)],
    sanitizeTitle(i.title),
  );
}

export interface SettlementPostInput {
  title: string;
  outcome: string;
  /** 原信号的入场价(¢)。缺失/越界时只报结果,不编回报率。 */
  entryCents?: number | null;
  /** 原信号方向。**必须传对**(SELL 语义见实现处注释,传错方向全错)。 */
  side?: "BUY" | "SELL";
  won: boolean;
  /** 原信号类型 → "Consensus signal"/"Whale signal" 标签;缺省退 "Signal"。 */
  signalKind?: "whale" | "consensus";
  /**
   * 原帖发出距今秒数(posted_at → now)。不用 "settled today" ——
   * alert_outcomes 没有真实结算时刻,backfill 可能滞后;"posted 2d ago"
   * 从 thread 就能验证,还多给了提前量信息。
   */
  postedAgoSec?: number | null;
  category?: string | null;
  subcategory?: string | null;
  /** 自定义文案模板(/manage 可配):null/省略 = 内置文案。 */
  template?: string | null;
}

// 佐证行的 posted-ago 短格式:阈值与 settleShort 同一套(<1h / <48h 小时 /
// 其余天),读者在同一个账号里看到的时间颗粒度是一致的。
function agoShort(sec: number): string {
  const h = sec / 3600;
  if (h < 1) return "under 1h ago";
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * 结算战报(v2)—— 对已发过的信号帖做 self-reply,补上"后来呢"。
 *
 *   ✅ CALLED IT · 40¢ → $1.00 (+150%)
 *
 *   Baltimore Orioles vs. Tampa Bay Rays
 *   └ Consensus signal on Baltimore Orioles, posted 2d ago
 *
 *   #Polymarket #MLB
 *
 * 回报率提进抬头:被 quote 的就是这行,通知预览一行读完输赢与倍数。
 *
 * 四点设计立场:
 *
 * 1. **输的也发**。账号简介写着 "No screenshots. Just the record." —— 只挑
 *    赢的发,读者第一次对照原帖就会发现,信任一次性归零。而且一串有输有赢
 *    的记录,比一串全赢可信得多。
 * 2. **只报单笔事实,不报统计**。"40¢ → $1.00 (+150%)" 是这一笔的可验证
 *    算术;"我们胜率 65%" 则是统计声明 —— 后者当前样本量根本撑不住
 *    (见 scripts/edge-audit)。单笔事实现在就能说,统计要等样本。
 * 3. **回报率是名义值**:按信号价买入、持有到结算,不含手续费与滑点。
 *    真实成交要扣 taker 费(见 lib/fees,中间价位约 2.5%)。这里不标注是
 *    因为 280 字符太贵,而"入场价 → 结算价"本身已经把原始事实给全了。
 * 4. **只有输的帖子带立场行**。赢时自夸+表态是油,输时表态是全场最硬的
 *    信任证明 —— 不对称是刻意的,别"顺手"把它加到赢帖上。
 */
export function composeSettlementPost(i: SettlementPostInput): string {
  const c = i.entryCents;
  // 边界含 100¢:以 $1.00 成交是合法的(卖方尤其常见),排掉它会让整段价格
  // 信息凭空消失。只排 ≤0 与 >100 这种脏值。
  const priced = c != null && Number.isFinite(c) && c > 0 && c <= 100;
  const isSell = i.side === "SELL";
  const result = i.won ? "✅ CALLED IT" : "❌ MISSED";
  let priceMove = "";
  if (priced) {
    const entry = c as number;
    // 二元结算:赢的那边归 $1,输的那边归 $0。
    // ⚠️ SELL 语义:outcomeStats.settleWon 的 won 对 SELL 是「卖出后价格
    // 下跌」—— BUY 赢 ⇒ 结算 $1;SELL 赢 ⇒ 价格跌到 $0(卖方不用赔)。
    // 套用买入的 entry→$1.00 公式会把「卖对了」说成「买赢了」,数字和
    // 方向全错(实测真实数据时踩到)。
    if (isSell) {
      // 卖方是空头,「回报率」的基准(保证金/占用资金)在预测市场里没有
      // 统一口径 —— 与其编一个,不如只给两个可核对的价格。
      // 卖了、归零 = 赢。
      const settle = i.won ? "$0.00" : "$1.00";
      priceMove = `sold ${entry}¢ → ${settle}`;
    } else if (i.won) {
      // 买入并持有到结算的名义回报:每份额从 entry¢ 变 $1。
      const pct = Math.round((100 / entry - 1) * 100);
      priceMove = `${entry}¢ → $1.00 (+${pct}%)`;
    } else {
      // 输 = 归零,"-100%" 是废话 —— → $0 已经把损失说尽了。
      priceMove = `${entry}¢ → $0`;
    }
  }
  const head = priceMove ? `${result} · ${priceMove}` : result;
  const kindLabel =
    i.signalKind === "consensus"
      ? "Consensus signal"
      : i.signalKind === "whale"
        ? "Whale signal"
        : "Signal";
  const agoClean = i.postedAgoSec != null ? agoShort(i.postedAgoSec) : "";
  const ago = agoClean ? `, posted ${agoClean}` : "";
  const line = `└ ${kindLabel} on ${outcomeDisplay(i.outcome)}${ago}`;
  // 输帖才带立场行:见设计立场第 4 点。
  const stanceClean = i.won ? "" : "We post every result, wins and losses.";
  const stance = stanceClean ? `\n\n${stanceClean}` : "";
  const tags = buildTags({
    category: i.category,
    subcategory: i.subcategory,
    title: i.title,
  });
  if (i.template) {
    const out = renderCustom(
      i.template,
      {
        result,
        priceMove,
        signal: kindLabel,
        outcome: outcomeDisplay(i.outcome),
        ago: agoClean,
        stance: stanceClean,
        tags,
      },
      i.title,
      false,
    );
    if (out != null) return out;
  }
  return fitPost(
    [(title) => `${head}\n\n${title}\n${line}${stance}\n\n${tags}`],
    sanitizeTitle(i.title),
  );
}

export interface WeeklyPostInput {
  weekLabel: string;
  settled: number;
  winRatePct: number | null;
  pnlUsd: number;
  bestName: string;
  bestRoiPct: number;
  url: string;
  /** 自定义文案模板(/manage 可配):null/省略 = 内置文案。 */
  template?: string | null;
}

/**
 * 周报是唯一允许带 URL 的模板(唯一的 $0.20 帖,导流入口)。
 *
 *   📊 WEEKLY REPORT · Aug 10–16
 *
 *   19 paper strategies tracking Polymarket smart money
 *
 *   ✅ 42 settled · 55% win rate
 *   💰 PnL +$1.2K
 *   🏆 Best: Mega Whale +12.3% ROI
 *
 *   Full verified record: https://…
 *
 *   #Polymarket #PredictionMarkets #SmartMoney
 */
export function composeWeeklyPost(i: WeeklyPostInput): string {
  const pnl = `${i.pnlUsd >= 0 ? "+" : ""}${usdCompact(i.pnlUsd)}`;
  const settledLine =
    i.winRatePct != null
      ? `✅ ${i.settled} settled · ${Math.round(i.winRatePct)}% win rate`
      : `✅ ${i.settled} settled`;
  const roi = `${i.bestRoiPct >= 0 ? "+" : ""}${Math.round(i.bestRoiPct * 10) / 10}%`;
  if (i.template) {
    // weekly 无 title(不走 fitPost 截断),URL 合法(唯一的 $0.20 帖)。
    // 渲染超 280 → 回退内置(内置由测试钉住恒不超)。
    const out = collapseBlank(
      renderTemplate(i.template, {
        week: i.weekLabel,
        settled: String(i.settled),
        winRate: i.winRatePct != null ? `${Math.round(i.winRatePct)}%` : "",
        pnl,
        best: strategyEn(i.bestName),
        bestRoi: roi,
        url: i.url,
        tags: "#Polymarket #PredictionMarkets",
      }),
    );
    if (weightedLength(out) <= X_POST_MAX_CHARS) return out;
  }
  return (
    `📊 WEEKLY REPORT · ${i.weekLabel}\n\n` +
    `19 paper strategies tracking Polymarket smart money\n\n` +
    `${settledLine}\n` +
    `💰 PnL ${pnl}\n` +
    `🏆 Best: ${strategyEn(i.bestName)} ${roi} ROI\n\n` +
    `Full verified record: ${i.url}\n\n` +
    // 周报没有赛道可言(全站汇总),用品类标签代替;#SmartMoney 与其它模板
    // 一同去掉,理由见 buildTags 上方注释。
    `#Polymarket #PredictionMarkets`
  );
}

// ---- 每日战报榜(2026-08-31)------------------------------------------------

export interface ScorecardRow {
  won: boolean;
  title: string;
  /** 名义回报(%)。输单或入场价缺失时传 null —— 只报事实,绝不编数字。 */
  roiPct: number | null;
}

export interface ScorecardPostInput {
  /** "Aug 30 (UTC)" —— 与 pulse 日帖同一口径。 */
  dayLabel: string;
  settled: number;
  wins: number;
  /** 代表行,调用方按戏剧性降序传;composer 按长度从后往前丢。 */
  rows: ScorecardRow[];
  /** 自定义文案模板(/manage 可配):null/省略 = 内置文案。 */
  template?: string | null;
}

const SCORECARD_STANCE = "Win or lose, every call gets its receipt.";
const SCORECARD_TAGS = "#Polymarket #PredictionMarkets";
// 单条代表行的标题预算(加权)。一条超长标题不该把整帖挤爆,更不该把
// 「几战几胜」这行挤掉 —— 战绩行才是这帖的主体。
const SCORECARD_ROW_TITLE_MAX = 64;
/** 代表行上限:再多就成列表帖了,读者只扫前几行。 */
const SCORECARD_MAX_ROWS = 3;

function clipWeighted(s: string, budget: number): string {
  if (weightedLength(s) <= budget) return s;
  let used = 0;
  let keep = 0;
  for (const ch of [...s]) {
    const cw = weightedLength(ch);
    // 预留 2:省略号在加权口径下占 2。
    if (used + cw > budget - 2) break;
    used += cw;
    keep++;
  }
  return [...s].slice(0, keep).join("") + "…";
}

function scorecardLine(r: ScorecardRow): string {
  const roi = r.won && r.roiPct != null ? ` +${Math.round(r.roiPct)}%` : "";
  return `${r.won ? "✅" : "❌"}${roi} ${clipWeighted(sanitizeTitle(r.title), SCORECARD_ROW_TITLE_MAX)}`;
}

/**
 * 每日战报榜 —— 把一天的结算战果聚成一条**主帖**。
 *
 *   📋 THE CARD — Aug 30 (UTC)
 *
 *   12 settled · 8 hit · 67%
 *
 *   ✅ +138% Will Sunderland AFC win on 2026-08-30?
 *   ❌ Will SSC Napoli win on 2026-08-30?
 *
 *   Win or lose, every call gets its receipt.
 *
 *   #Polymarket #PredictionMarkets
 *
 * 为什么要有这一类(2026-08-31 线上实测):逐条战报走 self-reply,17 条合计
 * 只有 13 次浏览 —— 自回复在 X 上没有独立分发,「赢输都报」这个卖点因此
 * 对时间线完全不可见。self-reply 继续留着当可核验的凭证(thread 里点开
 * 原帖就能对),这条主帖负责让它被看见。两层分工,不是二选一。
 *
 * 降级阶梯:丢代表行(3→0)→ 丢立场行。战绩行与抬头永不丢。
 */
export function composeScorecardPost(i: ScorecardPostInput): string {
  const hitPct = i.settled > 0 ? Math.round((i.wins / i.settled) * 100) : 0;
  const head = `📋 THE CARD — ${i.dayLabel}`;
  const record = `${i.settled} settled · ${i.wins} hit · ${hitPct}%`;
  const lines = i.rows.map(scorecardLine);
  const build = (k: number, stance: boolean) =>
    collapseBlank(
      `${head}\n\n${record}\n\n` +
        (k > 0 ? `${lines.slice(0, k).join("\n")}\n\n` : "") +
        (stance ? `${SCORECARD_STANCE}\n\n` : "") +
        SCORECARD_TAGS,
    );
  if (i.template) {
    // 与 weekly 同款「无 title」路径(不走 fitPost 截断);带 URL 或超 280
    // 都回退内置 —— 成本口子与折叠帖两条红线在这里同样适用。
    const out = collapseBlank(
      renderTemplate(i.template, {
        day: i.dayLabel,
        settled: String(i.settled),
        wins: String(i.wins),
        hitRate: `${hitPct}%`,
        rows: lines.slice(0, SCORECARD_MAX_ROWS).join("\n"),
        stance: SCORECARD_STANCE,
        tags: SCORECARD_TAGS,
      }),
    );
    if (
      !/https?:\/\//i.test(out) &&
      weightedLength(out) <= X_POST_MAX_CHARS &&
      out !== ""
    ) {
      return out;
    }
  }
  for (let k = Math.min(lines.length, SCORECARD_MAX_ROWS); k >= 0; k--) {
    const out = build(k, true);
    if (weightedLength(out) <= X_POST_MAX_CHARS) return out;
  }
  // 兜底:抬头 + 战绩行 + 标签,恒 ≤280(标题不参与,没有可撑爆的变量)。
  return build(0, false);
}

// 19 档种子名 → 英文(与 lib/db.ts seeds v4 一一对应;新档缺映射时回退原名,
// 宁可中文名出现在英文帖里也不显示错误翻译)。
// ---- 市场脉搏日帖(内容引擎,2026-08-27) ------------------------------------

const PULSE_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "2026-08-26" → "Aug 26 (UTC)"。解析失败原样返回 —— 日期串坏了也不炸帖。
 *  日榜与每日战报榜共用,读者在同一个账号里看到的日期写法必须一致。 */
export function utcDayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return `${PULSE_MONTHS[Number(m[2]) - 1]} ${Number(m[3])} (UTC)`;
}

/** 榜单次名的标题短化:runners 不是 fitPost 的锚点,只能在数据侧预截。 */
function shortTitle(title: string, max = 30): string {
  const s = sanitizeTitle(title);
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max - 1).join("") + "…";
}

export interface PulsePostInput {
  /** UTC 日(yyyy-mm-dd),即 /pulse 的 latestDay。 */
  day: string;
  title: string;
  score: number;
  /** 今日量 ÷ 自身基线均值;基线不足为 null(该段省略)。 */
  volRatio: number | null;
  oneSidedPct: number;
  whaleSharePct: number;
  /** 次名(≤2 条进帖,富梯级专属)。 */
  runners: { title: string; score: number }[];
  category?: string | null;
  subcategory?: string | null;
  /** 自定义文案模板(/manage 可配):null/省略 = 内置文案。 */
  template?: string | null;
}

/**
 * 异常市场日榜帖。与 /pulse 页同源同口径:异常分四分量,帖里给「为什么它
 * 异常」的短句拆解 —— 一个不能解释的总分连一条推文都撑不起来。
 * 降级阶梯:丢次名行 → 丢拆解行 → 只剩抬头+标题 → 截标题。
 */
export function composePulsePost(i: PulsePostInput): string {
  const whyParts: string[] = [];
  if (i.volRatio != null) {
    whyParts.push(`${i.volRatio.toFixed(1)}× its volume baseline`);
  }
  if (i.oneSidedPct > 0) {
    whyParts.push(`${Math.round(i.oneSidedPct)}% one-sided`);
  }
  if (i.whaleSharePct > 0) {
    whyParts.push(`whales ${Math.round(i.whaleSharePct)}% of flow`);
  }
  const why = whyParts.join(" · ");
  const runners = i.runners
    .slice(0, 2)
    .map((r, idx) => `#${idx + 2} ${shortTitle(r.title)} (${r.score})`)
    .join(" · ");
  const tags = buildTags({
    category: i.category,
    subcategory: i.subcategory,
    title: i.title,
  });
  const head = `📊 MARKET PULSE — ${utcDayLabel(i.day)}`;
  if (i.template) {
    const out = renderCustom(
      i.template,
      {
        day: utcDayLabel(i.day),
        score: String(i.score),
        why,
        runners,
        tags,
      },
      i.title,
      false,
    );
    if (out != null) return out;
  }
  const story = (title: string) =>
    `${head}\n\n${title}\n└ most abnormal market · ${i.score}/100`;
  const variant = (withWhy: boolean, withRunners: boolean) => (title: string) =>
    story(title) +
    (withWhy && why ? `\n└ ${why}` : "") +
    (withRunners && runners ? `\n\nAlso hot: ${runners}` : "") +
    `\n\n${tags}`;
  return fitPost(
    [variant(true, true), variant(true, false), variant(false, false)],
    sanitizeTitle(i.title),
  );
}

export interface DivergencePostInput {
  title: string;
  smallOutcome: string;
  smallNetUsd: number;
  whaleOutcome: string;
  whaleNetUsd: number;
  category?: string | null;
  subcategory?: string | null;
  /** 自定义文案模板(/manage 可配):null/省略 = 内置文案。 */
  template?: string | null;
}

const DIVERGENCE_KICKER = "One side is wrong.";

/**
 * 小单 vs 鲸鱼分歧帖。口径与 /pulse 页一致:双边都是**正向净买**且材料性
 * 达标才成帖(数据侧已筛)——文案说 small orders,绝不说 retail(抓取
 * 下限之下的真散户不可见)。降级阶梯:丢 kicker → 双行并一行 → 截标题。
 */
export function composeDivergencePost(i: DivergencePostInput): string {
  const small = outcomeDisplay(i.smallOutcome);
  const whale = outcomeDisplay(i.whaleOutcome);
  const smallUsd = usdCompact(i.smallNetUsd);
  const whaleUsd = usdCompact(i.whaleNetUsd);
  const tags = buildTags({
    category: i.category,
    subcategory: i.subcategory,
    title: i.title,
  });
  if (i.template) {
    const out = renderCustom(
      i.template,
      {
        smallOutcome: small,
        smallUsd,
        whaleOutcome: whale,
        whaleUsd,
        kicker: DIVERGENCE_KICKER,
        tags,
      },
      i.title,
      false,
    );
    if (out != null) return out;
  }
  const head = "⚔️ SPLIT TAPE — small money vs whales";
  const twoLine = (title: string) =>
    `${head}\n\n${title}\n└ small orders buying ${small} (+${smallUsd})\n└ whales buying ${whale} (+${whaleUsd})`;
  const oneLine = (title: string) =>
    `${head}\n\n${title}\n└ small: ${small} +${smallUsd} · whales: ${whale} +${whaleUsd}`;
  return fitPost(
    [
      (t) => `${twoLine(t)}\n\n${DIVERGENCE_KICKER}\n\n${tags}`,
      (t) => `${twoLine(t)}\n\n${tags}`,
      (t) => `${oneLine(t)}\n\n${tags}`,
    ],
    sanitizeTitle(i.title),
  );
}

export const STRATEGY_EN: Record<string, string> = {
  保守: "Conservative Consensus",
  激进: "Aggressive Consensus",
  精英共识: "Elite Consensus",
  重仓共识: "Heavy Consensus",
  首发共识: "First-Mover Consensus",
  巨鲸: "Whale Follow",
  超级巨鲸: "Mega Whale",
  巨鲸精英: "Elite Whale",
  一边倒分歧: "Lopsided Majority",
  分歧解除: "Standoff Resolved",
  高分独狼: "Lone Wolf",
  早期赢家跟投: "Early Winner",
  逆势少数边: "Contrarian Minority",
  反巨鲸: "Inverse Whale",
  反超级巨鲸: "Inverse Mega Whale",
  反巨鲸精英: "Inverse Elite Whale",
  反分歧解除: "Inverse Standoff Resolved",
  反高分独狼: "Inverse Lone Wolf",
  反早期赢家: "Inverse Early Winner",
};

export function strategyEn(name: string): string {
  return STRATEGY_EN[name] ?? name;
}
