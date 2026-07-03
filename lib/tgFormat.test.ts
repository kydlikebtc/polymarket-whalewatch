import { describe, it, expect } from "vitest";
import { esc, escAttr, urlSeg, usd, short } from "./tgFormat";

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
