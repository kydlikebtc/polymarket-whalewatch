// 一次性样式预览脚本：把三种告警的代表性样例推到指定 chat（默认私聊，
// 不进频道）。仅用于显示调优，不写库、不触发引擎。
// 用法: npx tsx scripts/push-samples.ts <chat_id> <标签前缀>
import "dotenv/config";
import { sendMessage } from "../lib/telegram";
import { formatLargeTradeAlert } from "../lib/alert";
import { formatConsensusAlert, type ConsensusGroup } from "../lib/consensus";
import { formatRecordLine } from "../lib/signalRecord";
import type { Trade } from "../lib/types";

const chatId = process.argv[2] ?? process.env.TELEGRAM_CHANNEL_ID ?? "";
const label = process.argv[3] ?? "样式预览";
if (!chatId) {
  console.error("用法: npx tsx scripts/push-samples.ts <chat_id> [标签]");
  process.exit(1);
}
const creds = {
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  chatId,
};

const NOW = Math.floor(Date.now() / 1000);

const trade = (over: Partial<Trade>): Trade =>
  ({
    transactionHash:
      "0x6a3f0e6f9d1c2b4a8e7d5c3b1a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f",
    asset: "tok",
    proxyWallet: "0x9e86ad64a9a56cf1d29ee672a03dcf0dd7b2a1c4",
    side: "BUY",
    size: 30000,
    price: 0.5,
    timestamp: NOW - 60,
    title: "Will the Fed cut rates at the September 2026 meeting?",
    slug: "fed-september-2026",
    eventSlug: "fed-september-2026",
    outcome: "Yes",
    outcomeIndex: 0,
    conditionId: "0xc1",
    ...over,
  }) as Trade;

async function main() {
  // 1) 💰 大额买入（带市场上下文 + 命中率尾行）
  let m1 = formatLargeTradeAlert(trade({}), null, {
    impact24h: 0.18,
    liquidity: 229073,
    hoursToEnd: 5,
    liquidityShare: null,
    volume24hr: null,
    category: null,
  });
  const rec1 = formatRecordLine("该钱包", {
    settled: 18,
    wins: 12,
    wilsonLo: 0.44,
  });
  if (rec1) m1 += `\n${rec1}`;

  // 2) 🐳 巨鲸卖出（聪明钱标注 + 冷却折叠后缀）
  let m2 = formatLargeTradeAlert(
    trade({
      side: "SELL",
      size: 250000,
      price: 0.48,
      outcome: "No",
      title:
        "LoL: ThunderTalk Gaming vs EDward Gaming (BO3) - LPL Group Ascend",
    }),
    { score: 72, winRate: 0.68, netPnl: 1_200_000 },
    {
      impact24h: 0.42,
      liquidity: 88000,
      hoursToEnd: 26,
      liquidityShare: null,
      volume24hr: null,
      category: null,
    },
  );
  m2 += `\n⏳ 该钱包本轮在此市场共 3 笔，冷却 30 分钟内其余仅入库`;
  const rec2 = formatRecordLine("该钱包", {
    settled: 3,
    wins: 2,
    wilsonLo: 0.2,
  });
  if (rec2) m2 += `\n${rec2}`;

  // 3) 🔥 共识（3 钱包 + 凭据 + 类型战绩尾行）
  const g: ConsensusGroup = {
    conditionId: "0xc1",
    outcome: "Yes",
    title: "Will the Fed cut rates at the September 2026 meeting?",
    slug: "fed-september-2026",
    eventSlug: "fed-september-2026",
    asset: "tok",
    outcomeIndex: 0,
    wallets: [
      {
        wallet: "0x9e86ad64a9a56cf1d29ee672a03dcf0dd7b2a1c4",
        netUsd: 21000,
        buyCount: 3,
        avgBuyPrice: 0.372,
        score: 82,
        winRate: 0.71,
        qualifiedTs: NOW - 2100,
      },
      {
        wallet: "0x1f2e3d4c5b6a79881726354493827160594837aa",
        netUsd: 15000,
        buyCount: 2,
        avgBuyPrice: 0.385,
        score: 64,
        winRate: 0.62,
        qualifiedTs: NOW - 1500,
      },
      {
        wallet: "0xab19716584931d81cd9e7763402673a64baa4876",
        netUsd: 9000,
        buyCount: 1,
        avgBuyPrice: 0.391,
        score: null,
        winRate: null,
        qualifiedTs: NOW - 600,
      },
    ],
    walletCount: 3,
    totalNetUsd: 45000,
    avgBuyPrice: 0.3785,
    firstTs: NOW - 2820,
    lastTs: NOW - 180,
    formationTs: NOW - 1500,
  };
  let m3 = formatConsensusAlert(g, { nowSec: NOW, latestPrice: 0.397 });
  const rec3 = formatRecordLine("共识", {
    settled: 26,
    wins: 17,
    wilsonLo: 0.46,
  });
  if (rec3) m3 += `\n${rec3}`;

  for (const [name, html] of [
    ["💰 大额", m1],
    ["🐳 巨鲸+聪明钱", m2],
    ["🔥 共识", m3],
  ] as const) {
    await sendMessage(creds, `——【${label} · ${name}】——\n${html}`);
    await new Promise((r) => setTimeout(r, 3500));
    console.log(`sent: ${name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
