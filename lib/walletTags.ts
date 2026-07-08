import type { DB } from "./db";
import { MARKET_MAKER_MIN_MARKETS } from "./walletStats";
import { ADMIT_EVIDENCE_WINDOW_SEC } from "./admission";

// ---------------------------------------------------------------------------
// Derived wallet tags — the first brick of the wallet-label system (方向③).
// Nothing here is stored: every tag is derived on read from tables that
// already exist (smart_wallets / wallet_stats / wallet_candidates), following
// the codebase's "store raw features, derive labels" convention. A tag's
// `key` is a stable machine id (drives filtering); `label` is the display.
// ---------------------------------------------------------------------------

export type WalletTagKind = "status" | "source" | "channel";

export interface WalletTag {
  key: string; // stable filter id, e.g. 'whitelist' | 'bot' | 'src:category:tech' | 'ch:echo'
  label: string; // display text, e.g. '🏅 分类榜·tech' | '🔁 共识同行 ×3'
  kind: WalletTagKind;
  // Channel tags: distinct evidence markets inside the recurrence window.
  count?: number;
}

export const CHANNEL_TAG_META: Record<string, { icon: string; name: string }> =
  {
    echo: { icon: "🔁", name: "共识同行" },
    splitter: { icon: "🧩", name: "拆单建仓" },
    insider: { icon: "🕵️", name: "内幕签名" },
    early_winner: { icon: "🎯", name: "早期赢家" },
  };

export function sourceTag(source: string): WalletTag {
  if (source.startsWith("category:")) {
    return {
      key: `src:${source}`,
      label: `🏅 分类榜·${source.slice("category:".length)}`,
      kind: "source",
    };
  }
  if (source.startsWith("discovered:")) {
    const ch = source.slice("discovered:".length);
    const meta = CHANNEL_TAG_META[ch];
    return {
      key: `src:${source}`,
      label: `🔭 发现入池·${meta ? meta.name : ch}`,
      kind: "source",
    };
  }
  return { key: "src:leaderboard", label: "🏛 全局榜", kind: "source" };
}

export function channelTag(channel: string, count: number): WalletTag {
  const meta = CHANNEL_TAG_META[channel];
  return {
    key: `ch:${channel}`,
    label: `${meta ? `${meta.icon} ${meta.name}` : channel} ×${count}`,
    kind: "channel",
    count,
  };
}

/**
 * Batch tag derivation for a set of addresses (lowercased in, lowercased
 * keys out). One indexed query per underlying table. Order inside a wallet's
 * list: status tags (whitelist/bot) → source → channels by evidence breadth.
 */
export function getWalletTagsBatch(
  db: DB,
  addresses: string[],
  nowSec: number = Math.floor(Date.now() / 1000),
): Map<string, WalletTag[]> {
  const distinct = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const out = new Map<string, WalletTag[]>();
  if (distinct.length === 0) return out;
  for (const a of distinct) out.set(a, []);
  const ph = distinct.map(() => "?").join(",");

  const pool = db
    .prepare(
      `SELECT address, source, is_whitelist FROM smart_wallets WHERE address IN (${ph})`,
    )
    .all(...distinct) as {
    address: string;
    source: string | null;
    is_whitelist: number;
  }[];
  for (const r of pool) {
    const tags = out.get(r.address.toLowerCase())!;
    if (r.is_whitelist) {
      tags.push({ key: "whitelist", label: "🏆 手动白名单", kind: "status" });
    }
    if (r.source) tags.push(sourceTag(r.source));
    else if (!r.is_whitelist) {
      // In the pool with no attribution (pre-source legacy row).
      tags.push({
        key: "src:unknown",
        label: "池成员·来源未知",
        kind: "source",
      });
    }
  }

  const bots = db
    .prepare(
      `SELECT wallet FROM wallet_stats WHERE markets_traded >= ${MARKET_MAKER_MIN_MARKETS} AND wallet IN (${ph})`,
    )
    .all(...distinct) as { wallet: string }[];
  for (const r of bots) {
    out
      .get(r.wallet.toLowerCase())!
      .unshift({ key: "bot", label: "🤖 做市机器人", kind: "status" });
  }

  const evidence = db
    .prepare(
      `SELECT address, channel, COUNT(DISTINCT condition_id) AS markets
         FROM wallet_candidates
        WHERE evidence_ts >= ? AND address IN (${ph})
        GROUP BY address, channel`,
    )
    .all(nowSec - ADMIT_EVIDENCE_WINDOW_SEC, ...distinct) as {
    address: string;
    channel: string;
    markets: number;
  }[];
  const perWallet = new Map<string, WalletTag[]>();
  for (const r of evidence) {
    const list = perWallet.get(r.address) ?? [];
    list.push(channelTag(r.channel, r.markets));
    perWallet.set(r.address, list);
  }
  for (const [addr, chTags] of perWallet) {
    chTags.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
    out.get(addr.toLowerCase())!.push(...chTags);
  }
  return out;
}

/** Single-wallet convenience for the dossier API. */
export function getWalletTags(
  db: DB,
  address: string,
  nowSec?: number,
): WalletTag[] {
  return (
    getWalletTagsBatch(db, [address], nowSec).get(address.toLowerCase()) ?? []
  );
}
