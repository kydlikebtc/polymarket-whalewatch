import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import { formatMarketCardTg, runBotCycle, type BotUpdate } from "./botCommands";
import type { MarketCard } from "./marketCard";

const card = (over: Partial<MarketCard> = {}): MarketCard => ({
  conditionId: "0xc1",
  identity: { title: "Will X happen?", slug: "x", eventSlug: "x-ev" },
  meta: {
    conditionId: "0xc1",
    volume24hr: 120_000,
    liquidity: 50_000,
    endDate: null,
    closed: false,
    category: null,
    feesEnabled: false,
    feeType: null,
    feeSchedule: null,
    umaDisputed: false,
    outcomes: ["Yes", "No"],
    clobTokenIds: ["tok-a", "tok-b"],
    outcomePrices: [0.4, 0.6],
  },
  brief: {
    classification: {
      kind: "consensus",
      group: {
        conditionId: "0xc1",
        outcome: "Yes",
        title: "Will X happen?",
        slug: "x",
        eventSlug: "x-ev",
        asset: "tok",
        outcomeIndex: 0,
        wallets: [],
        walletCount: 3,
        totalNetUsd: 45_000,
        avgBuyPrice: 0.379,
        firstTs: 0,
        lastTs: 0,
        formationTs: 0,
      },
    },
    smartFlow: [
      {
        outcome: "Yes",
        totalExposureUsd: 34_855,
        totalNetShares: 70_000,
        wallets: [
          {
            wallet: "0xa",
            exposureUsd: 34_855,
            netShares: 70_000,
            avgBuyPrice: 0.5,
            score: 80,
            winRate: 0.7,
            isMarketMaker: false,
          },
        ],
      },
    ],
    accum: [],
    settled: false,
  },
  freshFlow: [
    {
      wallet: "0xf",
      ageDays: 0.2,
      usd: 9_971,
      price: 0.684,
      outcome: "Yes",
      ts: 1,
    },
  ],
  history: [
    {
      type: "consensus",
      createdAt: 1,
      title: "Will X happen?",
      outcome: "Yes",
      side: "BUY",
      usd: 18_470,
      price: null,
      eventSlug: "x-ev",
      won: 1,
      price1h: 0.725,
      price24h: null,
      resolved: true,
      foldKey: "consensus:0xc1:Yes",
    },
  ],
  window: { trades: 36, truncated: false, hours: 24 },
  // 默认 null = 底座没覆盖到这个市场。TG 版式不渲染 pulse 段,夹具给 null 就
  // 够;需要断言标签的用例自己 over 掉。
  pulse: null,
  ...over,
});

describe("formatMarketCardTg", () => {
  it("分区版式:空行隔段,价格加粗做锚点,三个小节可扫读", () => {
    const html = formatMarketCardTg(card());
    // 头部块:标题 + 现价(价格加粗) + 量。
    expect(html).toContain("🎯 <b>Will X happen?</b>");
    expect(html).toContain("Yes <b>40¢</b> · No <b>60¢</b>");
    expect(html).toContain("24h 量 $120,000");
    // 空行分区(TG 可读性的关键)。
    expect(html).toContain("\n\n");
    // 信号区:共识醒目,金额与均价独立行。
    expect(html).toContain("🔥 <b>共识</b> · 3 钱包买入 <b>Yes</b>");
    expect(html).toContain("净买 $45,000 @37.9¢");
    // 聪明钱动向区:小节标题 + 每行一个事实。
    expect(html).toContain("<b>聪明钱动向</b>");
    expect(html).toContain("🏆 Yes 留仓 <b>$34,855</b>（1 钱包 · 均价 50¢）");
    expect(html).toContain("🆕 新钱包 1 笔 · 最大 $9,971 @68.4¢（账龄 5小时）");
    // 战绩区。
    expect(html).toContain("<b>本工具战绩</b>");
    expect(html).toContain("📐 90d 1 条告警 · 已判定 1/1 中");
    expect(html).toContain("polymarket.com/event/x-ev");
  });

  it("已结算市场:不说「留仓」,改报窗口净股数,且均价不被归零的敞口权重带崩", () => {
    const base = card();
    const html = formatMarketCardTg({
      ...base,
      brief: {
        ...base.brief,
        settled: true,
        // 服务端(lib/marketBrief 结算闸门)已把敞口归零后的真实形状。
        smartFlow: base.brief.smartFlow.map((f) => ({
          ...f,
          totalExposureUsd: 0,
          wallets: f.wallets.map((w) => ({ ...w, exposureUsd: 0 })),
        })),
      },
    });
    expect(html).not.toContain("留仓");
    expect(html).toContain("🏆 Yes 窗口净买 <b>70,000</b> 股");
    // 权重换成净股数后,均价仍是 50¢ —— 用 exposureUsd 加权会打印 0¢。
    expect(html).toContain("均价 50¢");
    expect(html).toContain("已结算");
  });

  it("战绩行折叠共识升级 —— 一次共识不报成三条(与推送/看板同口径)", () => {
    // 实测复现过的错法:同一组 2→3→4 人的三条升级行 + 一条判负的大额,
    // 逐行计数输出「已判定 3/4 中」,而诚实口径是 1/2。
    const esc = (n: number, won: number) => ({
      type: "consensus",
      createdAt: n,
      title: "Will X happen?",
      outcome: "Yes",
      side: "BUY",
      usd: 1000 * n,
      price: null,
      eventSlug: "x-ev",
      won,
      price1h: null,
      price24h: null,
      resolved: true,
      foldKey: "consensus:0xc1:Yes",
    });
    const html = formatMarketCardTg(
      card({
        history: [
          esc(1, 1),
          esc(2, 1),
          esc(3, 1),
          {
            type: "large",
            createdAt: 4,
            title: "Will X happen?",
            outcome: "Yes",
            side: "BUY",
            usd: 12_000,
            price: 0.4,
            eventSlug: "x-ev",
            won: 0,
            price1h: null,
            price24h: null,
            resolved: true,
            foldKey: null, // 单笔成交:独立信号,不折叠
          },
        ],
      }),
    );
    expect(html).toContain("已判定 1/2 中");
    expect(html).not.toContain("已判定 3/4 中");
    // 「N 条告警」仍报原始行数 —— 这个市场上确实推送过 4 次。
    expect(html).toContain("90d 4 条告警");
  });

  it("publicUrl → 链接区带 🔗 完整信号卡（identity 缺失也照带,cid 已知）", () => {
    const html = formatMarketCardTg(card(), {
      publicUrl: "https://whalewatch.wired.fund",
    });
    expect(html).toContain('href="https://whalewatch.wired.fund/market/0xc1"');
    expect(html).toContain("🔗");
    expect(html).toContain("完整信号卡");
    const bare = formatMarketCardTg(card({ identity: null }), {
      publicUrl: "https://whalewatch.wired.fund",
    });
    expect(bare).toContain("/market/0xc1");
  });

  it("空窗口/无共识时诚实降级:⚪️ 状态行,空节整段消失,不编数字", () => {
    const html = formatMarketCardTg(
      card({
        identity: null,
        brief: {
          classification: { kind: "none" },
          smartFlow: [],
          accum: [],
          settled: false,
        },
        freshFlow: [],
        history: [],
        window: { trades: 0, truncated: false, hours: 24 },
      }),
    );
    expect(html).toContain("0xc1"); // 无 identity 退回 cid
    expect(html).toContain("⚪️ 近 24h 无共识/分歧");
    expect(html).not.toContain("🆕");
    expect(html).not.toContain("聪明钱动向"); // 空节不留孤儿标题
    expect(html).toContain("📐 90d 暂无告警");
  });

  it("拆单与新钱包挂在聪明钱动向节下,各占一行", () => {
    const html = formatMarketCardTg(card());
    const section = html.split("<b>聪明钱动向</b>")[1].split("\n\n")[0];
    expect(section).toContain("🏆");
    expect(section).toContain("🆕");
  });
});

const upd = (id: number, text: string, chatId = 42): BotUpdate => ({
  update_id: id,
  message: { chat: { id: chatId, type: "private" }, text },
});

const cycleDeps = (over: Record<string, unknown> = {}) => ({
  getUpdatesFn: vi.fn(async () => [] as BotUpdate[]),
  send: vi.fn(async () => {}),
  buildCard: vi.fn(async () => card()),
  resolve: vi.fn(async () => ({ kind: "cid" as const, conditionId: "0xc1" })),
  ...over,
});

describe("runBotCycle", () => {
  it("/start → 帮助文案;offset 前进并持久化", async () => {
    const db = openDb(":memory:");
    const deps = cycleDeps({
      getUpdatesFn: vi.fn(async () => [upd(100, "/start")]),
    });
    await runBotCycle(db, deps);
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect((deps.send.mock.calls[0] as unknown[])[1]).toContain("市场信号卡");
    const off = db
      .prepare("SELECT value FROM config WHERE key='bot_updates_offset'")
      .get() as { value: string };
    expect(off.value).toBe("101");
    // 下一轮用新 offset 拉取。
    await runBotCycle(db, deps);
    expect(deps.getUpdatesFn).toHaveBeenLastCalledWith(101);
  });

  it("/card 菜单命令 → 引导提示（下一条消息即查询,无需状态机）", async () => {
    const db = openDb(":memory:");
    const deps = cycleDeps({
      getUpdatesFn: vi.fn(async () => [upd(1, "/card", 55)]),
    });
    await runBotCycle(db, deps);
    expect(deps.buildCard).not.toHaveBeenCalled();
    const msg = (deps.send.mock.calls[0] as unknown[])[1] as string;
    expect(msg).toContain("发给我");
    expect((deps.send.mock.calls[0] as unknown[])[0]).toBe(55);
  });

  it("文本查询 → 解析 → 组卡 → 回复到发问的 chat", async () => {
    const db = openDb(":memory:");
    const deps = cycleDeps({
      getUpdatesFn: vi.fn(async () => [upd(1, "fed-september", 77)]),
    });
    const r = await runBotCycle(db, deps);
    expect(deps.resolve).toHaveBeenCalledWith("fed-september");
    expect(deps.buildCard).toHaveBeenCalledWith("0xc1");
    expect((deps.send.mock.calls[0] as unknown[])[0]).toBe(77);
    expect((deps.send.mock.calls[0] as unknown[])[1]).toContain("🎯");
    expect(r.cards).toBe(1);
  });

  it("事件多市场 → 候选列表;解析失败 → 提示", async () => {
    const db = openDb(":memory:");
    const deps = cycleDeps({
      getUpdatesFn: vi.fn(async () => [upd(1, "some-event"), upd(2, "???")]),
      resolve: vi
        .fn()
        .mockResolvedValueOnce({
          kind: "candidates",
          candidates: [
            { conditionId: "0xaa", question: "Q1?" },
            { conditionId: "0xbb", question: "Q2?" },
          ],
        })
        .mockResolvedValueOnce({ kind: "error", message: "未找到该市场" }),
    });
    await runBotCycle(db, deps);
    const msgs = deps.send.mock.calls.map((c) => (c as unknown[])[1] as string);
    expect(msgs[0]).toContain("Q1?");
    expect(msgs[0]).toContain("0xaa");
    expect(msgs[1]).toContain("未找到该市场");
  });

  it("非 message 更新(频道贴文/成员变更)跳过但 offset 照常前进", async () => {
    const db = openDb(":memory:");
    const deps = cycleDeps({
      getUpdatesFn: vi.fn(async () => [
        { update_id: 5 } as BotUpdate, // my_chat_member 等无 message 的更新
        upd(6, "/help"),
      ]),
    });
    await runBotCycle(db, deps);
    expect(deps.send).toHaveBeenCalledTimes(1);
    const off = db
      .prepare("SELECT value FROM config WHERE key='bot_updates_offset'")
      .get() as { value: string };
    expect(off.value).toBe("7");
  });

  it("单轮组卡上限:超出的查询留给下一轮(offset 停在其之前)", async () => {
    const db = openDb(":memory:");
    const deps = cycleDeps({
      getUpdatesFn: vi.fn(async () => [upd(1, "a"), upd(2, "b"), upd(3, "c")]),
      maxCards: 2,
    });
    const r = await runBotCycle(db, deps);
    expect(r.cards).toBe(2);
    const off = db
      .prepare("SELECT value FROM config WHERE key='bot_updates_offset'")
      .get() as { value: string };
    expect(off.value).toBe("3"); // update 3 未处理,下一轮从它开始
  });

  it("无更新 → 不写 offset 不发消息", async () => {
    const db = openDb(":memory:");
    const deps = cycleDeps();
    await runBotCycle(db, deps);
    expect(deps.send).not.toHaveBeenCalled();
    expect(
      db
        .prepare("SELECT value FROM config WHERE key='bot_updates_offset'")
        .get(),
    ).toBeUndefined();
  });
});
