# AI 对话快照 0014：固定 Demo 与投稿材料

> 日期：2026-09-12  
> AI 工具：Codex  
> 关联计划：`docs/superpowers/plans/2026-09-10-decision-arena-implementation.md`

## Real User Prompt

用户要求按已冻结计划完成最后一个实现任务：固定 Demo、E2E、20 次稳定性、README、架构与实验文档，以及比赛交付材料；发现问题必须修复后继续，不能用未验证数据包装成果。

## AI Recommendation

- 使用固定项目 Fixture 和 Mock Mode 保证无外网可复现。
- 浏览器 Demo 明确标注 `DEMO FIXTURE`，不伪装成 live orchestration。
- 使用 Playwright 覆盖 1440x900 与 390x844，截图作为视觉证据。
- 20 次稳定性必须真实执行，结果写入 `docs/experiments/stability-output.txt`。
- 只记录已测量的测试数据，不填写推测指标。

## Human / Controller Corrections

Task 12 首次执行 Agent 在稳定性阶段停滞，控制器接管并修复：

1. 根脚本内部调用 ambient pnpm 11.9，绕过仓库锁定的 pnpm 10.6.5。根脚本已统一改为 `corepack pnpm`。
2. DB 与 Core 集成测试缺少默认 `DATABASE_URL`，导致全量测试失败。新增测试配置，使用本地 Docker PostgreSQL，并关闭数据库测试文件并行。
3. Vitest 错误收集 Playwright 的 `e2e/*.spec.ts`。Web Vitest 配置已排除 `e2e/**`。
4. `pnpm-workspace.yaml` 被工具写入未完成 `allowBuilds` 占位值，已删除。
5. PostgreSQL `TRUNCATE ... CASCADE` NOTICE 噪音已在测试数据库客户端中关闭。

## Verification Evidence

Typecheck:

```text
corepack pnpm typecheck
shared, web, db, llm, core: all passed
```

Full test suite:

```text
corepack pnpm test
shared: 47 passed
core: 54 passed
db: 9 passed
llm: 6 passed
web: 19 passed
total: 135 passed
```

Production build:

```text
corepack pnpm --filter @nexus/web build
Next.js production build: passed
routes: /, /sessions/[sessionId], /sessions/[sessionId]/report, /sessions/demo
```

E2E:

```text
corepack pnpm --filter @nexus/web test:e2e
desktop-1440x900: passed
mobile-390x844: passed
```

Stability:

```text
corepack pnpm test:stability
40/40 runs passed (desktop 20 + mobile 20)
duration: 143135 ms
exit_code: 0
raw evidence: docs/experiments/stability-output.txt
```

Screenshots:

```text
artifacts/playwright/desktop-1440x900-initial.png
artifacts/playwright/desktop-1440x900-conflict.png
artifacts/playwright/desktop-1440x900-final.png
artifacts/playwright/desktop-1440x900-report.png
artifacts/playwright/mobile-390x844-initial.png
artifacts/playwright/mobile-390x844-conflict.png
artifacts/playwright/mobile-390x844-final.png
artifacts/playwright/mobile-390x844-report.png
```

## Known Boundary

固定浏览器 Demo 使用 fixture，不调用真实模型，也不写入 live DecisionSession。底层 Core、PostgreSQL、SSE、LLM provider 和 human decision 路径拥有独立测试，但浏览器与 live orchestration 的最终连线仍属于后续集成工作。投稿材料必须保持这一边界说明。

## Commit

- Commit title: `feat: complete reproducible decision arena demo`
- Commit hash: `ff9793a`.