"use client";

import { Tag } from "./ui";
import { walletTagTip } from "./glossary";
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

export function WalletTagChips({
  tags,
  max,
}: {
  tags: WalletTag[];
  max?: number;
}) {
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
      {shown.map((t) => (
        // Hover tip from the same data source as /glossary and the tag
        // dialog (app/glossary.ts WALLET_TAGS) — the three can never drift.
        <span key={t.key} title={walletTagTip(t.key) || t.label}>
          <Tag variant={tagVariant(t)}>{t.label}</Tag>
        </span>
      ))}
      {hidden > 0 && <span className="ds-hint">+{hidden}</span>}
    </span>
  );
}
