# 0010 REST API

## Actual Task Prompt

```text
You are implementing Task 8: Expose REST Commands with Idempotency.

Read this file first; it is your requirements:
E:\AI创新应用挑战赛\.worktrees\decision-arena\.superpowers\sdd\2026-09-10-decision-arena-implementation\task-8-brief.md

Work from E:\AI创新应用挑战赛\.worktrees\decision-arena on branch feature/decision-arena. Do not stop for progress messages; continue through tests, commit, report.

Context:
- Tasks 1-7 are complete. Shared schemas, Core deterministic/Cross Examination modules, LLM package, and DB repositories exist.
- Task 8 creates the Fastify app and REST routes. Core must NOT add `@nexus/db` yet; that dependency is added in Task 9 when real repository adapters are wired. The `server.ts` placeholder adapters from the brief are acceptable only in this task.
- Use the brief's exact `CreateSessionSchema`, response statuses, route paths, and commit message.
- `POST /api/sessions` uses `Idempotency-Key`, validates project input, and calls `sessions.createWithProject(project, session)`.
- `POST /api/sessions/:id/start` must call `runSession.start()` once for a given idempotency key.
- Inspector route returns 404 when missing.
- Add route/plugin tests before implementation. Run `corepack pnpm --filter @nexus/core test` and typecheck.
- Create `docs/ai-history/0010-rest-api.md` with real prompt, AI recommendation, corrections, RED/GREEN evidence, and commit title.
- Commit with the exact brief message.
```

## AI Recommendation

- Keep Core independent of `@nexus/db` by defining structural repository and
  service interfaces in `createApp`; Task 9 can then pass the real adapters
  without a package dependency in this task.
- Implement the brief's `InMemoryIdempotencyStore` unchanged, and hash the
  normalized operation and validated request so the same key cannot be reused
  for a different route request.
- Validate session creation with the exact `CreateSessionSchema`, create fresh
  project and session UUIDv7 IDs, and persist both through
  `sessions.createWithProject(project, session)`.
- Replay stored responses with the route's required status: `201` for session
  creation and `202` for start.
- Keep the Inspector route as a direct repository read returning `404` for a
  missing claim.
- Register the planned human-decision path as an explicit `501` placeholder in
  this task; Task 11 owns its transactional persistence behavior.
- Keep the brief's temporary `{} as never` adapters in `server.ts` until Task 9.

## Corrections Applied

- The Core manifest already contained the required Fastify and Zod
  dependencies, so no package manifest change was necessary.
- Added focused API coverage beyond the brief's sample for duplicate create and
  start requests, invalid project input, and the required missing-Inspector
  `404`.
- No `@nexus/db` import or dependency was added to Core.

## RED Evidence

Tests were added before the app and store implementation. The requested focused
command was:

```bash
corepack pnpm --filter @nexus/core test -- sessions.test.ts idempotency.test.ts
```

Actual failure:

```text
FAIL src/api/plugins/idempotency.test.ts
Error: Failed to load url ./idempotency

FAIL src/api/routes/sessions.test.ts
Error: Failed to load url ../../app

Test Files  2 failed | 4 passed (6)
Tests       15 passed (15)
```

## GREEN Evidence

Focused API tests after implementation:

```text
Test Files  6 passed (6)
Tests       20 passed (20)
```

Full Core suite:

```bash
corepack pnpm --filter @nexus/core test
```

```text
Test Files  6 passed (6)
Tests       20 passed (20)
```

Core typecheck:

```bash
corepack pnpm --filter @nexus/core typecheck
```

Result: `tsc --noEmit` completed with no diagnostics.

## Commit Record

- Commit title: `feat(core): expose idempotent session APIs`
