import { it, expect } from "vitest";
import { formatLargeTradeAlert } from "./alert";
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
  const html = formatLargeTradeAlert(t, 50000);
  expect(html).toContain("Trump &amp; &lt;Biden&gt;");
  expect(html).toContain("$50,000");
  expect(html).toContain("polygonscan.com/tx/0xhash");
  expect(html).toContain("polymarket.com/event/e");
});

it("URL-encodes special-character slugs/wallets so an href can never be truncated", () => {
  const html = formatLargeTradeAlert(
    { ...t, eventSlug: 'weird "slug"?&x', proxyWallet: "0xAB CD" },
    50000,
  );
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
