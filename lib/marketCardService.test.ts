import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { serveMarketCard, STALE_GATE_SEC } from "./marketCardService";
import { __resetWindows } from "./marketWindow";

const NOW = 1_700_000_000;
const CID = `0x${"a".repeat(64)}`;

/** 空窗口就够:本组测的是编排与闸门,不是卡片内容(那归 marketCard 自己的测试)。 */
const baseDeps = {
  fetchWindow: async () => ({ trades: [], truncated: false }),
  agesFetcher: async () => ({}),
  // 不注入就会直连 gamma —— 单元测试不打网络。
  metaFetcher: async () => ({}),
};

describe("serveMarketCard", () => {
  it("窗口新鲜 —— live:true,staleSec 为 0", async () => {
    __resetWindows();
    const db = openDb(":memory:");
    const r = await serveMarketCard(db, CID, {
      ...baseDeps,
      nowSec: NOW,
      takeToken: () => true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.live).toBe(true);
      expect(r.staleSec).toBe(0);
    }
    db.close();
  });

  it("预算耗尽但窗口在闸内 —— live:false 且带 staleSec", async () => {
    __resetWindows();
    const db = openDb(":memory:");
    await serveMarketCard(db, CID, {
      ...baseDeps,
      nowSec: NOW,
      takeToken: () => true,
    });
    const r = await serveMarketCard(db, CID, {
      ...baseDeps,
      nowSec: NOW + 60,
      takeToken: () => false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.live).toBe(false);
      expect(r.staleSec).toBe(60);
    }
    db.close();
  });

  it("超过陈旧闸 —— 拒绝,而不是给出会误导的旧卡", async () => {
    __resetWindows();
    const db = openDb(":memory:");
    await serveMarketCard(db, CID, {
      ...baseDeps,
      nowSec: NOW,
      takeToken: () => true,
    });
    // 卡片说「3 个聪明钱刚买入」而其中 2 个已卖出,那不是不够新,是错的 ——
    // 而且错在会让人亏钱的方向上。带 staleSec 让客户端自己判断不够:客户端
    // 会为了不显示空白而照渲染。
    const r = await serveMarketCard(db, CID, {
      ...baseDeps,
      nowSec: NOW + STALE_GATE_SEC + 1,
      takeToken: () => false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(429);
    db.close();
  });

  it("从未抓过的市场 + 预算耗尽 —— 同样 429,不给空壳卡", async () => {
    __resetWindows();
    const db = openDb(":memory:");
    const r = await serveMarketCard(db, CID, {
      ...baseDeps,
      nowSec: NOW,
      takeToken: () => false,
    });
    expect(r.ok).toBe(false);
    db.close();
  });

  it("降级路径零上游 —— 连 gamma 元信息都不许再捅一次", async () => {
    __resetWindows();
    const db = openDb(":memory:");
    let metaCalls = 0;
    const deps = {
      fetchWindow: async () => ({ trades: [], truncated: false }),
      agesFetcher: async () => ({}),
      metaFetcher: async () => {
        metaCalls++;
        return {};
      },
    };
    await serveMarketCard(db, CID, {
      ...deps,
      nowSec: NOW,
      takeToken: () => true,
    });
    // 先证明接线:实况路径确实经由注入的 metaFetcher(否则下面那条断言恒真,
    // 是一条什么都不测的假绿)。
    expect(metaCalls).toBe(1);
    await serveMarketCard(db, CID, {
      ...deps,
      nowSec: NOW + 60,
      takeToken: () => false,
    });
    // 降级的全部意义就是「不再向上游要任何东西」。一条声称零上游的路径上
    // 藏着一个网络调用,这个契约就是假的 —— 哪怕它打的是另一个 host。
    expect(metaCalls).toBe(1);
    db.close();
  });

  it("网页与对外两条路由共用同一窗口 —— 一边预热,另一边零上游命中", async () => {
    __resetWindows();
    const db = openDb(":memory:");
    let fetches = 0;
    const counting = {
      agesFetcher: async () => ({}),
      metaFetcher: async () => ({}),
      fetchWindow: async () => {
        fetches++;
        return { trades: [], truncated: false };
      },
    };
    await serveMarketCard(db, CID, {
      ...counting,
      nowSec: NOW,
      takeToken: () => true,
    });
    await serveMarketCard(db, CID, {
      ...counting,
      nowSec: NOW + 5,
      takeToken: () => true,
    });
    // 上游预算本来就是同一份,分两个桶只是把同一个天花板切成两半;而热门市场
    // 高度重合,共享工作集是净收益。
    expect(fetches).toBe(1);
    db.close();
  });
});
