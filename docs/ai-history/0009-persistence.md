# 0009 Persistence

## Actual Task Prompt

```text
You are implementing Task 7: Persist the Decision Model in PostgreSQL.

Read the task brief first; it is your requirements:
E:\AI创新应用挑战赛\.worktrees\decision-arena\.superpowers\sdd\2026-09-10-decision-arena-implementation\task-7-brief.md

Work from E:\AI创新应用挑战赛\.worktrees\decision-arena on branch feature/decision-arena.

Environment and tooling:
- Docker Desktop is now running (`docker info` server version 29.7.2). Use `docker compose up -d postgres`.
- `DATABASE_URL` must be `postgres://nexus:nexus@localhost:5432/nexus` for tests.
- The sandbox helper may reject normal exec/apply_patch calls. If that happens, do not loop asking for permission. Use `exec_command` with `sandbox_permissions: "require_escalated"` directly; user approval is expected for this task.
- Use `corepack pnpm` to enforce pnpm 10.6.5.
- Do not dispatch subagents.

Scope:
- Create the `@nexus/db` package, Drizzle schema, migration runner, `0001_initial.sql`, and `0002_claim_inspector_view.sql`.
- Implement `DecisionSessionRepository`, `EventRepository`, and `InspectorRepository`.
- `DecisionSessionRepository.createWithProject()` must create Project and DecisionSession in one transaction.
- `EventRepository.append()` must allocate a per-session sequence using `UPDATE decision_sessions SET next_event_sequence = next_event_sequence + 1 ... RETURNING`, never `MAX(sequence)+1`.
- `InspectorRepository` must use a parameterized query and return the stable DTO shape from the brief. Do not interpolate IDs into SQL.
- The DB package must not import Core or LLM packages.
- Keep the migration runner executable via the package's `db:migrate` script.
- Run the real PostgreSQL integration tests, not mocks. Run DB typecheck. If schema/test code has a concrete defect, fix it and document the correction.
- Commit with the exact message in the brief.
- Create `docs/ai-history/0009-persistence.md` before committing, containing the actual task prompt, AI implementation recommendation, human plan ruling/environment correction, RED/GREEN commands and output, and commit title.

Write the full report to:
E:\AI创新应用挑战赛\.worktrees\decision-arena\.superpowers\sdd\2026-09-10-decision-arena-implementation\task-7-report.md

Return only: Status, commits (short SHA + subject), one-line test summary, concerns, report file path.
```

## AI Recommendation

Keep persistence as a leaf workspace package:

- `@nexus/db` imports only `@nexus/shared`, Drizzle ORM, and the PostgreSQL driver. It does not import Core or LLM.
- Store domain timestamps in PostgreSQL `timestamp with time zone` columns using Drizzle's string mode so persisted rows round-trip through the ISO-string contracts used by `@nexus/shared`.
- Put Project and DecisionSession creation in one Drizzle transaction.
- Allocate event sequence numbers by atomically incrementing `decision_sessions.next_event_sequence` and returning the updated value in the same transaction. The first allocated event therefore has sequence `1`.
- Fetch Inspector evidence, Challenges, and Conflicts through the `claim_inspector_view` using a Drizzle SQL template parameter for `claim_id`.
- Keep the migration runner small and executable through the package script `tsx src/migrate.ts`.

## Human Plan Ruling and Environment Correction

The task ruling fixed the database behavior at the repository boundary:

- Do not use `MAX(sequence) + 1`.
- Do not interpolate IDs into Inspector SQL.
- Create Project and DecisionSession atomically.
- Use the exact test URL `postgres://nexus:nexus@localhost:5432/nexus`.
- Use `corepack pnpm` and the task's exact commit message.

The local Docker daemon could not reach `registry-1.docker.io` directly because Docker Desktop had no HTTPS proxy configured. The required image was pulled through `docker.m.daocloud.io/library/postgres:16-alpine`, then tagged locally as `postgres:16-alpine`. The compose file remains exactly the brief's image reference: `postgres:16-alpine`.

## Real RED Evidence

The requested RED command was run before the package existed:

```bash
$env:DATABASE_URL='postgres://nexus:nexus@localhost:5432/nexus'
corepack pnpm --filter @nexus/db test
```

Actual output:

```text
No projects matched the filters in "E:\AI创新应用挑战赛\.worktrees\decision-arena"
```

This was the expected failure state: `@nexus/db` did not exist and no matching workspace project could run.

## Concrete Corrections Found During Implementation

The first DB typecheck found two issues in the implementation shape:

1. Inserting a shared `ExecutionEvent` directly into Drizzle retained `payload?: unknown`; the insert was changed to pass explicit column values.
2. The postgres-js result is a `RowList`, so the parameterized view result cast was made explicit through `unknown`.

A populated Inspector integration test then found two more concrete defects:

1. `database.execute(query)` inside the overridden client method called the override recursively. The client now captures Drizzle's original `execute` binding before replacing the public method, and delegates SQL objects to that captured function.
2. Integration files sharing one PostgreSQL database ran in parallel and truncated each other's fixtures. A package-local `vitest.config.ts` now sets `fileParallelism: false`, and test cleanup truncates `prompt_versions` as well as the original tables.

These corrections are implementation/test defects. No schema defect was found.

## GREEN Evidence

Migration application:

```bash
$env:DATABASE_URL='postgres://nexus:nexus@localhost:5432/nexus'
corepack pnpm --filter @nexus/db db:migrate
```

Actual output:

```text
applied 0001_initial.sql
applied 0002_claim_inspector_view.sql
```

Real PostgreSQL integration tests:

```bash
$env:DATABASE_URL='postgres://nexus:nexus@localhost:5432/nexus'
corepack pnpm --filter @nexus/db test
```

Actual result:

```text
✓ src/repositories/inspector-repository.integration.test.ts (2 tests)
✓ src/repositories/event-repository.integration.test.ts (1 test)

Test Files  2 passed (2)
Tests       3 passed (3)
```

DB typecheck:

```bash
corepack pnpm --filter @nexus/db typecheck
```

Actual result: `tsc --noEmit` completed with no diagnostics.

The tests cover:

- first event sequence `1` and second event sequence `2`;
- missing Claim returning `null`;
- populated Inspector DTO with Claim, Evidence, Challenge, Conflict, provenance, and decision rationale;
- transactional creation of Project and DecisionSession used by the populated Inspector fixture.

## Commit Record

- Commit title: `feat(db): persist decision sessions and inspector data`
