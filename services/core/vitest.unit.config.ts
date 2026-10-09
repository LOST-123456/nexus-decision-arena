import { defineConfig } from "vitest/config";

/** 单元测试：不接触数据库，可在任何环境运行。 */
export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 30_000,
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"]
  }
});
