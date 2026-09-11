# 0006 Claim Rules

## Real User Prompt

```text
You are implementing Task 4: Implement Claim Selection and Challenger Assignment.

Read this file first; it is your complete requirements and exact values:
E:\AI创新应用挑战赛\.worktrees\decision-arena\.superpowers\sdd\2026-09-10-decision-arena-implementation\task-4-brief.md

Context:
- Work from E:\AI创新应用挑战赛\.worktrees\decision-arena on branch feature/decision-arena.
- Tasks 1-3 are complete. `@nexus/shared` exports strict UUIDv7 IDs, domain schemas, invariants, and the frozen state machine.
- This task creates the `@nexus/core` package and pure deterministic workflow rules only. Do not add orchestration, LLM calls, API routes, or UI code.
- Global constraints: Node.js 22 target, pnpm 10.6.5, strict TypeScript, deterministic behavior, exactly five top-level AgentRole keys, max five selected Claims, max two challengers per Claim, focused test-first development, independent commit.
- Use `corepack pnpm` to keep the pinned toolchain. `services/core/package.json` depends only on `@nexus/shared`, Fastify, and Zod at this stage. Do not add `@nexus/llm` or `@nexus/db` yet.
- Follow TDD exactly. Run the failing pure-rule tests before implementation and record actual RED/GREEN output. If the brief's test code has a small type or fixture defect, correct the test while preserving its intent and document the correction in AI history.
- Commit with the exact message from the brief.
- Before committing, create `docs/ai-history/0006-claim-rules.md` with the actual task Prompt, AI recommendation, human correction, RED command/output, GREEN command/output, and commit title.
- Do not dispatch subagents and do not modify unrelated files.

Write your full report to:
E:\AI创新应用挑战赛\.worktrees\decision-arena\.superpowers\sdd\2026-09-10-decision-arena-implementation\task-4-report.md

Return only: Status, commits (short SHA + subject), one-line test summary, concerns, report file path.
```

## AI Recommendation

Implement the three pure functions exactly as specified in the brief: sort
Claims by importance, then evidence gaps, then confidence, then type, then
UUID for full determinism; exclude the originating role when assigning
challengers and use each Claim type's preferred role order as the tie-breaker;
and detect both claim-to-claim `contradicts` relations and unresolved severe
Challenges as validated `Conflict` records. Add focused tests for the conflict
detector because Step 7 explicitly expects conflict tests to pass even though
the Step 2 test snippet only covered selection and assignment.

## Human Correction

The brief's Step 2 test snippet omitted conflict-detector coverage while Step
7 expected "selection, assignment, and conflict tests pass". Three focused
conflict tests were added: a `contradicts` relation produces a logic conflict,
an unresolved challenge with severity at least 4 produces an evidence conflict,
and challenges that are not unresolved or are below severity 4 are ignored.

The claim-selection fixture expected
`[weakAssumption.id, lowerImportance.id]`. That expectation contradicts the
specified comparator, which sorts importance first: a higher-importance Claim
with three evidence items should outrank a lower-importance Claim, even if the
lower-importance Claim has an evidence gap. The expected array was corrected to
`[weakAssumption.id, highEvidence.id]`.

The first implementation run confirmed the fixture mismatch:

```text
 ❯ src/workflow/workflow.test.ts (5 tests | 1 failed) 11ms
   × claim selection > prioritizes importance, evidence gaps, and lower confidence 7ms
     → expected [ …(2) ] to deeply equal [ …(2) ]
```

## Test Evidence

The repository pin was used through Corepack (`pnpm 10.6.5`). Node.js in the
runner was v24.14.0 rather than the requested Node.js 22.

### RED

Command:

```bash
corepack pnpm --filter @nexus/core test -- workflow.test.ts
```

Actual output:

```text
> @nexus/core@ test E:\AI创新应用挑战赛\.worktrees\decision-arena\services\core
> vitest run "--" "workflow.test.ts"


 RUN  v3.0.8 E:/AI创新应用挑战赛/.worktrees/decision-arena/services/core

 ❯ src/workflow/workflow.test.ts (0 test)

⎯⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/workflow/workflow.test.ts [ src/workflow/workflow.test.ts ]
Error: Failed to load url ./challenger-assigner (resolved id: ./challenger-assigner) in E:/AI创新应用挑战赛/.worktrees/decision-arena/services/core/src/workflow/workflow.test.ts. Does the file exist?
 ❯ loadAndTransform ../../../../../AI%E5%88%9B%E6%96%B0%E5%BA%94%E7%94%A8%E6%8C%91%E6%88%98%E8%B5%9B/.worktrees/decision-arena/node_modules/.pnpm/vite@6.4.3_@types+node@22.13.10_tsx@4.19.3/node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:35835:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  no tests
   Start at  11:14:16
   Duration  1.86s (transform 425ms, setup 0ms, collect 0ms, tests 0ms, environment 0ms, prepare 609ms)

E:\AI创新应用挑战赛\.worktrees\decision-arena\services\core:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @nexus/core@ test: `vitest run "--" "workflow.test.ts"`
Exit status 1
```

### GREEN

Command:

```bash
corepack pnpm --filter @nexus/core test
```

Actual output:

```text
> @nexus/core@ test E:\AI创新应用挑战赛\.worktrees\decision-arena\services\core
> vitest run


 RUN  v3.0.8 E:/AI创新应用挑战赛/.worktrees/decision-arena/services/core

 ✓ src/workflow/workflow.test.ts (5 tests) 6ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  11:20:00
   Duration  752ms (transform 102ms, setup 0ms, collect 224ms, tests 6ms, environment 0ms, prepare 235ms)
```

Typecheck:

```bash
corepack pnpm --filter @nexus/core typecheck
```

Actual output:

```text
> @nexus/core@ typecheck E:\AI创新应用挑战赛\.worktrees\decision-arena\services\core
> tsc --noEmit
```

## Commit Record

- Commit title: `feat(core): add deterministic claim challenge rules`
