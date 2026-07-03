import { configDefaults, defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // .claude/** holds git-worktree COPIES of this repo (parallel batch work).
    // Without this exclude, `npm test` from the MAIN checkout also collects
    // every copy's *.test.ts and multi-counts the suite (observed: 769 vs the
    // real 262). configDefaults keeps node_modules/dist excluded as before.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
