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
    outcomes: ["Yes", "No"],
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
    },
  ],
  window: { trades: 36, truncated: false, hours: 24 },
  ...over,
});

describe("formatMarketCardTg", () => {
  it("渲染标题/现价/共识/敞口/新钱包/告警战绩为紧凑 TG 卡", () => {
    const html = formatMarketCardTg(card());
    expect(html).toContain("🎯 <b>Will X happen?</b>");
    expect(html).toContain("Yes 40¢");
    expect(html).toContain("🔥 共识:3 钱包买入 <b>Yes</b>");
    expect(html).toContain("$45,000");
    expect(html).toContain("🏆 聪明钱敞口:Yes $34,855(1 钱包)");
    expect(html).toContain("🆕 新钱包:1 笔");
    expect(html).toContain("📐 告警史 90d:1 条 · 已判定 1/1 中");
    expect(html).toContain("polymarket.com/event/x-ev");
  });

  it("publicUrl → 卡片带完整线上信号卡链接（identity 缺失也照带,cid 已知）", () => {
    const html = formatMarketCardTg(card(), {
      publicUrl: "https://whalewatch.wired.fund",
    });
    expect(html).toContain('href="https://whalewatch.wired.fund/market/0xc1"');
    expect(html).toContain("完整信号卡");
    // identity 为 null 时线上链接仍在（conditionId 永远可用）。
    const bare = formatMarketCardTg(card({ identity: null }), {
      publicUrl: "https://whalewatch.wired.fund",
    });
    expect(bare).toContain("/market/0xc1");
  });

  it("空窗口/无共识时诚实降级,不编数字", () => {
    const html = formatMarketCardTg(
      card({
        identity: null,
        brief: { classification: { kind: "none" }, smartFlow: [], accum: [] },
        freshFlow: [],
        history: [],
        window: { trades: 0, truncated: false, hours: 24 },
      }),
    );
    expect(html).toContain("0xc1"); // 无 identity 退回 cid
    expect(html).toContain("窗口内无共识/分歧");
    expect(html).not.toContain("🆕");
    expect(html).toContain("暂无本工具告警");
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
