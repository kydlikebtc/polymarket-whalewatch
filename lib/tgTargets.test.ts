import { describe, it, expect, vi } from "vitest";
import { openDb, type DB } from "./db";
import {
  DEFAULT_TG_KINDS,
  TG_KINDS,
  addTarget,
  deleteTarget,
  listTargets,
  markSendResult,
  makeKindSender,
  resolveTargets,
  setPaused,
  updateTarget,
  type TgKind,
} from "./tgTargets";

const NOW = 1_800_000_000;
const ENV = {
  botToken: "envbot:AAA",
  alertChatId: "@public",
  signalChatId: "@vip",
  publicDelayMin: 15,
};

const seed = (db: DB, over: Record<string, unknown> = {}) =>
  addTarget(db, {
    label: "公开频道",
    botToken: "bot1:AAA",
    chatId: "@chan1",
    kinds: { large: true, consensus: true, strategy: false, ops: false },
    delayMin: 0,
    nowSec: NOW,
    ...over,
  } as Parameters<typeof addTarget>[1]);

describe("目标 CRUD", () => {
  it("新增后能读回,凭据不在列表里回显", () => {
    const db = openDb(":memory:");
    const id = seed(db);
    const rows = listTargets(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].label).toBe("公开频道");
    expect(rows[0].chatId).toBe("@chan1");
    // bot token 是凭据:列表结构里根本没有这个字段,不给「不小心渲染出去」
    // 留任何机会(与 x_accounts 的 access token 同一纪律)。
    expect(rows[0]).not.toHaveProperty("botToken");
    expect(JSON.stringify(rows[0])).not.toContain("bot1:AAA");
  });

  it("同一个 (bot, chat) 不能重复登记", () => {
    const db = openDb(":memory:");
    seed(db);
    expect(() => seed(db)).toThrow();
  });

  it("同一个 bot 发不同频道是两条独立目标", () => {
    const db = openDb(":memory:");
    seed(db);
    seed(db, { chatId: "@chan2", label: "VIP 群" });
    expect(listTargets(db)).toHaveLength(2);
  });

  it("改开关/延迟/名称", () => {
    const db = openDb(":memory:");
    const id = seed(db);
    updateTarget(db, id, {
      label: "改名了",
      kinds: { large: false, consensus: true, strategy: true, ops: true },
      delayMin: 30,
    });
    const row = listTargets(db)[0];
    expect(row.label).toBe("改名了");
    expect(row.kinds.large).toBe(false);
    expect(row.kinds.strategy).toBe(true);
    expect(row.delayMin).toBe(30);
  });

  it("暂停与删除", () => {
    const db = openDb(":memory:");
    const id = seed(db);
    setPaused(db, id, true);
    expect(listTargets(db)[0].paused).toBe(true);
    expect(deleteTarget(db, id)).toBe(true);
    expect(listTargets(db)).toHaveLength(0);
    expect(deleteTarget(db, 999)).toBe(false);
  });

  it("坏的 kinds JSON 回落默认,不让一行脏数据打死整个推送", () => {
    const db = openDb(":memory:");
    const id = seed(db);
    db.prepare("UPDATE tg_targets SET kinds = 'not json' WHERE id = ?").run(id);
    expect(listTargets(db)[0].kinds).toEqual(DEFAULT_TG_KINDS);
  });
});

describe("resolveTargets · env 向后兼容", () => {
  it("库里没有目标时,从 env 合成两条 —— 升级不能让线上静默停推", () => {
    // 这条是生产安全线:TELEGRAM_BOT_TOKEN/CHANNEL_ID 是现网正在用的配置,
    // 加了后台管理就把它们忽略掉,等于一次升级打断所有推送。
    const db = openDb(":memory:");
    const t = resolveTargets(db, ENV);
    expect(t).toHaveLength(2);
    const alert = t.find((x) => x.chatId === "@public")!;
    const vip = t.find((x) => x.chatId === "@vip")!;
    // 告警频道收大单/共识/运维,外加延迟版策略信号(现网的公开延迟通道)。
    // cohort 不进 env 回退 —— 新能力默认关的纪律贯穿零配置路径。
    expect(alert.kinds).toEqual({
      large: true,
      consensus: true,
      cohort: false,
      strategy: true,
      ops: true,
    });
    expect(alert.delayMin).toBe(15);
    expect(alert.source).toBe("env");
    // 策略频道零延迟,只收策略信号。
    expect(vip.kinds.strategy).toBe(true);
    expect(vip.kinds.large).toBe(false);
    expect(vip.delayMin).toBe(0);
  });

  it("只配了告警频道时只合成一条", () => {
    const db = openDb(":memory:");
    expect(resolveTargets(db, { ...ENV, signalChatId: "" })).toHaveLength(1);
  });

  it("没有 bot token 时一条都没有(功能整体未启用)", () => {
    const db = openDb(":memory:");
    expect(resolveTargets(db, { ...ENV, botToken: "" })).toHaveLength(0);
  });

  it("库里一旦有目标,env 完全让位 —— 不与后台配置叠加造成重复推送", () => {
    const db = openDb(":memory:");
    seed(db);
    const t = resolveTargets(db, ENV);
    expect(t).toHaveLength(1);
    expect(t[0].chatId).toBe("@chan1");
    expect(t[0].source).toBe("db");
  });

  it("暂停的目标不参与解析,但仍留在管理列表里", () => {
    const db = openDb(":memory:");
    const id = seed(db);
    seed(db, { chatId: "@chan2" });
    setPaused(db, id, true);
    expect(resolveTargets(db, ENV).map((x) => x.chatId)).toEqual(["@chan2"]);
    expect(listTargets(db)).toHaveLength(2);
  });

  it("全部暂停时不回退 env —— 那是运营者的明确意图,不该被「善意」覆盖", () => {
    const db = openDb(":memory:");
    const id = seed(db);
    setPaused(db, id, true);
    expect(resolveTargets(db, ENV)).toHaveLength(0);
  });
});

describe("按类型筛选", () => {
  it("每类只发给勾选了它的目标", () => {
    const db = openDb(":memory:");
    seed(db, {
      chatId: "@a",
      kinds: { large: true, consensus: false, strategy: false, ops: false },
    });
    seed(db, {
      chatId: "@b",
      kinds: { large: false, consensus: true, strategy: true, ops: true },
    });
    const pick = (k: TgKind) =>
      resolveTargets(db, ENV)
        .filter((t) => t.kinds[k])
        .map((t) => t.chatId);
    expect(pick("large")).toEqual(["@a"]);
    expect(pick("consensus")).toEqual(["@b"]);
    expect(pick("strategy")).toEqual(["@b"]);
    expect(pick("ops")).toEqual(["@b"]);
  });

  it("四类的键与展示元数据一一对应", () => {
    expect(TG_KINDS.map((k) => k.kind).sort()).toEqual(
      Object.keys(DEFAULT_TG_KINDS).sort(),
    );
  });
});

describe("投递健康度", () => {
  it("成功清零失败计数并记时间", () => {
    const db = openDb(":memory:");
    const id = seed(db);
    markSendResult(db, id, { ok: false, error: "boom", nowSec: NOW });
    markSendResult(db, id, { ok: false, error: "boom", nowSec: NOW });
    expect(listTargets(db)[0].consecutiveFailures).toBe(2);
    markSendResult(db, id, { ok: true, nowSec: NOW + 10 });
    const row = listTargets(db)[0];
    expect(row.consecutiveFailures).toBe(0);
    expect(row.lastOkAt).toBe(NOW + 10);
  });

  it("记录最后一条错误供后台展示(沉默是最贵的故障形态)", () => {
    const db = openDb(":memory:");
    const id = seed(db);
    markSendResult(db, id, { ok: false, error: "chat not found", nowSec: NOW });
    const row = listTargets(db)[0];
    expect(row.lastError).toBe("chat not found");
    expect(row.lastErrorAt).toBe(NOW);
  });

  it("对不存在的 id 是 no-op,不抛错", () => {
    const db = openDb(":memory:");
    expect(() =>
      markSendResult(db, 999, { ok: true, nowSec: NOW }),
    ).not.toThrow();
  });
});

describe("makeKindSender · 扇出与失败隔离", () => {
  const env = { ...ENV, botToken: "" }; // 关掉 env 回退,只测库里的目标

  it("同一条消息扇出到所有勾选了该类型的目标", async () => {
    const db = openDb(":memory:");
    seed(db, { chatId: "@a", kinds: { large: true } });
    seed(db, { chatId: "@b", kinds: { large: true } });
    seed(db, { chatId: "@c", kinds: { large: false, consensus: true } });
    const sent: string[] = [];
    const send = makeKindSender(db, env, "large", {
      sender: async (creds) => {
        sent.push(creds.chatId);
      },
    })!;
    await send("hello");
    expect(sent.sort()).toEqual(["@a", "@b"]);
  });

  it("一个目标挂了不影响其他目标 —— 部分成功视为成功,不抛不重推", async () => {
    // 这是 at-least-once 下的正确语义:已经发出去的那条不能因为另一条
    // 失败而被重推(alertEngine 的 claim 会回滚重来)。
    const db = openDb(":memory:");
    seed(db, { chatId: "@good", kinds: { large: true } });
    seed(db, { chatId: "@bad", kinds: { large: true } });
    const sent: string[] = [];
    const send = makeKindSender(db, env, "large", {
      sender: async (creds) => {
        if (creds.chatId === "@bad") throw new Error("chat not found");
        sent.push(creds.chatId);
      },
    })!;
    await expect(send("hi")).resolves.toBeUndefined();
    expect(sent).toEqual(["@good"]);
    // 失败的那个记了账,后台能看见。
    const bad = listTargets(db).find((t) => t.chatId === "@bad")!;
    expect(bad.consecutiveFailures).toBe(1);
    expect(bad.lastError).toContain("chat not found");
  });

  it("全部失败才抛 —— 保住 claim 回滚重试的既有语义", async () => {
    const db = openDb(":memory:");
    seed(db, { chatId: "@a", kinds: { large: true } });
    seed(db, { chatId: "@b", kinds: { large: true } });
    const send = makeKindSender(db, env, "large", {
      sender: async () => {
        throw new Error("down");
      },
    })!;
    await expect(send("hi")).rejects.toThrow();
  });

  it("TG 整体没配置(env 与库都空)才返回 undefined", async () => {
    const db = openDb(":memory:");
    expect(
      makeKindSender(db, env, "large", { sender: async () => {} }),
    ).toBeUndefined();
  });

  it("某类当前没人订阅时仍返回函数 —— 后台勾上就生效,不必重启", async () => {
    // 真实 bug:引擎启动时只建一次 sender。若按「这一类有没有订阅者」来决定
    // undefined,冷启动时空库就永久哑掉,之后在后台新增目标也不发,除非重启
    // —— 与「改完下一轮生效、无需重启」的承诺直接冲突。
    const db = openDb(":memory:");
    const id = seed(db, { chatId: "@a", kinds: { large: true, ops: false } });
    const sent: string[] = [];
    const send = makeKindSender(db, env, "ops", {
      sender: async (c) => {
        sent.push(c.chatId);
      },
    });
    expect(send).toBeDefined();
    await send!("nobody wants this yet");
    expect(sent).toEqual([]); // 当下确实没人订阅 → 静默 no-op
    // 运营者在后台勾上「运维通知」后,同一个 sender 立刻开始投递。
    updateTarget(db, id, { kinds: { ops: true } });
    await send!("now someone does");
    expect(sent).toEqual(["@a"]);
  });

  it("每次发送都重新解析目标 —— 后台改完下一条消息就生效", async () => {
    const db = openDb(":memory:");
    const id = seed(db, { chatId: "@a", kinds: { large: true } });
    const sent: string[] = [];
    const send = makeKindSender(db, env, "large", {
      sender: async (c) => {
        sent.push(c.chatId);
      },
    })!;
    await send("one");
    setPaused(db, id, true);
    seed(db, { chatId: "@b", kinds: { large: true } });
    await send("two");
    expect(sent).toEqual(["@a", "@b"]);
  });

  it("成功后清零失败计数", async () => {
    const db = openDb(":memory:");
    const id = seed(db, { chatId: "@a", kinds: { large: true } });
    markSendResult(db, id, { ok: false, error: "x", nowSec: NOW });
    const send = makeKindSender(db, env, "large", { sender: async () => {} })!;
    await send("hi");
    expect(listTargets(db)[0].consecutiveFailures).toBe(0);
  });
});

describe("deliveryKey · 防重投", () => {
  // signal_deliveries 主键是 (signal_id, event, channel)。换 channel 键 =
  // 历史上投过的信号全被判为「本通道没投过」→ 整批重发。所以 env 回退
  // 必须沿用现网的原键。
  it("env 回退沿用现网原键 tg_paid / tg_public", () => {
    const db = openDb(":memory:");
    const t = resolveTargets(db, ENV);
    expect(t.find((x) => x.chatId === "@public")!.deliveryKey).toBe(
      "tg_public",
    );
    expect(t.find((x) => x.chatId === "@vip")!.deliveryKey).toBe("tg_paid");
  });

  it("库里新建的目标用 tg:<id>,与历史键不撞", () => {
    const db = openDb(":memory:");
    const id = seed(db);
    const t = resolveTargets(db, ENV);
    expect(t[0].deliveryKey).toBe(`tg:${id}`);
    expect(t[0].deliveryKey).not.toBe("tg_public");
  });
});

// --- 同批出生(第一梯队五件套):cohort kind ---

describe("cohort kind(同批出生告警)", () => {
  it("默认关(新能力一律默认关的纪律)—— 老目标行不合并出 cohort 推送", () => {
    expect(DEFAULT_TG_KINDS.cohort).toBe(false);
  });

  it("TG_KINDS 元数据登记(管理页复选框随它自动出现)", () => {
    const entry = TG_KINDS.find((k) => k.kind === "cohort");
    expect(entry).toBeTruthy();
    expect(entry!.label).toContain("同批新钱包");
  });
});
