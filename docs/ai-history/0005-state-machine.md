# 0005 State Machine

## Real User Prompt

```text
You are implementing Task 3: Enforce Claim Invariants and Session Transitions.

Read this file first; it is your complete requirements and exact values:
E:\AI创新应用挑战赛\.worktrees\decision-arena\.superpowers\sdd\2026-09-10-decision-arena-implementation\task-3-brief.md

Context:
- Work from E:\AI创新应用挑战赛\.worktrees\decision-arena on branch feature/decision-arena.
- Tasks 1-2 are complete. `@nexus/shared` already exports validated domain schemas, including a strict UUIDv7 `IdSchema`.
- This task adds pure workflow constraints only; do not add runtime orchestration or UI code.
- Global constraints: Node.js 22, pnpm 10.6.5, strict TypeScript, UUIDv7 IDs, no Claim overwrite, one focused test cycle per behavior, independent commit.
- Follow TDD exactly. Use the brief's test cases first, record actual RED output, then implement the minimal invariants and state machine and record GREEN output.
- Commit with the exact message from the brief.
- Before committing, create `docs/ai-history/0005-state-machine.md` with the actual task Prompt, AI recommendation, human correction, RED command/output, GREEN command/output, and commit title.
- Do not dispatch subagents and do not modify unrelated files.

Write your full report to:
E:\AI创新应用挑战赛\.worktrees\decision-arena\.superpowers\sdd\2026-09-10-decision-arena-implementation\task-3-report.md

Return only: Status, commits (short SHA + subject), one-line test summary, concerns, report file path.
```

## AI Recommendation

Represent Claim revisions as immutable lineage: root Claims must stay at
revision 1, non-root revisions must advance beyond revision 1, and revisions
must link to their predecessor. Accepted important Claims require evidence
that is both attached to the Claim and verified. Keep the session workflow as
a small explicit transition table so invalid jumps are rejected by
`transitionSession`.

## Human Correction

The brief's test snippet omitted `assertClaimInvariants` from its import list,
so the test file would not exercise the intended public API. The import was
added.

The brief's predecessor test used a root Claim with revision 2, which is the
same input shape as the root-revision test and therefore cannot isolate the
missing-predecessor invariant. The focused implementation run failed with:

```text
expected [Function] to throw error including 'A revision must reference its predece...'
but got 'Root claim revision must be 1'
```

The human correction was to make that fixture a non-root revision by setting
`rootClaimId` to a different ID while leaving the production invariant order
and behavior unchanged.

## Test Evidence

The ambient pnpm was 11.9.0 and attempted dependency repair, so the repository
pin was used through Corepack (`pnpm 10.6.5`). Node.js in the runner was
v24.14.0 rather than the requested Node.js 22.

### RED

Command:

```bash
corepack pnpm --filter @nexus/shared test -- workflow.test.ts
```

Actual output:

```text
> @nexus/shared@ test E:\AI创新应用挑战赛\.worktrees\decision-arena\packages\shared
> vitest run "--" "workflow.test.ts"

 ❯ src/workflow/workflow.test.ts (5 tests | 5 failed) 13ms
   × claim invariants > rejects a root Claim with revision greater than one
     → expected [Function] to throw error including 'Root claim revision must be 1' but got '(0 , assertClai…'
   × claim invariants > rejects an accepted important Claim without verified evidence
     → expected [Function] to throw error including 'Accepted important claims require ver…' but got '(0 , assertClai…'
   × claim invariants > rejects a revision without a predecessor
     → expected [Function] to throw error including 'A revision must reference its predece…' but got '(0 , assertClai…'
   × session transitions > allows the frozen happy path
     → (0 , canTransition) is not a function
   × session transitions > rejects skipping the analysis phase
     → (0 , canTransition) is not a function

 Test Files  1 failed | 2 passed (3)
      Tests  5 failed | 9 passed (14)
```

After the minimal implementation, the isolated fixture mismatch was confirmed:

```text
 ❯ src/workflow/workflow.test.ts (5 tests | 1 failed)
   ✓ rejects a root Claim with revision greater than one
   ✓ rejects an accepted important Claim without verified evidence
   × rejects a revision without a predecessor
     → expected [Function] to throw error including 'A revision must reference its predece…'
       but got 'Root claim revision must be 1'
   ✓ allows the frozen happy path
   ✓ rejects skipping the analysis phase
```

### GREEN

Focused workflow test:

```bash
corepack pnpm --filter @nexus/shared exec vitest run src/workflow/workflow.test.ts
```

Actual output:

```text
RUN  v3.0.8 E:/AI创新应用挑战赛/.worktrees/decision-arena/packages/shared

✓ src/workflow/workflow.test.ts (5 tests) 6ms

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
✓ src/workflow/workflow.test.ts (5 tests) 6ms
✓ src/domain/domain.test.ts (8 tests) 7ms

Test Files  3 passed (3)
     Tests  14 passed (14)
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

- Commit title: `feat(shared): enforce decision workflow invariants`
