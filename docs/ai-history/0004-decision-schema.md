# 0004 Decision Schema

## Real User Prompt

```text
You are implementing Task 2: Define the Decision Domain Schemas.

Read this file first; it is your complete requirements and exact values:
E:\AI创新应用挑战赛\.worktrees\decision-arena\.superpowers\sdd\2026-09-10-decision-arena-implementation\task-2-brief.md

Context:
- Work from E:\AI创新应用挑战赛\.worktrees\decision-arena on branch feature/decision-arena.
- Task 1 is complete: the pnpm workspace and `@nexus/shared` package exist, with `productName` and a passing smoke test.
- This task establishes the shared Zod contracts consumed by every later Core, DB, LLM, and Web task. Keep every field name and enum exactly as specified.
- Global constraints: Node.js 22 and pnpm 10.6.5; TypeScript strict with `noUncheckedIndexedAccess`; UUIDv7 for all persisted IDs; focused tests before implementation; commit each task separately; keep agent business rules out of UI.
- Use `corepack pnpm` if the ambient pnpm version differs. Ensure the new `uuid` and `zod` dependencies are recorded in `packages/shared/package.json` and the lockfile.
- Follow TDD: run the specified schema tests and record the real RED failure before implementation, then GREEN after.
- Before committing, create `docs/ai-history/0004-decision-schema.md` with the actual task Prompt, AI schema recommendation, human correction, RED command/output, GREEN command/output, and commit title.
- Do not dispatch any subagents.
- Do not modify unrelated files.

Write your full report to:
E:\AI创新应用挑战赛\.worktrees\decision-arena\.superpowers\sdd\2026-09-10-decision-arena-implementation\task-2-report.md

Return only: Status, commits (short SHA + subject), one-line test summary, concerns, report file path.
```

## AI Schema Recommendation

Use UUIDv7 for all persisted IDs through a single `newId()` helper and UUID Zod
schema. Model Claims as immutable revisions with `revision`,
`revisionOfClaimId`, and `rootClaimId`; use typed Claim relations; and give
Evidence an optional validity period. Encode each domain enum as a Zod enum,
and use `superRefine` on Evidence so external references require `sourceRef`
and assumptions cannot be marked `verified`.

## Human Correction

The human correction required two additions before committing:

1. Add `correlationId` to Challenge and ExecutionEvent so cross-agent work can
   be correlated.
2. Add structured human decision rationale to Conflict and HumanDecision,
   represented by `humanDecisionRequired` on Conflict and the
   `previousConclusion` / `newConclusion` fields on HumanDecision.

## Test Evidence

### RED

The brief's `pnpm --filter @nexus/shared test -- domain.test.ts` did not select
the new test under Corepack. The real failing test was run directly through
Vitest.

Command:

```bash
corepack pnpm --filter @nexus/shared exec vitest run src/domain/domain.test.ts
```

Actual output:

```text
 RUN  v3.0.8 E:/AI创新应用挑战赛/.worktrees/decision-arena/packages/shared

 ❯ src/domain/domain.test.ts (5 tests | 2 failed) 5ms
   × decision domain schemas > accepts a valid Claim 3ms
     → (0 , newId) is not a function
   ✓ decision domain schemas > rejects confidence outside 0..1
   ✓ decision domain schemas > requires an event correlation ID
   × decision domain schemas > accepts a high-severity challenge 0ms
     → Cannot read properties of undefined (reading 'parse')
   ✓ decision domain schemas > rejects a conflict without a human requirement field

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/domain/domain.test.ts > decision domain schemas > accepts a valid Claim
TypeError: (0 , newId) is not a function
 ❯ src/domain/domain.test.ts:13:16

 FAIL  src/domain/domain.test.ts > decision domain schemas > accepts a high-severity challenge
TypeError: Cannot read properties of undefined (reading 'parse')
 ❯ src/domain/domain.test.ts:71:23

 Test Files  1 failed (1)
      Tests  2 failed | 3 passed (5)
```

### GREEN

Focused schema test:

```bash
corepack pnpm --filter @nexus/shared exec vitest run src/domain/domain.test.ts
```

Actual output:

```text
 RUN  v3.0.8 E:/AI创新应用挑战赛/.worktrees/decision-arena/packages/shared

 ✓ src/domain/domain.test.ts (5 tests) 6ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

Full shared test:

```bash
corepack pnpm --filter @nexus/shared test
```

Actual output:

```text
 RUN  v3.0.8 E:/AI创新应用挑战赛/.worktrees/decision-arena/packages/shared

 ✓ src/index.test.ts (1 test) 1ms
 ✓ src/domain/domain.test.ts (5 tests) 7ms

 Test Files  2 passed (2)
      Tests  6 passed (6)
```

Typecheck:

```bash
corepack pnpm --filter @nexus/shared typecheck
```

Actual output:

```text
> @nexus/shared@ typecheck E:\AI创新应用挑战赛\.worktrees\decision-arena\packages\shared
> tsc --noEmit
```

## Commit Record

- Commit title: `feat(shared): add validated decision domain schemas`
