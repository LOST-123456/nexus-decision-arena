import { defineConfig } from "vitest/config";

/**
 * 集成测试：**只**在显式配置 `TEST_DATABASE_URL` 的专用测试库上运行。
 * 未配置时守卫会在建连前抛错；这里不提供任何默认值。
 *
 * 超时预算（必须显式声明，不依赖 vitest 默认值）：
 *
 * 这些用例会真实地 `CREATE DATABASE` → 跑迁移 → `DROP DATABASE`。一整轮 DB 生命周期在规范
 * 拓扑（`docker compose up -d postgres`，postgres:16-alpine）约 0.3s，但在较慢/高负载的环境上
 * 会显著变长。vitest 默认的 5000ms 对这种用例结构性不足：一旦超时，用例虽被判失败，其异步体
 * 仍会在后台继续建库/删库，反过来与后续用例争抢同一实例，形成级联变慢。
 *
 * `testTimeout` 定为 60_000 的依据：它与本目录既有用例先前内联的预算一致（不降低任何既有预算），
 * 并把预算**收敛到这一处**——内联的 per-test 超时会覆盖配置与 CLI 的 `--testTimeout`，导致预算
 * 无法按环境集中调整。现在所有集成用例使用同一个可集中调整的预算。
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    include: ["src/**/*.integration.test.ts"]
  }
});
