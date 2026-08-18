import { defineConfig } from "vitest/config";

// 默认 node 环境;需要 DOM 的用例在文件头用
// `// @vitest-environment jsdom` 单独声明(分法同 aisee)。
export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    environment: "node",
  },
});
