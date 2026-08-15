import { describe, it, expect } from "vitest";
import {
  formatStrategyEntryTg,
  formatStrategySettleTg,
  SIGNAL_DISCLAIMER,
  type PushSignalRow,
} from "./signalPush";
import type { SignalRecord } from "./signalRecord";

// 对外信号批次 1:TG 消息格式化(纯函数)。
// 铁律:战绩行必须经 formatRecordLine(implied 必印、excess 不脱离 ±2σ);
// 免责尾行每条必带;所有动态文本经 esc/urlSeg(毒消息防线)。

const row = (o: Partial<PushSignalRow> = {}): PushSignalRow => ({
  id: 1,
  strategy_id: 6,
  condition_id: "0xc1",
  outcome: "Yes",
  outcome_index: 0,
  asset: "tok1",
  title: "Will X win?",
  slug: "will-x-win",
  event_slug: "x-event",
  formation_ts: 1000,
  reference_price: 0.61,
  wallet_count: 1,
  total_net_usd: 52000,
  entry_price: 0.63,
  size_usd: 500,
  emitted_at: 1047,
  settled: 0,
  settled_ts: null,
  exit_price: null,
  won: null,
  realized_pnl: null,
  ...o,
});

const rec = (settled: number): SignalRecord => ({
  settled,
  wins: Math.round(settled * 0.6),
  implied: settled * 0.55,
  excess: settled * 0.05,
  sd: Math.sqrt(settled * 0.25),
});

describe("formatStrategyEntryTg", () => {
  it("单档:策略名/标题深链/方向价位/聪明钱成本/追价/延迟/免责全在", () => {
    const html = formatStrategyEntryTg([row()], {
      strategyNames: new Map([[6, "巨鲸"]]),
      recordByStrategy: new Map(),
      publicUrl: "https://example.com",
      nowSec: 1100,
    });
    expect(html).toContain("巨鲸");
    expect(html).toContain('href="https://example.com/market/0xc1"');
    expect(html).toContain("Will X win?");
    expect(html).toContain("Yes");
    expect(html).toContain("63¢");
    expect(html).toContain("61¢");
    // 追价 = 63 - 61 = +2¢(带符号)。
    expect(html).toContain("+2");
    expect(html).toContain(SIGNAL_DISCLAIMER);
    // 模拟口径必须自明。
    expect(html).toContain("$500");
  });

  it("同市场同方向多档合并为一条,名字全列出(以最早 emitted 行为数字基准)", () => {
    const html = formatStrategyEntryTg(
      [
        row({ id: 2, strategy_id: 3, emitted_at: 1200, entry_price: 0.66 }),
        row({ id: 1, strategy_id: 6, emitted_at: 1047, entry_price: 0.63 }),
      ],
      {
        strategyNames: new Map([
          [6, "巨鲸"],
          [3, "精英共识"],
        ]),
        recordByStrategy: new Map(),
        nowSec: 1300,
      },
    );
    expect(html).toContain("巨鲸");
    expect(html).toContain("精英共识");
    // 最早 emitted(id=1, entry 0.63)提供头部数字 —— 与 foldEscalations
    // 「按读者真正能行动的那个价格计」同一哲学。
    expect(html).toContain("63¢");
    expect(html).not.toContain("66¢");
  });

  it("战绩行:settled>0 经 formatRecordLine 打印;=0 整行省略;最多 2 行", () => {
    const html = formatStrategyEntryTg(
      [
        row({ id: 1, strategy_id: 1 }),
        row({ id: 2, strategy_id: 2 }),
        row({ id: 3, strategy_id: 3 }),
      ],
      {
        strategyNames: new Map([
          [1, "A"],
          [2, "B"],
          [3, "C"],
        ]),
        recordByStrategy: new Map([
          [1, rec(20)],
          [2, rec(15)],
          [3, rec(10)],
        ]),
        nowSec: 1100,
      },
    );
    // formatRecordLine 的口径词根必须在(市场同价位预期 = implied 必印铁律)。
    expect(html).toContain("市场同价位预期");
    expect((html.match(/📐/g) ?? []).length).toBe(2);
    const none = formatStrategyEntryTg([row()], {
      strategyNames: new Map([[6, "巨鲸"]]),
      recordByStrategy: new Map([[6, rec(0)]]),
      nowSec: 1100,
    });
    expect(none).not.toContain("📐");
  });

  it("HTML 注入防线:标题恶意字符被转义,深链 cid 经 urlSeg", () => {
    const html = formatStrategyEntryTg(
      [row({ title: '<b>"x"&y</b>', condition_id: 'a"b<c>' })],
      {
        strategyNames: new Map([[6, "巨鲸"]]),
        recordByStrategy: new Map(),
        publicUrl: "https://e.com",
        nowSec: 1100,
      },
    );
    expect(html).not.toContain('<b>"x"');
    expect(html).toContain("&lt;b&gt;");
    // href 里不允许裸引号(经 encodeURIComponent + escAttr)。
    expect(html).toContain('href="https://e.com/market/a%22b%3Cc%3E"');
  });

  it("分类行:有值才出现,一二级用 · 连接", () => {
    const withCat = formatStrategyEntryTg([row()], {
      strategyNames: new Map([[6, "巨鲸"]]),
      recordByStrategy: new Map(),
      category: "Sports",
      subcategory: "NBA",
      nowSec: 1100,
    });
    expect(withCat).toContain("Sports · NBA");
    const noCat = formatStrategyEntryTg([row()], {
      strategyNames: new Map([[6, "巨鲸"]]),
      recordByStrategy: new Map(),
      nowSec: 1100,
    });
    expect(noCat).not.toContain("分类");
  });
});

describe("formatStrategySettleTg", () => {
  it("认账:结算价/每档入场与盈亏/胜负 emoji/免责", () => {
    const html = formatStrategySettleTg(
      [
        row({
          id: 1,
          strategy_id: 6,
          settled: 1,
          settled_ts: 5000,
          exit_price: 1,
          won: 1,
          realized_pnl: 293.7,
        }),
        row({
          id: 2,
          strategy_id: 3,
          entry_price: 0.66,
          settled: 1,
          settled_ts: 5000,
          exit_price: 1,
          won: 1,
          realized_pnl: 257.6,
        }),
      ],
      {
        strategyNames: new Map([
          [6, "巨鲸"],
          [3, "精英共识"],
        ]),
        nowSec: 5100,
      },
    );
    expect(html).toContain("100¢");
    expect(html).toContain("巨鲸");
    expect(html).toContain("精英共识");
    expect(html).toContain("+$294");
    expect(html).toContain("+$258");
    expect(html).toContain("✅");
    expect(html).toContain(SIGNAL_DISCLAIMER);
  });

  it("亏损与平局:❌ 与 ➖(push 纪律,盈亏 $0 不算胜负)", () => {
    const html = formatStrategySettleTg(
      [
        row({
          id: 1,
          strategy_id: 6,
          settled: 1,
          exit_price: 0,
          won: 0,
          realized_pnl: -500,
        }),
        row({
          id: 2,
          strategy_id: 3,
          settled: 1,
          exit_price: 0.63,
          won: null,
          realized_pnl: 0,
        }),
      ],
      {
        strategyNames: new Map([
          [6, "巨鲸"],
          [3, "精英共识"],
        ]),
        nowSec: 5100,
      },
    );
    expect(html).toContain("❌");
    expect(html).toContain("➖");
    expect(html).toContain("-$500");
  });
});
