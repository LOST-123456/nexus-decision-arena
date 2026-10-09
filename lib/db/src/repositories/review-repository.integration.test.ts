import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  newId,
  type ClaimReview,
  type Evidence,
  type Source
} from "@nexus/shared";
import type { Database } from "../client";
import { createTestDatabase } from "../testing/test-database";
import {
  agentRoles,
  agentRuns,
  claimReviews,
  claims,
  decisionSessions,
  evidence,
  projects,
  promptVersions,
  sources
} from "../schema";
import {
  ReviewClaimNotFoundError,
  ReviewReferenceError,
  ReviewRepository
} from "./review-repository";

// fail-closed: without TEST_DATABASE_URL this throws before connecting, and the
// target has to be a dedicated test database.
const database: Database = createTestDatabase();
const repository = new ReviewRepository(database);

beforeEach(async () => {
  await database.execute(
    "TRUNCATE execution_events, claim_reviews, conflicts, evidence, sources, claims, agent_runs, agent_roles, prompt_versions, decision_sessions, projects CASCADE"
  );
});

afterAll(async () => {
  await database.end();
});

async function seedSession(): Promise<string> {
  const projectId = newId();
  const sessionId = newId();
  await database.insert(projects).values({
    id: projectId,
    name: "Review research",
    input: {}
  });
  await database.insert(decisionSessions).values({
    id: sessionId,
    projectId,
    locale: "zh-CN",
    phase: "ANALYZING",
    operationalStatus: "ACTIVE",
    researchQuestion: "Did shipments grow last quarter?"
  } as never);
  return sessionId;
}

async function seedClaim(sessionId: string): Promise<string> {
  const claimId = newId();
  const now = new Date().toISOString();
  await database.insert(claims).values({
    id: claimId,
    sessionId,
    lens: "research",
    statement: "Shipments grew 12% year over year.",
    type: "fact",
    stance: "support",
    importance: 4,
    confidence: 0.5,
    evidenceIds: [],
    status: "proposed",
    rootClaimId: claimId,
    revision: 1,
    relations: [],
    createdAt: now,
    updatedAt: now
  } as never);
  return claimId;
}

async function seedSource(sessionId: string): Promise<string> {
  const sourceId = newId();
  const now = new Date().toISOString();
  await database.insert(sources).values({
    id: sourceId,
    sessionId,
    title: "Q4 shipment statistics",
    kind: "document",
    url: "https://example.org/q4.pdf",
    createdBy: "human",
    createdAt: now,
    updatedAt: now
  } as never);
  return sourceId;
}

async function seedEvidence(
  sessionId: string,
  claimId: string,
  sourceId: string
): Promise<string> {
  const evidenceId = newId();
  await database.insert(evidence).values({
    id: evidenceId,
    sessionId,
    claimIds: [claimId],
    kind: "external_reference",
    title: "Quarterly figures",
    content: "Shipments rose 12%.",
    description: "Vendor-reported growth.",
    sourceId,
    direction: "supports",
    reliability: 0.6,
    verificationStatus: "verified",
    verifiedBy: "Owner (owner)",
    verifiedAt: new Date().toISOString(),
    verificationNote: "Checked against page 14.",
    retrievedAt: new Date().toISOString(),
    createdBy: "human"
  } as never);
  return evidenceId;
}

async function seedAgentRoleAndPrompt(): Promise<{
  roleId: string;
  promptVersionId: string;
}> {
  const promptVersionId = newId();
  const roleId = newId();
  await database.insert(promptVersions).values({
    id: promptVersionId,
    name: "challenger",
    version: "v1",
    content: "prompt"
  });
  await database.insert(agentRoles).values({
    id: roleId,
    key: `role-${roleId.slice(0, 8)}`,
    name: "Risk auditor",
    goal: "Challenge claims",
    perspective: "Skeptical",
    evaluationCriteria: [],
    evidenceRequired: [],
    conflictPreference: [],
    lenses: [],
    promptVersionId
  } as never);
  return { roleId, promptVersionId };
}

function reviewFixture(
  sessionId: string,
  claimId: string,
  overrides: Partial<ClaimReview> = {}
): ClaimReview {
  return {
    id: newId(),
    sessionId,
    claimId,
    outcome: "confirmed",
    rationale: "与年报第 14 页逐字核对一致。",
    reviewer: "Owner (owner)",
    evidenceIds: [],
    sourceIds: [],
    verdictStatusAtReview: "supported",
    verdictConfidenceAtReview: 0.6,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

describe("ReviewRepository · human rulings", () => {
  it("records a ruling and its audit event together", async () => {
    const sessionId = await seedSession();
    const claimId = await seedClaim(sessionId);
    const review = reviewFixture(sessionId, claimId);

    const created = await repository.createReview({
      review,
      event: {
        correlationId: review.id,
        type: "CLAIM_REVIEW_RECORDED",
        payload: { reviewId: review.id, claimId }
      }
    });

    expect(created.review.id).toBe(review.id);
    expect(created.review.reviewer).toBe("Owner (owner)");
    expect(created.event.type).toBe("CLAIM_REVIEW_RECORDED");
    // The session's event sequence is consumed by the same transaction.
    const [session] = await database
      .select()
      .from(decisionSessions);
    expect(session?.nextEventSequence).toBeGreaterThan(1);
  });

  it("keeps every ruling instead of overwriting history", async () => {
    const sessionId = await seedSession();
    const claimId = await seedClaim(sessionId);

    const first = reviewFixture(sessionId, claimId, {
      outcome: "needs_more_evidence",
      rationale: "还缺采购记录，暂不能确认。",
      createdAt: "2026-02-01T00:00:00.000Z"
    });
    const second = reviewFixture(sessionId, claimId, {
      outcome: "confirmed",
      rationale: "补上采购记录后确认结论。",
      createdAt: "2026-02-02T00:00:00.000Z"
    });

    for (const review of [first, second]) {
      await repository.createReview({
        review,
        event: {
          correlationId: review.id,
          type: "CLAIM_REVIEW_RECORDED",
          payload: { reviewId: review.id }
        }
      });
    }

    const history = await repository.listReviewHistory(sessionId, claimId);
    expect(history).toHaveLength(2);
    expect(history[0]?.outcome).toBe("confirmed");
    expect(history[1]?.outcome).toBe("needs_more_evidence");
    expect(await repository.listReviews(sessionId)).toHaveLength(2);
  });

  it("refuses a ruling on a claim from another research task", async () => {
    const sessionId = await seedSession();
    const otherSessionId = await seedSession();
    const foreignClaimId = await seedClaim(otherSessionId);

    await expect(
      repository.createReview({
        review: reviewFixture(sessionId, foreignClaimId),
        event: {
          correlationId: newId(),
          type: "CLAIM_REVIEW_RECORDED",
          payload: {}
        }
      })
    ).rejects.toBeInstanceOf(ReviewClaimNotFoundError);
  });

  it("refuses a ruling that cites another task's material", async () => {
    const sessionId = await seedSession();
    const otherSessionId = await seedSession();
    const claimId = await seedClaim(sessionId);
    const foreignSourceId = await seedSource(otherSessionId);
    const foreignEvidenceId = await seedEvidence(
      otherSessionId,
      await seedClaim(otherSessionId),
      foreignSourceId
    );

    await expect(
      repository.createReview({
        review: reviewFixture(sessionId, claimId, {
          evidenceIds: [foreignEvidenceId]
        }),
        event: {
          correlationId: newId(),
          type: "CLAIM_REVIEW_RECORDED",
          payload: {}
        }
      })
    ).rejects.toBeInstanceOf(ReviewReferenceError);

    await expect(
      repository.createReview({
        review: reviewFixture(sessionId, claimId, {
          sourceIds: [foreignSourceId]
        }),
        event: {
          correlationId: newId(),
          type: "CLAIM_REVIEW_RECORDED",
          payload: {}
        }
      })
    ).rejects.toBeInstanceOf(ReviewReferenceError);

    // Nothing was written by either rejected attempt.
    expect(await repository.listReviews(sessionId)).toHaveLength(0);
  });

  it("accepts a ruling that cites material from the same task", async () => {
    const sessionId = await seedSession();
    const claimId = await seedClaim(sessionId);
    const sourceId = await seedSource(sessionId);
    const evidenceId = await seedEvidence(sessionId, claimId, sourceId);

    const created = await repository.createReview({
      review: reviewFixture(sessionId, claimId, {
        evidenceIds: [evidenceId],
        sourceIds: [sourceId]
      }),
      event: {
        correlationId: newId(),
        type: "CLAIM_REVIEW_RECORDED",
        payload: {}
      }
    });

    expect(created.review.evidenceIds).toEqual([evidenceId]);
    expect(created.review.sourceIds).toEqual([sourceId]);
  });

  it("stores the verdict the ruling was made against", async () => {
    const sessionId = await seedSession();
    const claimId = await seedClaim(sessionId);
    const review = reviewFixture(sessionId, claimId, {
      verdictStatusAtReview: "inconclusive",
      verdictConfidenceAtReview: 0.35
    });

    await repository.createReview({
      review,
      event: {
        correlationId: review.id,
        type: "CLAIM_REVIEW_RECORDED",
        payload: {}
      }
    });

    const [row] = await database
      .select()
      .from(claimReviews);
    expect(row?.verdictStatusAtReview).toBe("inconclusive");
    expect(row?.verdictConfidenceAtReview).toBeCloseTo(0.35);
  });
});

describe("ReviewRepository · cross-review runs", () => {
  it("tracks a run from start to completion", async () => {
    const sessionId = await seedSession();
    const claimId = await seedClaim(sessionId);
    const { roleId, promptVersionId } = await seedAgentRoleAndPrompt();
    const runId = newId();

    const started = await repository.startCrossReviewRun({
      id: runId,
      sessionId,
      roleId,
      promptVersionId,
      targetClaimId: claimId,
      requestedBy: "Owner (owner)",
      correlationId: newId()
    });
    expect(started.status).toBe("running");
    expect(started.purpose).toBe("cross_review");
    expect(started.targetClaimId).toBe(claimId);

    // A running cross-review is discoverable, so a second one can be refused.
    const running = await repository.findRunningCrossReview(sessionId, claimId);
    expect(running?.id).toBe(runId);

    await repository.completeCrossReviewRun({
      runId,
      output: { purpose: "cross_review", challenges: [] }
    });

    const runs = await repository.listAgentRuns(sessionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
    expect(await repository.findRunningCrossReview(sessionId, claimId)).toBeNull();
  });

  it("records a failure with its reason", async () => {
    const sessionId = await seedSession();
    const claimId = await seedClaim(sessionId);
    const { roleId, promptVersionId } = await seedAgentRoleAndPrompt();
    const runId = newId();

    await repository.startCrossReviewRun({
      id: runId,
      sessionId,
      roleId,
      promptVersionId,
      targetClaimId: claimId,
      requestedBy: "Owner (owner)",
      correlationId: newId()
    });
    await repository.failCrossReviewRun({
      runId,
      error: "Provider returned malformed JSON"
    });

    const runs = await repository.listAgentRuns(sessionId);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error).toBe("Provider returned malformed JSON");
    expect(await repository.findRunningCrossReview(sessionId, claimId)).toBeNull();
  });

  it("does not let a finished run be overwritten by a late failure", async () => {
    const sessionId = await seedSession();
    const claimId = await seedClaim(sessionId);
    const { roleId, promptVersionId } = await seedAgentRoleAndPrompt();
    const runId = newId();

    await repository.startCrossReviewRun({
      id: runId,
      sessionId,
      roleId,
      promptVersionId,
      targetClaimId: claimId,
      requestedBy: "Owner (owner)",
      correlationId: newId()
    });
    await repository.completeCrossReviewRun({ runId, output: {} });
    await repository.failCrossReviewRun({ runId, error: "late failure" });

    const runs = await repository.listAgentRuns(sessionId);
    expect(runs[0]?.status).toBe("completed");
    expect(runs[0]?.error).toBeUndefined();
  });

  it("separates cross-review runs from analysis runs", async () => {
    const sessionId = await seedSession();
    const claimId = await seedClaim(sessionId);
    const { roleId, promptVersionId } = await seedAgentRoleAndPrompt();

    await repository.startCrossReviewRun({
      id: newId(),
      sessionId,
      roleId,
      promptVersionId,
      targetClaimId: claimId,
      requestedBy: "Owner (owner)",
      correlationId: newId()
    });
    await database.insert(agentRuns).values({
      id: newId(),
      sessionId,
      roleId,
      promptVersionId,
      status: "completed",
      input: { kind: "analysis" }
    });

    const runs = await repository.listAgentRuns(sessionId);
    expect(runs.filter((run) => run.purpose === "cross_review")).toHaveLength(1);
    expect(runs.filter((run) => run.purpose === "analysis")).toHaveLength(1);
  });

  it("scopes a running run to its own claim", async () => {
    const sessionId = await seedSession();
    const claimId = await seedClaim(sessionId);
    const otherClaimId = await seedClaim(sessionId);
    const { roleId, promptVersionId } = await seedAgentRoleAndPrompt();

    await repository.startCrossReviewRun({
      id: newId(),
      sessionId,
      roleId,
      promptVersionId,
      targetClaimId: claimId,
      requestedBy: "Owner (owner)",
      correlationId: newId()
    });

    expect(
      await repository.findRunningCrossReview(sessionId, otherClaimId)
    ).toBeNull();
  });
});
