import { defineConfig } from "vitest/config";

/**
 * 默认配置：运行包内全部测试（含 *.integration.test.ts）。
 *
 * ⚠️ 集成测试只在显式配置 `TEST_DATABASE_URL` 的专用测试库上运行；
 *    未配置时会在建立连接前 fail-closed 抛错（见 @nexus/db 的 testing/test-database）。
 *    这里**刻意不再**为 DATABASE_URL 提供任何默认值 / 回退到应用库。
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 30_000
  }
});