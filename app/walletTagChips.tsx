"use client";

import { Tag } from "./ui";
import { walletTagTip } from "./glossary";
import { useLang } from "./i18n";
import type { WalletTag } from "../lib/walletTags";

// Shared renderer for derived wallet tags (lib/walletTags) — used by the
// discovery funnel lists and the wallet dossier header so the two can never
// drift. Color semantics follow the sitewide convention: amber = warning
// (bot), brand = trusted standing (manual whitelist), green = graduated
// through the discovery admission gate, neutral = attribution/evidence.
export function tagVariant(
  t: WalletTag,
): "default" | "brand" | "up" | "down" | "warn" {
  if (t.key === "bot") return "warn";
  if (t.key === "whitelist") return "brand";
  if (t.key.startsWith("src:discovered:")) return "up";
  return "default";
}

// lib/walletTags 产出的 label 有三种形态:①固定串(🏆 手动白名单 / 🤖 做市
// 机器人 / 🏛 全局榜 / 池成员·来源未知);②固定前缀 + 动态后缀(🏅 分类榜·
// tech / 🔭 发现入池·拆单建仓);③渠道证据串 + 数量后缀(🔁 共识同行 ×3)。
// ×N 是语言中立的,先摘下再整串查字典、最后拼回 —— 与 /discovery 的筛选
// chips 同一口径,可枚举全集(6 类别 × 4 渠道 + 固定串)已在 discovery /
// glossary 分片登记;未登记的新类别或新渠道按字典机制回退中文,不会空串。
// t 由调用方从 useLang 传入,本函数保持纯函数(与 ui.tsx catLabelFineT 同风格)。
function tagLabel(t: (zh: string) => string, label: string): string {
  const m = label.match(/^(.*) ×(\d+)$/);
  return m ? `${t(m[1])} ×${m[2]}` : t(label);
}

export function WalletTagChips({
  tags,
  max,
}: {
  tags: WalletTag[];
  max?: number;
}) {
  const { t } = useLang();
  const shown = max != null ? tags.slice(0, max) : tags;
  const hidden = tags.length - shown.length;
  return (
    <span
      style={{
        display: "inline-flex",
        flexWrap: "wrap",
        gap: "var(--s-1)",
        alignItems: "center",
      }}
    >
      {shown.map((tag) => {
        const label = tagLabel(t, tag.label);
        return (
          // Hover tip from the same data source as /glossary and the tag
          // dialog (app/glossary.ts WALLET_TAGS) — the three can never drift.
          // 词表无条目时回退标签本身(与改造前一致:t("") 仍是 "")。
          <span key={tag.key} title={t(walletTagTip(tag.key)) || label}>
            <Tag variant={tagVariant(tag)}>{label}</Tag>
          </span>
        );
      })}
      {hidden > 0 && <span className="ds-hint">+{hidden}</span>}
    </span>
  );
}
