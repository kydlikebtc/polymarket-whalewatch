import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { WW_EXTENSION_MESSAGE } from "./protocol";

// 防漂移:协议常量在服务端(lib/extensionProtocol.ts)与插件(本目录)各存一份
// —— 插件是独立工程,不能 import 主仓库的 lib。两份必须逐字一致,否则握手会
// **静默**失败(页面 postMessage 出去,插件因为 source 对不上直接忽略,双方
// 都不报错)。这条测试就是那份一致性的执行者。
const here = dirname(fileURLToPath(import.meta.url));
const SERVER_COPY = resolve(here, "../../../lib/extensionProtocol.ts");

describe("协议常量与服务端同源", () => {
  it("三个字符串字面量与 lib/extensionProtocol.ts 逐字一致", () => {
    const src = readFileSync(SERVER_COPY, "utf8");
    for (const [name, value] of Object.entries(WW_EXTENSION_MESSAGE)) {
      // 服务端那份写成 `source: "whalewatch-web",` 形式;逐个断言存在。
      expect(
        src.includes(`${name}: "${value}"`),
        `lib/extensionProtocol.ts 里找不到 ${name}: "${value}" —— 两份协议已漂移`,
      ).toBe(true);
    }
  });

  it("服务端那份没有多出插件不认识的 action", () => {
    const src = readFileSync(SERVER_COPY, "utf8");
    const block = src.slice(
      src.indexOf("WW_EXTENSION_MESSAGE = {"),
      src.indexOf("} as const;"),
    );
    const keys = [...block.matchAll(/^\s*(\w+):\s*"/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual(Object.keys(WW_EXTENSION_MESSAGE).sort());
  });
});
