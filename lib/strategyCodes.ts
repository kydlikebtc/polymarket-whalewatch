// 对外稳定档位码(`strategy.code`)。
//
// 存在理由:对外契约此前没有任何**跨部署稳定且非中文**的档位标识 ——
//   · `strategy.id` 是 follow_strategies 的自增行号,而种子块按版本门控整体
//     重播、`INSERT OR IGNORE` 命中 UNIQUE 时照样消耗自增号,于是 id 图谱是
//     「这个库在哪个种子版本上建的」的函数(同一档在新库是 7、在从 v1 升上来
//     的库里是 9)—— 硬编码它会静默读到另一档;
//   · `name` 跨部署稳定,但它是中文;让 mm-mobile 这类英文消费方在代码里写
//     「超级巨鲸」不是一份正经契约,而且运营手工改名就会断;
//   · `source` 是英文,但一个族下挂多档(heavy 有 6 档),不唯一。
// 于是补这一层:ASCII、snake_case、每档唯一、**冻结**。
//
// ⚠️ 冻结的含义:一旦某个 code 发布出去,它就永远不许改 —— 订阅方会把它写进
// 代码和配置。改档名可以(那是展示层),改 code 不行。codes.test.ts 里有一份
// golden 快照钉着这条,任何改动都会当场红。
//
// ⚠️ 刻意不从英文展示名(lib/xComposer.ts 的 STRATEGY_EN)自动派生:那份是
// **文案**,润色一次(如 "Mega Whale" → "Super Whale")就会把所有订阅方硬
// 编码的值悄悄换掉,等于把刚修好的坑原样再挖一遍。两者各自独立维护,靠
// strategyCodes.test.ts 的覆盖比对保证不漏档、不多档。
//
// 命名规则:
//   1. snake_case,ASCII;
//   2. 反向对照档一律 `inverse_` + 被镜像档的 code(镜像关系有测试断言);
//   3. 「高分独狼」「早期赢家跟投」刻意不直译成 lone_wolf / early_winner ——
//      那两个字符串已经是 `source` 的取值,同一个对象里出现
//      `{code:"lone_wolf", source:"lone_wolf"}` 会让配置文件里的
//      `strategy: lone_wolf` 说不清指哪个字段。中文名里的「高分」「跟投」
//      正好补回区分度。

/** 档名 → 对外稳定档位码。键必须与 lib/db.ts 的种子档名逐字一致。 */
export const STRATEGY_CODE: Record<string, string> = {
  // v1
  保守: "conservative_consensus",
  激进: "aggressive_consensus",
  // v2 · consensus 族
  精英共识: "elite_consensus",
  重仓共识: "heavy_consensus",
  首发共识: "first_mover_consensus",
  // v2 · heavy 族
  巨鲸: "whale_follow",
  超级巨鲸: "mega_whale",
  巨鲸精英: "elite_whale",
  // v2 · 分歧族
  一边倒分歧: "lopsided_majority",
  分歧解除: "standoff_resolved",
  // v2 · 钱包族
  高分独狼: "high_score_lone_wolf",
  早期赢家跟投: "early_winner_follow",
  // v3 · C1 的对照组(跟少数边),不是 reverse 档,故无 inverse_ 前缀
  逆势少数边: "contrarian_minority",
  // v4 · 6 个反向对照档
  反巨鲸: "inverse_whale_follow",
  反超级巨鲸: "inverse_mega_whale",
  反巨鲸精英: "inverse_elite_whale",
  反分歧解除: "inverse_standoff_resolved",
  反高分独狼: "inverse_high_score_lone_wolf",
  反早期赢家: "inverse_early_winner_follow",
};

/**
 * 档名 → 档位码;未登记时返回 null(而不是回退成档名或空串)。
 *
 * null 是诚实的:运营手工建的档没有对外码,谎报一个「像 code 的东西」会让
 * 订阅方把它写进配置,下次真的分配 code 时就冲突了。对外契约因此是
 * `code: string | null`,文档明说 null 时只能用 name 认档。
 */
export function strategyCode(name: string): string | null {
  return STRATEGY_CODE[name] ?? null;
}
