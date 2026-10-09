import { defineConfig } from "vitest/config";

/**
 * 集成测试：**只**在显式配置 `TEST_DATABASE_URL` 的专用测试库上运行。
 * 未配置时守卫会在建连前抛错；这里不提供任何默认值。
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 30_000,
    include: ["src/**/*.integration.test.ts"]
  }
});
