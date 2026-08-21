import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { STRATEGY_CODE, strategyCode } from "./strategyCodes";
import { STRATEGY_EN } from "./xComposer";

// 档位码是**冻结的对外契约**,这组测试是它的锁。
//
// 背景:`strategy.id` 是部署本地自增行号(不可硬编码)、`name` 是中文(英文
// 消费方不该往代码里写)、`source` 一个族挂多档(不唯一)—— code 是唯一一个
// 「跨部署稳定 + ASCII + 每档唯一」的标识,订阅方会把它写进代码和配置。

function seeded(): { name: string; params: Record<string, unknown> }[] {
  const db = openDb(":memory:");
  try {
    return (
      db.prepare("SELECT name, params_json FROM follow_strategies").all() as {
        name: string;
        params_json: string | null;
      }[]
    ).map((r) => ({
      name: r.name,
      params: JSON.parse(r.params_json ?? "{}") as Record<string, unknown>,
    }));
  } finally {
    db.close();
  }
}

/** 字段顺序无关的稳定序列化,用于「参数逐字段相同」比较。 */
function canon(p: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(p).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

describe("STRATEGY_CODE 与种子的覆盖关系", () => {
  it("键集合与种子档名完全一致(双向) —— 加了档必须分配 code", () => {
    const names = seeded().map((s) => s.name);
    // 漏档 ⇒ 该档对外 code 为 null,订阅方只能退回中文 name;
    // 多档 ⇒ 映射里躺着一个永不出现的死码,下次改名时会误导人。
    expect(Object.keys(STRATEGY_CODE).sort()).toEqual([...names].sort());
  });

  it("与英文展示名 STRATEGY_EN 覆盖同一批档 —— 防两份映射各自漂移", () => {
    // code 刻意不从 STRATEGY_EN 派生(展示名是文案,润色会误伤契约),
    // 代价就是两份表要各自维护。这条闸门保证它们至少不会漏掉不同的档。
    expect(Object.keys(STRATEGY_CODE).sort()).toEqual(
      Object.keys(STRATEGY_EN).sort(),
    );
  });

  it("未登记的档名返回 null,不回退成档名或空串", () => {
    expect(strategyCode("运营手工建的档")).toBeNull();
    expect(strategyCode("")).toBeNull();
    expect(strategyCode("超级巨鲸")).toBe("mega_whale");
  });
});

describe("档位码的命名规则", () => {
  const codes = Object.values(STRATEGY_CODE);

  it("每档唯一", () => {
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("全部是 ASCII snake_case", () => {
    for (const c of codes)
      expect(c, `「${c}」不是 ASCII snake_case`).toMatch(
        /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/,
      );
  });

  it("不与任何 source 取值撞车 —— 否则配置里 `strategy: x` 说不清指哪个字段", () => {
    const sources = new Set(
      seeded().map((s) => String(s.params.source ?? "consensus")),
    );
    for (const c of codes) {
      expect(sources.has(c), `code「${c}」与某个 source 同名`).toBe(false);
    }
  });

  it("反向档 code = inverse_ + 被镜像档 code(镜像关系从 params 现算)", () => {
    const all = seeded();
    // 不依赖任何手抄的配对清单:反向档的参数除 reverse 外与正向档逐字段
    // 相同(那是 v4 的建档红线),据此现场配对。
    const fwdByParams = new Map(
      all
        .filter((s) => s.params.reverse !== true)
        .map((s) => [canon(s.params), s.name]),
    );
    const reverses = all.filter((s) => s.params.reverse === true);
    expect(reverses.length, "v4 应有 6 个反向对照档").toBe(6);

    for (const rev of reverses) {
      const { reverse: _drop, ...bare } = rev.params;
      const fwdName = fwdByParams.get(canon(bare));
      expect(
        fwdName,
        `反向档「${rev.name}」找不到参数相同的正向档`,
      ).toBeTruthy();
      expect(STRATEGY_CODE[rev.name]).toBe(
        `inverse_${STRATEGY_CODE[fwdName!]}`,
      );
    }
  });

  it("只有 reverse:true 的档带 inverse_ 前缀", () => {
    // 「逆势少数边」是 C1 的对照组但不是 reverse 档(它跟少数边,不是买对面),
    // 故 code 是 contrarian_minority 而非 inverse_*。
    for (const s of seeded()) {
      expect(
        STRATEGY_CODE[s.name].startsWith("inverse_"),
        `「${s.name}」的 inverse_ 前缀与 reverse 标志不一致`,
      ).toBe(s.params.reverse === true);
    }
  });
});

describe("冻结快照 —— 改任何一个 code 都会在这里红", () => {
  it("19 档的 code 逐条钉死", () => {
    // ⚠️ 这份快照红了不是"更新期望值"就完事:code 一旦发布,订阅方已经把它
    // 写进代码和配置,改名等于**静默破坏所有下游**。真要改,先走契约变更
    // 流程(docs/api-access.md §16 记一笔 + 通知订阅方 + 给过渡期)。
    expect(STRATEGY_CODE).toEqual({
      保守: "conservative_consensus",
      激进: "aggressive_consensus",
      精英共识: "elite_consensus",
      重仓共识: "heavy_consensus",
      首发共识: "first_mover_consensus",
      巨鲸: "whale_follow",
      超级巨鲸: "mega_whale",
      巨鲸精英: "elite_whale",
      一边倒分歧: "lopsided_majority",
      分歧解除: "standoff_resolved",
      高分独狼: "high_score_lone_wolf",
      早期赢家跟投: "early_winner_follow",
      逆势少数边: "contrarian_minority",
      反巨鲸: "inverse_whale_follow",
      反超级巨鲸: "inverse_mega_whale",
      反巨鲸精英: "inverse_elite_whale",
      反分歧解除: "inverse_standoff_resolved",
      反高分独狼: "inverse_high_score_lone_wolf",
      反早期赢家: "inverse_early_winner_follow",
    });
  });
});
