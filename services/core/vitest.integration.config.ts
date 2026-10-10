import { defineConfig } from "vitest/config";

/**
 * 集成测试：**只**在显式配置 `TEST_DATABASE_URL` 的专用测试库上运行。
 * 未配置时守卫会在建连前抛错；这里不提供任何默认值。
 *
 * 超时预算：这些用例同样会真实地 `CREATE DATABASE` → 跑迁移 → `DROP DATABASE`，vitest 默认的
 * 5000ms 对一整轮 DB 生命周期结构性不足（详见 `lib/db/vitest.integration.config.ts` 的说明）。
 * 这里显式声明预算，使两个集成套件使用一致、可按环境集中调整的 `testTimeout`。
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    include: ["src/**/*.integration.test.ts"]
  }
});
