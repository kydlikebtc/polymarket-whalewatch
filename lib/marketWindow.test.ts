import { describe, it, expect } from "vitest";
import {
  mergeWindow,
  getMarketWindow,
  windowCount,
  windowStats,
  NoBudgetError,
  WINDOW_LRU_MAX,
  __resetWindows,
} from "./marketWindow";
import type { Trade } from "./types";
import { openDb } from "./db";

/** 只变 transactionHash —— dedupKey 的第一段,足以区分两笔。 */
export const trade = (ts: number, hash: string): Trade => ({
  proxyWallet: "0xa",
  side: "BUY",
  asset: "1",
  conditionId: "0xc1",
  size: 100,
  price: 0.5,
  timestamp: ts,
  title: "t",
  slug: "s",
  eventSlug: "e",
  outcome: "Yes",
  outcomeIndex: 0,
  transactionHash: hash,
});

describe("mergeWindow", () => {
  it("新成交并入既有窗口,结果按时间倒序", () => {
    const prev = [trade(200, "0xb"), trade(100, "0xa")];
    const out = mergeWindow(prev, [trade(300, "0xc")], 0);
    expect(out.map((t) => t.timestamp)).toEqual([300, 200, 100]);
  });

  it("重叠的成交只留一份 —— 续抓必然重复覆盖锚点那一笔", () => {
    const prev = [trade(200, "0xb")];
    const out = mergeWindow(prev, [trade(300, "0xc"), trade(200, "0xb")], 0);
    expect(out).toHaveLength(2);
  });

  it("滚动裁剪:超出窗口下界的尾部丢弃(窗口是滑动的,不是累积的)", () => {
    const prev = [trade(200, "0xb"), trade(100, "0xa")];
    const out = mergeWindow(prev, [], 150);
    expect(out.map((t) => t.timestamp)).toEqual([200]);
  });

  it("空续抓只做裁剪,不动既有内容", () => {
    const prev = [trade(200, "0xb")];
    expect(mergeWindow(prev, [], 0)).toHaveLength(1);
  });
});

// --- 窗口层:工作集 + 增量续抓 + 无预算时降级 -------------------------------

const NOW = 1_700_000_000;
const okFetch =
  (trades: Trade[] = [trade(NOW - 10, "0xa")]) =>
  async () => ({ trades, truncated: false });

describe("getMarketWindow", () => {
  it("首次是冷启:按整窗抓,sinceSec = now − 24h", async () => {
    __resetWindows();
    const calls: number[] = [];
    const r = await getMarketWindow("0xc1", {
      nowSec: NOW,
      takeToken: () => true,
      fetchWindow: async (_cid, o) => {
        calls.push(o.sinceSec);
        return { trades: [trade(NOW - 10, "0xa")], truncated: false };
      },
    });
    expect(calls).toEqual([NOW - 24 * 3600]);
    expect(r.degraded).toBe(false);
    expect(r.trades).toHaveLength(1);
  });

  it("TTL 内不再抓 —— 零上游", async () => {
    __resetWindows();
    let n = 0;
    const fetchWindow = async () => {
      n++;
      return { trades: [trade(NOW - 10, "0xa")], truncated: false };
    };
    await getMarketWindow("0xc1", {
      nowSec: NOW,
      takeToken: () => true,
      fetchWindow,
    });
    await getMarketWindow("0xc1", {
      nowSec: NOW + 10,
      takeToken: () => true,
      fetchWindow,
    });
    expect(n).toBe(1);
  });

  it("TTL 过后是增量续抓:sinceSec = 上次见到的最新成交时刻", async () => {
    __resetWindows();
    const calls: number[] = [];
    const fetchWindow = async (_cid: string, o: { sinceSec: number }) => {
      calls.push(o.sinceSec);
      return { trades: [trade(NOW - 10, "0xa")], truncated: false };
    };
    await getMarketWindow("0xc1", {
      nowSec: NOW,
      takeToken: () => true,
      fetchWindow,
    });
    await getMarketWindow("0xc1", {
      nowSec: NOW + 60,
      takeToken: () => true,
      fetchWindow,
    });
    // 第二次的下界是第一次抓到的最新成交 —— 这就是「只续新的」。
    expect(calls[1]).toBe(NOW - 10);
  });

  it("没有令牌但有陈旧窗口 —— 降级返回,不发上游请求", async () => {
    __resetWindows();
    let n = 0;
    const counting = async () => {
      n++;
      return { trades: [trade(NOW - 10, "0xa")], truncated: false };
    };
    await getMarketWindow("0xc1", {
      nowSec: NOW,
      takeToken: () => true,
      fetchWindow: counting,
    });
    const r = await getMarketWindow("0xc1", {
      nowSec: NOW + 60,
      takeToken: () => false,
      fetchWindow: counting,
    });
    expect(n).toBe(1);
    expect(r.degraded).toBe(true);
    expect(r.builtAt).toBe(NOW);
  });

  it("没有令牌也没有窗口 —— 抛 NoBudgetError,由调用方转 429", async () => {
    __resetWindows();
    await expect(
      getMarketWindow("0xcold", {
        nowSec: NOW,
        takeToken: () => false,
        fetchWindow: okFetch([]),
      }),
    ).rejects.toThrow(NoBudgetError);
  });

  it("LRU 上限:超出后淘汰最久未用的市场", async () => {
    __resetWindows();
    for (let i = 0; i <= WINDOW_LRU_MAX; i++) {
      await getMarketWindow(`0x${i}`, {
        nowSec: NOW + i,
        takeToken: () => true,
        fetchWindow: okFetch(),
      });
    }
    expect(windowCount()).toBe(WINDOW_LRU_MAX);
  });

  it("并发只花一枚令牌 —— 令牌按市场数消耗,不按并发数", async () => {
    __resetWindows();
    let tokens = 0;
    let fetches = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deps = {
      nowSec: NOW,
      takeToken: () => {
        tokens++;
        return true;
      },
      fetchWindow: async () => {
        fetches++;
        await gate;
        return { trades: [trade(NOW - 10, "0xa")], truncated: false };
      },
    };
    const both = Promise.all([
      getMarketWindow("0xc1", deps),
      getMarketWindow("0xc1", deps),
    ]);
    release!();
    await both;
    expect(fetches).toBe(1);
    // 第二个请求加入在途那一次,不该再付一枚 —— 否则热门市场的并发会把预算
    // 按并发数烧掉,而预算的全部意义就是按市场数计量。
    expect(tokens).toBe(1);
  });

  it("按实际页数计费 —— 冷启翻了几页就补收几枚", async () => {
    __resetWindows();
    const spent: number[] = [];
    // 600 笔 = 3 页(每页 250)。闸门先收 1 枚放行,抓完补收 2 枚。
    const many = Array.from({ length: 600 }, (_, i) =>
      trade(NOW - 100 - i, `0x${i}`),
    );
    await getMarketWindow("0xc1", {
      nowSec: NOW,
      takeToken: (cost) => {
        spent.push(cost);
        return true;
      },
      fetchWindow: async () => ({ trades: many, truncated: false }),
    });
    // 令牌桶想近似的是「向上游发了几个请求」。冷启和热续都只收 1 枚的话,
    // 进程刚重启、工作集全空时,预算会被超出十几倍 —— 正好在最脆弱的时刻。
    expect(spent.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("热续只有一页 —— 不补收", async () => {
    __resetWindows();
    const spent: number[] = [];
    const deps = {
      takeToken: (cost: number) => {
        spent.push(cost);
        return true;
      },
      fetchWindow: async () => ({
        trades: [trade(NOW - 10, "0xa")],
        truncated: false,
      }),
    };
    await getMarketWindow("0xc1", { ...deps, nowSec: NOW });
    await getMarketWindow("0xc1", { ...deps, nowSec: NOW + 60 });
    expect(spent).toEqual([1, 1]);
  });

  it("指标:冷启 / 热续 / 命中 / 降级 / 拒绝 各自计数", async () => {
    __resetWindows();
    const fetchWindow = okFetch();
    // 冷启
    await getMarketWindow("0xc1", {
      nowSec: NOW,
      takeToken: () => true,
      fetchWindow,
    });
    // 新鲜期内命中
    await getMarketWindow("0xc1", {
      nowSec: NOW + 5,
      takeToken: () => true,
      fetchWindow,
    });
    // 热续
    await getMarketWindow("0xc1", {
      nowSec: NOW + 60,
      takeToken: () => true,
      fetchWindow,
    });
    // 降级
    await getMarketWindow("0xc1", {
      nowSec: NOW + 120,
      takeToken: () => false,
      fetchWindow,
    });
    // 拒绝(无窗口且无预算)
    await expect(
      getMarketWindow("0xother", {
        nowSec: NOW,
        takeToken: () => false,
        fetchWindow,
      }),
    ).rejects.toThrow(NoBudgetError);

    const s = windowStats();
    expect(s.cold).toBe(1);
    expect(s.warm).toBe(1);
    expect(s.hit).toBe(1);
    expect(s.degraded).toBe(1);
    expect(s.refused).toBe(1);
    expect(s.workingSet).toBe(1);
  });

  it("重启后从存档水合 —— 算热续不算冷启,且续抓下界是存档的锚点", async () => {
    const db = openDb(":memory:");
    __resetWindows();
    await getMarketWindow("0xc1", {
      nowSec: NOW,
      takeToken: () => true,
      fetchWindow: okFetch(),
      db,
    });
    // 模拟进程重启:内存工作集没了,库还在。
    __resetWindows();
    const calls: number[] = [];
    await getMarketWindow("0xc1", {
      nowSec: NOW + 600,
      takeToken: () => true,
      fetchWindow: async (_cid, o) => {
        calls.push(o.sinceSec);
        return { trades: [], truncated: false };
      },
      db,
    });
    // 冷启一个市场要翻 1–13 页,而重启那一刻工作集全空 —— 若干热门市场同时被
    // 访问就是一次自伤式的上游冲击,恰好在服务刚起来、最该表现稳的时候。
    expect(windowStats().cold).toBe(0);
    expect(windowStats().warm).toBe(1);
    expect(calls[0]).toBe(NOW - 10);
    db.close();
  });

  it("没有 db 也能跑 —— 落库是可选增强,不是必需依赖", async () => {
    __resetWindows();
    const r = await getMarketWindow("0xc1", {
      nowSec: NOW,
      takeToken: () => true,
      fetchWindow: okFetch(),
    });
    expect(r.trades).toHaveLength(1);
  });

  it("cid 大小写不影响命中 —— 0xAB… 与 0xab… 是同一个工作集条目", async () => {
    __resetWindows();
    let n = 0;
    const counting = async () => {
      n++;
      return { trades: [trade(NOW - 10, "0xa")], truncated: false };
    };
    await getMarketWindow("0xABC", {
      nowSec: NOW,
      takeToken: () => true,
      fetchWindow: counting,
    });
    await getMarketWindow("0xabc", {
      nowSec: NOW + 5,
      takeToken: () => true,
      fetchWindow: counting,
    });
    expect(n).toBe(1);
  });
});
