import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
  parseCsvLine,
  parseRecordCsv,
  verifyDigestDays,
  webcryptoSha256Hex,
  type VerifyDigest,
  type VerifyRow,
} from "./digestVerify";
import { DIGEST_GENESIS, digestPreimage } from "./digestPreimage";
import { computeDigestChain } from "./signalDigest";

const sha256 = async (s: string): Promise<string> =>
  createHash("sha256").update(s).digest("hex");

const DAY = "2026-09-05";
const DAY_START = Math.floor(Date.parse(`${DAY}T00:00:00Z`) / 1000);

function row(id: number, over: Partial<VerifyRow> = {}): VerifyRow {
  return {
    id,
    strategyName: "巨鲸",
    conditionId: `0xcid${id}`,
    outcome: "Yes",
    emittedAt: DAY_START + id * 60,
    entryPriceRaw: "0.53",
    ...over,
  };
}

/** 用生成侧的实现算出「正确答案」,再交给复算侧比 —— 两侧共用 preimage。 */
function expectedDigest(prev: string, rows: VerifyRow[]): string {
  return computeDigestChain(
    prev,
    rows.map((r) => ({
      id: r.id,
      strategyName: r.strategyName,
      conditionId: r.conditionId,
      outcome: r.outcome,
      emittedAt: r.emittedAt,
      entryPrice: r.entryPriceRaw === "" ? null : Number(r.entryPriceRaw),
    })),
  );
}

describe("verifyDigestDays", () => {
  it("生成侧与复算侧对同一批行给出同一个摘要", async () => {
    const rows = [row(1), row(2), row(3)];
    const digest = expectedDigest(DIGEST_GENESIS, rows);
    const digests: VerifyDigest[] = [
      { day: DAY, digest, prev: DIGEST_GENESIS, count: 3 },
    ];
    const r = await verifyDigestDays(rows, digests, sha256);
    expect(r.allOk).toBe(true);
    expect(r.days[0].status).toBe("ok");
    expect(r.days[0].actual).toBe(digest);
  });

  it("行序不影响结果 —— 复算侧自己按 id 升序排", async () => {
    const rows = [row(1), row(2), row(3)];
    const digest = expectedDigest(DIGEST_GENESIS, rows);
    const shuffled = [rows[2], rows[0], rows[1]];
    const r = await verifyDigestDays(
      shuffled,
      [{ day: DAY, digest, prev: DIGEST_GENESIS, count: 3 }],
      sha256,
    );
    expect(r.days[0].status).toBe("ok");
  });

  it("无入场价的行按 null 进 preimage(空串 ≠ 字符串 \"\")", async () => {
    const rows = [row(1, { entryPriceRaw: "" })];
    const digest = expectedDigest(DIGEST_GENESIS, rows);
    const r = await verifyDigestDays(
      rows,
      [{ day: DAY, digest, prev: DIGEST_GENESIS, count: 1 }],
      sha256,
    );
    expect(r.days[0].status).toBe("ok");
  });

  it("改一个字段就判 tampered(行数不变)", async () => {
    const rows = [row(1), row(2)];
    const digest = expectedDigest(DIGEST_GENESIS, rows);
    const doctored = [rows[0], { ...rows[1], outcome: "No" }];
    const r = await verifyDigestDays(
      doctored,
      [{ day: DAY, digest, prev: DIGEST_GENESIS, count: 2 }],
      sha256,
    );
    expect(r.days[0].status).toBe("tampered");
    expect(r.allOk).toBe(false);
    expect(r.tampered).toBe(1);
  });

  it("导出里少了行 → missing-rows,而不是笼统的 tampered", async () => {
    const rows = [row(1), row(2), row(3)];
    const digest = expectedDigest(DIGEST_GENESIS, rows);
    const r = await verifyDigestDays(
      [rows[0], rows[2]], // 有人把第 2 条从导出里拿掉了
      [{ day: DAY, digest, prev: DIGEST_GENESIS, count: 3 }],
      sha256,
    );
    // 这是唯一真正要报警的方向:摘要里有、导出里没了。
    expect(r.days[0].status).toBe("missing-rows");
    expect(r.days[0].exportCount).toBe(2);
    expect(r.days[0].digestCount).toBe(3);
    expect(r.missingRows).toBe(1);
  });

  it("导出里多了行 → extra-rows(摘要算完后才投递成功的良性漂移)", async () => {
    const rows = [row(1), row(2)];
    const digest = expectedDigest(DIGEST_GENESIS, [rows[0]]);
    const r = await verifyDigestDays(
      rows,
      [{ day: DAY, digest, prev: DIGEST_GENESIS, count: 1 }],
      sha256,
    );
    expect(r.days[0].status).toBe("extra-rows");
    expect(r.extraRows).toBe(1);
  });

  it("只算本日窗口内的行 —— 邻日的行不参与", async () => {
    const mine = [row(1), row(2)];
    const digest = expectedDigest(DIGEST_GENESIS, mine);
    const neighbour = row(9, { emittedAt: DAY_START + 86_400 + 10 });
    const r = await verifyDigestDays(
      [...mine, neighbour],
      [{ day: DAY, digest, prev: DIGEST_GENESIS, count: 2 }],
      sha256,
    );
    expect(r.days[0].status).toBe("ok");
  });

  it("链接检查比的是表里的上一条,不是日历前一天(停机缺日不算断链)", async () => {
    const d1Rows = [row(1)];
    const d1 = expectedDigest(DIGEST_GENESIS, d1Rows);
    // 中间隔了一天没有存证行(引擎停机),第三天的 prev 应等于第一天的 digest。
    const d3Start = DAY_START + 2 * 86_400;
    const d3Rows = [row(5, { emittedAt: d3Start + 60 })];
    const d3 = expectedDigest(d1, d3Rows);
    const r = await verifyDigestDays(
      [...d1Rows, ...d3Rows],
      [
        { day: DAY, digest: d1, prev: DIGEST_GENESIS, count: 1 },
        { day: "2026-09-07", digest: d3, prev: d1, count: 1 },
      ],
      sha256,
    );
    expect(r.days.map((x) => x.status)).toEqual(["ok", "ok"]);
    expect(r.days[1].linked).toBe(true);
    expect(r.brokenLinks).toBe(0);
    expect(r.allOk).toBe(true);
  });

  it("prev 接不上前一条 digest → brokenLinks(历史被整段替换的形态)", async () => {
    const d1Rows = [row(1)];
    const d1 = expectedDigest(DIGEST_GENESIS, d1Rows);
    const d2Start = DAY_START + 86_400;
    const d2Rows = [row(4, { emittedAt: d2Start + 60 })];
    const bogusPrev = "f".repeat(64);
    const d2 = expectedDigest(bogusPrev, d2Rows);
    const r = await verifyDigestDays(
      [...d1Rows, ...d2Rows],
      [
        { day: DAY, digest: d1, prev: DIGEST_GENESIS, count: 1 },
        { day: "2026-09-06", digest: d2, prev: bogusPrev, count: 1 },
      ],
      sha256,
    );
    // 逐日各自复算都对(每天都用自己公布的 prev),断的是链接。
    expect(r.days.map((x) => x.status)).toEqual(["ok", "ok"]);
    expect(r.days[1].linked).toBe(false);
    expect(r.brokenLinks).toBe(1);
    expect(r.allOk).toBe(false);
  });

  it("零存证行 → 空结果且 allOk(还没积累不是失败)", async () => {
    const r = await verifyDigestDays([], [], sha256);
    expect(r.days).toEqual([]);
    expect(r.allOk).toBe(true);
  });
});

describe("digestPreimage 的原文/数字等价", () => {
  it("CSV 原始字段与解析后的数字进 preimage 逐字相同", () => {
    const base = {
      id: 7,
      strategyName: "共识",
      conditionId: "0xabc",
      outcome: "Yes",
      emittedAt: 1_757_000_000,
    };
    expect(digestPreimage("p", { ...base, entryPrice: "0.53" })).toBe(
      digestPreimage("p", { ...base, entryPrice: 0.53 }),
    );
    expect(digestPreimage("p", { ...base, entryPrice: null })).toContain("null");
  });
});

describe("parseCsvLine / parseRecordCsv", () => {
  it("处理引号、逗号与转义双引号", () => {
    expect(parseCsvLine('a,"b,c","d""e",')).toEqual(["a", "b,c", 'd"e', ""]);
  });

  it("跳过 # 注释头,按列名定位(不假设列序)", () => {
    const csv = [
      "# license: CC BY 4.0",
      "# generated: whatever",
      "emitted_at_utc,strategy_name,condition_id,outcome,entry_price,signal_id",
      "2026-09-05T00:01:00.000Z,巨鲸,0xcid1,Yes,0.53,1",
      '2026-09-05T00:02:00.000Z,"共识, 强",0xcid2,No,,2',
    ].join("\n");
    const rows = parseRecordCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 1,
      strategyName: "巨鲸",
      entryPriceRaw: "0.53",
    });
    expect(rows[1]).toMatchObject({
      id: 2,
      strategyName: "共识, 强",
      entryPriceRaw: "",
    });
  });

  it("缺 signal_id 列时明确抛错 —— 不能把工具缺列读成篡改", () => {
    const csv = [
      "emitted_at_utc,strategy_name,condition_id,outcome,entry_price",
      "2026-09-05T00:01:00.000Z,巨鲸,0xcid1,Yes,0.53",
    ].join("\n");
    expect(() => parseRecordCsv(csv)).toThrow(/signal_id/);
  });

  it("坏行跳过,不毒化整份导出", () => {
    const csv = [
      "emitted_at_utc,strategy_name,condition_id,outcome,entry_price,signal_id",
      "not-a-date,x,0x1,Yes,0.5,1",
      "2026-09-05T00:01:00.000Z,巨鲸,0xcid1,Yes,0.53,2",
    ].join("\n");
    expect(parseRecordCsv(csv).map((r) => r.id)).toEqual([2]);
  });
});

describe("webcryptoSha256Hex", () => {
  it("与 node crypto 给出同一串 hex —— 浏览器按钮与生成侧才可能对得上", async () => {
    for (const s of ["", "abc", "巨鲸|0xcid|Yes", "genesis|1|共识|0xa|No|100|0.53"]) {
      expect(await webcryptoSha256Hex(s)).toBe(
        createHash("sha256").update(s).digest("hex"),
      );
    }
  });

  it("非 ASCII 走 UTF-8,与 Node 的默认编码一致(档名是中文,这条不成立就全错)", async () => {
    const zh = "早期赢家跟投|0xcid|一边倒";
    expect(await webcryptoSha256Hex(zh)).toBe(
      createHash("sha256").update(zh, "utf8").digest("hex"),
    );
  });

  it("整条链用 WebCrypto 复算,结果与生成侧的 node 实现相同", async () => {
    const rows = [row(1), row(2)];
    const digest = expectedDigest(DIGEST_GENESIS, rows);
    const r = await verifyDigestDays(
      rows,
      [{ day: DAY, digest, prev: DIGEST_GENESIS, count: 2 }],
      webcryptoSha256Hex,
    );
    expect(r.days[0].status).toBe("ok");
  });
});
