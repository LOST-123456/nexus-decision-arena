# 0007 Structured LLM Provider Pipeline

## Real User Prompt

```text
You are implementing Task 5: Add the Structured LLM Provider Pipeline.

Read this file first; it is your complete requirements and exact values:
E:\AI创新应用挑战赛\.worktrees\decision-arena\.superpowers\sdd\2026-09-10-decision-arena-implementation\task-5-brief.md

Context:
- Work from E:\AI创新应用挑战赛\.worktrees\decision-arena on branch feature/decision-arena.
- Tasks 1-4 are complete. `@nexus/shared` and `@nexus/core` exist. This task creates the isolated `@nexus/llm` package and must not import Core or DB.
- Global constraints: Node.js 22 target, pnpm 10.6.5, strict TypeScript, Mock provider is the default, real model access is explicit only, one repair attempt after invalid JSON/schema, 45-second call timeout, no secrets in logs, focused test-first development, independent commit.
- The brief's code must be followed in spirit, but ensure `JSON.parse` failures enter the same one-repair path as schema mismatch rather than escaping immediately.
- Include `withLlmTimeout(parent?)` as specified in the brief. Keep the OpenAI-compatible provider minimal and free of retry logic beyond the structured-output repair layer.
- Use `corepack pnpm`. Commit with the exact message from the brief.
- Before committing, create `docs/ai-history/0007-structured-llm.md` with the actual task Prompt, AI recommendation, human correction, RED command/output, GREEN command/output, and commit title.
- Do not dispatch subagents and do not modify unrelated files.

Write your full report to:
E:\AI创新应用挑战赛\.worktrees\decision-arena\.superpowers\sdd\2026-09-10-decision-arena-implementation\task-5-report.md

Return only: Status, commits (short SHA + subject), one-line test summary, concerns, report file path.
```

## AI Recommendation

Implement the `@nexus/llm` package in `lib/llm` with the provider contract,
`MockLlmProvider`, `OpenAiCompatibleProvider`, and `generateStructured<T>()`.
Keep the structured-output layer as the single repair point for both schema
mismatches and `JSON.parse` failures, and apply `withLlmTimeout()` around each
provider call so the 45-second timeout is enforced by the pipeline rather than
by the minimal OpenAI-compatible transport.

## Human Correction

The brief's repair request sets `schemaName` to `${schemaName}:repair`, but its
`MockLlmProvider` performs an exact handler lookup. Without a small fix the
repair tests would throw `No mock response for schema: verdict:repair` instead
of exercising the repair path. The mock provider now resolves a `:repair`
suffix back to the base schema handler.

The brief's "invalid JSON" repair fixture was valid JSON that failed schema
validation (`{"answer":"wrong"}`), so it did not cover the explicit
requirement that `JSON.parse` failures enter the same repair path. A focused
fourth test was added with malformed input (`not-json`), and it expects the
same one-repair behavior.

`withLlmTimeout(parent?)` was included exactly as specified, and wired into
`generateStructured` so each provider call receives a 45-second bounded signal.
The OpenAI-compatible provider remains free of retry logic; it only forwards
the supplied signal to `fetch`.

## Test Evidence

The repository pin was used through Corepack (`pnpm 10.6.5`). Node.js in the
runner was v24.14.0 rather than the requested Node.js 22.

### RED

Command:

```bash
corepack pnpm --filter @nexus/llm test
```

Actual output:

```text
No projects matched the filters in "E:\AI创新应用挑战赛\.worktrees\decision-arena"
```

### GREEN

Command:

```bash
corepack pnpm --filter @nexus/llm test
```

Actual output:

```text
> @nexus/llm@ test E:\AI创新应用挑战赛\.worktrees\decision-arena\lib\llm
> vitest run


 RUN  v3.0.8 E:/AI创新应用挑战赛/.worktrees/decision-arena/lib/llm

 ✓ src/structured-output.test.ts (4 tests) 6ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  12:21:32
   Duration  649ms (transform 65ms, setup 0ms, collect 125ms, tests 6ms, environment 0ms, prepare 257ms)
```

Typecheck:

```bash
corepack pnpm --filter @nexus/llm typecheck
```

Actual output:

```text
> @nexus/llm@ typecheck E:\AI创新应用挑战赛\.worktrees\decision-arena\lib\llm
> tsc --noEmit
```

## Commit Record

- Commit title: `feat(llm): add structured generation with repair`
