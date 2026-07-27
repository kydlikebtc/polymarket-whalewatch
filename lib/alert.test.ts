import { describe, it, expect } from "vitest";
import { formatLargeTradeAlert, formatSmartTag } from "./alert";
const t = {
  proxyWallet: "0x1234567890abcdef",
  side: "BUY",
  asset: "9",
  conditionId: "0xc",
  size: 100000,
  price: 0.5,
  timestamp: 1700000000,
  title: "Trump & <Biden>",
  slug: "s",
  eventSlug: "e",
  outcome: "Yes",
  outcomeIndex: 0,
  transactionHash: "0xhash",
} as any;
it("escapes HTML and includes notional + links", () => {
  const html = formatLargeTradeAlert(t);
  expect(html).toContain("Trump &amp; &lt;Biden&gt;");
  expect(html).toContain("$50,000");
  expect(html).toContain("polygonscan.com/tx/0xhash");
  expect(html).toContain("polymarket.com/event/e");
});

it("URL-encodes special-character slugs/wallets so an href can never be truncated", () => {
  const html = formatLargeTradeAlert({
    ...t,
    eventSlug: 'weird "slug"?&x',
    proxyWallet: "0xAB CD",
  });
  // The quote/space/ampersand live only percent-encoded inside the URL —
  // a raw `"` here truncates the attribute and 400s the whole message.
  expect(html).toContain(
    'href="https://polymarket.com/event/weird%20%22slug%22%3F%26x"',
  );
  expect(html).toContain('href="https://polymarket.com/profile/0xAB%20CD"');
  // Every href value stays quote-free between its delimiters.
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    expect(m[1]).not.toContain(" ");
    expect(m[1]).not.toContain('"');
  }
});

describe("🐳/💰 tier by NOTIONAL, not configuration", () => {
  it("a $50k fill leads with 🐳 (fixed cutoff, no tier param to misuse)", () => {
    expect(formatLargeTradeAlert(t).startsWith("🐳 ")).toBe(true);
  });
  it("a $12k fill leads with 💰 even though it cleared the alert threshold", () => {
    const html = formatLargeTradeAlert({ ...t, size: 24000, price: 0.5 });
    expect(html.startsWith("💰 ")).toBe(true);
    expect(html).not.toContain("🐳");
  });
});

describe("headline = decision head (TG 锁屏通知只显示第一行)", () => {
  it("BUY 首行 = tier + 方向 + 加粗金额 + 结果 @ ¢，标题退居第二行", () => {
    // 50,000 shares at 53.2¢ → $26,600
    const html = formatLargeTradeAlert({ ...t, size: 50000, price: 0.532 });
    expect(html.split("\n")[0]).toBe("💰 🟢买入 <b>$26,600</b> · Yes @ 53.2¢");
    expect(html.split("\n")[1]).toBe("<b>Trump &amp; &lt;Biden&gt;</b>");
  });
  it("SELL renders 🔴卖出 and trims a whole-cent price to 50¢", () => {
    const html = formatLargeTradeAlert({ ...t, side: "SELL" });
    expect(html.split("\n")[0]).toBe("🐳 🔴卖出 <b>$50,000</b> · Yes @ 50¢");
  });
});

describe("publicUrl → 推送带 🎯 线上信号卡链接", () => {
  it("链接行追加 /market/<cid>；未配置则不渲染", () => {
    const withUrl = formatLargeTradeAlert(t, null, null, {
      publicUrl: "https://whalewatch.wired.fund",
    });
    expect(withUrl).toContain(
      'href="https://whalewatch.wired.fund/market/0xc"',
    );
    expect(withUrl).toContain("🎯");
    expect(formatLargeTradeAlert(t)).not.toContain("🎯");
  });
});

describe("formatSmartTag（独立凭据行）", () => {
  it("renders score · win rate · realized pnl when all present", () => {
    expect(
      formatSmartTag({ score: 72, winRate: 0.68, netPnl: 1_200_000 }),
    ).toBe("🏆 聪明钱 72分 · 胜率68% · 盈$1.2M");
  });
  it("omits null segments individually", () => {
    expect(formatSmartTag({ score: null, winRate: 0.68, netPnl: null })).toBe(
      "🏆 聪明钱 胜率68%",
    );
    expect(formatSmartTag({ score: 82 })).toBe("🏆 聪明钱 82分");
  });
  it("degrades to the bare label when every segment is null", () => {
    expect(formatSmartTag({ score: null, winRate: null, netPnl: null })).toBe(
      "🏆 聪明钱",
    );
  });
  it("a negative realized pnl reads 亏, not 盈", () => {
    expect(formatSmartTag({ score: null, netPnl: -250_000 })).toBe(
      "🏆 聪明钱 亏$250K",
    );
  });
  it("no tag at all renders nothing", () => {
    expect(formatSmartTag(undefined)).toBe("");
    expect(formatSmartTag(null)).toBe("");
  });
  it("聪明钱：首行带 🏆 标记，凭据独立成行（首行不再拥挤）", () => {
    const html = formatLargeTradeAlert(t, {
      score: 72,
      winRate: 0.68,
      netPnl: 1_200_000,
    });
    const lines = html.split("\n");
    expect(lines[0]).toBe("🐳 🏆 🟢买入 <b>$50,000</b> · Yes @ 50¢");
    expect(lines[1]).toBe("<b>Trump &amp; &lt;Biden&gt;</b>");
    expect(lines[2]).toBe("🏆 聪明钱 72分 · 胜率68% · 盈$1.2M");
  });
});
