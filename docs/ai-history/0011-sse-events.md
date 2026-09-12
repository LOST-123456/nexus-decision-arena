# 0011 SSE Events and Persistent Idempotency

## Actual Task Prompt

```text
You are implementing Task 9: Stream Durable Events over SSE and wire real persistence.

Read the task brief:
E:\AI创新应用挑战赛\.worktrees\decision-arena\.superpowers\sdd\2026-09-10-decision-arena-implementation\task-9-brief.md

Work from E:\AI创新应用挑战赛\.worktrees\decision-arena on branch feature/decision-arena. Do not send progress-only messages and do not ask sandbox permission questions; use escalated exec commands directly if needed.

Requirements:
- Implement `EventBus`, SSE route, `?after=`/Last-Event-ID replay ordering, heartbeat, unsubscribe on close, and the required text/event-stream format.
- Replace temporary App/Server dependency seams with real `DecisionSessionRepository`, `EventRepository`, and `InspectorRepository` from `@nexus/db`.
- Add `@nexus/db` to Core dependencies now; Task 7 created it.
- Replace the in-memory production idempotency store with a PostgreSQL-backed adapter using `idempotency_keys` so same-key concurrent requests are deduplicated across processes where possible. If an operation is already processing, wait for completion with a bounded timeout; store failures as retryable and remove failed reservations.
- Keep `runSession.start` as an explicit integration placeholder only until Task 12; do not fake agent execution.
- Add focused tests for event ordering/replay and persistent idempotency. Run Docker PostgreSQL, @nexus/core tests, @nexus/db tests if touched, and typechecks.
- Create `docs/ai-history/0011-sse-events.md` with real prompt, recommendation, corrections, RED/GREEN output, and commit title.
- Commit with the exact task message from the brief. Do not touch UI or unrelated files.

Write full report to:
E:\AI创新应用挑战赛\.worktrees\decision-arena\.superpowers\sdd\2026-09-10-decision-arena-implementation\task-9-report.md

Return only Status, commit hash/subject, one-line test summary, concerns, report path.
```

## AI Recommendation

- Keep `EventBus` commit-aware: `publishAfterCommit()` awaits the repository
  append and only then notifies subscribers, so no SSE client sees an event
  before PostgreSQL accepts it.
- Register `GET /api/sessions/:id/events/stream` as a hijacked Fastify route.
  Resolve `after` from `?after=` first, then `Last-Event-ID`, replay persisted
  events in sequence order, then subscribe for live events. Emit SSE `id`,
  `event`, and JSON `data` fields, flush headers immediately, and keep the
  connection alive with a 15-second `: heartbeat` comment.
- Type `AppDependencies` with the real repository classes from `@nexus/db`;
  construct the production repositories and PostgreSQL idempotency adapter in
  `server.ts`. Keep `runSession.start` as a throwing Task 12 placeholder.
- Implement `PostgresIdempotencyStore` on top of `idempotency_keys` using an
  atomic insert reservation. Same-key callers wait for the reserved operation
  with a bounded timeout; a different request hash is a conflict; failed
  reservations are removed so the key can be retried.

## Corrections Applied

1. The first SSE test run exposed that Fastify did not flush response headers
   when replay was empty. The route now calls `reply.raw.flushHeaders()` after
   `writeHead`, allowing clients to receive `200 text/event-stream` before the
   first heartbeat.
2. The SSE test cleanup was tightened to stop the response body without waiting
   for the streaming request to finish, then close server connections during
   teardown. This prevents a successful route assertion from hanging the suite.
3. The persistent idempotency adapter initially left a failed row behind until a
   later retry. It now deletes the `processing` reservation immediately on
   failure, preserving retryability without leaving stale failed reservations.
4. Core now declares both `@nexus/db` and the direct `drizzle-orm` dependency
   used by the PostgreSQL adapter.

## Real RED Evidence

The event bus and SSE tests were added before the implementation:

```text
FAIL src/execution/event-bus.test.ts
Error: Failed to load url ./event-bus

FAIL src/api/routes/events.test.ts
Error: Failed to load url ../../execution/event-bus
```

The first SSE implementation run also produced a real RED failure because
headers were not flushed for an empty replay:

```text
FAIL src/api/routes/events.test.ts
Test timed out in 5000ms
```

The persistent idempotency integration test was added before the PostgreSQL
adapter existed:

```text
FAIL src/api/plugins/idempotency.integration.test.ts
TypeError: PostgresIdempotencyStore is not a constructor

Test Files  1 failed | 8 passed (9)
Tests       3 failed | 29 passed (32)
```

## GREEN Evidence

Focused event tests after adding header flushing:

```text
Test Files  8 passed (8)
Tests       29 passed (29)
```

Focused persistent idempotency and SSE tests:

```text
Test Files  9 passed (9)
Tests       32 passed (32)
```

Full Core suite with `DATABASE_URL` pointing at Docker PostgreSQL:

```bash
$env:DATABASE_URL='postgres://nexus:nexus@localhost:5432/nexus'
corepack pnpm --filter @nexus/core test
```

```text
Test Files  9 passed (9)
Tests       32 passed (32)
```

Existing PostgreSQL repository suite:

```text
Test Files  3 passed (3)
Tests       4 passed (4)
```

Typechecks:

```text
@nexus/core typecheck: tsc --noEmit with no diagnostics
@nexus/db typecheck: tsc --noEmit with no diagnostics
```

## Commit Record

- Commit title: `feat(core): stream replayable execution events`

## Task 9 Review Fixes

### High 1: Subscribe Before Replay

The SSE route now subscribes to `EventBus` before calling
`EventRepository.listAfter()`. Events published while replay is in flight are
buffered. When replay resolves, the route synchronously merges replay and
buffered events, deduplicates by sequence, writes them in ascending order, and
only then leaves replay mode. There is no `await` inside that final flush.

RED evidence for the controlled replay-time publication test:

```text
FAIL src/api/routes/events.test.ts > delivers an event published while replay is in flight
Test timed out in 5000ms
```

GREEN evidence:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

### Medium 3: Preserve Out-Of-Order Live Events

Live delivery now uses a per-subscription sequence buffer with a bounded
`SSE_REORDER_WINDOW` of 16 events. A higher sequence is held until the missing
lower sequence arrives, then both are emitted in order. If the buffer grows
past the window, the route recovers the range from `EventRepository.listAfter`
instead of discarding the event.

RED evidence for the focused out-of-order test:

```text
FAIL src/api/routes/events.test.ts > emits a lower live sequence after a higher one in order
Test timed out in 5000ms
```

GREEN evidence is included in the four passing SSE tests above.

### High 2: Reclaim Stale Idempotency Reservations

`PostgresIdempotencyStore` now has an explicit
`IDEMPOTENCY_STALE_PROCESSING_MS` threshold of five minutes. A request that
finds an old `processing` row performs an atomic conditional `UPDATE` that
matches only the same key, request hash, status, and an `updated_at` older than
the threshold. Exactly one caller can claim the stale reservation and execute
the operation. Hash mismatches still fail with
`IdempotencyConflictError` before reclaim is attempted.

RED evidence:

```text
FAIL src/api/plugins/idempotency.integration.test.ts > reclaims an old processing reservation and executes it
IdempotencyTimeoutError: Timed out waiting for the concurrent idempotent operation
```

GREEN evidence:

```text
Test Files  1 passed (1)
Tests       5 passed (5)
```

### Residual Exact-Once Limitation

Completion of the wrapped side effect and the `idempotency_keys` update are not
one shared transaction. If a process crashes after committing side effects but
before marking the reservation complete, stale reclaim can execute the
operation again. Eliminating that failure mode would require the operation to
participate in the same database transaction or an equivalent outbox protocol;
Task 9 does not couple agent/repository side effects into the idempotency
adapter.

### Review Verification

```text
Core: Test Files 9 passed (9), Tests 36 passed (36)
DB:   Test Files 3 passed (3), Tests 4 passed (4)
Core typecheck: tsc --noEmit with no diagnostics
DB typecheck:   tsc --noEmit with no diagnostics
```

### Review Fix Commit

- Commit title: `fix(core): close SSE replay and idempotency gaps`

## Task 9 Review Fixes Round 2

### SSE: Strict Sequence Cursor

The SSE route now subscribes, installs close/error cleanup, hijacks the
response, flushes headers, and starts the heartbeat before awaiting replay.
`expectedSequence` is the only cursor. Every replay or live event is placed in
a pending map and only events starting exactly at `expectedSequence` are
flushed. A sequence gap therefore holds all later events until the missing
sequence arrives.

When a gap remains, recovery calls `EventRepository.listAfter()` with bounded
exponential backoff (`SSE_RECOVERY_BASE_DELAY_MS = 25`,
`SSE_RECOVERY_MAX_DELAY_MS = 1_000`) and a single in-flight recovery guard.
There is no tight database loop and no event is discarded merely because a
higher sequence was observed first.

RED evidence:

```text
FAIL src/api/routes/events.test.ts > holds replay and live events until a sequence gap is filled
expected body to contain 'id: 1'

FAIL src/api/routes/events.test.ts > unsubscribes when the client disconnects during replay
expected +0 to be 1
```

GREEN evidence:

```text
Test Files  1 passed (1)
Tests       5 passed (5)
```

### Idempotency: Lease Tokens and Expiry

Migration `0003_idempotency_leases.sql` adds `lease_token` and
`lease_expires_at` to `idempotency_keys`. `PostgresIdempotencyStore` now:

- reserves processing rows with a generated owner token and lease expiry;
- reclaims only expired or legacy-null leases through an atomic conditional
  `UPDATE`;
- completes a reservation only when key, request hash, status, processing, and
  the exact lease token still match;
- deletes a failed reservation only when the exact lease token still owns it;
- throws `IdempotencyLeaseLostError` when an expired owner tries to complete
  after a newer reclaim.

The migration test now expects `0003_idempotency_leases.sql`.

RED evidence:

```text
FAIL src/api/plugins/idempotency.integration.test.ts > prevents an expired owner from completing after a newer reclaim
promise resolved "{ status: 'completed', response: { id: 'old-owner' } }" instead of rejecting
```

GREEN evidence:

```text
Test Files  1 passed (1)
Tests       7 passed (7)
```

### Exact-Once Limitation

The database lease prevents an old owner from overwriting a newer lease, but
the operation's side effects and the idempotency completion update are still
not one shared transaction. If a process dies after side effects commit but
before marking the lease complete, reclaim can still run the operation again.
True exactly-once behavior would require the operation itself to participate
in the database transaction or an equivalent outbox/transactional protocol.

### Round 2 Verification

```text
Core: Test Files 9 passed (9), Tests 39 passed (39)
DB:   Test Files 3 passed (3), Tests 4 passed (4)
Core typecheck: tsc --noEmit with no diagnostics
DB typecheck:   tsc --noEmit with no diagnostics
```

### Round 2 Commit

- Commit title: `fix(core): hold SSE gaps and lease idempotency`

## Task 9 Follow-Up Tests

### Deterministic SSE Recovery Backoff

The SSE route tests now use fake timers and a manually resolved recovery read.
The test proves the retry times are 25, 50, 100, 200, 400, 800, 1000, and
1000ms, that the delay is capped at 1000ms, and that recovery reads do not
overlap because no second read starts until the first is resolved.

### Expired Owner Failure Fencing

The PostgreSQL idempotency integration tests now cover failure cleanup after a
lease has been reclaimed. The old owner's operation rejects after the new owner
has claimed the row; the old owner's cleanup leaves the row `processing` with
the new owner's lease token and null response. The new owner then completes
successfully, proving the old owner could neither delete nor overwrite the
replacement reservation.

### Follow-Up Verification

```text
Focused: Test Files 2 passed (2), Tests 14 passed (14)
Core:    Test Files 9 passed (9), Tests 41 passed (41)
DB:      Test Files 3 passed (3), Tests 4 passed (4)
Core typecheck: tsc --noEmit with no diagnostics
DB typecheck:   tsc --noEmit with no diagnostics
```

### Follow-Up Commit

- Commit title: `test(core): cover sse recovery and lease fencing`
