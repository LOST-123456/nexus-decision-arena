# AI 对话快照 0015：最终残余问题修复

> 日期：2026-09-12  
> AI 工具：Codex  
> 关联报告：`final-fix-report.md`

## Original User Request

用户要求解决最终审查发现的三个残余问题，并在全部任务完成后汇报。

## Reproduced Symptoms

1. `request_more_analysis` 把会话写入 `REASSESSING`，但 `RunSessionService.start()` 只接受 `CREATED`，因此唯一的补充轮无法执行。
2. `FinalReportRepository` 不检查会话是否处于终态，它会为 `REASSESSING` 生成报告；同时强制要求 HumanDecision，导致自动 `DECIDED` 会话无法生成报告。
3. Core 会先通过 SSE 发布人工裁决事件再返回 HTTP 201，前端两条路径均直接追加事件和裁决，造成重复 Timeline 记录。

## Ranked Hypotheses

1. 补充轮死路来自 `start()` 的 phase guard，而不是状态机缺少 `REASSESSING`。
2. 报告问题来自 FinalReport 生成条件只看 HumanDecision，不检查 session phase。
3. 重复记录来自前端 HTTP 响应路径未复用事件 reducer 的按 ID 去重语义。

三条假设均通过失败回归测试验证。

## Regression Tests

- `services/core/src/arena/run-session.test.ts`
- `lib/db/src/repositories/final-report-repository.integration.test.ts`
- `apps/web/features/arena/human-decision-sync.test.ts`
- `apps/web/features/arena/session-workspace.test.ts`

RED evidence before the fix:

```text
RunSessionService.start: SessionAlreadyStartedError
report repository: ReportNotReadyError for auto-DECIDED and premature report for REASSESSING
web: applyHumanDecisionResponse missing; REASSESSING report link allowed
```

## Fix

- `RunSessionService.start()` now accepts exactly one `REASSESSING` supplement round, reuses persisted Claims, reruns Cross Examination, and returns to `HUMAN_REVIEW` or `DECIDED`.
- Human decision route automatically runs the allowed supplement round when action is `request_more_analysis`.
- FinalReport generation requires `DECIDED` or `REPORT_READY`; automatic decisions can generate reports without a HumanDecision.
- Report route rejects non-terminal sessions with HTTP 409.
- Web human-decision responses use an idempotent synchronization helper and no longer duplicate decisions or timeline events.
- Report links are only shown for `DECIDED` and `REPORT_READY`.

## Verification

```text
corepack pnpm typecheck
PASS

corepack pnpm test
152 tests passed

Shared: 48
Core: 62
DB: 13
LLM: 6
Web: 23

corepack pnpm --filter @nexus/web build
Next.js 15.5.25 production build PASS

corepack pnpm --filter @nexus/web test:e2e
4/4 passed across desktop and mobile
```

## Commit

`fix: resolve residual decision lifecycle issues`