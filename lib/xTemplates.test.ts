import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import {
  DEFAULT_X_TEMPLATES,
  getXTemplates,
  setXTemplates,
  validateXTemplate,
  previewXTemplate,
} from "./xTemplates";
import { TEMPLATE_VOCAB, weightedLength } from "./xComposer";
import type { XPostKind } from "./xSettings";

function writeRaw(db: DB, value: string) {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    "x_broadcast_templates",
    value,
  );
}

describe("getXTemplates / setXTemplates", () => {
  it("无配置 → 全 null(内置);set → get 往返", () => {
    const db = openDb(":memory:");
    expect(getXTemplates(db)).toEqual(DEFAULT_X_TEMPLATES);
    const t = {
      ...DEFAULT_X_TEMPLATES,
      whale: "{icon} {amount}\n\n{title}\n\n{tags}",
    };
    setXTemplates(db, t);
    expect(getXTemplates(db)).toEqual(t);
  });

  it("坏 JSON / 空串键 / 坏类型键 → 回落 null", () => {
    const db = openDb(":memory:");
    writeRaw(db, "{broken");
    expect(getXTemplates(db)).toEqual(DEFAULT_X_TEMPLATES);
    writeRaw(
      db,
      JSON.stringify({ whale: "  ", consensus: 42, pregame: "{title} ok" }),
    );
    const got = getXTemplates(db);
    expect(got.whale).toBeNull();
    expect(got.consensus).toBeNull();
    expect(got.pregame).toBe("{title} ok");
  });

  it("真实变更才写 config_history", () => {
    const db = openDb(":memory:");
    const t = { ...DEFAULT_X_TEMPLATES, weekly: "{week} {url}" };
    setXTemplates(db, t);
    setXTemplates(db, t);
    setXTemplates(db, { ...t, weekly: null });
    const n = db
      .prepare(
        "SELECT COUNT(*) AS n FROM config_history WHERE key = 'x_broadcast_templates'",
      )
      .get() as { n: number };
    expect(n.n).toBe(2);
  });
});

describe("validateXTemplate", () => {
  it("未知占位符被拦,错误里给出可用词表", () => {
    const r = validateXTemplate("whale", "{nope} {title}");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("{nope}");
      expect(r.error).toContain("{amount}");
    }
  });

  it("非 weekly:{title} 必须恰好一个;夹带链接被拦(成本红线)", () => {
    expect(validateXTemplate("whale", "{amount} {tags}").ok).toBe(false);
    expect(validateXTemplate("whale", "{title} and {title}").ok).toBe(false);
    expect(
      validateXTemplate("consensus", "{title} https://x.com/foo {tags}").ok,
    ).toBe(false);
    // weekly 允许链接({url} 是它存在的意义)。
    expect(validateXTemplate("weekly", "{week} {url}").ok).toBe(true);
  });

  it("scorecard 无 {title} 但同样禁链接 —— 成本口子的边界是 kind,不是「有没有标题锚点」", () => {
    // 无标题锚点:不要求 {title}(与 weekly 同一类)。
    expect(validateXTemplate("scorecard", "{day} {settled} {tags}").ok).toBe(
      true,
    );
    // 但绝不因此顺带拿到 weekly 的带链接许可($0.20/条 = 13 倍成本)。
    const r = validateXTemplate(
      "scorecard",
      "{day} https://whalewatch.wired.fund {tags}",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("链接");
  });

  it("底座超长被拦(样本渲染估算)", () => {
    const fat = `${"Very long fixed copy. ".repeat(20)}{title}`;
    const r = validateXTemplate("pregame", fat);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("加权字符");
  });

  it("每个 kind 的「全词表模板」都合法 —— 词表与样本齐备的自检", () => {
    for (const kind of Object.keys(TEMPLATE_VOCAB) as XPostKind[]) {
      const tpl = TEMPLATE_VOCAB[kind].map((v) => `{${v}}`).join("\n");
      const r = validateXTemplate(kind, tpl);
      expect(r, `${kind} 全词表模板应合法`).toEqual({ ok: true });
      // 预览渲染无残留花括号(每个占位符都有样本值)。
      expect(previewXTemplate(kind, tpl)).not.toMatch(/\{[A-Za-z0-9_]+\}/);
    }
  });

  it("weekly 全量渲染超 280 被拦", () => {
    const fat = `${"Weekly words repeat. ".repeat(20)}{url}`;
    const r = validateXTemplate("weekly", fat);
    expect(r.ok).toBe(false);
    // 而正常模板渲染后在限内。
    const ok =
      "📊 {week}\n\n{settled} settled · {winRate} win · {pnl}\n\n{url}\n\n{tags}";
    expect(validateXTemplate("weekly", ok)).toEqual({ ok: true });
    expect(weightedLength(previewXTemplate("weekly", ok))).toBeLessThanOrEqual(
      280,
    );
  });
});
