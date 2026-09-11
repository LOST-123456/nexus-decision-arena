# 0008 Cross-Examination Orchestration

## Actual Task Prompt

```text
You are taking over Task 6: Orchestrate Multi-Agent Analysis and Cross
Examination. The previous implementer was interrupted by provider quota
exhaustion after creating partial files. Preserve and inspect the existing
partial work; do not discard or reset it.

Work from E:\AI创新应用挑战赛\.worktrees\decision-arena on branch
feature/decision-arena.

Requirements and rulings:
- Do NOT add `@nexus/db` to Core in this task; only `@nexus/llm` should be
  added now. `@nexus/db` is introduced in Task 9 after the DB package exists.
- Create/export `SessionView` in
  `packages/shared/src/execution/session-view.ts`. Core and Web must not import
  each other internally.
- Enforce max 5 Claims, max 2 challengers, different challenger role keys, and
  no self-challenge.
- `RunSessionService` must use `Promise.allSettled` so one Agent failure does
  not stop others and must emit `AGENT_RUN_FAILED`.
- `CrossExaminationService` must isolate each Challenge in try/catch and emit
  `CHALLENGE_FAILED`; original Claims stay immutable and responses are new
  Claim revisions.
- Use `corepack pnpm`.
- Read all existing partial code before editing. Complete missing
  functionality/tests, run `corepack pnpm --filter @nexus/core test` plus core
  typecheck and any shared typecheck required. If partial code has defects, fix
  them as part of this task.
- Ensure `docs/ai-history/0008-cross-examination.md` contains actual task
  prompt, AI recommendation, human plan ruling, real RED/GREEN or integration
  evidence, and commit title. Do not fabricate a race bug.
- Commit with the exact task message:
  `feat(core): orchestrate cross examination flow`.
- Do not dispatch subagents and do not make unrelated changes.
```

## AI Recommendation

Keep the orchestration boundary dependency-injected and stage-local:

- `AgentRunner` is a narrow contract returning `AgentAnalysis`; Core does not
  need to know which provider or adapter produced Claims and Evidence.
- `RunSessionService.runAnalysis()` uses `Promise.allSettled`, preserves all
  fulfilled analyses, and emits one `AGENT_RUN_FAILED` event for every rejected
  Agent.
- `CrossExaminationService.run()` uses `selectClaims(..., 5)` and
  `assignChallengers(..., 2)`, isolates each Challenge with its own try/catch,
  and emits `CHALLENGE_FAILED` without aborting the remaining Challenges.
- Dependencies receive isolated Claim snapshots. Returned responses are
  validated as new Claim revisions linked to the original Claim before they
  can be accepted.
- `SessionView` belongs to `@nexus/shared`, so later Core and Web consumers can
  share the execution snapshot without cross-package internal imports.

## Human Plan Ruling

The implementing brief originally included `@nexus/db`, but the human ruling
removed it because that workspace package does not exist until a later task.
Core now adds only `@nexus/llm` and keeps `@nexus/db` absent.

The human also required `SessionView` to move to `@nexus/shared`, Challenge
failure isolation, the Agent failure event, immutable originals, newer response
revisions, exact `corepack pnpm` verification, and one independent commit.

The brief's `RunSessionService` snippet returned failures but did not show how
`AGENT_RUN_FAILED` was emitted. The partial implementation resolved that by
adding an `emit` callback to `runAnalysis`. `start(sessionId)` remains an
explicit integration placeholder because Task 6 has no repositories or real
LLM-backed Agent factory from which to load a session; later tasks replace it.

## Real RED Evidence

After preserving the partial work, the existing suite was run first:

```bash
corepack pnpm --filter @nexus/core test
```

It passed 12 tests. Two focused regression tests were then added for the
unverified CrossExaminationService invariants.

```bash
corepack pnpm --filter @nexus/core exec vitest run src/arena/cross-examination.test.ts
```

Actual result:

```text
❯ src/arena/cross-examination.test.ts (3 tests | 2 failed) 12ms
  ✓ creates, answers, resolves, and converts a challenge to conflict
  × isolates a failed challenge and protects the original claim from mutation
    → expected { …(17) } to deeply equal { …(17) }
  × rejects a response that reuses the original claim revision
    → expected [ { …(17) } ] to have a length of +0 but got 1

Test Files  1 failed (1)
     Tests  2 failed | 1 passed (3)
```

The first failure proved that a Challenge dependency could mutate the original
Claim object. The second proved that a dependency could return the original
revision as its response without rejection.

## GREEN and Integration Evidence

The service now passes isolated `structuredClone` Claim snapshots to Challenge
dependencies and validates response Claims with `ClaimSchema` plus explicit
revision, session, and Challenge linkage checks.

Focused GREEN:

```bash
corepack pnpm --filter @nexus/core exec vitest run src/arena/cross-examination.test.ts
```

Actual result:

```text
✓ src/arena/cross-examination.test.ts (3 tests) 7ms

Test Files  1 passed (1)
     Tests  3 passed (3)
```

Full Core GREEN:

```bash
corepack pnpm --filter @nexus/core test
```

Actual result:

```text
✓ src/arena/run-session.test.ts (1 test) 4ms
✓ src/workflow/workflow.test.ts (5 tests) 8ms
✓ src/arena/cross-examination.test.ts (3 tests) 10ms
✓ src/workflow/boundary.test.ts (5 tests) 18ms

Test Files  4 passed (4)
     Tests  14 passed (14)
```

Typechecks:

```bash
corepack pnpm --filter @nexus/core typecheck
corepack pnpm --filter @nexus/shared typecheck
```

Both completed with no TypeScript diagnostics.

The existing `run-session.test.ts` concurrently runs three Agents with two
rejections and one fulfillment. The fulfilled analysis survives and exactly
two `AGENT_RUN_FAILED` events are emitted. No genuine concurrency race or
state-loss defect was observed or fabricated.

## Commit Record

- Commit title: `feat(core): orchestrate cross examination flow`
## Review Fix: Immutable CHALLENGE_CREATED Payload

Review found that the service emitted the live Challenge object for
`CHALLENGE_CREATED`, then later mutated that same object while answering and
evaluating the Challenge. A retaining event sink could therefore observe a
created event whose `status` had changed from `open` to `unresolved`.

The regression test retains the emitted `CHALLENGE_CREATED` payload and
asserts that it remains `open` after the service finishes. The minimal fix is
to emit `structuredClone(challenge)` for that event while keeping the live
domain object for the subsequent state transition.

Verified after the fix:

```text
corepack pnpm --filter @nexus/core exec vitest run src/arena/cross-examination.test.ts
4 passed

corepack pnpm --filter @nexus/core test
15 passed

corepack pnpm --filter @nexus/core typecheck
no diagnostics
```
