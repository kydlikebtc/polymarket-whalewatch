import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  fmtRecordCell,
  parseTheme,
  renderRecordEmbed,
  renderSelfTestEmbed,
  renderStatusEmbed,
} from "./embedCards";
import type { RecordFeed, RecordFeedStrategy } from "./recordFeed";
import type { HealthReport } from "./health";
import type { ContinuityReport } from "./continuity";
import { buildSelfTestVerdict, type PoolMemberRow } from "./selfTest";
import type { WalletStats } from "./walletStats";

const BASE = "https://whalewatch.wired.fund";

function strat(over: Partial<RecordFeedStrategy> = {}): RecordFeedStrategy {
  return {
    id: 1,
    code: "mega_whale",
    name: "超级巨鲸",
    source: "whale",
    pushedCount: 12,
    record: { settled: 8, wins: 6, implied: 4.2, excess: 1.8, sd: 1.2 },
    settledRecent: [],
    ...over,
  };
}

function feed(strategies: RecordFeedStrategy[]): RecordFeed {
  return {
    updatedAt: 1_787_800_000,
    strategies,
    digest: { day: "2026-08-26", tail: "abcdef0123456789" },
  };
}

const HEALTH_OK: HealthReport = {
  ok: true,
  nowSec: 1_787_800_000,
  loops: [
    {
      loop: "alert",
      lastTs: 1,
      ageSec: 1,
      staleAfterSec: 300,
      stale: false,
      cycles: 10,
      maxGapSec: 2,
    },
  ],
  staleLoops: [],
  startedAt: 1,
};

function cont(over: Partial<ContinuityReport> = {}): ContinuityReport {
  return {
    gateDays: 30,
    tolSec: 1200,
    recordStartDay: "2026-07-13",
    days: [],
    streakDays: 13,
    streakStartDay: "2026-08-14",
    streakClipped: false,
    todayCoveredSoFar: true,
    gateReached: false,
    ...over,
  };
}

describe("parseTheme / escapeHtml", () => {
  it("theme 只认 dark,其余一律 light(未知值不该猜)", () => {
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("blue")).toBe("light");
    expect(parseTheme(null)).toBe("light");
  });
  it("四件套转义 —— 档位名来自库,嵌入卡是注入面", () => {
    expect(escapeHtml(`<b a="1">&`)).toBe("&lt;b a=&quot;1&quot;&gt;&amp;");
  });
});

describe("fmtRecordCell", () => {
  it("零样本给 — 而非 0 —— 「没测过」不能冒充「测过了是零」", () => {
    const c = fmtRecordCell(
      strat({ record: { settled: 0, wins: 0, implied: 0, excess: 0, sd: 0 } }),
    );
    expect(c).toEqual({ text: "—", tone: "muted" });
  });
  it("有样本给 wins/settled 与对市场超额,σ 只在 sd>0 时出现", () => {
    const c = fmtRecordCell(strat());
    expect(c.text).toBe("6/8 · +1.8 vs market (1.5σ)");
    expect(c.tone).toBe("up");
    const noSd = fmtRecordCell(
      strat({ record: { settled: 3, wins: 1, implied: 2, excess: -1, sd: 0 } }),
    );
    expect(noSd.text).toBe("1/3 · -1.0 vs market");
    expect(noSd.tone).toBe("down");
  });
});

describe("renderRecordEmbed", () => {
  it("档位名转义后出现,署名回链指向 /record", () => {
    const html = renderRecordEmbed(feed([strat({ name: "<script>x" })]), {
      theme: "light",
      baseUrl: BASE,
    });
    expect(html).toContain("&lt;script&gt;x");
    expect(html).not.toContain("<script>x");
    expect(html).toContain(`href="${BASE}/record"`);
    expect(html).toContain("whalewatch.wired.fund");
  });
  it("按 pushedCount 降序截 maxRows,溢出行数如实标注", () => {
    const many = [1, 2, 3].map((n) =>
      strat({ id: n, name: `档${n}`, pushedCount: n }),
    );
    const html = renderRecordEmbed(feed(many), {
      theme: "light",
      baseUrl: BASE,
      maxRows: 2,
    });
    expect(html).toContain("档3");
    expect(html).toContain("档2");
    expect(html).not.toContain("档1</td>");
    expect(html).toContain("+1 more tiers");
  });
  it("空账给积累中文案,不渲染表格", () => {
    const html = renderRecordEmbed(feed([]), { theme: "light", baseUrl: BASE });
    expect(html).toContain("No published signals yet");
    expect(html).not.toContain("<table>");
  });
  it("存证链尾与更新时刻可见 —— 嵌入卡也要可对账", () => {
    const html = renderRecordEmbed(feed([strat()]), {
      theme: "light",
      baseUrl: BASE,
    });
    expect(html).toContain("digest 2026-08-26");
    expect(html).toContain("abcdef0123");
    expect(html).toContain("Updated 2026-08-27T");
  });
  it("dark 主题换底色,light 不含暗底", () => {
    const dark = renderRecordEmbed(feed([strat()]), {
      theme: "dark",
      baseUrl: BASE,
    });
    const light = renderRecordEmbed(feed([strat()]), {
      theme: "light",
      baseUrl: BASE,
    });
    expect(dark).toContain("#14161e");
    expect(light).not.toContain("#14161e");
  });
});

describe("renderStatusEmbed", () => {
  it("正常态:绿点 + 连续覆盖读数 + 起算日", () => {
    const html = renderStatusEmbed(HEALTH_OK, cont(), {
      theme: "light",
      baseUrl: BASE,
    });
    expect(html).toContain("All systems operational");
    expect(html).toContain("13d continuous coverage");
    expect(html).toContain("since 2026-08-14");
    expect(html).toContain(`href="${BASE}/status"`);
  });
  it("停跳态点名个数;clipped 加 ≥;达标加 30d gate ✓", () => {
    const bad: HealthReport = {
      ...HEALTH_OK,
      ok: false,
      loops: [
        { ...HEALTH_OK.loops[0], stale: true },
        { ...HEALTH_OK.loops[0], loop: "consensus", stale: true },
      ],
      staleLoops: ["alert", "consensus"],
    };
    const html = renderStatusEmbed(
      bad,
      cont({ streakClipped: true, streakDays: 60, gateReached: true }),
      { theme: "dark", baseUrl: BASE },
    );
    expect(html).toContain("2 loop(s) stalled");
    expect(html).toContain("≥60d continuous coverage");
    expect(html).toContain("30d gate ✓");
  });
  it("从未有记录:如实说 no cycle records yet", () => {
    const html = renderStatusEmbed(
      HEALTH_OK,
      cont({ recordStartDay: null, streakDays: 0, streakStartDay: null }),
      { theme: "light", baseUrl: BASE },
    );
    expect(html).toContain("no cycle records yet");
  });
});

describe("renderSelfTestEmbed", () => {
  const ADDR = "0x1234567890abcdef1234567890abcdef12345678";
  const wstats = (over: Partial<WalletStats> = {}): WalletStats => ({
    winRate: null,
    netPnl: null,
    roi: null,
    settledCount: 0,
    truncated: false,
    marketsTraded: 10,
    isMarketMaker: false,
    ...over,
  });
  const pool: PoolMemberRow[] = [
    { address: "0xa", score: 40, winRate: 0.5, netPnl: 100 },
    { address: "0xb", score: 60, winRate: 0.7, netPnl: 9000 },
  ];
  const render = (
    stats: WalletStats | null,
    over: { fetchedAt?: number | null; theme?: "light" | "dark" } = {},
  ) =>
    renderSelfTestEmbed(
      {
        address: ADDR,
        verdict: buildSelfTestVerdict(ADDR, stats, pool),
        statsFetchedAt: over.fetchedAt ?? 1_787_800_000,
      },
      { theme: over.theme ?? "light", baseUrl: BASE },
    );

  it("pass 卡:判决词 + 三行数据带池分位 + 口径行 + 免责声明 + 署名回链指 /selftest", () => {
    const html = render(
      wstats({ winRate: 0.6, netPnl: 1200, roi: 0.02, settledCount: 12 }),
    );
    expect(html).toContain("PASS");
    expect(html).toContain("clears the pool-admission bar");
    expect(html).toContain("0x1234…5678");
    expect(html).toContain("60%"); // win rate
    expect(html).toContain("P50 of 2"); // 0.6 在 [0.5,0.7] 的 midrank 分位
    expect(html).toContain("12 settled");
    expect(html).toContain("not certification, not investment advice");
    expect(html).toContain("≥55%"); // 口径引用常量
    expect(html).toContain(`href="${BASE}/selftest"`);
    expect(html).toContain("Data as of 2026-08-27");
  });

  it("fail 卡:below the bar,与 unjudged 措辞严格分家", () => {
    const html = render(
      wstats({ winRate: 0.4, netPnl: -500, roi: -0.1, settledCount: 20 }),
    );
    expect(html).toContain("BELOW BAR");
    expect(html).not.toContain("UNJUDGEABLE");
  });

  it("截断样本:UNJUDGEABLE + 胜率显示 — 绝不显示错数", () => {
    const html = render(
      wstats({ netPnl: 8000, settledCount: 900, truncated: true }),
    );
    expect(html).toContain("UNJUDGEABLE");
    expect(html).toContain("record truncated");
    expect(html).toMatch(/Win rate<\/td><td[^>]*>—/);
  });

  it("做市商:N/A 判决,不给评分", () => {
    const html = render(
      wstats({ netPnl: 90000, marketsTraded: 5000, isMarketMaker: true }),
    );
    expect(html).toContain("N/A");
    expect(html).toContain("market-maker");
  });

  it("no_data(本地无缓存)→ 未测过引导卡,不渲染数据表", () => {
    const html = render(null, { fetchedAt: null });
    expect(html).toContain("Not tested yet");
    expect(html).toContain("Run the self-test");
    expect(html).not.toContain("Win rate");
  });

  it("dark 主题换底色", () => {
    const html = render(
      wstats({ winRate: 0.6, netPnl: 1200, roi: 0.02, settledCount: 12 }),
      { theme: "dark" },
    );
    expect(html).toContain("#14161e");
  });
});
