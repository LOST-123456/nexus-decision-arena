# 测试数据库隔离（fail-closed）

## 为什么要做

`lib/db/vitest.config.ts` 与 `services/core/vitest.config.ts` 曾经这样写：

```ts
env: {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://nexus:nexus@localhost:5432/nexus"
}
```

于是**任何**测试命令在没有配置数据库时都会静默连到**应用库 `nexus`**，
而集成测试的 `beforeEach` 会执行 `TRUNCATE ... CASCADE` —— 直接清空业务数据。
CI 里的 `pnpm test` 也是同样的问题（测试目标 = 应用目标）。

现在改为：测试只认 `TEST_DATABASE_URL`，**没有默认值**；缺失或目标非法时在
**建立连接之前**就抛错（fail-closed）。

## 守卫规则（`@nexus/db` 的 `testing/test-database`）

| 规则 | 行为 |
|---|---|
| 配置来源 | 只读 `TEST_DATABASE_URL`，无默认值；缺失 → 建连前抛 `TestDatabaseGuardError` |
| 受保护库名 | `nexus` / `postgres` / `template0` / `template1` 永远拒绝 |
| 允许库名 | 默认前缀 `nexus_test*`、`nexus_it*`、`nexus_migration_*`；可用 `TEST_DB_PREFIX` / `TEST_DB_ALLOWLIST` 扩展 |
| 主机 | 默认只允许 `localhost` / `127.0.0.1` / `::1` |
| 应用库重叠 | `TEST_DATABASE_URL` 与 `DATABASE_URL` 指向同一个 host:port/db → 拒绝 |
| 建/删库 | `CREATE/DROP DATABASE` 的库名必须是一次性测试库名（`assertDisposableDatabaseName`） |
| 纵深防御 | 由工厂返回的句柄会拦截字符串形式的破坏性 SQL（TRUNCATE / DROP / DELETE FROM / ALTER TABLE / CREATE DATABASE …） |

工厂：`createTestDatabase()`、`createTestAdminDatabase()`、`createTestDatabaseForUrl(url)`。

## 安全命令

```bash
# 0) 环境（示例占位，请勿提交真实凭据；<user>/<password> 按本机情况填写）
export DATABASE_URL='postgres://<user>:<password>@localhost:5432/nexus'          # 应用库
export TEST_DATABASE_URL='postgres://<user>:<password>@localhost:5432/nexus_test' # 专用测试库

# 1) 建专用测试库（幂等）
corepack pnpm db:test:create

# 2) 迁移专用测试库
corepack pnpm db:test:migrate

# 3) 只跑不碰数据库的单元测试
corepack pnpm test:unit

# 4) 只跑专用测试库上的集成测试
corepack pnpm test:integration
```

**禁止**：在没有 `TEST_DATABASE_URL` 的情况下运行 `pnpm test` / `pnpm test:integration`，
或把 `TEST_DATABASE_URL` 指向 `nexus`。

## 边界：应用迁移 CLI 与测试库迁移是两条路

| 命令 | 目标 | 读哪个变量 | 说明 |
|---|---|---|---|
| `pnpm --filter @nexus/db db:migrate` | **应用库** | `DATABASE_URL` | 既有行为保持不变（`src/migrate.ts` / `drizzle.config.ts` 未改动） |
| `pnpm db:test:migrate` | **专用测试库** | `TEST_DATABASE_URL` | 新增；永远不会读 `DATABASE_URL` |

防误用保护：`no-bypass-scan` 会扫描所有 `package.json`，**任何以 `test` 开头的脚本都不允许引用 `db:migrate`**。
测试要迁移数据库时只能走 `db:test:migrate`。

## 「无绕过」静态扫描

`lib/db/src/testing/no-bypass-scan.ts` 会**自动发现**：

- 所有 `*.integration.test.ts`（新增文件自动纳入，不依赖固定文件清单或固定数量）；
- 所有 `vitest*.config.ts`；
- 所有工作区 `package.json` 的测试脚本。

并逐条断言：不得读 `process.env.DATABASE_URL`、不得直接调 `createDatabase(...)`、
不得硬编码 `postgres://`、必须使用受保护工厂；配置不得再注入 `DATABASE_URL` 或写回退默认值；
测试脚本不得触发应用库迁移。

## CI 拓扑

`.github/workflows/ci.yml` 显式声明两个互不相同的目标，并在任何迁移之前先跑
`node scripts/assert-ci-db-topology.mjs` 做纯配置校验：

```
DATABASE_URL      = postgres://nexus:nexus@localhost:5432/nexus        # 应用迁移 / E2E
TEST_DATABASE_URL = postgres://nexus:nexus@localhost:5432/nexus_test   # 集成测试
```

## 本地 Docker

`docker-compose.yml` 挂载 `.docker/postgres-init/`，数据卷**首次初始化**时自动建 `nexus_test`；
若卷已存在（脚本不会重跑），改用 `corepack pnpm db:test:create`。
