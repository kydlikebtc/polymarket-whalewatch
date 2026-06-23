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
