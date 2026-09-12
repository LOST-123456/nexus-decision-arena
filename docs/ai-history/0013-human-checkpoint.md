# 0013 Human Checkpoint, Replay, Inspector, and Report

## Actual Task Prompt

```text
You are implementing Task 11: Add Inspector, Timeline, Human Checkpoint, and Report.

Read the task brief:
E:\AI创新应用挑战赛\.worktrees\decision-arena\.superpowers\sdd\2026-09-10-decision-arena-implementation\task-11-brief.md

Work from E:\AI创新应用挑战赛\.worktrees\decision-arena on branch feature/decision-arena. Do not send progress-only messages; finish, test, commit, return final contract. Use escalated exec commands if sandbox helpers fail.

Context:
- Tasks 1-10 are complete. The command-room workspace, Decision Map, reducer, and shared SessionView exist.
- Implement Inspector, Timeline, Human Checkpoint, core checkpoint transition, Decision Replay, report page, and the human-decision POST route.
- The route must persist HumanDecision plus the resulting session phase/conclusion and append the appropriate ExecutionEvent transactionally or via a repository operation that makes this guarantee explicit. Replace the current 501 behavior.
- Timeline must restore map state at a selected sequence. Replay must reconstruct state from ExecutionEvents without mutating source events.
- Inspector must use the stable camelCase DTO from Task 7 and show `decisionRationale`.
- Preserve the frontend visual direction: command-room, readable at mobile/desktop, no generic admin cards, real button semantics and keyboard focus.
- Use focused TDD. Run web/core/db tests and typechecks plus Next production build.
- Create `docs/ai-history/0013-human-checkpoint.md` with real prompt, recommendation, corrections, RED/GREEN evidence, and commit title.
- Commit with the exact brief message. Do not dispatch subagents or touch unrelated files.
```

## AI Recommendation

- Implement `DecisionReplay` as a bounded event reducer over a defensive,
  sequence-sorted copy of the source stream. Rebuild phase, operational status,
  conclusion, claims, challenges, conflicts, and human decisions up to the
  selected sequence without mutating input events.
- Add `DecisionSessionRepository.recordHumanDecision()` as one database
  transaction. It updates the session transition, inserts `HumanDecision`, and
  appends `SESSION_STATE_CHANGED` with the new sequence and conclusion. A
  failure in any write rolls back all three.
- Replace the `501` route with an idempotent validated command. It derives the
  full persisted decision, calls `applyHumanDecision()`, and publishes the
  committed event to the existing EventBus.
- Keep the Inspector independent from SQL and Core internals. The component
  consumes the stable camelCase shape and makes
  `decisionRationale.summary` the primary explanation.
- Use the existing command-room visual system. Timeline entries are native
  buttons with `aria-current`, checkpoint actions are native buttons, and the
  mobile layout keeps the controls wrapping without horizontal clipping.
- Keep preview replay state deterministic for the fixed demo while the core
  replay class remains the durable event-stream implementation.

## Corrections Applied

1. The original brief's replay sketch only restored phase and appended entity
   payloads. The final implementation handles out-of-order input, entity
   updates, operational status, current conclusion, human decisions, and
   `SESSION_COMPLETED`, while preserving source event order.
2. Atomicity is explicit in `DecisionSessionRepository.recordHumanDecision()`
   rather than being split across route-level repository calls.
3. The `SESSION_STATE_CHANGED` payload carries the persisted human decision so
   the web reducer can project it without a separate event type.
4. `request_more_analysis` returns `REASSESSING` with `ACTIVE`; accepting or
   upholding the checkpoint returns `DECIDED` with `COMPLETED`.
5. The fixed demo Timeline restores its map state at the selected historical
   sequence, then retains the decision snapshot for the newly appended event.

## RED Evidence

The focused tests were created before the corresponding production modules:

```text
FAIL src/replay/decision-replay.test.ts
Failed to load url ./decision-replay

FAIL src/checkpoints/human-checkpoint.test.ts
Failed to load url ./human-checkpoint

FAIL components/inspector.test.tsx
Failed to resolve import ./inspector

FAIL components/timeline.test.tsx
Failed to resolve import ./timeline

FAIL components/human-checkpoint.test.tsx
Failed to resolve import ./human-checkpoint

FAIL src/api/routes/human-decisions.test.ts
expected 501 to be 201
expected 501 to be 400

FAIL src/repositories/decision-session-repository.integration.test.ts
repository.recordHumanDecision is not a function
```

## GREEN Evidence

Focused Task 11 tests:

```text
Core: 3 files passed, 7 tests passed
Web:  4 files passed, 8 tests passed
DB:   1 file passed, 2 tests passed
```

Full package tests:

```text
@nexus/core: 12 files passed, 48 tests passed
@nexus/web:   8 files passed, 17 tests passed
@nexus/db:    4 files passed,  6 tests passed
```

Typechecks:

```text
@nexus/core tsc --noEmit: no diagnostics
@nexus/db   tsc --noEmit: no diagnostics
@nexus/web  tsc --noEmit: no diagnostics
```

Production build:

```text
Next.js 15.2.4 compiled successfully
Routes:
  /
  /_not-found
  /sessions/[sessionId]
  /sessions/[sessionId]/report
```

## Commit Record

- Commit title: `feat(web): add replay inspector and human checkpoint`

## Task 11 Review Fix Round

### Ruling

`HUMAN_REVIEW -> DECIDED` is now a valid shared state-machine transition for
`accept_challenge` and `uphold_claim`. `request_more_analysis` continues to use
`HUMAN_REVIEW -> REASSESSING`.

### P1 Fixes

- `DecisionSessionRepository.recordHumanDecision()` now rejects sessions not in
  `HUMAN_REVIEW`.
- The repository verifies that `conflictId` belongs to the session and has
  `humanDecisionRequired = true`.
- The session update uses compare-and-set:
  `WHERE id = sessionId AND phase = HUMAN_REVIEW`. A concurrent second decision
  receives a deterministic `SessionNotInHumanReviewError`, mapped by the route
  to HTTP 409.
- `previousConclusion` is omitted from the request schema and loaded from the
  persisted `DecisionSession`.
- `ClaimInspectorDTO` now lives in `@nexus/shared`. The DB repository,
  API client, and Inspector component all consume that shared type.
- The preview workspace uses `toPreviewInspectorDTO()` as an explicitly named
  fixture. The live UUID session path fetches the session and calls the
  Inspector API.

### P2 Fixes

- UUID session IDs submit checkpoint actions through the durable POST endpoint.
- Preview sessions are marked `PREVIEW / NOT PERSISTED`, update only local UI
  state, and do not append synthetic durable events.
- Added route integration tests proving EventBus publication occurs after the
  transaction commits and publication failure does not corrupt persisted state.
- Added repository tests for non-review rejection, ineligible and cross-session
  conflicts, persisted previous-conclusion history, and one-winner concurrency.

### Review RED/GREEN Evidence

The new behavior was added with focused tests first for the state-machine
transition, route conflict mapping, repository compare-and-set, and Inspector
DTO contract.

Final verification:

```text
Shared: 3 files passed, 47 tests passed
Core:  13 files passed, 54 tests passed
Web:    9 files passed, 19 tests passed
DB:     4 files passed,  9 tests passed

All four package typechecks completed with no diagnostics.
Next.js 15.2.4 production build completed successfully.
```

## Review Commit Record

- Commit title: `fix(core): enforce human checkpoint invariants`