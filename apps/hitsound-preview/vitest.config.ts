import * as path from "node:path";
import { defineConfig } from "vitest/config";

// 测试在 node 环境跑：直接把 workspace 包别名到 src（不走 exports 的 source 条件）
export default defineConfig({
  resolve: {
    alias: {
      "@osucad/core": path.resolve(__dirname, "../../packages/core/src/index.ts"),
      "@osucad/framework": path.resolve(__dirname, "../../packages/framework/src/index.ts"),
      "@osucad/ruleset-osu": path.resolve(__dirname, "../../packages/ruleset-osu/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
