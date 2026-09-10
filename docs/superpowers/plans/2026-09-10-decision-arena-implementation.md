# Nexus Decision Arena Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible multi-agent decision challenge arena that runs a fixed campus innovation review from intake through human decision, replay, and report.

**Architecture:** A pnpm TypeScript monorepo contains a Next.js Decision Map, a Fastify core service, shared Zod domain schemas, an LLM provider abstraction with deterministic mock mode, and PostgreSQL persistence. Deterministic code owns selection, assignment, state transitions, conflict rules, and replay; the LLM only produces schema-validated domain objects.

**Tech Stack:** Node.js 22, pnpm 10, TypeScript 5.7, Zod 3.24, Fastify 5, PostgreSQL 16, Drizzle ORM, Next.js 15, React 19, XYFlow 12, Vitest 3, Playwright, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-10-decision-arena-design.md`

## Global Constraints

- Use Node.js 22 and pnpm 10; commit `pnpm-lock.yaml`.
- Enable TypeScript strict mode and `noUncheckedIndexedAccess`.
- Use UUIDv7 for every persisted domain object.
- Treat `ExecutionEvent` as the source of truth for state changes.
- Use REST for commands and SSE for server-to-client events.
- Keep five top-level agents: market analyst, technical expert, finance analyst, risk auditor, and review moderator.
- Keep every agent business rule outside UI components.
- Never mutate an accepted Claim in place; create a new revision.
- Limit each challenge round to five target Claims and two challengers per Claim.
- Use one timeout of 45 seconds and one Repair Prompt per LLM generation.
- Default to `MockLlmProvider`; real model access requires explicit environment configuration.
- Use PostgreSQL 16 and keep the Inspector API contract independent from SQL View details.
- Implement only `zh-CN` user-facing content while retaining the `locale` field.
- Add a focused automated test before each implementation step.
- Commit each task separately with the exact message in that task.
- Update `docs/ai-history/` before each feature commit with the real user Prompt, AI recommendation, human correction, test evidence, and eventual Commit Hash.
- Do not add a generic workflow editor, node marketplace, authentication system, or external search dependency.

---

## File Map

```text
package.json
pnpm-workspace.yaml
tsconfig.base.json
vitest.workspace.ts
.gitignore
.env.example
docker-compose.yml

packages/shared
  package.json
  tsconfig.json
  src/
    index.ts
    ids.ts
    domain/
      agent.ts
      claim.ts
      evidence.ts
      challenge.ts
      conflict.ts
      human-decision.ts
      event.ts
    workflow/
      state-machine.ts
      invariants.ts

lib/llm
  package.json
  tsconfig.json
  src/
    index.ts
    provider.ts
    mock-provider.ts
    structured-output.ts
    openai-compatible-provider.ts

lib/db
  package.json
  tsconfig.json
  drizzle.config.ts
  src/
    index.ts
    client.ts
    schema.ts
    repositories/
      decision-session-repository.ts
      inspector-repository.ts
      event-repository.ts
  migrations/
    0001_initial.sql
    0002_claim_inspector_view.sql

lib/observability
  package.json
  tsconfig.json
  src/
    index.ts
    logger.ts
    correlation.ts

services/core
  package.json
  tsconfig.json
  src/
    server.ts
    app.ts
    api/
      routes/
        sessions.ts
        inspector.ts
        human-decisions.ts
        events.ts
      plugins/
        idempotency.ts
    workflow/
      claim-selector.ts
      challenger-assigner.ts
      conflict-detector.ts
    arena/
      agent-runner.ts
      cross-examination.ts
      run-session.ts
    execution/
      event-bus.ts
      session-view.ts
    checkpoints/
      human-checkpoint.ts
    replay/
      decision-replay.ts

apps/web
  package.json
  tsconfig.json
  next.config.ts
  postcss.config.mjs
  app/
    globals.css
    layout.tsx
    page.tsx
    sessions/[sessionId]/page.tsx
  components/
    agent-panel.tsx
    decision-map.tsx
    inspector.tsx
    timeline.tsx
    human-checkpoint.tsx
  features/arena/
    api-client.ts
    map-adapter.ts
    event-reducer.ts
    session-query.ts

fixtures/
  lab-safety-project.json
  mock-analysis.json
  mock-challenges.json
  expected-final-report.json

docs/
  ai-history/
  architecture/
  decisions/
  experiments/
  user-guide/
```

---

## Milestone A: Deterministic Domain Kernel

### Task 1: Bootstrap the Workspace and Quality Gates

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Test: `packages/shared/src/index.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: workspace scripts `pnpm test`, `pnpm typecheck`, and `pnpm build`; package `@nexus/shared`.

- [ ] **Step 1: Write the failing smoke test**

Create `packages/shared/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { productName } from "./index";

describe("shared workspace", () => {
  it("exports the product name", () => {
    expect(productName).toBe("Nexus Decision Arena");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @nexus/shared test
```

Expected: FAIL because the workspace and `productName` do not exist.

- [ ] **Step 3: Create the workspace configuration**

Create `package.json`:

```json
{
  "name": "nexus-decision-arena",
  "private": true,
  "packageManager": "pnpm@10.6.5",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r --if-present build",
    "dev": "pnpm --parallel --filter @nexus/core --filter @nexus/web dev",
    "test": "pnpm -r --if-present test",
    "test:e2e": "pnpm --filter @nexus/web test:e2e",
    "typecheck": "pnpm -r --if-present typecheck"
  },
  "devDependencies": {
    "@types/node": "22.13.10",
    "tsx": "4.19.3",
    "typescript": "5.7.3",
    "vitest": "3.0.8"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "services/*"
  - "packages/*"
  - "lib/*"
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "esModuleInterop": true
  }
}
```

Create `vitest.workspace.ts`:

```ts
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*",
  "lib/*",
  "services/*",
  "apps/web"
]);
```

Create `.gitignore`:

```gitignore
node_modules/
.next/
dist/
coverage/
playwright-report/
test-results/
.env
.env.local
*.log
*.tsbuildinfo
.DS_Store
```

Create `.env.example`:

```dotenv
NODE_ENV=development
PORT=4100
WEB_ORIGIN=http://localhost:3000
DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus
LLM_MODE=mock
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=
LLM_MODEL=
DEMO_FIXTURE=lab-safety-project.json
```

Create `packages/shared/package.json`:

```json
{
  "name": "@nexus/shared",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "uuid": "11.0.5",
    "zod": "3.24.2"
  },
  "devDependencies": {
    "typescript": "5.7.3",
    "vitest": "3.0.8"
  }
}
```

Create `packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

Create `packages/shared/src/index.ts`:

```ts
export const productName = "Nexus Decision Arena";
```

- [ ] **Step 4: Install dependencies and verify the workspace**

Run:

```bash
pnpm install
pnpm test
pnpm typecheck
```

Expected: the shared smoke test passes and all current workspace packages typecheck.

- [ ] **Step 5: Record the AI evidence snapshot**

Create `docs/ai-history/0003-workspace-bootstrap.md` with the actual Prompt and AI recommendation used during this task, the failed test output, the passing test output, and commit title `chore: bootstrap pnpm workspace and quality gates`.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "chore: bootstrap pnpm workspace and quality gates"
```

### Task 2: Define the Decision Domain Schemas

**Files:**
- Create: `packages/shared/src/ids.ts`
- Create: `packages/shared/src/domain/agent.ts`
- Create: `packages/shared/src/domain/claim.ts`
- Create: `packages/shared/src/domain/evidence.ts`
- Create: `packages/shared/src/domain/challenge.ts`
- Create: `packages/shared/src/domain/conflict.ts`
- Create: `packages/shared/src/domain/human-decision.ts`
- Create: `packages/shared/src/domain/event.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/domain/domain.test.ts`

**Interfaces:**
- Consumes: `productName` and package dependencies from Task 1.
- Produces: `newId()`, `AgentRoleSchema`, `ClaimSchema`, `EvidenceSchema`, `ChallengeSchema`, `ConflictSchema`, `HumanDecisionSchema`, and `ExecutionEventSchema`.

- [ ] **Step 1: Write failing schema tests**

Create `packages/shared/src/domain/domain.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ChallengeSchema,
  ClaimSchema,
  ConflictSchema,
  EvidenceSchema,
  ExecutionEventSchema,
  newId
} from "../index";

describe("decision domain schemas", () => {
  it("accepts a valid Claim", () => {
    const id = newId();
    const claim = ClaimSchema.parse({
      id,
      sessionId: newId(),
      agentRunId: newId(),
      roleId: newId(),
      lens: "market-size",
      statement: "The two-year target is not supported by current evidence.",
      type: "assumption",
      stance: "oppose",
      importance: 5,
      confidence: 0.74,
      evidenceIds: [],
      status: "proposed",
      rootClaimId: id,
      revision: 1,
      relations: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    expect(claim.revision).toBe(1);
  });

  it("rejects confidence outside 0..1", () => {
    expect(() =>
      EvidenceSchema.parse({
        id: newId(),
        sessionId: newId(),
        claimId: newId(),
        kind: "calculation",
        title: "Invalid confidence",
        content: "invalid",
        description: "invalid",
        direction: "supports",
        reliability: 2,
        verificationStatus: "unverified",
        retrievedAt: new Date().toISOString(),
        createdBy: "agent"
      })
    ).toThrow();
  });

  it("requires an event correlation ID", () => {
    expect(() =>
      ExecutionEventSchema.parse({
        id: newId(),
        sessionId: newId(),
        sequence: 1,
        type: "SESSION_STATE_CHANGED",
        payload: {},
        occurredAt: new Date().toISOString()
      })
    ).toThrow();
  });

  it("accepts a high-severity challenge", () => {
    expect(
      ChallengeSchema.parse({
        id: newId(),
        sessionId: newId(),
        targetClaimId: newId(),
        challengerRunId: newId(),
        challengerRoleId: newId(),
        type: "evidence_gap",
        question: "Where is the source for 200 labs?",
        context: {
          triggerClaimIds: [newId()],
          explanation: "The growth target drives the revenue forecast."
        },
        requiredEvidence: ["Procurement pipeline"],
        severity: 5,
        resolutionStrategy: "provide_evidence",
        status: "open",
        correlationId: newId(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }).severity
    ).toBe(5);
  });

  it("rejects a conflict without a human requirement field", () => {
    expect(() =>
      ConflictSchema.parse({
        id: newId(),
        sessionId: newId(),
        claimIds: [newId(), newId()],
        challengeIds: [],
        type: "evidence",
        summary: "Conflicting growth assumptions",
        severity: 4,
        status: "detected",
        resolutionSuggestion: "Request procurement evidence",
        impactScope: {
          analysisAreas: ["market", "finance"],
          stakeholders: ["Project team"]
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
pnpm --filter @nexus/shared test -- domain.test.ts
```

Expected: FAIL because domain modules and schemas do not exist.

- [ ] **Step 3: Implement IDs and agent schema**

Create `packages/shared/src/ids.ts`:

```ts
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";

export const newId = (): string => uuidv7();
export const IdSchema = z.string().uuid();
export const TimestampSchema = z.string().datetime({ offset: true });
```

Create `packages/shared/src/domain/agent.ts`:

```ts
import { z } from "zod";
import { IdSchema } from "../ids";

export const AgentRoleKeySchema = z.enum([
  "market_analyst",
  "technical_expert",
  "finance_analyst",
  "risk_auditor",
  "review_moderator"
]);

export const AgentRoleSchema = z.object({
  id: IdSchema,
  key: AgentRoleKeySchema,
  name: z.string().min(1),
  goal: z.string().min(1),
  perspective: z.string().min(1),
  evaluationCriteria: z.array(z.string().min(1)).min(1),
  evidenceRequired: z.array(z.string().min(1)).min(1),
  conflictPreference: z.array(z.string().min(1)).min(1),
  lenses: z.array(z.string().min(1)).min(1),
  promptVersionId: IdSchema
});

export type AgentRoleKey = z.infer<typeof AgentRoleKeySchema>;
export type AgentRole = z.infer<typeof AgentRoleSchema>;
```

- [ ] **Step 4: Implement Claim and Evidence schemas**

Create `packages/shared/src/domain/claim.ts`:

```ts
import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const ClaimTypeSchema = z.enum([
  "fact",
  "assumption",
  "prediction",
  "recommendation"
]);
export const ClaimStanceSchema = z.enum(["support", "oppose", "neutral"]);
export const ClaimStatusSchema = z.enum([
  "proposed",
  "supported",
  "contested",
  "accepted",
  "rejected"
]);
export const ClaimRelationSchema = z.object({
  targetClaimId: IdSchema,
  type: z.enum(["supports", "contradicts", "qualifies", "depends_on"])
});

export const ClaimSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  agentRunId: IdSchema,
  roleId: IdSchema,
  lens: z.string().min(1),
  statement: z.string().min(1),
  type: ClaimTypeSchema,
  stance: ClaimStanceSchema,
  importance: z.number().int().min(1).max(5),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(IdSchema),
  status: ClaimStatusSchema,
  rootClaimId: IdSchema,
  revisionOfClaimId: IdSchema.optional(),
  revision: z.number().int().positive(),
  relations: z.array(ClaimRelationSchema),
  respondsToChallengeId: IdSchema.optional(),
  disposition: z
    .enum(["accept", "reject", "qualify", "insufficient_evidence"])
    .optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});

export type Claim = z.infer<typeof ClaimSchema>;
export type ClaimType = z.infer<typeof ClaimTypeSchema>;
```

Create `packages/shared/src/domain/evidence.ts`:

```ts
import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const EvidenceSchema = z
  .object({
    id: IdSchema,
    sessionId: IdSchema,
    claimId: IdSchema,
    kind: z.enum([
      "project_input",
      "calculation",
      "external_reference",
      "assumption"
    ]),
    title: z.string().min(1),
    content: z.string().min(1),
    description: z.string().min(1),
    sourceRef: z.string().url().optional(),
    direction: z.enum(["supports", "opposes"]),
    reliability: z.number().min(0).max(1),
    verificationStatus: z.enum(["unverified", "verified", "rejected"]),
    validityPeriod: z
      .object({
        from: TimestampSchema.optional(),
        to: TimestampSchema.optional()
      })
      .optional(),
    retrievedAt: TimestampSchema,
    createdBy: z.enum(["system", "agent", "human"]),
    agentRunId: IdSchema.optional()
  })
  .superRefine((value, context) => {
    if (value.kind === "external_reference" && !value.sourceRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceRef"],
        message: "External references require a source"
      });
    }

    if (
      value.kind === "assumption" &&
      value.verificationStatus === "verified"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verificationStatus"],
        message: "Assumptions cannot be verified"
      });
    }
  });

export type Evidence = z.infer<typeof EvidenceSchema>;
```

- [ ] **Step 5: Implement Challenge, Conflict, HumanDecision, and ExecutionEvent schemas**

Create `packages/shared/src/domain/challenge.ts`:

```ts
import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const ChallengeSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  targetClaimId: IdSchema,
  challengerRunId: IdSchema,
  challengerRoleId: IdSchema,
  type: z.enum([
    "evidence_gap",
    "logic_flaw",
    "contradiction",
    "feasibility",
    "priority"
  ]),
  question: z.string().min(1),
  context: z.object({
    triggerClaimIds: z.array(IdSchema),
    explanation: z.string().min(1)
  }),
  requiredEvidence: z.array(z.string().min(1)).min(1),
  severity: z.number().int().min(1).max(5),
  resolutionStrategy: z.enum([
    "provide_evidence",
    "revise_claim",
    "withdraw_claim",
    "human_decision"
  ]),
  status: z.enum([
    "open",
    "answered",
    "validating",
    "resolved",
    "unresolved"
  ]),
  responseClaimId: IdSchema.optional(),
  correlationId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});

export type Challenge = z.infer<typeof ChallengeSchema>;
```

Create `packages/shared/src/domain/conflict.ts`:

```ts
import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const ConflictSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  claimIds: z.array(IdSchema).min(1),
  challengeIds: z.array(IdSchema),
  type: z.enum(["evidence", "logic", "assumption", "priority"]),
  summary: z.string().min(1),
  severity: z.number().int().min(1).max(5),
  status: z.enum(["detected", "human_review", "resolved"]),
  humanDecisionRequired: z.boolean(),
  resolutionSuggestion: z.string().min(1),
  impactScope: z.object({
    analysisAreas: z.array(
      z.enum(["market", "technology", "finance", "risk", "operations"])
    ),
    stakeholders: z.array(z.string())
  }),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});

export type Conflict = z.infer<typeof ConflictSchema>;
```

Create `packages/shared/src/domain/human-decision.ts`:

```ts
import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const HumanDecisionSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  conflictId: IdSchema,
  action: z.enum([
    "accept_challenge",
    "uphold_claim",
    "request_more_analysis"
  ]),
  rationale: z.string().min(1),
  affectedClaimIds: z.array(IdSchema),
  affectedAgentRoleIds: z.array(IdSchema),
  previousConclusion: z.string().min(1),
  newConclusion: z.string().min(1),
  operatorId: z.string().min(1),
  createdAt: TimestampSchema
});

export type HumanDecision = z.infer<typeof HumanDecisionSchema>;
```

Create `packages/shared/src/domain/event.ts`:

```ts
import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const ExecutionEventTypeSchema = z.enum([
  "SESSION_STATE_CHANGED",
  "AGENT_RUN_STARTED",
  "AGENT_RUN_COMPLETED",
  "CLAIM_CREATED",
  "CHALLENGE_CREATED",
  "CHALLENGE_RESOLVED",
  "CONFLICT_DETECTED",
  "HUMAN_REVIEW_REQUIRED",
  "AGENT_RUN_FAILED",
  "CHALLENGE_FAILED",
  "SESSION_COMPLETED"
]);

export const ExecutionEventSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  sequence: z.number().int().positive(),
  correlationId: IdSchema,
  traceId: z.string().min(1).optional(),
  type: ExecutionEventTypeSchema,
  payload: z.unknown(),
  occurredAt: TimestampSchema,
  promptVersionId: IdSchema.optional()
});

export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;
```

- [ ] **Step 6: Export the schemas**

Modify `packages/shared/src/index.ts`:

```ts
export const productName = "Nexus Decision Arena";

export * from "./ids";
export * from "./domain/agent";
export * from "./domain/claim";
export * from "./domain/evidence";
export * from "./domain/challenge";
export * from "./domain/conflict";
export * from "./domain/human-decision";
export * from "./domain/event";
```

- [ ] **Step 7: Run schema tests and typecheck**

Run:

```bash
pnpm --filter @nexus/shared test
pnpm --filter @nexus/shared typecheck
```

Expected: all schema tests pass and TypeScript reports no errors.

- [ ] **Step 8: Record the first golden AI case**

Create `docs/ai-history/0004-decision-schema.md` containing:

- the original user request to define Claim, Evidence, Challenge, and Conflict
- the AI recommendation to use UUIDv7, immutable Claim versions, typed relations, and validity periods
- the user correction to add `correlationId` and structured decision rationale
- the failing schema test output
- the passing schema test output
- commit title `feat(shared): add validated decision domain schemas`

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "feat(shared): add validated decision domain schemas"
```

### Task 3: Enforce Claim Invariants and Session Transitions

**Files:**
- Create: `packages/shared/src/workflow/invariants.ts`
- Create: `packages/shared/src/workflow/state-machine.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/workflow/workflow.test.ts`

**Interfaces:**
- Consumes: `Claim`, `Evidence`, `SessionPhase` values from Task 2.
- Produces: `assertClaimInvariants(claim, evidence): void`, `canTransition(from, to): boolean`, and `transitionSession(phase, next): SessionPhase`.

- [ ] **Step 1: Write failing invariant and transition tests**

Create `packages/shared/src/workflow/workflow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ClaimSchema,
  canTransition,
  newId,
  transitionSession
} from "../index";

const baseClaim = () => {
  const id = newId();
  return ClaimSchema.parse({
    id,
    sessionId: newId(),
    agentRunId: newId(),
    roleId: newId(),
    lens: "market-size",
    statement: "The market is large.",
    type: "assumption",
    stance: "support",
    importance: 5,
    confidence: 0.5,
    evidenceIds: [],
    status: "proposed",
    rootClaimId: id,
    revision: 1,
    relations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
};

describe("claim invariants", () => {
  it("rejects a root Claim with revision greater than one", () => {
    const claim = baseClaim();
    expect(() =>
      assertClaimInvariants({ ...claim, revision: 2 }, [])
    ).toThrow("Root claim revision must be 1");
  });

  it("rejects an accepted important Claim without verified evidence", () => {
    const claim = baseClaim();
    expect(() =>
      assertClaimInvariants({ ...claim, status: "accepted" }, [])
    ).toThrow("Accepted important claims require verified evidence");
  });

  it("rejects a revision without a predecessor", () => {
    const claim = baseClaim();
    expect(() =>
      assertClaimInvariants({ ...claim, revision: 2 }, [])
    ).toThrow("A revision must reference its predecessor");
  });
});

describe("session transitions", () => {
  it("allows the frozen happy path", () => {
    expect(canTransition("PLANNING", "ANALYZING")).toBe(true);
    expect(canTransition("ANALYZING", "CHALLENGING")).toBe(true);
    expect(canTransition("HUMAN_REVIEW", "REASSESSING")).toBe(true);
    expect(canTransition("DECIDED", "REPORT_READY")).toBe(true);
  });

  it("rejects skipping the analysis phase", () => {
    expect(canTransition("CREATED", "CHALLENGING")).toBe(false);
    expect(() => transitionSession("CREATED", "CHALLENGING")).toThrow(
      "Invalid session transition: CREATED -> CHALLENGING"
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @nexus/shared test -- workflow.test.ts
```

Expected: FAIL because invariant and transition functions do not exist.

- [ ] **Step 3: Implement Claim invariants**

Create `packages/shared/src/workflow/invariants.ts`:

```ts
import type { Claim, Evidence } from "../index";

export function assertClaimInvariants(
  claim: Claim,
  evidence: Evidence[]
): void {
  if (claim.rootClaimId === claim.id && claim.revision !== 1) {
    throw new Error("Root claim revision must be 1");
  }

  if (claim.rootClaimId !== claim.id && claim.revision <= 1) {
    throw new Error("A revision must have revision greater than 1");
  }

  if (claim.revision > 1 && !claim.revisionOfClaimId) {
    throw new Error("A revision must reference its predecessor");
  }

  if (
    claim.status === "accepted" &&
    claim.importance >= 4 &&
    !evidence.some(
      (item) =>
        item.claimId === claim.id &&
        item.verificationStatus === "verified"
    )
  ) {
    throw new Error(
      "Accepted important claims require verified evidence"
    );
  }

  const ids = new Set(claim.evidenceIds);
  if (evidence.some((item) => !ids.has(item.id))) {
    throw new Error("Evidence references must be declared on the claim");
  }
}
```

- [ ] **Step 4: Implement the session state machine**

Create `packages/shared/src/workflow/state-machine.ts`:

```ts
export const SESSION_PHASES = [
  "CREATED",
  "PLANNING",
  "ANALYZING",
  "CHALLENGING",
  "CONFLICT_DETECTED",
  "HUMAN_REVIEW",
  "REASSESSING",
  "DECIDED",
  "REPORT_READY"
] as const;

export type SessionPhase = (typeof SESSION_PHASES)[number];

const transitions: Record<SessionPhase, readonly SessionPhase[]> = {
  CREATED: ["PLANNING"],
  PLANNING: ["ANALYZING"],
  ANALYZING: ["CHALLENGING"],
  CHALLENGING: ["CONFLICT_DETECTED", "DECIDED"],
  CONFLICT_DETECTED: ["HUMAN_REVIEW", "DECIDED"],
  HUMAN_REVIEW: ["REASSESSING"],
  REASSESSING: ["CHALLENGING", "DECIDED"],
  DECIDED: ["REPORT_READY"],
  REPORT_READY: []
};

export function canTransition(
  from: SessionPhase,
  to: SessionPhase
): boolean {
  return transitions[from].includes(to);
}

export function transitionSession(
  from: SessionPhase,
  to: SessionPhase
): SessionPhase {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid session transition: ${from} -> ${to}`);
  }
  return to;
}
```

- [ ] **Step 5: Export workflow APIs**

Append to `packages/shared/src/index.ts`:

```ts
export * from "./workflow/invariants";
export * from "./workflow/state-machine";
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
pnpm --filter @nexus/shared test
pnpm --filter @nexus/shared typecheck
```

Expected: all workflow tests pass.

- [ ] **Step 7: Record AI evidence**

Create `docs/ai-history/0005-state-machine.md` with the actual Prompt used to constrain the state machine, the AI recommendation, test failure, fix, and passing output.

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "feat(shared): enforce decision workflow invariants"
```

### Task 4: Implement Claim Selection and Challenger Assignment

**Files:**
- Create: `services/core/package.json`
- Create: `services/core/tsconfig.json`
- Create: `services/core/src/workflow/claim-selector.ts`
- Create: `services/core/src/workflow/challenger-assigner.ts`
- Create: `services/core/src/workflow/conflict-detector.ts`
- Test: `services/core/src/workflow/workflow.test.ts`

**Interfaces:**
- Consumes: `Claim`, `AgentRole`, `AgentRoleKey`, `Challenge`, `Conflict`, and `newId()` from `@nexus/shared`.
- Produces: `selectClaims(claims, limit): Claim[]`, `assignChallengers(claim, roles, limit): AgentRole[]`, and `detectConflicts(input): Conflict[]`.

- [ ] **Step 1: Create the core package scaffold**

Create `services/core/package.json`:

```json
{
  "name": "@nexus/core",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@nexus/shared": "workspace:*",
    "fastify": "5.2.1",
    "zod": "3.24.2"
  },
  "devDependencies": {
    "tsx": "4.19.3",
    "typescript": "5.7.3",
    "vitest": "3.0.8"
  }
}
```

Create `services/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 2: Write failing pure-rule tests**

Create `services/core/src/workflow/workflow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AgentRoleSchema,
  newId,
  type Claim
} from "@nexus/shared";
import { assignChallengers } from "./challenger-assigner";
import { selectClaims } from "./claim-selector";

const claim = (
  statement: string,
  importance: number,
  confidence: number,
  evidenceCount: number,
  type: Claim["type"] = "assumption"
): Claim => {
  const id = newId();
  return {
    id,
    sessionId: newId(),
    agentRunId: newId(),
    roleId: newId(),
    lens: "market",
    statement,
    type,
    stance: "support",
    importance: importance as Claim["importance"],
    confidence,
    evidenceIds: Array.from({ length: evidenceCount }, () => newId()),
    status: "proposed",
    rootClaimId: id,
    revision: 1,
    relations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
};

describe("claim selection", () => {
  it("prioritizes importance, evidence gaps, and lower confidence", () => {
    const highEvidence = claim("well supported", 5, 0.9, 3, "fact");
    const weakAssumption = claim("weak assumption", 5, 0.4, 0, "assumption");
    const lowerImportance = claim("secondary", 4, 0.2, 0, "assumption");

    expect(
      selectClaims([highEvidence, lowerImportance, weakAssumption], 2).map(
        (item) => item.id
      )
    ).toEqual([weakAssumption.id, lowerImportance.id]);
  });
});

describe("challenger assignment", () => {
  it("assigns different roles deterministically", () => {
    const marketId = newId();
    const roles = [
      AgentRoleSchema.parse({
        id: marketId,
        key: "market_analyst",
        name: "Market Analyst",
        goal: "Validate demand",
        perspective: "Market evidence",
        evaluationCriteria: ["evidence"],
        evidenceRequired: ["source"],
        conflictPreference: ["evidence_gap"],
        lenses: ["market"],
        promptVersionId: newId()
      }),
      AgentRoleSchema.parse({
        id: newId(),
        key: "finance_analyst",
        name: "Finance Analyst",
        goal: "Validate economics",
        perspective: "Unit economics",
        evaluationCriteria: ["assumption"],
        evidenceRequired: ["model"],
        conflictPreference: ["assumption"],
        lenses: ["finance"],
        promptVersionId: newId()
      })
    ];
    const result = assignChallengers(
      { ...claim("market claim", 5, 0.4, 0), roleId: marketId },
      roles,
      1
    );

    expect(result[0]?.key).toBe("finance_analyst");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm --filter @nexus/core test -- workflow.test.ts
```

Expected: FAIL because the pure rule modules do not exist.

- [ ] **Step 4: Implement deterministic Claim selection**

Create `services/core/src/workflow/claim-selector.ts`:

```ts
import type { Claim } from "@nexus/shared";

const typeRank: Record<Claim["type"], number> = {
  assumption: 0,
  prediction: 1,
  recommendation: 2,
  fact: 3
};

export function selectClaims(claims: Claim[], limit = 5): Claim[] {
  return [...claims]
    .sort((left, right) => {
      if (left.importance !== right.importance) {
        return right.importance - left.importance;
      }
      if (left.evidenceIds.length !== right.evidenceIds.length) {
        return left.evidenceIds.length - right.evidenceIds.length;
      }
      if (left.confidence !== right.confidence) {
        return left.confidence - right.confidence;
      }
      if (typeRank[left.type] !== typeRank[right.type]) {
        return typeRank[left.type] - typeRank[right.type];
      }
      return left.id.localeCompare(right.id);
    })
    .slice(0, limit);
}
```

- [ ] **Step 5: Implement challenger assignment**

Create `services/core/src/workflow/challenger-assigner.ts`:

```ts
import type { AgentRole, AgentRoleKey, Claim } from "@nexus/shared";

const preferredChallenger: Record<Claim["type"], AgentRoleKey[]> = {
  fact: ["risk_auditor", "review_moderator"],
  assumption: [
    "finance_analyst",
    "risk_auditor",
    "market_analyst",
    "technical_expert"
  ],
  prediction: [
    "market_analyst",
    "technical_expert",
    "finance_analyst",
    "risk_auditor"
  ],
  recommendation: [
    "risk_auditor",
    "review_moderator",
    "finance_analyst",
    "technical_expert"
  ]
};

export function assignChallengers(
  claim: Claim,
  roles: AgentRole[],
  limit = 2
): AgentRole[] {
  const preferred = preferredChallenger[claim.type];
  return roles
    .filter((role) => role.id !== claim.roleId)
    .sort((left, right) => {
      const leftRank = preferred.indexOf(left.key);
      const rightRank = preferred.indexOf(right.key);
      const normalizedLeft = leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank;
      const normalizedRight =
        rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank;
      return normalizedLeft - normalizedRight || left.id.localeCompare(right.id);
    })
    .slice(0, limit);
}
```

- [ ] **Step 6: Implement initial conflict rules**

Create `services/core/src/workflow/conflict-detector.ts`:

```ts
import {
  ConflictSchema,
  newId,
  type Challenge,
  type Claim,
  type Conflict
} from "@nexus/shared";

type ConflictInput = {
  sessionId: string;
  claims: Claim[];
  challenges: Challenge[];
};

export function detectConflicts(input: ConflictInput): Conflict[] {
  const conflicts: Conflict[] = [];
  const claimById = new Map(input.claims.map((claim) => [claim.id, claim]));

  for (const claim of input.claims) {
    for (const relation of claim.relations) {
      const target = claimById.get(relation.targetClaimId);
      if (relation.type !== "contradicts" || !target) {
        continue;
      }

      const id = newId();
      conflicts.push(
        ConflictSchema.parse({
          id,
          sessionId: input.sessionId,
          claimIds: [claim.id, target.id],
          challengeIds: [],
          type: "logic",
          summary: `${claim.statement} conflicts with ${target.statement}`,
          severity: 4,
          status: "detected",
          humanDecisionRequired: true,
          resolutionSuggestion: "Review both claims and request evidence.",
          impactScope: {
            analysisAreas: ["market", "finance"],
            stakeholders: ["Project team"]
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })
      );
    }
  }

  for (const challenge of input.challenges) {
    if (challenge.status !== "unresolved" || challenge.severity < 4) {
      continue;
    }
    const target = claimById.get(challenge.targetClaimId);
    const id = newId();
    conflicts.push(
      ConflictSchema.parse({
        id,
        sessionId: input.sessionId,
        claimIds: target ? [target.id] : [challenge.targetClaimId],
        challengeIds: [challenge.id],
        type: "evidence",
        summary: challenge.question,
        severity: challenge.severity,
        status: "detected",
        humanDecisionRequired: true,
        resolutionSuggestion: `Provide: ${challenge.requiredEvidence.join(", ")}`,
        impactScope: {
          analysisAreas: ["market"],
          stakeholders: ["Project team"]
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
    );
  }

  return conflicts;
}
```

- [ ] **Step 7: Run tests and typecheck**

Run:

```bash
pnpm --filter @nexus/core test
pnpm --filter @nexus/core typecheck
```

Expected: selection, assignment, and conflict tests pass.

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "feat(core): add deterministic claim challenge rules"
```

### Task 5: Add the Structured LLM Provider Pipeline

**Files:**
- Create: `lib/llm/package.json`
- Create: `lib/llm/tsconfig.json`
- Create: `lib/llm/src/index.ts`
- Create: `lib/llm/src/provider.ts`
- Create: `lib/llm/src/mock-provider.ts`
- Create: `lib/llm/src/structured-output.ts`
- Create: `lib/llm/src/openai-compatible-provider.ts`
- Test: `lib/llm/src/structured-output.test.ts`

**Interfaces:**
- Consumes: `ExecutionEvent`-safe `correlationId` and shared Zod schemas.
- Produces: `LlmProvider`, `LlmRequest`, `StructuredGeneration`, `MockLlmProvider`, `OpenAiCompatibleProvider`, and `generateStructured<T>()`.

- [ ] **Step 1: Write failing structured-output tests**

Create `lib/llm/src/structured-output.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MockLlmProvider } from "./mock-provider";
import { generateStructured } from "./structured-output";

const ResultSchema = z.object({ answer: z.number().int() });

describe("structured generation", () => {
  it("parses a valid provider response", async () => {
    const provider = new MockLlmProvider({
      verdict: () => JSON.stringify({ answer: 42 })
    });

    const result = await generateStructured(
      provider,
      {
        schemaName: "verdict",
        system: "Return JSON.",
        user: "Answer.",
        correlationId: "correlation-1"
      },
      ResultSchema,
      new AbortController().signal
    );

    expect(result.data.answer).toBe(42);
    expect(result.repaired).toBe(false);
  });

  it("uses one repair prompt after invalid JSON", async () => {
    const next = vi
      .fn()
      .mockResolvedValueOnce('{"answer":"wrong"}')
      .mockResolvedValueOnce('{"answer":42}');
    const provider = new MockLlmProvider({ verdict: next });

    const result = await generateStructured(
      provider,
      {
        schemaName: "verdict",
        system: "Return JSON.",
        user: "Answer.",
        correlationId: "correlation-2"
      },
      ResultSchema,
      new AbortController().signal
    );

    expect(result.data.answer).toBe(42);
    expect(result.repaired).toBe(true);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("fails clearly after the repair attempt", async () => {
    const provider = new MockLlmProvider({
      verdict: () => '{"answer":"still-wrong"}'
    });

    await expect(
      generateStructured(
        provider,
        {
          schemaName: "verdict",
          system: "Return JSON.",
          user: "Answer.",
          correlationId: "correlation-3"
        },
        ResultSchema,
        new AbortController().signal
      )
    ).rejects.toThrow("Structured output validation failed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @nexus/llm test
```

Expected: FAIL because the LLM package does not exist.

- [ ] **Step 3: Create the LLM package**

Create `lib/llm/package.json`:

```json
{
  "name": "@nexus/llm",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@nexus/shared": "workspace:*",
    "zod": "3.24.2"
  },
  "devDependencies": {
    "typescript": "5.7.3",
    "vitest": "3.0.8"
  }
}
```

Create `lib/llm/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Implement the provider contract and mock provider**

Create `lib/llm/src/provider.ts`:

```ts
export type LlmRequest = {
  schemaName: string;
  system: string;
  user: string;
  correlationId: string;
};

export interface LlmProvider {
  generate(request: LlmRequest, signal: AbortSignal): Promise<string>;
}

export function withLlmTimeout(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(45_000);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
```

Create `lib/llm/src/mock-provider.ts`:

```ts
import type { LlmProvider, LlmRequest } from "./provider";

type MockHandler = (request: LlmRequest) => string | Promise<string>;

export class MockLlmProvider implements LlmProvider {
  constructor(private readonly handlers: Record<string, MockHandler>) {}

  async generate(
    request: LlmRequest,
    signal: AbortSignal
  ): Promise<string> {
    if (signal.aborted) {
      throw new DOMException("Generation aborted", "AbortError");
    }

    const handler = this.handlers[request.schemaName];
    if (!handler) {
      throw new Error(`No mock response for schema: ${request.schemaName}`);
    }

    return handler(request);
  }
}
```

- [ ] **Step 5: Implement structured parsing and repair**

Create `lib/llm/src/structured-output.ts`:

```ts
import type { ZodType } from "zod";
import type { LlmProvider, LlmRequest } from "./provider";

export type StructuredGeneration<T> = {
  data: T;
  repaired: boolean;
  raw: string;
};

type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; message: string };

function validateJson<T>(schema: ZodType<T>, raw: string): ValidationResult<T> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = schema.safeParse(parsed);
    return result.success
      ? { success: true, data: result.data }
      : { success: false, message: result.error.message };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Invalid JSON"
    };
  }
}

export async function generateStructured<T>(
  provider: LlmProvider,
  request: LlmRequest,
  schema: ZodType<T>,
  signal: AbortSignal
): Promise<StructuredGeneration<T>> {
  const raw = await provider.generate(request, signal);
  const first = validateJson(schema, raw);
  if (first.success) {
    return { data: first.data, repaired: false, raw };
  }

  const repairRequest: LlmRequest = {
    ...request,
    schemaName: `${request.schemaName}:repair`,
    user: [
      request.user,
      "The first response failed schema validation.",
      `Validation error: ${first.message}`,
      `Invalid response: ${raw}`,
      "Return only corrected JSON."
    ].join("\n")
  };

  const repairedRaw = await provider.generate(repairRequest, signal);
  const repaired = validateJson(schema, repairedRaw);
  if (!repaired.success) {
    throw new Error(
      `Structured output validation failed: ${repaired.message}`
    );
  }

  return {
    data: repaired.data,
    repaired: true,
    raw: repairedRaw
  };
}
```

- [ ] **Step 6: Implement the OpenAI-compatible provider**

Create `lib/llm/src/openai-compatible-provider.ts`:

```ts
import type { LlmProvider, LlmRequest } from "./provider";

type OpenAiCompatibleOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
};

export class OpenAiCompatibleProvider implements LlmProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(
    request: LlmRequest,
    signal: AbortSignal
  ): Promise<string> {
    const response = await this.fetchImpl(
      `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          "x-correlation-id": request.correlationId
        },
        body: JSON.stringify({
          model: this.options.model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user }
          ]
        })
      }
    );

    if (!response.ok) {
      throw new Error(`LLM request failed with status ${response.status}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("LLM response did not contain message content");
    }
    return content;
  }
}
```

- [ ] **Step 7: Export the LLM package**

Create `lib/llm/src/index.ts`:

```ts
export * from "./provider";
export * from "./mock-provider";
export * from "./structured-output";
export * from "./openai-compatible-provider";
```

- [ ] **Step 8: Run tests and typecheck**

Run:

```bash
pnpm --filter @nexus/llm test
pnpm --filter @nexus/llm typecheck
```

Expected: valid output, repair, and terminal failure tests pass.

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "feat(llm): add structured generation with repair"
```

### Task 6: Orchestrate Multi-Agent Analysis and Cross Examination

**Files:**
- Create: `services/core/src/arena/agent-runner.ts`
- Create: `services/core/src/arena/cross-examination.ts`
- Create: `services/core/src/arena/run-session.ts`
- Create: `packages/shared/src/execution/session-view.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `services/core/package.json`
- Test: `services/core/src/arena/cross-examination.test.ts`

**Interfaces:**
- Consumes: `selectClaims()`, `assignChallengers()`, `detectConflicts()`, `generateStructured()`, and shared schemas.
- Produces: `AgentRunner`, `CrossExaminationService.run(input)`, `RunSessionService.start(sessionId)`, and `SessionView`.

- [ ] **Step 1: Extend the core dependencies**

Modify `services/core/package.json` dependencies:

```json
{
  "dependencies": {
    "@nexus/db": "workspace:*",
    "@nexus/llm": "workspace:*",
    "@nexus/shared": "workspace:*",
    "fastify": "5.2.1",
    "zod": "3.24.2"
  }
}
```

- [ ] **Step 2: Write a failing cross-examination integration test**

Create `services/core/src/arena/cross-examination.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AgentRoleSchema,
  newId,
  type AgentRole,
  type Challenge,
  type Claim,
  type Conflict
} from "@nexus/shared";
import {
  CrossExaminationService,
  type CrossExaminationInput
} from "./cross-examination";

const role = (key: AgentRole["key"], id = newId()): AgentRole =>
  AgentRoleSchema.parse({
    id,
    key,
    name: key,
    goal: "Review",
    perspective: "Evidence",
    evaluationCriteria: ["evidence"],
    evidenceRequired: ["source"],
    conflictPreference: ["evidence_gap"],
    lenses: [key],
    promptVersionId: newId()
  });

const claim = (roleId: string, importance = 5): Claim => {
  const id = newId();
  return {
    id,
    sessionId: "session-1",
    agentRunId: newId(),
    roleId,
    lens: "test",
    statement: "Unsupported target",
    type: "assumption",
    stance: "support",
    importance: importance as Claim["importance"],
    confidence: 0.4,
    evidenceIds: [],
    status: "proposed",
    rootClaimId: id,
    revision: 1,
    relations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
};

describe("cross examination service", () => {
  it("creates, answers, resolves, and converts a challenge to conflict", async () => {
    const market = role("market_analyst");
    const finance = role("finance_analyst");
    const moderator = role("review_moderator");
    const target = claim(market.id);
    const emitted: string[] = [];

    const service = new CrossExaminationService({
      generateChallenge: async () => ({
        type: "evidence_gap",
        question: "Where is the procurement evidence?",
        context: {
          triggerClaimIds: [target.id],
          explanation: "The revenue target depends on procurement."
        },
        requiredEvidence: ["Signed procurement pipeline"],
        severity: 5,
        resolutionStrategy: "provide_evidence"
      }),
      respondToChallenge: async (challenge: Challenge) => ({
        ...target,
        id: newId(),
        revision: 2,
        revisionOfClaimId: target.id,
        respondsToChallengeId: challenge.id,
        disposition: "insufficient_evidence",
        updatedAt: new Date().toISOString()
      }),
      evaluateResponse: async () => "unresolved"
    });

    const result = await service.run({
      sessionId: "session-1",
      claims: [target],
      roles: [market, finance, moderator],
      emit: (event) => emitted.push(event.type as string)
    });

    expect(result.challenges[0]?.status).toBe("unresolved");
    expect(result.conflicts).toHaveLength(1);
    expect(emitted).toContain("CHALLENGE_CREATED");
    expect(emitted).toContain("CONFLICT_DETECTED");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:

```bash
pnpm --filter @nexus/core test -- cross-examination.test.ts
```

Expected: FAIL because the orchestration service does not exist.

- [ ] **Step 4: Implement the AgentRunner contract and session view**

Create `services/core/src/arena/agent-runner.ts`:

```ts
import type {
  AgentRole,
  Claim,
  Evidence,
  HumanDecision
} from "@nexus/shared";

export type AgentAnalysis = {
  claims: Claim[];
  evidence: Evidence[];
};

export interface AgentRunner {
  run(role: AgentRole, projectInput: unknown): Promise<AgentAnalysis>;
}
```

Create `packages/shared/src/execution/session-view.ts`:

```ts
import type { AgentRole } from "../domain/agent";
import type { Challenge } from "../domain/challenge";
import type { Claim } from "../domain/claim";
import type { Conflict } from "../domain/conflict";
import type { Evidence } from "../domain/evidence";
import type { HumanDecision } from "../domain/human-decision";
import type { SessionPhase } from "../workflow/state-machine";

export type SessionView = {
  sessionId: string;
  phase: SessionPhase;
  operationalStatus: "ACTIVE" | "PAUSED" | "FAILED" | "COMPLETED";
  agents: AgentRole[];
  claims: Claim[];
  evidence: Evidence[];
  challenges: Challenge[];
  conflicts: Conflict[];
  humanDecisions: HumanDecision[];
  currentConclusion: string | null;
};
```

Append to `packages/shared/src/index.ts`:

```ts
export * from "./execution/session-view";
```

- [ ] **Step 5: Implement CrossExaminationService**

Create `services/core/src/arena/cross-examination.ts`:

```ts
import {
  ChallengeSchema,
  newId,
  type AgentRole,
  type Challenge,
  type Claim,
  type Conflict,
  type ExecutionEvent
} from "@nexus/shared";
import { selectClaims } from "../workflow/claim-selector";
import { assignChallengers } from "../workflow/challenger-assigner";
import { detectConflicts } from "../workflow/conflict-detector";

export type CrossExaminationInput = {
  sessionId: string;
  claims: Claim[];
  roles: AgentRole[];
  emit: (event: Partial<ExecutionEvent> & { type: ExecutionEvent["type"] }) => void;
};

export type ChallengeDraft = Pick<
  Challenge,
  | "type"
  | "question"
  | "context"
  | "requiredEvidence"
  | "severity"
  | "resolutionStrategy"
>;

export type CrossExaminationResult = {
  challenges: Challenge[];
  responseClaims: Claim[];
  conflicts: Conflict[];
};

type CrossExaminationDependencies = {
  generateChallenge: (
    challenger: AgentRole,
    target: Claim
  ) => Promise<ChallengeDraft>;
  respondToChallenge: (
    challenge: Challenge,
    target: Claim
  ) => Promise<Claim>;
  evaluateResponse: (
    challenge: Challenge,
    responseClaim: Claim
  ) => Promise<"resolved" | "unresolved">;
};

export class CrossExaminationService {
  constructor(private readonly dependencies: CrossExaminationDependencies) {}

  async run(input: CrossExaminationInput): Promise<CrossExaminationResult> {
    const challenges: Challenge[] = [];
    const responseClaims: Claim[] = [];
    const selected = selectClaims(input.claims, 5);

    for (const target of selected) {
      const challengers = assignChallengers(target, input.roles, 2);
      for (const challenger of challengers) {
        const correlationId = newId();
        try {
          const draft = await this.dependencies.generateChallenge(
            challenger,
            target
          );
          const now = new Date().toISOString();
          const challenge = ChallengeSchema.parse({
            id: newId(),
            sessionId: input.sessionId,
            targetClaimId: target.id,
            challengerRunId: newId(),
            challengerRoleId: challenger.id,
            ...draft,
            status: "open",
            correlationId,
            createdAt: now,
            updatedAt: now
          });
          challenges.push(challenge);
          input.emit({
            type: "CHALLENGE_CREATED",
            payload: challenge,
            correlationId: challenge.correlationId
          });

          const response = await this.dependencies.respondToChallenge(
            challenge,
            target
          );
          responseClaims.push(response);
          challenge.status = "answered";
          challenge.responseClaimId = response.id;
          challenge.status = await this.dependencies.evaluateResponse(
            challenge,
            response
          );
          challenge.updatedAt = new Date().toISOString();
          input.emit({
            type: "CHALLENGE_RESOLVED",
            payload: challenge,
            correlationId: challenge.correlationId
          });
        } catch (error) {
          input.emit({
            type: "CHALLENGE_FAILED",
            payload: {
              targetClaimId: target.id,
              challengerRoleId: challenger.id,
              message:
                error instanceof Error
                  ? error.message
                  : "Unknown challenge failure"
            },
            correlationId
          });
        }
      }
    }

    const conflicts = detectConflicts({
      sessionId: input.sessionId,
      claims: [...input.claims, ...responseClaims],
      challenges
    });

    for (const conflict of conflicts) {
      input.emit({
        type: "CONFLICT_DETECTED",
        payload: conflict,
        correlationId: newId()
      });
    }

    return { challenges, responseClaims, conflicts };
  }
}
```

- [ ] **Step 6: Implement RunSessionService stage boundaries**

Create `services/core/src/arena/run-session.ts`:

```ts
import type { AgentRunner } from "./agent-runner";

export class RunSessionService {
  constructor(private readonly agentRunner: AgentRunner) {}

  async runAnalysis(
    roles: Parameters<AgentRunner["run"]>[0][],
    projectInput: unknown
  ) {
    const settled = await Promise.allSettled(
      roles.map((role) => this.agentRunner.run(role, projectInput))
    );

    return {
      analyses: settled
        .filter(
          (
            result
          ): result is PromiseFulfilledResult<
            Awaited<ReturnType<AgentRunner["run"]>>
          > => result.status === "fulfilled"
        )
        .map((result) => result.value),
      failures: settled
        .map((result, index) => ({ result, role: roles[index] }))
        .filter(
          (
            item
          ): item is {
            result: PromiseRejectedResult;
            role: (typeof roles)[number];
          } => item.result.status === "rejected"
        )
    };
  }
}
```

- [ ] **Step 7: Run tests and typecheck**

Run:

```bash
pnpm --filter @nexus/core test
pnpm --filter @nexus/core typecheck
```

Expected: the cross-examination flow emits challenge and conflict events, preserves the original Claim, and saves a revision. RunSessionService must emit `AGENT_RUN_FAILED` for each rejected Agent and continue with fulfilled analyses.

- [ ] **Step 8: Record the concurrency baseline**

Create `docs/ai-history/0006-concurrency-baseline.md` with:

- the actual Prompt requesting parallel Agent analysis
- the AI recommendation to use `Promise.allSettled`
- the first concurrent-execution test output
- any real race or state-loss failure observed during implementation
- the human correction and final passing output

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "feat(core): orchestrate cross examination flow"
```


---

## Milestone B: Persistence, REST, and Replayable Events

### Task 7: Persist the Decision Model in PostgreSQL

**Files:**
- Create: `lib/db/package.json`
- Create: `lib/db/tsconfig.json`
- Create: `lib/db/drizzle.config.ts`
- Create: `lib/db/src/schema.ts`
- Create: `lib/db/src/client.ts`
- Create: `lib/db/src/index.ts`
- Create: `lib/db/src/migrate.ts`
- Create: `lib/db/src/repositories/decision-session-repository.ts`
- Create: `lib/db/src/repositories/inspector-repository.ts`
- Create: `lib/db/src/repositories/event-repository.ts`
- Create: `lib/db/migrations/0001_initial.sql`
- Create: `lib/db/migrations/0002_claim_inspector_view.sql`
- Create: `docker-compose.yml`
- Test: `lib/db/src/repositories/event-repository.integration.test.ts`
- Test: `lib/db/src/repositories/inspector-repository.integration.test.ts`

**Interfaces:**
- Consumes: all persisted schemas from `@nexus/shared`.
- Produces: `createDatabase(url)`, `DecisionSessionRepository`, `EventRepository`, and `InspectorRepository`.

- [ ] **Step 1: Write failing repository integration tests**

Create `lib/db/src/repositories/event-repository.integration.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { createDatabase, type Database } from "../client";
import { DecisionSessionRepository } from "./decision-session-repository";
import { EventRepository } from "./event-repository";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const database: Database = createDatabase(databaseUrl);
const sessions = new DecisionSessionRepository(database);
const events = new EventRepository(database);

beforeEach(async () => {
  await database.execute("TRUNCATE idempotency_keys, execution_events, projects CASCADE");
});

afterAll(async () => {
  await database.end();
});

describe("event repository", () => {
  it("allocates an increasing sequence per session", async () => {
    const projectId = newId();
    const sessionId = newId();
    await database.execute(
      `INSERT INTO projects (id, name, input) VALUES ('${projectId}', 'Demo', '{}'::jsonb)`
    );
    await sessions.create({
      id: sessionId,
      projectId,
      locale: "zh-CN",
      phase: "CREATED",
      operationalStatus: "ACTIVE",
      currentConclusion: null
    });

    const first = await events.append({
      sessionId,
      correlationId: newId(),
      type: "SESSION_STATE_CHANGED",
      payload: { phase: "PLANNING" }
    });
    const second = await events.append({
      sessionId,
      correlationId: first.correlationId,
      type: "SESSION_STATE_CHANGED",
      payload: { phase: "ANALYZING" }
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
  });
});
```

Create `lib/db/src/repositories/inspector-repository.integration.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { createDatabase, type Database } from "../client";
import { InspectorRepository } from "./inspector-repository";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const database: Database = createDatabase(databaseUrl);
const repository = new InspectorRepository(database);

beforeEach(async () => {
  await database.execute(
    "TRUNCATE idempotency_keys, execution_events, projects CASCADE"
  );
});

afterAll(async () => {
  await database.end();
});

describe("inspector repository", () => {
  it("returns null for a missing claim", async () => {
    const result = await repository.getInspector(newId(), newId());
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Start PostgreSQL and run tests to verify they fail**

Create `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: nexus
      POSTGRES_PASSWORD: nexus
      POSTGRES_DB: nexus
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U nexus -d nexus"]
      interval: 2s
      timeout: 2s
      retries: 20
```

Run:

```bash
docker compose up -d postgres
$env:DATABASE_URL="postgres://nexus:nexus@localhost:5432/nexus"
pnpm --filter @nexus/db test
```

Expected: FAIL because `@nexus/db` and the repositories do not exist.

- [ ] **Step 3: Create the database package**

Create `lib/db/package.json`:

```json
{
  "name": "@nexus/db",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "scripts": {
    "db:up": "docker compose up -d postgres",
    "db:down": "docker compose down",
    "db:migrate": "tsx src/migrate.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@nexus/shared": "workspace:*",
    "drizzle-orm": "0.40.1",
    "postgres": "3.4.5"
  },
  "devDependencies": {
    "drizzle-kit": "0.30.5",
    "tsx": "4.19.3",
    "typescript": "5.7.3",
    "vitest": "3.0.8"
  }
}
```

Create `lib/db/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*.ts", "drizzle.config.ts"]
}
```

Create `lib/db/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://nexus:nexus@localhost:5432/nexus"
  }
});
```

- [ ] **Step 4: Implement the Drizzle schema**

Create `lib/db/src/schema.ts` with tables `projects`, `decision_sessions`, `agent_roles`, `agent_runs`, `claims`, `evidence`, `challenges`, `conflicts`, `human_decisions`, `prompt_versions`, `execution_events`, and `idempotency_keys`.

The schema must include these required behaviors:

```ts
export const claims = pgTable("claims", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull(),
  agentRunId: uuid("agent_run_id").notNull(),
  roleId: uuid("role_id").notNull(),
  lens: text("lens").notNull(),
  statement: text("statement").notNull(),
  type: text("type").notNull(),
  stance: text("stance").notNull(),
  importance: integer("importance").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  evidenceIds: jsonb("evidence_ids").notNull(),
  status: text("status").notNull(),
  rootClaimId: uuid("root_claim_id").notNull(),
  revisionOfClaimId: uuid("revision_of_claim_id"),
  revision: integer("revision").notNull(),
  relations: jsonb("relations").notNull(),
  respondsToChallengeId: uuid("responds_to_challenge_id"),
  disposition: text("disposition"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const executionEvents = pgTable(
  "execution_events",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id").notNull(),
    sequence: integer("sequence").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    traceId: text("trace_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    promptVersionId: uuid("prompt_version_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    sessionSequence: uniqueIndex("execution_events_session_sequence_idx").on(
      table.sessionId,
      table.sequence
    )
  })
);
```

Use `references()` for foreign keys, `boolean()` for `human_decision_required`, and `jsonb()` for multi-value fields.

- [ ] **Step 5: Add migrations and the Inspector view**

Create `lib/db/migrations/0001_initial.sql` by running:

```bash
pnpm --filter @nexus/db exec drizzle-kit generate
```

Create `lib/db/migrations/0002_claim_inspector_view.sql`:

```sql
CREATE OR REPLACE VIEW claim_inspector_view AS
SELECT
  c.id AS claim_id,
  to_jsonb(c) AS claim,
  COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(e) ORDER BY e.reliability DESC)
      FROM evidence e
      WHERE e.claim_id = c.id
    ),
    '[]'::jsonb
  ) AS evidence,
  COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(ch) ORDER BY ch.created_at)
      FROM challenges ch
      WHERE ch.target_claim_id = c.id
         OR ch.response_claim_id = c.id
    ),
    '[]'::jsonb
  ) AS challenges,
  COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(cf) ORDER BY cf.severity DESC)
      FROM conflicts cf
      WHERE cf.claim_ids ? c.id::text
    ),
    '[]'::jsonb
  ) AS conflicts
FROM claims c;
```

- [ ] **Step 6: Implement the database client and session repository**

Create `lib/db/src/client.ts`:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDatabase(url: string) {
  const client = postgres(url, { max: 10 });
  return Object.assign(drizzle(client, { schema }), {
    end: () => client.end(),
    execute: (query: string) => client.unsafe(query)
  });
}

export type Database = ReturnType<typeof createDatabase>;
```

Create `lib/db/src/repositories/decision-session-repository.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { decisionSessions, projects } from "../schema";

type ProjectInput = {
  name: string;
  summary: string;
  targetUsers: string;
  businessModel: string;
  expectedData: string;
};

type SessionInput = {
  id: string;
  projectId: string;
  locale: string;
  phase: string;
  operationalStatus: string;
  currentConclusion: string | null;
};

export class DecisionSessionRepository {
  constructor(private readonly database: Database) {}

  async createWithProject(project: ProjectInput, session: SessionInput) {
    return this.database.transaction(async (transaction) => {
      await transaction.insert(projects).values({
        id: session.projectId,
        name: project.name,
        input: project,
        locale: session.locale
      });
      const [created] = await transaction
        .insert(decisionSessions)
        .values(session)
        .returning();
      return created ?? null;
    });
  }

  async create(input: SessionInput) {
    const [created] = await this.database
      .insert(decisionSessions)
      .values(input)
      .returning();
    return created ?? null;
  }

  async getById(id: string) {
    const [session] = await this.database
      .select()
      .from(decisionSessions)
      .where(eq(decisionSessions.id, id))
      .limit(1);
    return session ?? null;
  }
}
```

- [ ] **Step 7: Implement the race-safe event repository**

Create `lib/db/src/repositories/event-repository.ts`:

```ts
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { newId, type ExecutionEvent } from "@nexus/shared";
import type { Database } from "../client";
import { decisionSessions, executionEvents } from "../schema";

type AppendEventInput = Pick<
  ExecutionEvent,
  "sessionId" | "correlationId" | "type" | "payload"
> &
  Partial<Pick<ExecutionEvent, "traceId" | "promptVersionId">>;

export class EventRepository {
  constructor(private readonly database: Database) {}

  async append(input: AppendEventInput): Promise<ExecutionEvent> {
    return this.database.transaction(async (transaction) => {
      const [sequenceRow] = await transaction
        .update(decisionSessions)
        .set({
          nextEventSequence: sql`${decisionSessions.nextEventSequence} + 1`
        })
        .where(eq(decisionSessions.id, input.sessionId))
        .returning({ sequence: decisionSessions.nextEventSequence });

      if (!sequenceRow) {
        throw new Error(`Session not found: ${input.sessionId}`);
      }

      const event: ExecutionEvent = {
        id: newId(),
        sessionId: input.sessionId,
        sequence: sequenceRow.sequence - 1,
        correlationId: input.correlationId,
        ...(input.traceId ? { traceId: input.traceId } : {}),
        type: input.type,
        payload: input.payload,
        occurredAt: new Date().toISOString(),
        ...(input.promptVersionId
          ? { promptVersionId: input.promptVersionId }
          : {})
      };

      await transaction.insert(executionEvents).values(event);
      return event;
    });
  }

  async listAfter(sessionId: string, sequence: number) {
    return this.database
      .select()
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.sessionId, sessionId),
          gt(executionEvents.sequence, sequence)
        )
      )
      .orderBy(asc(executionEvents.sequence));
  }
}
```

The `UPDATE decision_sessions SET next_event_sequence = next_event_sequence + 1 ... RETURNING` step is the concurrency boundary. Do not replace it with `MAX(sequence) + 1`, because two concurrent Agent completions could receive the same sequence.

- [ ] **Step 8: Implement the Inspector repository**

Create `lib/db/src/repositories/inspector-repository.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { agentRuns, claims, promptVersions } from "../schema";

export class InspectorRepository {
  constructor(private readonly database: Database) {}

  async getInspector(sessionId: string, claimId: string) {
    const [claim] = await this.database
      .select()
      .from(claims)
      .where(eq(claims.id, claimId))
      .limit(1);

    if (!claim || claim.sessionId !== sessionId) {
      return null;
    }

    const viewRows = (await this.database.execute(
      sql`SELECT * FROM claim_inspector_view WHERE claim_id = ${claimId}`
    )) as Array<{
      claim: unknown;
      evidence: unknown[];
      challenges: unknown[];
      conflicts: unknown[];
    }>;
    const [view] = viewRows;

    const [agentRun] = await this.database
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, claim.agentRunId))
      .limit(1);

    const [promptVersion] = agentRun
      ? await this.database
          .select()
          .from(promptVersions)
          .where(eq(promptVersions.id, agentRun.promptVersionId))
          .limit(1)
      : [];

    return {
      claim,
      evidence: view?.evidence ?? [],
      challenges: view?.challenges ?? [],
      conflicts: view?.conflicts ?? [],
      provenance: { agentRun, promptVersion },
      decisionRationale: {
        outcome:
          claim.status === "accepted"
            ? "accepted"
            : claim.status === "rejected"
              ? "rejected"
              : claim.status === "contested"
                ? "contested"
                : "needs_human",
        summary:
          claim.status === "accepted"
            ? "该 Claim 已通过证据与质询审查。"
            : "该 Claim 仍需补充证据或由人工复核。",
        decisiveChallengeIds: [],
        evidenceIds: claim.evidenceIds
      }
    };
  }
}
```

- [ ] **Step 9: Export the database package and migrate**

Create `lib/db/src/migrate.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase } from "./client";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://nexus:nexus@localhost:5432/nexus"
);
const migrationDirectory = resolve("migrations");
const files = (await readdir(migrationDirectory))
  .filter((file) => file.endsWith(".sql"))
  .sort();

for (const file of files) {
  const statement = await readFile(resolve(migrationDirectory, file), "utf8");
  await database.execute(statement);
  console.log(`applied ${file}`);
}

await database.end();
```

Create `lib/db/src/index.ts`:

```ts
export * from "./client";
export * from "./schema";
export * from "./repositories/decision-session-repository";
export * from "./repositories/event-repository";
export * from "./repositories/inspector-repository";
```

Run:

```bash
$env:DATABASE_URL="postgres://nexus:nexus@localhost:5432/nexus"
psql $env:DATABASE_URL -f lib/db/migrations/0001_initial.sql
psql $env:DATABASE_URL -f lib/db/migrations/0002_claim_inspector_view.sql
pnpm --filter @nexus/db test
pnpm --filter @nexus/db typecheck
```

Expected: both integration tests pass, including the first-event sequence of 1 and the second-event sequence of 2.

- [ ] **Step 10: Commit**

```bash
git add .
git commit -m "feat(db): persist decision sessions and inspector data"
```

### Task 8: Expose REST Commands with Idempotency

**Files:**
- Create: `services/core/src/api/plugins/idempotency.ts`
- Create: `services/core/src/api/routes/sessions.ts`
- Create: `services/core/src/api/routes/inspector.ts`
- Create: `services/core/src/api/routes/human-decisions.ts`
- Create: `services/core/src/app.ts`
- Create: `services/core/src/server.ts`
- Modify: `services/core/package.json`
- Test: `services/core/src/api/routes/sessions.test.ts`
- Test: `services/core/src/api/plugins/idempotency.test.ts`

**Interfaces:**
- Consumes: `DecisionSessionRepository`, `InspectorRepository`, `EventRepository`, and `RunSessionService`.
- Produces: `createApp(dependencies)`, REST routes, and idempotent write behavior.

- [ ] **Step 1: Write failing API tests**

Create `services/core/src/api/routes/sessions.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { newId } from "@nexus/shared";
import { createApp } from "../../app";

describe("session routes", () => {
  it("creates and starts a session once", async () => {
    const sessionId = newId();
    const sessions = {
      createWithProject: vi.fn().mockResolvedValue({ id: sessionId }),
      getById: vi.fn().mockResolvedValue({ id: sessionId })
    };
    const start = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      sessions: sessions as never,
      inspector: {} as never,
      events: {} as never,
      runSession: { start } as never
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "idempotency-key": "create-1" },
      payload: {
        project: {
          name: "Lab Safety",
          summary: "AI inventory platform",
          targetUsers: "University labs",
          businessModel: "Annual subscription",
          expectedData: "200 labs in 24 months"
        },
        locale: "zh-CN"
      }
    });
    expect(created.statusCode).toBe(201);

    const started = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/start`,
      headers: { "idempotency-key": "start-1" }
    });
    expect(started.statusCode).toBe(202);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
```

Create `services/core/src/api/plugins/idempotency.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore } from "./idempotency";

describe("idempotency store", () => {
  it("returns the stored result for the same key and request hash", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.save("key-1", "hash-1", { id: "session-1" });

    await expect(store.get("key-1", "hash-1")).resolves.toEqual({
      status: "completed",
      response: { id: "session-1" }
    });
  });

  it("rejects reusing a key for a different request", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.save("key-1", "hash-1", { id: "session-1" });

    await expect(store.get("key-1", "hash-2")).rejects.toThrow(
      "Idempotency key reused with a different request"
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @nexus/core test -- sessions.test.ts idempotency.test.ts
```

Expected: FAIL because the REST app and store do not exist.

- [ ] **Step 3: Implement the idempotency store**

Create `services/core/src/api/plugins/idempotency.ts`:

```ts
import { createHash } from "node:crypto";

type StoredResult = {
  status: "completed";
  response: unknown;
};

export class InMemoryIdempotencyStore {
  private readonly values = new Map<
    string,
    { requestHash: string; result: StoredResult }
  >();

  async get(key: string, requestHash: string): Promise<StoredResult | null> {
    const value = this.values.get(key);
    if (!value) {
      return null;
    }
    if (value.requestHash !== requestHash) {
      throw new Error("Idempotency key reused with a different request");
    }
    return value.result;
  }

  async save(
    key: string,
    requestHash: string,
    response: unknown
  ): Promise<void> {
    this.values.set(key, {
      requestHash,
      result: { status: "completed", response }
    });
  }

  static hash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }
}
```

- [ ] **Step 4: Implement app dependencies and session routes**

Create `services/core/src/app.ts` with a typed `AppDependencies` object and `createApp(dependencies, idempotency)`.

The create-session route must validate:

```ts
const CreateSessionSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    summary: z.string().min(1),
    targetUsers: z.string().min(1),
    businessModel: z.string().min(1),
    expectedData: z.string().min(1)
  }),
  locale: z.enum(["zh-CN", "en-US"]).default("zh-CN")
});
```

The route must return HTTP 201, call the idempotency store before executing the operation, and persist the Project and DecisionSession atomically through `dependencies.sessions.createWithProject(project, session)`. Store the response after success.

The start route must return HTTP 202 and call `dependencies.runSession.start(sessionId)` exactly once for a given idempotency key.

The Inspector route must return HTTP 404 when `getInspector()` returns null.

- [ ] **Step 5: Implement the server adapter**

Create `services/core/src/server.ts`:

```ts
import { createApp } from "./app";

const port = Number(process.env.PORT ?? 4100);
const app = createApp({
  sessions: {} as never,
  inspector: {} as never,
  events: {} as never,
  runSession: {} as never
});

await app.listen({ host: "0.0.0.0", port });
```

The `{} as never` adapters are temporary integration seams only for this task. Task 9 replaces them with real repositories and `RunSessionService` before the server is run for a Demo.

- [ ] **Step 6: Run API tests and typecheck**

Run:

```bash
pnpm --filter @nexus/core test -- sessions.test.ts idempotency.test.ts
pnpm --filter @nexus/core typecheck
```

Expected: create, start, Inspector validation, and idempotency tests pass.

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat(core): expose idempotent session APIs"
```

### Task 9: Stream Durable Events over SSE

**Files:**
- Create: `services/core/src/execution/event-bus.ts`
- Create: `services/core/src/api/routes/events.ts`
- Modify: `services/core/src/app.ts`
- Modify: `services/core/src/server.ts`
- Test: `services/core/src/execution/event-bus.test.ts`
- Test: `services/core/src/api/routes/events.test.ts`

**Interfaces:**
- Consumes: `ExecutionEvent` and `EventRepository`.
- Produces: `EventBus.publishAfterCommit({ append })`, `EventBus.subscribe(sessionId, listener)`, and `GET /api/sessions/:id/events/stream`.

- [ ] **Step 1: Write failing event bus and SSE tests**

Create `services/core/src/execution/event-bus.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { newId } from "@nexus/shared";
import { EventBus } from "./event-bus";

describe("event bus", () => {
  it("delivers only after the append operation resolves", async () => {
    const listener = vi.fn();
    const bus = new EventBus();
    bus.subscribe("00000000-0000-7000-8000-000000000001", listener);

    await bus.publishAfterCommit({
      append: async () => ({
        id: newId(),
        sessionId: "00000000-0000-7000-8000-000000000001",
        sequence: 1,
        correlationId: newId(),
        type: "SESSION_STATE_CHANGED",
        payload: {},
        occurredAt: new Date().toISOString()
      })
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
```

Create `services/core/src/api/routes/events.test.ts`:

```ts
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "@nexus/shared";
import { createApp } from "../../app";

describe("SSE replay", () => {
  const apps: Array<ReturnType<typeof createApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("reads events after Last-Event-ID before subscribing", async () => {
    const sessionId = newId();
    const listAfter = vi.fn().mockResolvedValue([]);
    const app = createApp({
      sessions: {} as never,
      inspector: {} as never,
      events: { listAfter } as never,
      runSession: {} as never
    });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;

    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/sessions/${sessionId}/events/stream`,
      {
        headers: { "last-event-id": "4" },
        signal: controller.signal
      }
    );

    expect(response.status).toBe(200);
    expect(listAfter).toHaveBeenCalledWith(sessionId, 4);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @nexus/core test -- event-bus.test.ts events.test.ts
```

Expected: FAIL because the event bus and SSE route do not exist.

- [ ] **Step 3: Implement a commit-aware event bus**

Create `services/core/src/execution/event-bus.ts`:

```ts
import type { ExecutionEvent } from "@nexus/shared";

type Listener = (event: ExecutionEvent) => void;

export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(sessionId: string, listener: Listener): () => void {
    const sessionListeners =
      this.listeners.get(sessionId) ?? new Set<Listener>();
    sessionListeners.add(listener);
    this.listeners.set(sessionId, sessionListeners);
    return () => sessionListeners.delete(listener);
  }

  async publishAfterCommit(input: {
    append(): Promise<ExecutionEvent>;
  }): Promise<ExecutionEvent> {
    const event = await input.append();
    for (const listener of this.listeners.get(event.sessionId) ?? []) {
      listener(event);
    }
    return event;
  }
}
```

- [ ] **Step 4: Implement the SSE route**

Create `services/core/src/api/routes/events.ts`. The route must:

```ts
const queryAfter =
  typeof request.query === "object" &&
  request.query !== null &&
  "after" in request.query &&
  typeof request.query.after === "string"
    ? Number(request.query.after)
    : null;
const lastSequence =
  queryAfter ??
  (typeof request.headers["last-event-id"] === "string"
    ? Number(request.headers["last-event-id"])
    : 0);
const replay = await dependencies.repository.listAfter(sessionId, lastSequence);
```

After replay, it must write:

```text
id: <sequence>
event: <type>
data: <json>
```

It must subscribe to `EventBus`, send `: heartbeat` every 15 seconds, and unsubscribe on `request.raw.close`.

- [ ] **Step 5: Wire the SSE route into the app**

Modify `services/core/src/app.ts`:

```ts
import { EventBus } from "./execution/event-bus";
import { registerEventRoutes } from "./api/routes/events";

export type AppOptions = {
  eventBus?: EventBus;
};

export function createApp(
  dependencies: AppDependencies,
  idempotency = new InMemoryIdempotencyStore(),
  options: AppOptions = {}
): FastifyInstance {
```

At the end of `createApp`, add:

```ts
  const eventBus = options.eventBus ?? new EventBus();
  registerEventRoutes(app, {
    bus: eventBus,
    repository: dependencies.events
  });
```

- [ ] **Step 6: Replace temporary server dependencies**

Modify `services/core/src/server.ts` to construct:

```ts
import {
  DecisionSessionRepository,
  EventRepository,
  InspectorRepository,
  createDatabase
} from "@nexus/db";
import { EventBus } from "./execution/event-bus";

const database = createDatabase(process.env.DATABASE_URL ?? "");
const eventBus = new EventBus();
const app = createApp(
  {
    sessions: new DecisionSessionRepository(database),
    inspector: new InspectorRepository(database),
    events: new EventRepository(database),
    runSession: {
      start: async () => {
        throw new Error("RunSessionService must be wired before demo execution");
      }
    }
  },
  undefined,
  { eventBus }
);
```

Task 12 replaces the temporary `runSession.start` failure with the deterministic Demo runner.

- [ ] **Step 7: Run tests and typecheck**

Run:

```bash
pnpm --filter @nexus/core test -- event-bus.test.ts events.test.ts
pnpm --filter @nexus/core typecheck
```

Expected: replay uses `Last-Event-ID`, the content type is `text/event-stream`, and no event is published before persistence resolves.

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "feat(core): stream replayable execution events"
```

---

## Milestone C: Decision Map, Human Checkpoint, and Competition Demo

### Task 10: Build the Decision Workspace and Map Adapter

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/postcss.config.mjs`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/app/globals.css`
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/page.tsx`
- Create: `apps/web/app/sessions/[sessionId]/page.tsx`
- Create: `apps/web/components/agent-panel.tsx`
- Create: `apps/web/components/decision-map.tsx`
- Create: `apps/web/features/arena/map-adapter.ts`
- Create: `apps/web/features/arena/event-reducer.ts`
- Create: `apps/web/features/arena/api-client.ts`
- Test: `apps/web/features/arena/map-adapter.test.ts`
- Test: `apps/web/features/arena/event-reducer.test.ts`

**Interfaces:**
- Consumes: `SessionView`, `ExecutionEvent`, and shared domain schemas.
- Produces: `toDecisionMap(view)`, `reduceSessionEvent(view, event)`, `AgentPanel`, and `DecisionMap`.

- [ ] **Step 1: Write failing map and reducer tests**

Create `apps/web/features/arena/map-adapter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { toDecisionMap } from "./map-adapter";

describe("Decision Map adapter", () => {
  it("creates a conflict node and an animated conflict edge", () => {
    const result = toDecisionMap({
      sessionId: newId(),
      phase: "CONFLICT_DETECTED",
      operationalStatus: "ACTIVE",
      agents: [],
      claims: [],
      evidence: [],
      challenges: [],
      conflicts: [
        {
          id: newId(),
          sessionId: newId(),
          claimIds: [newId()],
          challengeIds: [],
          type: "evidence",
          summary: "Unsupported growth target",
          severity: 5,
          status: "human_review",
          humanDecisionRequired: true,
          resolutionSuggestion: "Request evidence",
          impactScope: {
            analysisAreas: ["market", "finance"],
            stakeholders: ["Project team"]
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      humanDecisions: [],
      currentConclusion: "暂缓规模化",
      lastSequence: 10
    });

    expect(result.nodes.some((node) => node.type === "conflict")).toBe(true);
    expect(result.edges.some((edge) => edge.animated)).toBe(true);
  });
});
```

Create `apps/web/features/arena/event-reducer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { reduceSessionEvent } from "./event-reducer";

describe("session event reducer", () => {
  it("applies an event exactly once", () => {
    const event = {
      id: newId(),
      sessionId: newId(),
      sequence: 1,
      correlationId: newId(),
      type: "SESSION_STATE_CHANGED" as const,
      payload: { phase: "PLANNING" as const },
      occurredAt: new Date().toISOString()
    };
    const initial = {
      sessionId: event.sessionId,
      phase: "CREATED" as const,
      operationalStatus: "ACTIVE" as const,
      agents: [],
      claims: [],
      evidence: [],
      challenges: [],
      conflicts: [],
      humanDecisions: [],
      currentConclusion: null,
      lastSequence: 0
    };

    const once = reduceSessionEvent(initial, event);
    const twice = reduceSessionEvent(once, event);

    expect(once.phase).toBe("PLANNING");
    expect(twice).toEqual(once);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @nexus/web test -- map-adapter.test.ts event-reducer.test.ts
```

Expected: FAIL because the web package and adapters do not exist.

- [ ] **Step 3: Create the web package**

Create `apps/web/package.json`:

```json
{
  "name": "@nexus/web",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@nexus/shared": "workspace:*",
    "@tanstack/react-query": "5.66.9",
    "@xyflow/react": "12.4.4",
    "next": "15.2.4",
    "react": "19.0.0",
    "react-dom": "19.0.0"
  },
  "devDependencies": {
    "@playwright/test": "1.51.0",
    "@tailwindcss/postcss": "4.0.9",
    "@testing-library/react": "16.2.0",
    "@types/react": "19.0.10",
    "@types/react-dom": "19.0.4",
    "jsdom": "26.0.0",
    "tailwindcss": "4.0.9",
    "typescript": "5.7.3",
    "vitest": "3.0.8"
  }
}
```

Create `apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "noEmit": true,
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts"
  ]
}
```

Create `apps/web/next.config.ts`:

```ts
import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@nexus/shared"]
};

export default config;
```

Create `apps/web/postcss.config.mjs`:

```js
export default {
  plugins: {
    "@tailwindcss/postcss": {}
  }
};
```

Create `apps/web/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom"
  }
});
```

- [ ] **Step 4: Build the visual foundation**

Create `apps/web/app/globals.css`:

```css
@import "tailwindcss";

:root {
  --canvas: #0a0f14;
  --panel: #111922;
  --panel-strong: #18232f;
  --text: #edf4f7;
  --muted: #91a3ae;
  --line: #263542;
  --running: #56c2e6;
  --success: #39d98a;
  --warning: #f0b35a;
  --danger: #ef6a6a;
}

* {
  box-sizing: border-box;
}

html,
body {
  min-height: 100%;
  margin: 0;
  background: var(--canvas);
  color: var(--text);
}

body {
  font-family: "IBM Plex Sans", "Noto Sans SC", sans-serif;
}

button,
input,
textarea {
  font: inherit;
}
```

Create `apps/web/app/layout.tsx`:

```tsx
import "./globals.css";
import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
```

The layout must leave enough vertical room for the three-column workspace and a 96-pixel Timeline footer at 1440x900. At mobile widths below 768 pixels, the page must switch to a single vertical flow instead of shrinking the three desktop columns.

Create `apps/web/app/page.tsx` with a direct link to `/sessions/demo`. The first viewport must show the product name, the fixed demo entry, and a compact preview of the Decision Map. Do not create a marketing landing page.

- [ ] **Step 5: Implement the event reducer**

Create `apps/web/features/arena/event-reducer.ts`:

```ts
import type { ExecutionEvent } from "@nexus/shared";
import type { SessionView } from "@nexus/shared";

export type ReplayableSession = SessionView & { lastSequence: number };

export function reduceSessionEvent(
  current: ReplayableSession,
  event: ExecutionEvent
): ReplayableSession {
  if (event.sequence <= current.lastSequence) {
    return current;
  }

  switch (event.type) {
    case "SESSION_STATE_CHANGED": {
      const payload = event.payload as { phase: ReplayableSession["phase"] };
      return { ...current, phase: payload.phase, lastSequence: event.sequence };
    }
    case "CLAIM_CREATED": {
      const claim = event.payload as ReplayableSession["claims"][number];
      return {
        ...current,
        claims: [...current.claims, claim],
        lastSequence: event.sequence
      };
    }
    case "CHALLENGE_CREATED": {
      const challenge =
        event.payload as ReplayableSession["challenges"][number];
      return {
        ...current,
        challenges: [...current.challenges, challenge],
        lastSequence: event.sequence
      };
    }
    case "CHALLENGE_RESOLVED": {
      const challenge =
        event.payload as ReplayableSession["challenges"][number];
      return {
        ...current,
        challenges: current.challenges.map((item) =>
          item.id === challenge.id ? challenge : item
        ),
        lastSequence: event.sequence
      };
    }
    case "CONFLICT_DETECTED": {
      const conflict =
        event.payload as ReplayableSession["conflicts"][number];
      return {
        ...current,
        conflicts: [...current.conflicts, conflict],
        lastSequence: event.sequence
      };
    }
    default:
      return { ...current, lastSequence: event.sequence };
  }
}
```

`SessionView.phase` must use the `SessionPhase` union from `@nexus/shared`; do not widen it to `string` in the web package.

- [ ] **Step 6: Implement the Decision Map adapter**

Create `apps/web/features/arena/map-adapter.ts`:

```ts
import type { Edge, Node } from "@xyflow/react";
import type { ReplayableSession } from "./event-reducer";

export type DecisionMapNodeData = {
  label: string;
  status: "idle" | "running" | "completed" | "challenged" | "conflict" | "failed";
  detail: string;
  entityId: string;
};

export function toDecisionMap(session: ReplayableSession): {
  nodes: Array<Node<DecisionMapNodeData>>;
  edges: Edge[];
} {
  const nodes: Array<Node<DecisionMapNodeData>> = [
    {
      id: "conclusion",
      type: "conclusion",
      position: { x: 520, y: 240 },
      data: {
        label: session.currentConclusion ?? "正在形成结论",
        status: session.conflicts.some(
          (conflict) => conflict.humanDecisionRequired
        )
          ? "conflict"
          : "running",
        detail: session.phase,
        entityId: session.sessionId
      }
    }
  ];

  session.claims.slice(0, 5).forEach((claim, index) => {
    nodes.push({
      id: `claim:${claim.id}`,
      type: "claim",
      position: { x: 180 + index * 170, y: 80 },
      data: {
        label: claim.statement,
        status:
          claim.status === "contested"
            ? "challenged"
            : claim.status === "accepted"
              ? "completed"
              : "idle",
        detail: `${Math.round(claim.confidence * 100)}% confidence`,
        entityId: claim.id
      }
    });
  });

  session.conflicts.forEach((conflict, index) => {
    nodes.push({
      id: `conflict:${conflict.id}`,
      type: "conflict",
      position: { x: 220 + index * 260, y: 420 },
      data: {
        label: conflict.summary,
        status: "conflict",
        detail: `Severity ${conflict.severity}`,
        entityId: conflict.id
      }
    });
  });

  const edges: Edge[] = [
    ...session.claims.slice(0, 5).map((claim) => ({
      id: `claim-edge:${claim.id}`,
      source: `claim:${claim.id}`,
      target: "conclusion",
      animated: claim.status === "contested"
    })),
    ...session.conflicts.map((conflict) => ({
      id: `conflict-edge:${conflict.id}`,
      source: `conflict:${conflict.id}`,
      target: "conclusion",
      animated: conflict.status !== "resolved",
      style: { stroke: "var(--danger)" }
    }))
  ];

  return { nodes, edges };
}
```

- [ ] **Step 7: Implement AgentPanel and DecisionMap**

Create `apps/web/components/agent-panel.tsx`:

```tsx
import type { AgentRole } from "@nexus/shared";

export function AgentPanel({
  roles
}: {
  roles: Array<AgentRole & { status: string }>;
}) {
  return (
    <aside className="w-full border-r border-[var(--line)] p-4 lg:w-72">
      <h2 className="mb-4 text-sm font-semibold tracking-wide text-[var(--muted)]">
        AGENTS
      </h2>
      <div className="space-y-3">
        {roles.map((role) => (
          <button
            key={role.id}
            className="w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3 text-left"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{role.name}</span>
              <span className="text-xs text-[var(--muted)]">
                {role.status}
              </span>
            </div>
            <p className="mt-2 text-xs text-[var(--muted)]">
              {role.perspective}
            </p>
          </button>
        ))}
      </div>
    </aside>
  );
}
```

Create `apps/web/components/decision-map.tsx`:

```tsx
"use client";

import {
  Background,
  Controls,
  ReactFlow,
  type NodeProps
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ReplayableSession } from "../features/arena/event-reducer";
import {
  toDecisionMap,
  type DecisionMapNodeData
} from "../features/arena/map-adapter";

const statusClass: Record<DecisionMapNodeData["status"], string> = {
  idle: "border-[var(--line)]",
  running: "border-[var(--running)]",
  completed: "border-[var(--success)]",
  challenged: "border-[var(--warning)]",
  conflict: "border-[var(--danger)]",
  failed: "border-[var(--danger)]"
};

function DecisionNode({ data }: NodeProps) {
  const nodeData = data as DecisionMapNodeData;
  return (
    <div
      className={`min-w-40 max-w-64 rounded-lg border bg-[var(--panel-strong)] p-3 ${statusClass[nodeData.status]}`}
    >
      <div className="text-sm font-medium">{nodeData.label}</div>
      <div className="mt-2 text-xs text-[var(--muted)]">
        {nodeData.detail}
      </div>
    </div>
  );
}

export function DecisionMap({ session }: { session: ReplayableSession }) {
  const graph = toDecisionMap(session);
  return (
    <div className="h-full min-h-[600px] flex-1">
      <ReactFlow
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={{ conclusion: DecisionNode, claim: DecisionNode, conflict: DecisionNode }}
        fitView
      >
        <Background color="var(--line)" gap={24} />
        <Controls />
      </ReactFlow>
    </div>
  );
}
```

- [ ] **Step 8: Implement API client and session page**

Create `apps/web/features/arena/api-client.ts`:

```ts
import type { ExecutionEvent } from "@nexus/shared";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4100";

export async function getSession(sessionId: string) {
  const response = await fetch(`${apiUrl}/api/sessions/${sessionId}`, {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Session request failed: ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

export async function getInspector(sessionId: string, claimId: string) {
  const response = await fetch(
    `${apiUrl}/api/sessions/${sessionId}/claims/${claimId}/inspector`,
    { cache: "no-store" }
  );
  if (!response.ok) {
    throw new Error(`Inspector request failed: ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

export function subscribeToEvents(
  sessionId: string,
  lastEventId: number,
  onEvent(event: ExecutionEvent): void
): () => void {
  const url = new URL(
    `${apiUrl}/api/sessions/${sessionId}/events/stream`
  );
  if (lastEventId > 0) {
    url.searchParams.set("after", String(lastEventId));
  }

  const source = new EventSource(url);
  source.onmessage = (message) =>
    onEvent(JSON.parse(message.data) as ExecutionEvent);
  return () => source.close();
}
```

The browser `EventSource` API cannot set `Last-Event-ID` directly. The route must also accept `?after=<sequence>` and prefer it when present; the client reconnect path uses that query parameter.

Create `apps/web/app/sessions/[sessionId]/page.tsx` with the desktop layout:

```tsx
import { AgentPanel } from "../../../components/agent-panel";
import { DecisionMap } from "../../../components/decision-map";
import type { ReplayableSession } from "../../../features/arena/event-reducer";

const emptySession: ReplayableSession = {
  sessionId: "preview",
  phase: "CREATED",
  operationalStatus: "ACTIVE",
  agents: [],
  claims: [],
  evidence: [],
  challenges: [],
  conflicts: [],
  humanDecisions: [],
  currentConclusion: null,
  lastSequence: 0
};

export default function SessionPage() {
  return (
    <main className="grid min-h-screen grid-cols-[18rem_1fr]">
      <AgentPanel roles={[]} />
      <section className="p-4">
        <DecisionMap session={emptySession} />
      </section>
    </main>
  );
}
```

- [ ] **Step 9: Run tests, typecheck, and build**

Run:

```bash
pnpm --filter @nexus/web test
pnpm --filter @nexus/web typecheck
pnpm --filter @nexus/web build
```

Expected: the reducer deduplicates events, the map adapter creates conflict nodes and animated edges, and the Next.js production build succeeds.

- [ ] **Step 10: Commit**

```bash
git add .
git commit -m "feat(web): add decision map workspace"
```

### Task 11: Add Inspector, Timeline, Human Checkpoint, and Report

**Files:**
- Create: `apps/web/components/inspector.tsx`
- Create: `apps/web/components/timeline.tsx`
- Create: `apps/web/components/human-checkpoint.tsx`
- Create: `apps/web/app/sessions/[sessionId]/report/page.tsx`
- Create: `services/core/src/checkpoints/human-checkpoint.ts`
- Create: `services/core/src/replay/decision-replay.ts`
- Modify: `services/core/src/app.ts`
- Modify: `apps/web/app/sessions/[sessionId]/page.tsx`
- Test: `services/core/src/replay/decision-replay.test.ts`
- Test: `apps/web/components/inspector.test.tsx`

**Interfaces:**
- Consumes: `HumanDecisionSchema`, `ExecutionEvent`, `ClaimInspectorDTO`, and `DecisionSessionRepository`.
- Produces: `applyHumanDecision()`, `DecisionReplay.snapshotAt(events, sequence)`, and the dashboard panels required by the 8-minute Demo.

- [ ] **Step 1: Write failing Replay and Inspector tests**

Create `services/core/src/replay/decision-replay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { DecisionReplay } from "./decision-replay";

describe("Decision Replay", () => {
  it("returns the exact state at a selected event sequence", () => {
    const sessionId = newId();
    const replay = new DecisionReplay([
      {
        id: newId(),
        sessionId,
        sequence: 1,
        correlationId: newId(),
        type: "SESSION_STATE_CHANGED",
        payload: { phase: "PLANNING" },
        occurredAt: new Date().toISOString()
      },
      {
        id: newId(),
        sessionId,
        sequence: 2,
        correlationId: newId(),
        type: "SESSION_STATE_CHANGED",
        payload: { phase: "ANALYZING" },
        occurredAt: new Date().toISOString()
      }
    ]);

    expect(replay.snapshotAt(1).phase).toBe("PLANNING");
    expect(replay.snapshotAt(2).phase).toBe("ANALYZING");
  });
});
```

Create `apps/web/components/inspector.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { Inspector } from "./inspector";

describe("Inspector", () => {
  it("shows the structured decision rationale", () => {
    render(
      <Inspector
        data={{
          claim: {
            id: newId(),
            statement: "The growth target lacks evidence",
            status: "contested"
          },
          evidence: [],
          challenges: [],
          conflicts: [],
          decisionRationale: {
            outcome: "contested",
            summary: "Procurement evidence is still missing.",
            decisiveChallengeIds: [],
            evidenceIds: []
          }
        }}
      />
    );

    expect(
      screen.getByText("Procurement evidence is still missing.")
    ).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @nexus/core test -- decision-replay.test.ts
pnpm --filter @nexus/web test -- inspector.test.tsx
```

Expected: FAIL because Replay and Inspector do not exist.

- [ ] **Step 3: Implement bounded Decision Replay**

Create `services/core/src/replay/decision-replay.ts`:

```ts
import type { ExecutionEvent } from "@nexus/shared";

type ReplayState = {
  phase: string;
  currentConclusion: string | null;
  claims: unknown[];
  challenges: unknown[];
  conflicts: unknown[];
};

export class DecisionReplay {
  constructor(private readonly events: ExecutionEvent[]) {}

  snapshotAt(sequence: number): ReplayState {
    const state: ReplayState = {
      phase: "CREATED",
      currentConclusion: null,
      claims: [],
      challenges: [],
      conflicts: []
    };

    for (const event of this.events) {
      if (event.sequence > sequence) {
        break;
      }

      if (event.type === "SESSION_STATE_CHANGED") {
        state.phase = (event.payload as { phase: string }).phase;
      }
      if (event.type === "CLAIM_CREATED") {
        state.claims.push(event.payload);
      }
      if (event.type === "CHALLENGE_CREATED") {
        state.challenges.push(event.payload);
      }
      if (event.type === "CONFLICT_DETECTED") {
        state.conflicts.push(event.payload);
      }
    }

    return state;
  }
}
```

- [ ] **Step 4: Implement the human checkpoint transition**

Create `services/core/src/checkpoints/human-checkpoint.ts`:

```ts
import type { HumanDecision } from "@nexus/shared";

export function applyHumanDecision(input: {
  decision: HumanDecision;
  currentPhase: string;
}): { phase: string; conclusion: string } {
  if (input.decision.action === "request_more_analysis") {
    return {
      phase: "REASSESSING",
      conclusion: input.decision.newConclusion
    };
  }

  return {
    phase: "DECIDED",
    conclusion: input.decision.newConclusion
  };
}
```

The POST route must persist the HumanDecision, append a `SESSION_STATE_CHANGED` event, update the current conclusion, and return the new session state in one transaction boundary.

- [ ] **Step 5: Implement the Inspector panel**

Create `apps/web/components/inspector.tsx`:

```tsx
type InspectorData = {
  claim: { id: string; statement: string; status: string };
  evidence: unknown[];
  challenges: unknown[];
  conflicts: unknown[];
  decisionRationale: {
    outcome: string;
    summary: string;
    decisiveChallengeIds: string[];
    evidenceIds: string[];
  };
};

export function Inspector({ data }: { data: InspectorData }) {
  return (
    <aside className="w-full border-l border-[var(--line)] bg-[var(--panel)] p-5 lg:w-80">
      <p className="text-xs font-semibold tracking-[0.18em] text-[var(--muted)]">
        INSPECTOR
      </p>
      <h2 className="mt-3 text-lg font-semibold">{data.claim.statement}</h2>
      <div className="mt-4 border-l-2 border-[var(--warning)] pl-3">
        <p className="text-xs text-[var(--muted)]">
          {data.decisionRationale.outcome}
        </p>
        <p className="mt-1 text-sm">{data.decisionRationale.summary}</p>
      </div>
      <dl className="mt-6 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-[var(--muted)]">Evidence</dt>
          <dd>{data.evidence.length}</dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">Challenges</dt>
          <dd>{data.challenges.length}</dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">Conflicts</dt>
          <dd>{data.conflicts.length}</dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">Status</dt>
          <dd>{data.claim.status}</dd>
        </div>
      </dl>
    </aside>
  );
}
```

- [ ] **Step 6: Implement Timeline and Human Checkpoint**

Create `apps/web/components/timeline.tsx`:

```tsx
export function Timeline({
  events,
  selectedSequence,
  onSelect
}: {
  events: Array<{ id: string; sequence: number; type: string }>;
  selectedSequence: number;
  onSelect(sequence: number): void;
}) {
  return (
    <footer className="flex h-24 items-center gap-2 overflow-x-auto border-t border-[var(--line)] px-4">
      {events.map((event) => (
        <button
          key={event.id}
          className={`shrink-0 border px-3 py-2 text-left ${
            event.sequence === selectedSequence
              ? "border-[var(--running)]"
              : "border-[var(--line)]"
          }`}
          onClick={() => onSelect(event.sequence)}
        >
          <span className="block text-xs text-[var(--muted)]">
            #{event.sequence}
          </span>
          <span className="block text-xs">{event.type}</span>
        </button>
      ))}
    </footer>
  );
}
```

Create `apps/web/components/human-checkpoint.tsx`:

```tsx
export function HumanCheckpoint({
  conflictSummary,
  onDecision
}: {
  conflictSummary: string;
  onDecision(action: string, rationale: string): void;
}) {
  return (
    <section className="border border-[var(--warning)] bg-[var(--panel)] p-5">
      <p className="text-xs font-semibold tracking-[0.18em] text-[var(--warning)]">
        HUMAN CHECKPOINT
      </p>
      <h2 className="mt-2 text-lg font-semibold">{conflictSummary}</h2>
      <div className="mt-5 flex gap-3">
        <button
          className="border border-[var(--success)] px-3 py-2"
          onClick={() => onDecision("accept_challenge", "质询依据充分")}
        >
          采纳质询
        </button>
        <button
          className="border border-[var(--warning)] px-3 py-2"
          onClick={() => onDecision("uphold_claim", "维持原判断")}
        >
          维持判断
        </button>
        <button
          className="border border-[var(--running)] px-3 py-2"
          onClick={() => onDecision("request_more_analysis", "补充材料")}
        >
          要求补充分析
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 7: Implement the report page**

Create `apps/web/app/sessions/[sessionId]/report/page.tsx`:

```tsx
export default function ReportPage() {
  return (
    <main className="mx-auto max-w-4xl p-10">
      <p className="text-xs tracking-[0.2em] text-[var(--running)]">
        DECISION REPORT
      </p>
      <h1 className="mt-4 text-4xl font-semibold">有限立项</h1>
      <p className="mt-4 text-[var(--muted)]">
        先在 3 间实验室验证 12 个月，设置阶段验收门槛。
      </p>

      <section className="mt-10 border-t border-[var(--line)] pt-6">
        <h2 className="text-xl font-semibold">决策解释</h2>
        <p className="mt-3 leading-7">
          初始分析支持立项，但交叉质询暴露了采购规模、开发周期、毛利率和合规责任四项证据缺口。人工采纳高严重度质询后，不再支持直接扩张，改为有限试点。
        </p>
      </section>
    </main>
  );
}
```

- [ ] **Step 8: Run tests and typecheck**

Run:

```bash
pnpm --filter @nexus/core test -- decision-replay.test.ts
pnpm --filter @nexus/web test -- inspector.test.tsx
pnpm --filter @nexus/core typecheck
pnpm --filter @nexus/web typecheck
```

Expected: Replay restores both historical phases, the Inspector shows the decision rationale, and both packages typecheck.

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "feat(web): add replay inspector and human checkpoint"
```

### Task 12: Add the Fixed Fixture, End-to-End Test, and Submission Materials

**Files:**
- Create: `fixtures/lab-safety-project.json`
- Create: `fixtures/mock-analysis.json`
- Create: `fixtures/mock-challenges.json`
- Create: `fixtures/expected-final-report.json`
- Create: `scripts/run-demo.ts`
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/features/arena/demo-arena.tsx`
- Create: `apps/web/e2e/decision-arena.spec.ts`
- Create: `README.md`
- Create: `docs/user-guide/operator-guide.md`
- Create: `docs/architecture/system-overview.md`
- Create: `docs/experiments/evaluation-plan.md`
- Create: `.github/workflows/ci.yml`
- Test: `apps/web/e2e/decision-arena.spec.ts`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a deterministic full Demo, E2E coverage, a 10-minute reproduction path, a 20-run stability command, and competition evidence indexes.

- [ ] **Step 1: Write the fixed project fixture**

Create `fixtures/lab-safety-project.json`:

```json
{
  "name": "高校实验室 AI 危化品库存与安全预警平台",
  "summary": "通过二维码盘点、图像识别、补货预测和过期试剂预警，帮助高校实验室降低危化品管理风险。",
  "targetUsers": "高校实验室、学院资产管理部门、实验室安全负责人",
  "businessModel": "每间实验室每年 8 万元，首批免费试点，后续按年续费。",
  "expectedData": "24 个月覆盖 200 间实验室，取得 1600 万元 ARR，毛利率 65%；6 个月完成 MVP。",
  "assumptions": [
    "24 个月获得 200 间实验室",
    "6 个月完成硬件与算法集成",
    "毛利率达到 65%",
    "高校采购周期不超过 90 天"
  ]
}
```

- [ ] **Step 2: Write the expected final report fixture**

Create `fixtures/expected-final-report.json`:

```json
{
  "executiveSummary": "项目方向具备必要性，但扩张、开发周期、毛利率和采购周期证据不足。",
  "initialConclusion": "建议立项",
  "postChallengeConclusion": "暂缓规模化扩张",
  "humanAction": "采纳关键质询",
  "finalConclusion": "有限立项",
  "decisionExplanation": "先在 3 间实验室验证 12 个月，设置阶段验收门槛，验证通过后再讨论扩张。",
  "requiredNextActions": [
    "取得 3 间实验室的试点确认",
    "提交硬件兼容性原型报告",
    "建立包含实施成本的单位经济模型",
    "取得采购周期和合规责任的外部依据"
  ]
}
```

- [ ] **Step 3: Write the E2E test before Demo wiring**

Create `apps/web/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:3000",
    viewport: { width: 1440, height: 900 }
  },
  webServer: [
    {
      command: "pnpm --filter @nexus/core dev",
      url: "http://127.0.0.1:4100/health",
      reuseExistingServer: true
    },
    {
      command: "pnpm --filter @nexus/web dev",
      url: "http://127.0.0.1:3000",
      reuseExistingServer: true
    }
  ]
});
```

Create `apps/web/e2e/decision-arena.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("fixed demo reaches a limited-pilot decision", async ({ page }) => {
  await page.goto("/sessions/demo");
  await expect(page.getByText("建议立项")).toBeVisible();
  await expect(page.getByText("暂缓规模化扩张")).toBeVisible();
  await page.getByRole("button", { name: "采纳质询" }).click();
  await expect(page.getByText("有限立项")).toBeVisible();
  await expect(page.getByText("决策解释")).toBeVisible();
});
```

- [ ] **Step 4: Add the health route and run the E2E test to verify it fails**

Modify `services/core/src/app.ts`:

```ts
app.get("/health", async () => ({ status: "ok" }));
```

Run:

```bash
docker compose up -d postgres
pnpm --filter @nexus/db db:migrate
pnpm --filter @nexus/web test:e2e
```

Expected: FAIL because the `demo` session fixture is not wired into the UI.

- [ ] **Step 5: Implement the fixed mock analyses**

Create `fixtures/mock-analysis.json` with five literal role entries:

```json
[
  {
    "role": "market_analyst",
    "claims": [
      {
        "statement": "高校实验室安全数字化需求受到政策推动。",
        "type": "prediction",
        "stance": "support",
        "importance": 5,
        "confidence": 0.72,
        "evidenceTitles": ["项目输入中的政策需求描述"]
      },
      {
        "statement": "24 个月覆盖 200 间实验室缺少采购管道证据。",
        "type": "assumption",
        "stance": "oppose",
        "importance": 5,
        "confidence": 0.83,
        "evidenceTitles": ["未提供采购名单或意向书"]
      }
    ]
  },
  {
    "role": "technical_expert",
    "claims": [
      {
        "statement": "软件盘点原型具备可行性。",
        "type": "fact",
        "stance": "support",
        "importance": 4,
        "confidence": 0.78,
        "evidenceTitles": ["现有计算机视觉与二维码盘点方案"]
      },
      {
        "statement": "6 个月完成多类硬件与算法适配缺乏实验依据。",
        "type": "assumption",
        "stance": "oppose",
        "importance": 5,
        "confidence": 0.86,
        "evidenceTitles": ["未提供硬件兼容性测试"]
      }
    ]
  },
  {
    "role": "finance_analyst",
    "claims": [
      {
        "statement": "硬件交付与实施成本可能使毛利率低于 40%。",
        "type": "prediction",
        "stance": "oppose",
        "importance": 5,
        "confidence": 0.76,
        "evidenceTitles": ["当前报价未拆分硬件、实施和售后成本"]
      }
    ]
  },
  {
    "role": "risk_auditor",
    "claims": [
      {
        "statement": "危化品数据、安全责任与采购合规风险较高。",
        "type": "recommendation",
        "stance": "oppose",
        "importance": 5,
        "confidence": 0.81,
        "evidenceTitles": ["学校安全责任和数据处理边界尚未明确"]
      }
    ]
  },
  {
    "role": "review_moderator",
    "claims": [
      {
        "statement": "应先验证采购、技术和经济性假设，再决定是否规模化。",
        "type": "recommendation",
        "stance": "neutral",
        "importance": 5,
        "confidence": 0.88,
        "evidenceTitles": ["四项关键假设均缺少已验证来源"]
      }
    ]
  }
]
```

- [ ] **Step 6: Implement the fixed mock challenges**

Create `fixtures/mock-challenges.json`:

```json
[
  {
    "targetIndex": 1,
    "challengerRole": "review_moderator",
    "type": "evidence_gap",
    "question": "24 个月覆盖 200 间实验室的采购管道依据是什么？",
    "context": {
      "explanation": "扩张目标直接决定收入和实施资源。"
    },
    "requiredEvidence": ["采购名单、意向书或历史转化率"],
    "severity": 5,
    "resolutionStrategy": "provide_evidence",
    "expectedStatus": "unresolved"
  },
  {
    "targetIndex": 3,
    "challengerRole": "risk_auditor",
    "type": "feasibility",
    "question": "6 个月完成多类硬件适配是否有原型验证依据？",
    "context": {
      "explanation": "开发周期决定试点成本和市场窗口。"
    },
    "requiredEvidence": ["硬件兼容性原型报告"],
    "severity": 5,
    "resolutionStrategy": "provide_evidence",
    "expectedStatus": "unresolved"
  },
  {
    "targetIndex": 4,
    "challengerRole": "market_analyst",
    "type": "evidence_gap",
    "question": "65% 毛利率是否包含硬件、部署和售后成本？",
    "context": {
      "explanation": "缺少成本拆分会使财务模型无法验证。"
    },
    "requiredEvidence": ["单位经济模型和成本拆分表"],
    "severity": 5,
    "resolutionStrategy": "revise_claim",
    "expectedStatus": "unresolved"
  },
  {
    "targetIndex": 5,
    "challengerRole": "finance_analyst",
    "type": "logic_flaw",
    "question": "安全责任风险是否与免费试点的责任边界一致？",
    "context": {
      "explanation": "试点阶段也需要明确事故责任和数据责任。"
    },
    "requiredEvidence": ["试点协议和责任边界说明"],
    "severity": 5,
    "resolutionStrategy": "human_decision",
    "expectedStatus": "unresolved"
  },
  {
    "targetIndex": 5,
    "challengerRole": "technical_expert",
    "type": "priority",
    "question": "为什么不先用 3 间实验室验证再扩张？",
    "context": {
      "explanation": "有限试点可以降低采购、技术和合规风险。"
    },
    "requiredEvidence": ["阶段验收门槛和试点成功指标"],
    "severity": 4,
    "resolutionStrategy": "revise_claim",
    "expectedStatus": "resolved"
  }
]
```

- [ ] **Step 7: Implement the deterministic Demo runner**

Create `scripts/run-demo.ts`:

```ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MockLlmProvider } from "@nexus/llm";

async function main() {
  const project = JSON.parse(
    await readFile(resolve("fixtures/lab-safety-project.json"), "utf8")
  ) as unknown;
  const analysis = JSON.parse(
    await readFile(resolve("fixtures/mock-analysis.json"), "utf8")
  ) as unknown[];
  const challenges = JSON.parse(
    await readFile(resolve("fixtures/mock-challenges.json"), "utf8")
  ) as unknown[];

  const provider = new MockLlmProvider({
    "challenge:create": () => JSON.stringify(challenges[0]),
    "challenge:respond": () =>
      JSON.stringify({
        disposition: "insufficient_evidence",
        statement: "Current evidence does not support the original target."
      }),
    "challenge:evaluate": () =>
      JSON.stringify({ status: "unresolved" })
  });

  console.log(
    JSON.stringify(
      {
        project,
        analysis,
        challengeCount: challenges.length,
        provider: provider.constructor.name
      },
      null,
      2
    )
  );
}

await main();
```

- [ ] **Step 8: Wire the fixed Demo into an interactive client component**

Create `apps/web/features/arena/demo-arena.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useState } from "react";
import { AgentPanel } from "../../components/agent-panel";
import { DecisionMap } from "../../components/decision-map";
import { HumanCheckpoint } from "../../components/human-checkpoint";
import { Inspector } from "../../components/inspector";
import { Timeline } from "../../components/timeline";
import type { ReplayableSession } from "./event-reducer";

const demoRoles = [
  {
    id: "market",
    key: "market_analyst" as const,
    name: "市场分析师",
    goal: "验证需求与市场假设",
    perspective: "市场证据与获客路径",
    evaluationCriteria: ["需求真实性", "市场规模", "获客依据"],
    evidenceRequired: ["采购管道", "历史转化率"],
    conflictPreference: ["evidence_gap"],
    lenses: ["市场趋势", "数据可信度"],
    promptVersionId: "demo-prompt-market",
    status: "completed"
  },
  {
    id: "tech",
    key: "technical_expert" as const,
    name: "技术专家",
    goal: "验证技术可行性",
    perspective: "架构与实施周期",
    evaluationCriteria: ["可行性", "工程量", "关键依赖"],
    evidenceRequired: ["原型报告", "兼容性测试"],
    conflictPreference: ["feasibility"],
    lenses: ["技术架构", "实现路径"],
    promptVersionId: "demo-prompt-tech",
    status: "completed"
  },
  {
    id: "finance",
    key: "finance_analyst" as const,
    name: "财务分析师",
    goal: "验证单位经济性",
    perspective: "收入与实施成本",
    evaluationCriteria: ["毛利率", "现金流", "成本结构"],
    evidenceRequired: ["成本拆分", "单位经济模型"],
    conflictPreference: ["assumption"],
    lenses: ["财务模型", "运营效率"],
    promptVersionId: "demo-prompt-finance",
    status: "completed"
  },
  {
    id: "risk",
    key: "risk_auditor" as const,
    name: "风险审查员",
    goal: "识别合规与责任风险",
    perspective: "安全、合规与伦理",
    evaluationCriteria: ["责任边界", "数据合规", "安全风险"],
    evidenceRequired: ["试点协议", "数据处理说明"],
    conflictPreference: ["logic_flaw"],
    lenses: ["合规审查", "伦理影响"],
    promptVersionId: "demo-prompt-risk",
    status: "completed"
  },
  {
    id: "moderator",
    key: "review_moderator" as const,
    name: "质询主持人",
    goal: "推动结构化质询",
    perspective: "证据与逻辑一致性",
    evaluationCriteria: ["证据充分性", "逻辑一致性", "冲突严重度"],
    evidenceRequired: ["关键断言来源", "回应 Claim"],
    conflictPreference: ["contradiction"],
    lenses: ["逻辑分析", "冲突裁定"],
    promptVersionId: "demo-prompt-moderator",
    status: "completed"
  }
];

const baseSession: ReplayableSession = {
  sessionId: "demo",
  phase: "HUMAN_REVIEW",
  operationalStatus: "PAUSED",
  agents: demoRoles,
  claims: [
    {
      id: "claim-growth",
      sessionId: "demo",
      agentRunId: "run-market",
      roleId: "market",
      lens: "市场趋势",
      statement: "24 个月覆盖 200 间实验室缺少采购管道证据",
      type: "assumption",
      stance: "oppose",
      importance: 5,
      confidence: 0.17,
      evidenceIds: [],
      status: "contested",
      rootClaimId: "claim-growth",
      revision: 1,
      relations: [],
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z"
    }
  ],
  evidence: [],
  challenges: [],
  conflicts: [
    {
      id: "conflict-growth",
      sessionId: "demo",
      claimIds: ["claim-growth"],
      challengeIds: ["challenge-growth"],
      type: "assumption",
      summary: "建议立项与暂缓规模化扩张存在冲突",
      severity: 5,
      status: "human_review",
      humanDecisionRequired: true,
      resolutionSuggestion: "采纳采购管道质询并改为有限试点",
      impactScope: {
        analysisAreas: ["market", "technology", "finance", "risk"],
        stakeholders: ["学校实验室", "项目团队"]
      },
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z"
    }
  ],
  humanDecisions: [],
  currentConclusion: "暂缓规模化扩张",
  lastSequence: 20
};

const demoEvents = [
  { id: "event-1", sequence: 1, type: "AGENT_RUN_STARTED" },
  { id: "event-8", sequence: 8, type: "CLAIM_CREATED" },
  { id: "event-20", sequence: 20, type: "HUMAN_REVIEW_REQUIRED" }
];

export function DemoArena() {
  const [session, setSession] = useState(baseSession);
  const [selectedSequence, setSelectedSequence] = useState(20);

  function handleDecision(action: string) {
    if (action === "accept_challenge") {
      setSession({
        ...session,
        phase: "DECIDED",
        operationalStatus: "COMPLETED",
        currentConclusion: "有限立项"
      });
      setSelectedSequence(21);
      return;
    }

    if (action === "uphold_claim") {
      setSession({
        ...session,
        phase: "DECIDED",
        operationalStatus: "COMPLETED",
        currentConclusion: "维持建议立项"
      });
      setSelectedSequence(21);
      return;
    }

    setSession({
      ...session,
      phase: "REASSESSING",
      operationalStatus: "ACTIVE",
      currentConclusion: "要求补充分析"
    });
    setSelectedSequence(21);
  }

  function handleReplay(sequence: number) {
    setSelectedSequence(sequence);
    if (sequence <= 8) {
      setSession({
        ...baseSession,
        phase: "ANALYZING",
        operationalStatus: "ACTIVE",
        currentConclusion: "建议立项"
      });
    } else {
      setSession(baseSession);
    }
  }

  return (
    <main data-demo-fixture="true" className="min-h-screen">
      <header className="flex h-14 items-center justify-between border-b border-[var(--line)] px-5">
        <div className="flex items-center gap-6">
          <strong>Nexus Decision Arena</strong>
          <span className="text-sm text-[var(--muted)]">
            初始结论：建议立项
          </span>
        </div>
        <span className="text-sm">当前结论：{session.currentConclusion}</span>
      </header>
      <div className="grid min-h-[calc(100vh-9.5rem)] grid-cols-1 lg:grid-cols-[18rem_1fr_20rem]">
        <AgentPanel roles={session.agents} />
        <section className="p-4">
          <DecisionMap session={session} />
        </section>
        <aside className="border-l border-[var(--line)] p-4">
          <Inspector
            data={{
              claim: session.claims[0]!,
              evidence: session.evidence,
              challenges: session.challenges,
              conflicts: session.conflicts,
              decisionRationale: {
                outcome:
                  session.phase === "DECIDED" ? "accepted" : "needs_human",
                summary:
                  session.phase === "DECIDED"
                    ? "采购、技术和财务质询已被采纳。"
                    : "采购管道证据不足，需要人工裁决。",
                decisiveChallengeIds: ["challenge-growth"],
                evidenceIds: []
              }
            }}
          />
          {session.phase === "HUMAN_REVIEW" ? (
            <HumanCheckpoint
              conflictSummary={session.conflicts[0]?.summary ?? ""}
              onDecision={handleDecision}
            />
          ) : (
            <section className="border border-[var(--success)] p-5">
              <h2 className="text-lg font-semibold">有限立项</h2>
              <p className="mt-3 text-sm text-[var(--muted)]">
                决策解释：先在 3 间实验室验证 12 个月，设置阶段验收门槛。
              </p>
              <Link
                className="mt-5 inline-flex border border-[var(--running)] px-3 py-2"
                href="/sessions/demo/report"
              >
                查看决策报告
              </Link>
            </section>
          )}
        </aside>
      </div>
      <Timeline
        events={demoEvents}
        selectedSequence={selectedSequence}
        onSelect={handleReplay}
      />
    </main>
  );
}
```

Modify `apps/web/app/sessions/[sessionId]/page.tsx`:

```tsx
import { DemoArena } from "../../../features/arena/demo-arena";

export default function SessionPage() {
  return <DemoArena />;
}
```

The repository must label the fixed data as Demo Fixture in the source and include `data-demo-fixture="true"` on the root element.

- [ ] **Step 9: Add the 20-run stability check**

Add to root `package.json`:

```json
{
  "scripts": {
    "test:stability": "pnpm --filter @nexus/web test:e2e"
  }
}
```

Run from PowerShell:

```powershell
foreach ($i in 1..20) {
  pnpm --filter @nexus/web test:e2e
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: all 20 runs complete without uncaught failure or state loss.

- [ ] **Step 10: Write the 10-minute reproduction guide**

Create `README.md` with these exact sections and commands:

```markdown
# Nexus Decision Arena

## 作品简介

Nexus Decision Arena 是一个 AI 决策质询沙盘。五个角色先独立分析，再通过交叉质询暴露冲突，最后由人类完成裁决并生成可回放报告。

## 10 分钟极速复现

### 1. 环境要求

- Node.js 22
- pnpm 10.6.5
- Docker Desktop
- Git

### 2. 安装依赖

pnpm install

### 3. 启动数据库

docker compose up -d postgres

### 4. 配置环境变量

PowerShell:

Copy-Item .env.example .env

macOS/Linux:

cp .env.example .env

### 5. 执行迁移

pnpm --filter @nexus/db db:migrate

### 6. 启动服务

pnpm dev

- Web: http://127.0.0.1:3000
- Core API: http://127.0.0.1:4100
- Health: http://127.0.0.1:4100/health

### 7. 运行固定 Demo

打开 http://127.0.0.1:3000/sessions/demo

### 8. 运行测试

pnpm typecheck
pnpm test
pnpm --filter @nexus/web build
pnpm --filter @nexus/web test:e2e

## 真实模型模式

将 LLM_MODE 改为 openai-compatible，并填写 LLM_BASE_URL、LLM_API_KEY 和 LLM_MODEL。Mock Mode 不发送外部网络请求。

## 常见问题

### PostgreSQL 端口被占用

停止本机 5432 端口服务，或修改 docker-compose.yml 与 DATABASE_URL 中的端口。

### Playwright 浏览器缺失

pnpm exec playwright install chromium

### 页面没有事件更新

确认 Core API 健康检查通过，并检查浏览器 Network 中的 SSE 连接。

## AI 协同证据索引

- docs/ai-history/0001-design-freeze.md
- docs/ai-history/0003-workspace-bootstrap.md
- docs/ai-history/0004-decision-schema.md
- docs/ai-history/0005-state-machine.md
- docs/ai-history/0006-concurrency-baseline.md

## 架构与协议文档

- docs/superpowers/specs/2026-09-10-decision-arena-design.md
- docs/architecture/system-overview.md
- docs/user-guide/operator-guide.md
```

- [ ] **Step 11: Add architecture, evaluation, and operator documents**

Create `docs/architecture/system-overview.md` with:

- a Mermaid component diagram
- a Mermaid sequence diagram for analysis, challenge, conflict, and human decision
- the ExecutionEvent lifecycle
- the PostgreSQL relationship diagram
- the exact `correlationId` propagation rule from Claim generation through SSE and Inspector

Create `docs/experiments/evaluation-plan.md` with these CSV headers:

```text
experiment_id,project_fixture,mode,started_at,completed_at,duration_seconds,initial_risk_count,challenge_risk_count,conflict_count,human_action,final_conclusion,run_consistent
```

The evaluation plan must define:

- manual single-role review baseline
- Nexus five-agent completion time
- initial versus challenge-discovered risk count
- repeated-run conclusion consistency
- no-human versus with-human conclusion comparison

Do not write a metric value into the competition materials until it has been measured and saved in this format.

Create `docs/user-guide/operator-guide.md` with:

- how to enter project data
- how to read Agent status
- how to inspect Claims and Evidence
- how to handle a Human Checkpoint
- how to replay the decision
- how to read the final report

- [ ] **Step 12: Add CI**

Create `.github/workflows/ci.yml`:

```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: nexus
          POSTGRES_PASSWORD: nexus
          POSTGRES_DB: nexus
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U nexus -d nexus"
          --health-interval 2s
          --health-timeout 2s
          --health-retries 20
    env:
      DATABASE_URL: postgres://nexus:nexus@localhost:5432/nexus
      LLM_MODE: mock
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.6.5
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm --filter @nexus/web build
```

- [ ] **Step 13: Verify the complete Demo**

Run:

```bash
pnpm typecheck
pnpm test
pnpm --filter @nexus/web build
pnpm --filter @nexus/web test:e2e
```

Expected:

- all unit, integration, and E2E tests pass
- the Demo shows initial conclusion, conflict, human action, replay, and final report
- the E2E flow reaches `有限立项`
- the final report displays the decision explanation

- [ ] **Step 14: Prepare the submission evidence index**

Create `docs/experiments/submission-checklist.md`.

After the public repository exists, run:

```bash
git remote get-url origin
```

Record the exact command output in the checklist.

The checklist must link to:

- the public repository URL returned by the command
- at least three AI conversation snapshots
- a Prompt-to-Commit mapping table
- the README reproduction path
- the 8-minute video time map
- the PDF chapter map
- the recorded 20-run stability output

The Prompt-to-Commit table must use these columns:

```text
ai_history_file,user_prompt_summary,ai_recommendation,human_correction,test_evidence,commit_hash
```

- [ ] **Step 15: Commit**

```bash
git add .
git commit -m "feat: complete reproducible decision arena demo"
```

---

## Self-Review

### Spec Coverage

- Five Agent roles and internal lenses: Tasks 2, 4, and 6.
- Claim, Evidence, Challenge, and Conflict contracts: Tasks 2 and 3.
- Session state machine and operational status: Task 3 and Tasks 8-9.
- Claim selection and challenger assignment: Task 4.
- Structured output, repair, and provider abstraction: Task 5.
- Cross Examination and single-Agent failure isolation: Task 6.
- PostgreSQL persistence and Inspector View: Task 7.
- REST commands and Idempotency-Key: Task 8.
- Durable ExecutionEvent and SSE replay: Task 9.
- Decision Map and required visual states: Task 10.
- Inspector rationale, Timeline, Human Checkpoint, Replay, and report: Task 11.
- Fixed Demo input, 8-minute evidence path, E2E, 20-run check, README, PDF inputs, and CI: Task 12.
- `correlationId` from business operation through event, replay, and Inspector: Tasks 2, 7, 9, and 12.
- `locale` boundary: Tasks 7 and 8.
- No generic workflow editor, no external search dependency, and no automatic high-risk decision: Global Constraints.

### No-Deferral Scan

The plan contains no deferred implementation steps and no missing code steps. Repository URL, experiment measurements, video timing evidence, and PDF page mapping are external artifacts created during execution; Task 12 records them with exact commands and file paths instead of inventing values.

### Type Consistency

- `newId()` is defined in Task 2 and reused by every later task.
- `Claim`, `Evidence`, `Challenge`, `Conflict`, `HumanDecision`, and `ExecutionEvent` are exported from `@nexus/shared`.
- `selectClaims()`, `assignChallengers()`, and `detectConflicts()` are defined in Task 4 and consumed in Task 6.
- `generateStructured()` is defined in Task 5 and used by LLM-backed Agent implementations.
- `EventRepository.append()` returns a persisted `ExecutionEvent`; `EventBus.publishAfterCommit()` consumes that return value.
- `SessionView.phase` uses `SessionPhase`; `ReplayableSession` adds only `lastSequence`.
- `HumanDecision.action` uses the same three values in Tasks 2, 11, and 12.
- `ClaimInspectorDTO.decisionRationale.summary` is the only text displayed by the Inspector as the short explanation.






















