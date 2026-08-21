import { describe, it, expect } from "vitest";
import {
  mergeWindow,
  getMarketWindow,
  windowCount,
  NoBudgetError,
  WINDOW_LRU_MAX,
  __resetWindows,
} from "./marketWindow";
import type { Trade } from "./types";

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
