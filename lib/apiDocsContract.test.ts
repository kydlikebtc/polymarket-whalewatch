import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db";
import { parseMarkdownDoc, type DocBlock } from "./markdownDoc";
import { STRATEGY_CODE } from "./strategyCodes";

// docs/api-access.md 与代码之间的契约守卫。
//
// 起因是一次真实的读者误读:文档 §8.3 那张 19 档表原本带一列 `#`(1…19 的
// 行序),而 §8.1 紧挨着把 `strategy.id` 记为「档位 ID」—— 订阅方顺理成章
// 地把行序当成了 id。两者在生产库上正面撞车:`#7` 是「超级巨鲸」,而本服务
// 库里 id=7 是「首发共识」、id=9 才是「超级巨鲸」。照文档硬编码
// `strategyId === 7` 不会报任何错,只会静默地把另一个检测器族的信号当成你
// 要的那档。
//
// 下面五道闸门各自守住这个缺陷的一条复发路径:
//   1. 加了档忘了写文档 → 档名集合双向比对;
//   2. 有人又往档位表里加一列看起来像 ID 的东西 → 表头黑名单;
//   3. 占位围栏块被删/改名 → 渲染分支变死代码、实时表静默消失;
//   4. 有人"顺手"想把 id 补齐成 1…19 → 把「id 是库的出生版本的函数」这个
//      反直觉事实钉成可执行断言;
//   5. 加了档但散文里的「19 档」没跟着改 → 活文档的档数声明与种子比对。
const MD = readFileSync(join(process.cwd(), "docs", "api-access.md"), "utf8");
const BLOCKS = parseMarkdownDoc(MD);

/** 种子建出来的档数 —— 全部闸门共用的唯一真相。 */
function seededTierNames(): string[] {
  const db = openDb(":memory:");
  try {
    return (
      db.prepare("SELECT name FROM follow_strategies").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
  } finally {
    db.close();
  }
}

/**
 * §8.3 那张档位表。刻意按「表头同时含 档名 与 source」定位而不是钉死
 * head[0] —— 本测试要守的恰恰是「有人在前面插了一列」,若定位方式对插列
 * 敏感,闸门会退化成一句看不懂的 undefined 报错,而不是指出违规的列名。
 */
function tierTables() {
  return BLOCKS.filter(
    (b): b is Extract<DocBlock, { kind: "table" }> =>
      b.kind === "table" &&
      b.head.some((h) => h.trim() === "档名") &&
      b.head.some((h) => h.trim() === "source"),
  );
}

/** 取档位表的某一列(不假设它在第几列 —— 列序是会调整的)。 */
function tierColumn(
  t: Extract<DocBlock, { kind: "table" }>,
  match: (head: string) => boolean,
) {
  const col = t.head.findIndex((h) => match(h.trim()));
  return t.rows.map((r) => r[col].trim());
}

function documentedTierNames(t: Extract<DocBlock, { kind: "table" }>) {
  return tierColumn(t, (h) => h === "档名");
}

/** 档位码列。表头形如「`code`（认档用它）」,故按前缀匹配。 */
function documentedTierCodes(t: Extract<DocBlock, { kind: "table" }>) {
  // 剥掉 markdown 的反引号:表里写的是 `mega_whale`,要比的是裸串。
  return tierColumn(t, (h) => h.startsWith("`code`")).map((c) =>
    c.replace(/`/g, ""),
  );
}

describe("docs/api-access.md §8.3 档位表 与 种子库", () => {
  it("档名集合与种子完全一致(双向) —— 加了档必须同步文档", () => {
    const tables = tierTables();
    // 唯一性本身就是闸门:出现第二张档位表说明文档结构变了,下面这条比对
    // 就可能在比一张错的表。
    expect(tables.length, "§8.3 档位表应当唯一").toBe(1);
    const documented = documentedTierNames(tables[0]);
    const seeded = seededTierNames();

    // 双向:文档不能漏档(订阅方收到 name 却查不到触发条件),也不能多列
    // 已经不存在的档(照着写解析分支永远走不到)。
    expect([...documented].sort()).toEqual([...seeded].sort());
  });

  it("code 列与 STRATEGY_CODE 逐行一致 —— 文档写错档位码就是发错契约", () => {
    const t = tierTables()[0];
    // 逐行(而非集合)比对:同一行里 code 与档名必须是**同一档**的,
    // 集合比较会放过「两行的 code 互换」这种最难肉眼发现的错。
    const pairs = documentedTierNames(t).map((name, i) => [
      name,
      documentedTierCodes(t)[i],
    ]);
    for (const [name, code] of pairs) {
      expect(code, `文档里「${name}」的 code 写错了`).toBe(STRATEGY_CODE[name]);
    }
  });

  it("档位表不含任何会被读成 strategy.id 的列", () => {
    const head = tierTables()[0].head.map((h) => h.trim());
    // `#`/序号/编号/id 都会被读者接上 §8.1 的「档位 ID」。这张表描述的是
    // **能力全集**(永不过期),真实 id 由 /api-docs 查库回答。
    for (const banned of ["#", "序号", "编号", "id", "ID", "档位 ID"]) {
      expect(head, `档位表不该有「${banned}」列`).not.toContain(banned);
    }
  });
});

describe("docs/api-access.md 的实时占位围栏块", () => {
  // 这两个块是 app/api-docs/page.tsx 里两个渲染分支的唯一触发点。块没了,
  // 分支就是死代码,而页面上只会少一张表 —— 不报错、没人发现。
  const langs = BLOCKS.filter((b) => b.kind === "code").map((b) =>
    b.kind === "code" ? b.lang : "",
  );

  it("§4 的 status 块在场", () => {
    expect(langs).toContain("status");
  });

  it("§8.3 的 strategy_ids 块在场", () => {
    expect(langs).toContain("strategy_ids");
  });

  it("围栏语言名只含 \\w —— 解析器正则会静默截断带连字符的名字", () => {
    // 解析器用 ^```(\w*) 取语言名。例:status-strategies 会被截成
    // lang="status",于是悄悄复用了 §4 的分支,渲染出一张完全不相干的表。
    // 这条闸门让那种命名当场红掉。
    for (const lang of langs) {
      if (lang === "") continue;
      expect(lang, `围栏语言「${lang}」含非 \\w 字符`).toMatch(/^\w+$/);
    }
  });
});

describe("strategy.id 为什么不可硬编码 —— AUTOINCREMENT 打洞的可执行证据", () => {
  it("INSERT OR IGNORE 命中 UNIQUE 时照样消耗自增号", () => {
    const db = new Database(":memory:");
    try {
      db.prepare(
        "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)",
      ).run();
      const ins = db.prepare("INSERT OR IGNORE INTO t (name) VALUES (?)");
      const seq = () =>
        (
          db
            .prepare("SELECT seq FROM sqlite_sequence WHERE name = 't'")
            .get() as { seq: number } | undefined
        )?.seq;

      ins.run("保守");
      ins.run("激进");
      expect(seq()).toBe(2);

      // 种子块按版本门控整体重播(见 lib/db.ts 的 follow_seed_v 注释):既有
      // 档会被再 INSERT OR IGNORE 一遍。行内容确实幂等 —— 但 id 空间不是。
      ins.run("保守");
      ins.run("激进");
      expect(seq(), "两条空跑的 INSERT 吃掉了 3 和 4").toBe(4);

      // 于是下一条真实插入拿到 5 而不是 3 —— 这就是生产库 id 图谱上的洞。
      ins.run("精英共识");
      expect(
        db.prepare("SELECT id FROM t WHERE name = '精英共识'").get(),
      ).toEqual({ id: 5 });
    } finally {
      db.close();
    }
  });

  it("全新库的 id 是 1…19 连号 —— 与生产库不同,正是不能硬编码的理由", () => {
    const db = openDb(":memory:");
    try {
      const rows = db
        .prepare("SELECT id, name FROM follow_strategies ORDER BY id")
        .all() as { id: number; name: string }[];
      // 全新安装一次跑完整个种子块,没有任何 INSERT 被 IGNORE,故连号。
      // 不写死 19:档数由种子决定,这里断言的是「连号」这个性质。
      expect(rows.map((r) => r.id)).toEqual(
        Array.from({ length: rows.length }, (_, i) => i + 1),
      );
      // 而线上库(v1 时代建的、之后 bump 过三次)同一档是 9、id=7 是
      // 「首发共识」。若哪天这两条断言需要改,说明种子机制变了 —— 停下来
      // 先想清楚 §8.3 的说法还成不成立。
      expect(rows.find((r) => r.name === "超级巨鲸")!.id).toBe(7);
      expect(rows.find((r) => r.name === "首发共识")!.id).toBe(5);
    } finally {
      db.close();
    }
  });
});

// 活文档里写死的档数声明。范围**刻意**只含这三份「描述当下」的文件:
// docs/plans/* 与 docs/README.md 里的「12 档」「13 档」是在复述某份历史设计
// 稿当年的样子(如「12 档时代的平铺大卡」),是准确的历史记录,不该被这道
// 闸门拖着一起改 —— 那才是把档案改成假话。
const LIVE_DOCS = [
  ["docs/api-access.md", /(\d+) 档/g],
  ["README.zh-CN.md", /(\d+) 档/g],
  ["README.md", /(\d+) (?:paper|tiers)/g],
] as const;

describe("活文档里写死的档数与种子一致", () => {
  // 判据:只校验「看起来像总档数」的声明(≥10)。小数字是别的意思 ——
  // 如 README 的「6 档是反向对照」,那是子集计数,不该被拉平成总数。
  const TOTAL_LIKE_MIN = 10;

  for (const [rel, re] of LIVE_DOCS) {
    it(`${rel} 的档数声明`, () => {
      const total = seededTierNames().length;
      const text = readFileSync(join(process.cwd(), rel), "utf8");
      const claimed = [...text.matchAll(re)]
        .map((m) => Number(m[1]))
        .filter((n) => n >= TOTAL_LIKE_MIN);
      // 空数组也算通过:该文件没做总档数声明,没有可过期的东西。
      for (const n of claimed) {
        expect(n, `${rel} 里写着「${n} 档」,但种子现在是 ${total} 档`).toBe(
          total,
        );
      }
    });
  }
});
