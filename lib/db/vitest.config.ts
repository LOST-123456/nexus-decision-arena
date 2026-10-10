import { defineConfig } from "vitest/config";

/**
 * 默认配置：运行包内全部测试（含 *.integration.test.ts）。
 *
 * ⚠️ 集成测试只在显式配置 `TEST_DATABASE_URL` 的专用测试库上运行；
 *    未配置时会在建立连接前 fail-closed 抛错（见 src/testing/test-database.ts）。
 *    这里**刻意不再**为 DATABASE_URL 提供任何默认值 / 回退到应用库。
 *
 * 超时预算：本配置会连带运行 `*.integration.test.ts`（真实 CREATE DATABASE → 迁移 →
 * DROP DATABASE），vitest 默认的 5000ms 对一整轮 DB 生命周期结构性不足，故显式声明。
 * 依据与取值说明见 `vitest.integration.config.ts`。
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000
  }
});
