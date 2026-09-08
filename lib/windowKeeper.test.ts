import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWindowKeeper } from "./windowKeeper";
import type { DeepWindowResult, TradesSinceResult } from "./polymarket";
import type { Trade } from "./types";

// 与 polymarket.test.ts 同款的行工厂;dedupKey 由 transactionHash 区分。
function trade(over: Partial<Trade> & { timestamp: number }): Trade {
  return {
    proxyWallet: "0x1",
    side: "BUY",
    asset: "9",
    conditionId: "0xc",
    size: 100,
    price: 0.5,
    title: "M",
    slug: "s",
    eventSlug: "e",
    outcome: "Yes",
    outcomeIndex: 0,
    transactionHash: `0x${over.timestamp}`,
    ...over,
  };
}

const WINDOW = 6 * 3600;
const T0 = 1_700_000_000;

function sweepResult(
  trades: Trade[],
  opts: { truncated?: boolean; effectiveSinceSec?: number; sinceSec?: number } = {},
): DeepWindowResult {
  return {
    trades: [...trades].sort((a, b) => b.timestamp - a.timestamp),
    truncated: opts.truncated ?? false,
    effectiveSinceSec: opts.effectiveSinceSec ?? opts.sinceSec ?? T0 - WINDOW,
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("windowKeeper — 种子与增量", () => {
  it("首轮走全量种子,返回形状与 getTradesWindowDeep 一致", async () => {
    const rows = [trade({ timestamp: T0 - 100 }), trade({ timestamp: T0 - 50 })];
    const fullSweep = vi
      .fn()
      .mockResolvedValue(sweepResult(rows, { sinceSec: T0 - WINDOW }));
    const fetchSince = vi.fn();
    const keeper = createWindowKeeper({
      fullSweep,
      fetchSince,
      windowSec: WINDOW,
      nowSec: () => T0,
    });
    const win = await keeper.tick();
    expect(fullSweep).toHaveBeenCalledWith(T0 - WINDOW);
    expect(fetchSince).not.toHaveBeenCalled();
    expect(win.trades.map((t) => t.timestamp)).toEqual([T0 - 50, T0 - 100]);
    expect(win.truncated).toBe(false);
    expect(win.effectiveSinceSec).toBe(T0 - WINDOW);
  });

  it("后续轮只增量:新行合并进缓冲,重叠行按 dedupKey 吸收", async () => {
    let now = T0;
    const seed = [trade({ timestamp: T0 - 100 })];
    const fullSweep = vi.fn().mockResolvedValue(sweepResult(seed));
    // 增量返回:一行真正的新行 + 一行与缓冲重复的旧行(边距重叠的典型形态)。
    const fetchSince = vi.fn().mockResolvedValue({
      trades: [trade({ timestamp: T0 + 30 }), trade({ timestamp: T0 - 100 })],
      connected: true,
    } satisfies TradesSinceResult);
    const keeper = createWindowKeeper({
      fullSweep,
      fetchSince,
      windowSec: WINDOW,
      nowSec: () => now,
    });
    await keeper.tick();
    now = T0 + 60;
    const win = await keeper.tick();
    expect(fullSweep).toHaveBeenCalledTimes(1); // 种子后不再全量
    expect(win.trades.map((t) => t.timestamp)).toEqual([T0 + 30, T0 - 100]);
    expect(keeper.size()).toBe(2); // 重复行没有第二份
  });

  it("增量抓取的边界 = 水位线 − 边距(并被覆盖起点钳住)", async () => {
    let now = T0;
    const fullSweep = vi
      .fn()
      .mockResolvedValue(sweepResult([trade({ timestamp: T0 - 40 })]));
    const fetchSince = vi
      .fn()
      .mockResolvedValue({ trades: [], connected: true });
    const keeper = createWindowKeeper({
      fullSweep,
      fetchSince,
      windowSec: WINDOW,
      marginSec: 180,
      nowSec: () => now,
    });
    await keeper.tick();
    now = T0 + 60;
    await keeper.tick();
    // 水位线 = 种子里最新行 T0-40,边界 = 水位线 − 180。
    expect(fetchSince).toHaveBeenCalledWith(T0 - 40 - 180);
  });

  it("时间淘汰:滚出窗口的行出账,覆盖起点随下界推进(种子截断自愈)", async () => {
    let now = T0;
    const old = trade({ timestamp: T0 - WINDOW + 30 });
    const fullSweep = vi.fn().mockResolvedValue(
      // 种子被截断:诚实起点比请求晚 600s。
      sweepResult([old], { truncated: true, effectiveSinceSec: T0 - WINDOW + 600 }),
    );
    const fetchSince = vi
      .fn()
      .mockResolvedValue({ trades: [], connected: true });
    const keeper = createWindowKeeper({
      fullSweep,
      fetchSince,
      windowSec: WINDOW,
      nowSec: () => now,
    });
    const first = await keeper.tick();
    expect(first.truncated).toBe(true); // 截断种子如实上报
    // 时间推进 600s:窗口下界越过了种子的诚实起点 → 截断愈合;
    // 同时 old 行(距下界 30s)滚出窗口被淘汰。
    now = T0 + 600;
    const win = await keeper.tick();
    expect(win.truncated).toBe(false);
    expect(win.effectiveSinceSec).toBe(now - WINDOW);
    expect(win.trades).toEqual([]);
  });
});

describe("windowKeeper — fail-closed 与自愈", () => {
  it("增量不衔接:丢弃前缀,当轮退回全量重扫", async () => {
    let now = T0;
    const fullSweep = vi
      .fn()
      .mockResolvedValue(sweepResult([trade({ timestamp: T0 - 10 })]));
    const fetchSince = vi.fn().mockResolvedValue({
      trades: [trade({ timestamp: T0 + 30, transactionHash: "0xorphan" })],
      connected: false,
    });
    const keeper = createWindowKeeper({
      fullSweep,
      fetchSince,
      windowSec: WINDOW,
      nowSec: () => now,
    });
    await keeper.tick();
    now = T0 + 60;
    const win = await keeper.tick();
    expect(fullSweep).toHaveBeenCalledTimes(2); // 种子 + 回退重扫
    // 不衔接的前缀绝不能进账(底下可能有洞)。
    expect(
      win.trades.some((t) => t.transactionHash === "0xorphan"),
    ).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("disconnected"),
    );
  });

  it("增量瞬态失败:陈旧限度内照常供给旧缓冲,不标 truncated", async () => {
    let now = T0;
    const fullSweep = vi
      .fn()
      .mockResolvedValue(sweepResult([trade({ timestamp: T0 - 10 })]));
    const fetchSince = vi.fn().mockRejectedValue(new Error("net down"));
    const keeper = createWindowKeeper({
      fullSweep,
      fetchSince,
      windowSec: WINDOW,
      staleLimitSec: 300,
      nowSec: () => now,
    });
    await keeper.tick();
    now = T0 + 60;
    const win = await keeper.tick();
    expect(win.trades).toHaveLength(1);
    expect(win.truncated).toBe(false); // 旧≠残缺
  });

  it("陈旧超限且本轮仍拿不到数据:抛错(engine 跳过 beat,停跳可见)", async () => {
    let now = T0;
    const fullSweep = vi
      .fn()
      .mockResolvedValue(sweepResult([trade({ timestamp: T0 - 10 })]));
    const fetchSince = vi.fn().mockRejectedValue(new Error("net down"));
    const keeper = createWindowKeeper({
      fullSweep,
      fetchSince,
      windowSec: WINDOW,
      staleLimitSec: 300,
      nowSec: () => now,
    });
    await keeper.tick(); // 种子成功,lastGoodFetch = T0
    now = T0 + 301; // 超过陈旧限度
    await expect(keeper.tick()).rejects.toThrow("net down");
  });

  it("种子失败:直接抛错,绝不假装有窗口", async () => {
    const fullSweep = vi.fn().mockRejectedValue(new Error("both sides failed"));
    const keeper = createWindowKeeper({
      fullSweep,
      fetchSince: vi.fn(),
      windowSec: WINDOW,
      nowSec: () => T0,
    });
    await expect(keeper.tick()).rejects.toThrow("both sides failed");
    // 下一轮种子恢复即正常。
    fullSweep.mockResolvedValue(sweepResult([trade({ timestamp: T0 - 5 })]));
    const win = await keeper.tick();
    expect(win.trades).toHaveLength(1);
  });

  it("定时全量重扫:到点后即使增量健康也重扫(迟到数据自愈)", async () => {
    let now = T0;
    const fullSweep = vi.fn().mockResolvedValue(sweepResult([]));
    const fetchSince = vi
      .fn()
      .mockResolvedValue({ trades: [], connected: true });
    const keeper = createWindowKeeper({
      fullSweep,
      fetchSince,
      windowSec: WINDOW,
      resweepIntervalSec: 3600,
      nowSec: () => now,
    });
    await keeper.tick(); // 种子
    now = T0 + 60;
    await keeper.tick(); // 增量
    expect(fullSweep).toHaveBeenCalledTimes(1);
    now = T0 + 3600;
    await keeper.tick(); // 到点重扫
    expect(fullSweep).toHaveBeenCalledTimes(2);
  });

  it("回滚开关:mode='full' 时每轮全量,增量路径彻底旁路", async () => {
    let now = T0;
    const fullSweep = vi.fn().mockResolvedValue(sweepResult([]));
    const fetchSince = vi.fn();
    const keeper = createWindowKeeper({
      fullSweep,
      fetchSince,
      windowSec: WINDOW,
      getMode: () => "full",
      nowSec: () => now,
    });
    await keeper.tick();
    now = T0 + 60;
    await keeper.tick();
    expect(fullSweep).toHaveBeenCalledTimes(2);
    expect(fetchSince).not.toHaveBeenCalled();
  });
});

describe("windowKeeper — 行数上限", () => {
  it("超限淘汰最旧、整秒切齐,覆盖起点如实上移并标 truncated", async () => {
    // 6 行,上限 3。最旧三行中第 3、4 旧的行同秒(ts=T0-400):整秒要么全留
    // 要么全走 —— 留一半会让边界秒的净买账残缺。cut 落在 T0-400 → 该秒两行
    // 全走,只剩 2 行,覆盖起点 = T0-400+1。
    const rows = [
      trade({ timestamp: T0 - 600, transactionHash: "0xa" }),
      trade({ timestamp: T0 - 500, transactionHash: "0xb" }),
      trade({ timestamp: T0 - 400, transactionHash: "0xc" }),
      trade({ timestamp: T0 - 400, transactionHash: "0xd" }),
      trade({ timestamp: T0 - 300, transactionHash: "0xe" }),
      trade({ timestamp: T0 - 200, transactionHash: "0xf" }),
    ];
    const fullSweep = vi.fn().mockResolvedValue(sweepResult(rows));
    const keeper = createWindowKeeper({
      fullSweep,
      fetchSince: vi.fn(),
      windowSec: WINDOW,
      maxBufferRows: 3,
      nowSec: () => T0,
    });
    const win = await keeper.tick();
    expect(win.trades.map((t) => t.transactionHash)).toEqual(["0xf", "0xe"]);
    expect(win.effectiveSinceSec).toBe(T0 - 400 + 1);
    expect(win.truncated).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("buffer cap"),
    );
  });
});
