import { describe, it, expect } from "vitest";
import {
  cents,
  durText,
  esc,
  escAttr,
  short,
  urlSeg,
  usd,
  usdCompact,
} from "./tgFormat";

describe("esc", () => {
  it("escapes &, <, > (in that order — & first so it can't double-escape)", () => {
    expect(esc("A & <b> > c")).toBe("A &amp; &lt;b&gt; &gt; c");
  });
  it("leaves double quotes alone (text-node context)", () => {
    expect(esc('say "hi"')).toBe('say "hi"');
  });
});

describe("escAttr", () => {
  it("escapes double quotes on top of esc", () => {
    expect(escAttr('a"b & <c>')).toBe("a&quot;b &amp; &lt;c&gt;");
  });
});

describe("urlSeg", () => {
  it("percent-encodes quotes/spaces/separators so an href can never be truncated", () => {
    const out = urlSeg('will-trump-win "2028"?&x=1');
    expect(out).not.toContain('"');
    expect(out).not.toContain(" ");
    expect(out).not.toContain("&x"); // & only appears inside %26 / entities
    expect(out).toBe("will-trump-win%20%222028%22%3F%26x%3D1");
  });
  it("percent-encodes non-ASCII slugs", () => {
    expect(urlSeg("北京")).toBe("%E5%8C%97%E4%BA%AC");
  });
  it("passes ordinary slugs / hashes through unchanged", () => {
    expect(urlSeg("some-market-slug-2026")).toBe("some-market-slug-2026");
    expect(urlSeg("0xabcDEF123")).toBe("0xabcDEF123");
  });
});

describe("usd / short", () => {
  it("usd rounds and adds thousands separators", () => {
    expect(usd(52000.6)).toBe("$52,001");
  });
  it("short keeps head and tail of an address", () => {
    expect(short("0x1234567890abcdef")).toBe("0x1234…cdef");
  });
});

describe("cents (Polymarket price notation)", () => {
  it("keeps one decimal for fractional cents", () => {
    expect(cents(0.532)).toBe("53.2¢");
    expect(cents(0.045)).toBe("4.5¢");
  });
  it("trims the trailing .0 on whole cents", () => {
    expect(cents(0.5)).toBe("50¢");
    expect(cents(1)).toBe("100¢");
  });
});

describe("usdCompact", () => {
  it("buckets into $/K/M with trailing-zero trim", () => {
    expect(usdCompact(1_200_000)).toBe("$1.2M");
    expect(usdCompact(1_000_000)).toBe("$1M");
    expect(usdCompact(850_000)).toBe("$850K");
    expect(usdCompact(900)).toBe("$900");
  });
  it("promotes a K value that rounds to 1000 into $1M", () => {
    expect(usdCompact(999_600)).toBe("$1M");
  });
  it("keeps the sign for negative values", () => {
    expect(usdCompact(-250_000)).toBe("-$250K");
  });
});

describe("durText", () => {
  it("shows minutes under an hour, clamping sub-minute to 1 分钟", () => {
    expect(durText(900)).toBe("15 分钟");
    expect(durText(10)).toBe("1 分钟");
    expect(durText(0)).toBe("1 分钟");
  });
  it("shows hours (one decimal, .0 trimmed) from an hour up", () => {
    expect(durText(3600)).toBe("1 小时");
    expect(durText(3.5 * 3600)).toBe("3.5 小时");
  });
});
