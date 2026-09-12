# Final Fix Wave: Live Arena and Final Report

## Prompt

The final review identified one critical missing production path: `RunSessionService.start` and the server adapter both threw, so the browser could only show a fixed fixture and the persisted report endpoint did not exist. The requested fix wave required the real Mock Mode engine, browser SSE transport, persisted FinalReport, Claim invariants, inspector rationale links, demo minimums, and a compatible patched Next 15.x release.

## AI Recommendation

- Keep the browser fixture path explicitly labeled `DEMO FIXTURE`.
- Add a deterministic AgentRunner backed by `MockLlmProvider` and the existing fixtures.
- Run five Agents in parallel, persist AgentRun, Claim, Evidence, Challenge, Conflict, and state events, then stop at `HUMAN_REVIEW` when a conflict requires a human decision.
- Use a fresh Cross Examination dependency instance per session so deterministic fixture cursors cannot leak across runs.
- Move DecisionReplay into shared code so both Core tests and the live Web workspace use the same event reconstruction.
- Persist FinalReport with a `final_reports` table and generate it from the persisted session, human decision, conflicts, challenges, and evidence.
- Upgrade Next from `15.2.4` to the latest available 15.x backport, `15.5.25`, with Playwright `1.51.1` for peer compatibility.

## Implementation

- Added `DeterministicAgentRunner`, default roles, a memory store for offline execution, and a Factory-style live runtime in `services/core`.
- Replaced the throwing server adapter with mode selection: deterministic Mock Mode is the default; `LLM_MODE=openai-compatible` uses the configured OpenAI-compatible provider.
- Added `ArenaRepository` persistence for runs, claims, evidence, challenges, and conflicts.
- Added `FinalReport` schema, migration `0004_live_orchestration_and_reports.sql`, `FinalReportRepository`, and `GET /api/sessions/:id/report`.
- Added `GET /api/sessions/:id/events` and a CORS policy based on `WEB_ORIGIN`, including hijacked SSE response headers.
- Updated the live workspace to consume named SSE events, buffer sequence gaps through the reducer, load persisted event history, and use shared `DecisionReplay` for Timeline selection.
- Expanded the fixed demo to 3 opposing Claims, 5 structured Challenges, and 3 Conflicts, while preserving the final `有限立项` decision when replaying sequence 21.
- Added inspector rationale linkage for decisive challenge IDs and human decision IDs.
- Enforced accepted important Claim invariants against unresolved severity >=4 Challenges and limited supplement decisions to one round.

## Human Correction

The first live verification exposed two integration mistakes that unit tests alone did not catch: Cross Examination dependencies were reused across sessions and lost their fixture cursor, and nullable PostgreSQL row values needed explicit normalization before shared Zod parsing. Both were fixed and covered by live E2E and repository integration tests.

## Verification

- `corepack pnpm typecheck`: PASS.
- `corepack pnpm test`: PASS, 146 tests across Shared, DB, LLM, Core, and Web.
- `corepack pnpm --filter @nexus/web build`: PASS with Next.js 15.5.25.
- `corepack pnpm --filter @nexus/web test:e2e`: PASS, 4 Playwright tests covering desktop and mobile fixed-demo and live-session flows.
- `corepack pnpm test:stability`: PASS, 80/80 repeated Playwright runs in 185763ms.
- `corepack pnpm demo:fixture`: reaches `HUMAN_REVIEW` with 12 Claims, 9 opposing Claims, 5 Challenges, 4 Conflicts, and 36 events.

## Commit

Implementation and evidence commit: `c3d4dcc` (`fix: complete live arena flow and final report`).
