import { createHash } from "crypto";
import {
  groupOf,
  loadScorecardRows,
  type ScorecardRow,
} from "./channelScorecard";
import type { DB } from "./db";

// 名人堂 + 反指名单(第二梯队八件套,2026-08-28,设计
// docs/plans/2026-08-28-tier2-octet-design.md §五):把渠道记分卡的
// 「逐钱包前向实验」机器换一个分组维度 —— 按钱包而非按渠道。同一套纪律:
// 逐行贡献 (won?1:0)−q−feePerShare、CRVE 聚簇区间、nc≥10 才发判定。
// 反指名单 = 净 edge 上界 < 0 的钱包 —— 逆势少数边(+38.9%)从孤例变一类。
// 多重比较沿记分卡先例:只披露不校正,页脚必须写明「共检验 W 个钱包,
// 区间未做 Bonferroni 校正 —— 名单是研究线索,不是交易结论」。
// 代号纯趣味零存储(确定性哈希),地址永远是第一标识。

export interface LeagueAlertRef {
  title: string | null;
  createdAt: number | null;
  /** 该行贡献(概率点,won−q−fee)。 */
  contrib: number;
}

export interface LeagueRow {
  wallet: string;
  codename: string;
  n: number;
  markets: number;
  winRate: number;
  netEdge: number;
  seC: number;
  verdict: "pos" | "neg";
  channel: string;
  isMarketMaker: boolean;
  best: LeagueAlertRef | null;
  worst: LeagueAlertRef | null;
}

export interface WalletLeague {
  /** 名人堂:verdict=pos,净 edge 降序,≤20。 */
  hall: LeagueRow[];
  /** 反指名单:verdict=neg,净 edge 升序,≤20。 */
  fade: LeagueRow[];
  /** 过了 nc≥10 判定线的钱包数 —— 多重比较披露的分母。 */
  testedWallets: number;
  disclosures: {
    gradedAlerts: number;
    rows: number;
    feeUnknownDropped: number;
    malformedDropped: number;
  };
}

const CAP = 20;

const ADJECTIVES = [
  "沉默",
  "闪电",
  "铁腕",
  "夜行",
  "冷面",
  "疾风",
  "深潜",
  "独眼",
  "白银",
  "赤焰",
  "碎冰",
  "巡夜",
  "薄雾",
  "长线",
  "斩风",
  "隐市",
];
const ANIMALS = [
  "座头鲸",
  "虎鲸",
  "灰狼",
  "游隼",
  "獾",
  "石斑",
  "信天翁",
  "雪豹",
  "蜜獾",
  "角雕",
  "旗鱼",
  "貂",
  "夜鹭",
  "狮鬃水母",
  "锤头鲨",
  "渡鸦",
];

/** 确定性代号(形容词·动物):纯展示趣味,零存储,与身份判定无关。 */
export function codenameOf(address: string): string {
  const h = createHash("sha256").update(address.toLowerCase()).digest();
  return `${ADJECTIVES[h[0] % ADJECTIVES.length]}·${ANIMALS[h[1] % ANIMALS.length]}`;
}

const contribOf = (r: ScorecardRow): number =>
  (r.won ? 1 : 0) - r.q - r.feePerShare;

export function buildWalletLeague(db: DB): WalletLeague {
  const loaded = loadScorecardRows(db);
  const byWallet = new Map<string, ScorecardRow[]>();
  for (const r of loaded.rows) {
    const arr = byWallet.get(r.wallet) ?? [];
    arr.push(r);
    byWallet.set(r.wallet, arr);
  }

  const hall: LeagueRow[] = [];
  const fade: LeagueRow[] = [];
  let testedWallets = 0;
  for (const [wallet, rows] of byWallet) {
    const g = groupOf(wallet, wallet, rows);
    if (g.verdict === "lowN") continue;
    testedWallets++;
    if (g.verdict === "flat") continue;
    let best: LeagueAlertRef | null = null;
    let worst: LeagueAlertRef | null = null;
    for (const r of rows) {
      const c = contribOf(r);
      const ref: LeagueAlertRef = {
        title: r.title ?? null,
        createdAt: r.createdAt ?? null,
        contrib: c,
      };
      if (best == null || c > best.contrib) best = ref;
      if (worst == null || c < worst.contrib) worst = ref;
    }
    const row: LeagueRow = {
      wallet,
      codename: codenameOf(wallet),
      n: g.n,
      markets: g.markets,
      winRate: g.winRate,
      netEdge: g.netEdge,
      seC: g.seC,
      verdict: g.verdict,
      channel: rows[0].channel,
      isMarketMaker: rows[0].isMarketMaker,
      best,
      worst,
    };
    if (g.verdict === "pos") hall.push(row);
    else fade.push(row);
  }
  hall.sort((a, b) => b.netEdge - a.netEdge);
  fade.sort((a, b) => a.netEdge - b.netEdge);
  return {
    hall: hall.slice(0, CAP),
    fade: fade.slice(0, CAP),
    testedWallets,
    disclosures: {
      gradedAlerts: loaded.gradedAlerts,
      rows: loaded.rows.length,
      feeUnknownDropped: loaded.feeUnknownDropped,
      malformedDropped: loaded.malformedDropped,
    },
  };
}
