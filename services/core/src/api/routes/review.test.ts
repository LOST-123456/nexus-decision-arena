import { describe, expect, it, vi } from "vitest";
import {
  ReviewClaimNotFoundError,
  ReviewReferenceError
} from "@nexus/db";
import {
  newId,
  type AgentRun,
  type Challenge,
  type Claim,
  type ClaimReview,
  type Evidence,
  type ExecutionEvent,
  type Source
} from "@nexus/shared";
import { createApp } from "../../app";
import { EventBus } from "../../execution/event-bus";
import {
  CrossReviewClaimNotFoundError,
  CrossReviewInProgressError,
  CrossReviewNoChallengerError,
  type CrossReviewResult
} from "../../research/cross-review-service";

const SESSION_ID = newId();
const CLAIM_ID = newId();
const OTHER_CLAIM_ID = newId();
const EVIDENCE_ID = newId();
const SOURCE_ID = newId();
const ROLE_ID = newId();
const RUN_ID = newId();

type Role = "owner" | "reviewer" | "viewer";

function fakeAuth(role: Role | null) {
  return {
    userFromRequest: () =>
      role
        ? {
            id: "user-1",
            username: "researcher",
            displayName: "Researcher One",
            role
          }
        : null
  } as never;
}

function fakeEvent(
  type: ExecutionEvent["type"],
  payload: unknown,
  sequence = 1
): ExecutionEvent {
  return {
    id: newId(),
    sessionId: SESSION_ID,
    sequence,
    correlationId: newId(),
    type,
    payload,
    occurredAt: new Date().toISOString()
  };
}

function claimFixture(overrides: Partial<Claim> = {}): Claim {
  const now = new Date().toISOString();
  return {
    id: CLAIM_ID,
    sessionId: SESSION_ID,
    lens: "research",
    statement: "Shipments grew 12% last quarter.",
    type: "fact",
    stance: "support",
    importance: 4,
    confidence: 0.5,
    evidenceIds: [],
    status: "proposed",
    rootClaimId: CLAIM_ID,
    revision: 1,
    relations: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function evidenceFixture(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: EVIDENCE_ID,
    sessionId: SESSION_ID,
    claimIds: [CLAIM_ID],
    kind: "external_reference",
    title: "Quarterly figures",
    content: "Shipments rose 12%.",
    description: "Vendor-reported growth.",
    sourceId: SOURCE_ID,
    direction: "supports",
    reliability: 0.6,
    verificationStatus: "verified",
    verifiedBy: "Owner (owner)",
    verifiedAt: new Date().toISOString(),
    verificationNote: "Checked against page 14.",
    retrievedAt: new Date().toISOString(),
    createdBy: "human",
    ...overrides
  };
}

function sourceFixture(): Source {
  const now = new Date().toISOString();
  return {
    id: SOURCE_ID,
    sessionId: SESSION_ID,
    title: "Q4 shipment statistics",
    kind: "document",
    url: "https://example.org/q4.pdf",
    publisher: "Example Bureau",
    createdBy: "human",
    createdAt: now,
    updatedAt: now
  };
}

function challengeFixture(overrides: Partial<Challenge> = {}): Challenge {
  const now = new Date().toISOString();
  return {
    id: newId(),
    sessionId: SESSION_ID,
    targetClaimId: CLAIM_ID,
    challengerRunId: RUN_ID,
    challengerRoleId: ROLE_ID,
    type: "evidence_gap",
    question: "Where is the procurement record?",
    context: {
      triggerClaimIds: [CLAIM_ID],
      explanation: "The claim drives the conclusion."
    },
    requiredEvidence: ["采购记录"],
    severity: 5,
    resolutionStrategy: "provide_evidence",
    status: "unresolved",
    correlationId: newId(),
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function agentRunFixture(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: RUN_ID,
    sessionId: SESSION_ID,
    roleId: ROLE_ID,
    promptVersionId: newId(),
    status: "completed",
    purpose: "cross_review",
    targetClaimId: CLAIM_ID,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides
  };
}

function reviewFixture(overrides: Partial<ClaimReview> = {}): ClaimReview {
  return {
    id: newId(),
    sessionId: SESSION_ID,
    claimId: CLAIM_ID,
    outcome: "confirmed",
    rationale: "与年报第 14 页逐字核对一致。",
    reviewer: "Owner (owner)",
    evidenceIds: [EVIDENCE_ID],
    sourceIds: [SOURCE_ID],
    verdictStatusAtReview: "supported",
    verdictConfidenceAtReview: 0.6,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function artifacts(overrides: Record<string, unknown> = {}) {
  return {
    claims: [claimFixture()],
    evidence: [evidenceFixture()],
    challenges: [] as Challenge[],
    conflicts: [],
    ...overrides
  };
}

function buildApp(options: {
  role?: Role | null;
  crossReview?: unknown;
  reviews?: Record<string, unknown>;
  arena?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  events?: Record<string, unknown>;
  session?: Record<string, unknown> | null;
}) {
  const role = options.role === undefined ? "owner" : options.role;
  return createApp(
    {
      auth: fakeAuth(role),
      sessions: {
        getById: vi.fn().mockResolvedValue(
          options.session === null
            ? null
            : {
                id: SESSION_ID,
                phase: "ANALYZING",
                operationalStatus: "ACTIVE",
                researchQuestion: "Did shipments grow last quarter?",
                currentConclusion: null,
                // The research belongs to the signed-in account: session access
                // is decided from the recorded owner, never from the request.
                ownerUserId: "user-1",
                ...(options.session ?? {})
              }
        )
      } as never,
      inspector: {} as never,
      events: (options.events ?? {}) as never,
      runSession: {} as never,
      evidence: (options.evidence ?? {}) as never,
      reviews: (options.reviews ?? {}) as never,
      arena: (options.arena ?? {}) as never,
      crossReview: options.crossReview as never
    },
    undefined,
    { eventBus: new EventBus() }
  );
}

function crossReviewResult(
  overrides: Partial<CrossReviewResult> = {}
): CrossReviewResult {
  return {
    sessionId: SESSION_ID,
    claimId: CLAIM_ID,
    status: "completed",
    runs: [
      {
        run: agentRunFixture(),
        challenges: [challengeFixture()],
        status: "completed",
        failure: null
      }
    ],
    challenges: [challengeFixture()],
    responseClaims: [],
    conflicts: [],
    failures: [],
    ...overrides
  };
}

describe("cross-review route", () => {
  it("requires authentication", async () => {
    const app = buildApp({ role: null });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/cross-review`,
      headers: { "idempotency-key": "x" }
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuses viewers", async () => {
    const runForClaim = vi.fn();
    const app = buildApp({ role: "viewer", crossReview: { runForClaim } });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/cross-review`,
      headers: { "idempotency-key": "x" }
    });
    expect(response.statusCode).toBe(403);
    expect(runForClaim).not.toHaveBeenCalled();
  });

  it("requires an idempotency key", async () => {
    const app = buildApp({ crossReview: { runForClaim: vi.fn() } });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/cross-review`
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 404 for a claim from another research task", async () => {
    const app = buildApp({
      crossReview: {
        runForClaim: vi
          .fn()
          .mockRejectedValue(new CrossReviewClaimNotFoundError(OTHER_CLAIM_ID))
      }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${OTHER_CLAIM_ID}/cross-review`,
      headers: { "idempotency-key": "cross-404" }
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 409 while an examination for the claim is still running", async () => {
    const app = buildApp({
      crossReview: {
        runForClaim: vi.fn().mockRejectedValue(new CrossReviewInProgressError(RUN_ID))
      }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/cross-review`,
      headers: { "idempotency-key": "cross-running" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toContain("already running");
  });

  it("returns 409 when no role can act as challenger", async () => {
    const app = buildApp({
      crossReview: {
        runForClaim: vi.fn().mockRejectedValue(new CrossReviewNoChallengerError())
      }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/cross-review`,
      headers: { "idempotency-key": "cross-nochallenger" }
    });
    expect(response.statusCode).toBe(409);
  });

  it("returns the real run records when the examination succeeds", async () => {
    const app = buildApp({
      crossReview: {
        runForClaim: vi.fn().mockResolvedValue(crossReviewResult())
      }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/cross-review`,
      headers: { "idempotency-key": "cross-ok" }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<CrossReviewResult>();
    expect(body.status).toBe("completed");
    expect(body.runs[0]?.run.status).toBe("completed");
    expect(body.challenges).toHaveLength(1);
  });

  it("reports a failed examination as failed, never as success", async () => {
    const failure = "The challenger model returned no usable challenge.";
    const app = buildApp({
      crossReview: {
        runForClaim: vi.fn().mockResolvedValue(
          crossReviewResult({
            status: "failed",
            challenges: [],
            failures: [{ runId: RUN_ID, roleId: ROLE_ID, reason: failure }],
            runs: [
              {
                run: agentRunFixture({ status: "failed", error: failure }),
                challenges: [],
                status: "failed",
                failure
              }
            ]
          })
        )
      }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/cross-review`,
      headers: { "idempotency-key": "cross-failed" }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<CrossReviewResult>();
    expect(body.status).toBe("failed");
    expect(body.failures[0]?.reason).toBe(failure);
    expect(body.runs[0]?.run.error).toBe(failure);
  });

  it("replays the same response for a repeated idempotency key", async () => {
    const runForClaim = vi.fn().mockResolvedValue(crossReviewResult());
    const app = buildApp({ crossReview: { runForClaim } });
    const request = {
      method: "POST" as const,
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/cross-review`,
      headers: { "idempotency-key": "cross-repeat" }
    };
    const first = await app.inject(request);
    const second = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(runForClaim).toHaveBeenCalledTimes(1);
  });
});

describe("cross-review listing", () => {
  it("separates cross-review runs from analysis runs", async () => {
    const app = buildApp({
      arena: { getSessionArtifacts: vi.fn().mockResolvedValue(artifacts()) },
      reviews: {
        listAgentRuns: vi.fn().mockResolvedValue([
          agentRunFixture(),
          agentRunFixture({ purpose: "analysis", targetClaimId: undefined })
        ])
      }
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/cross-reviews`
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      runs: AgentRun[];
      analysisRuns: AgentRun[];
    }>();
    expect(body.runs).toHaveLength(1);
    expect(body.analysisRuns).toHaveLength(1);
  });

  it("returns 404 for an unknown session", async () => {
    const app = buildApp({
      role: null,
      arena: { getSessionArtifacts: vi.fn() }
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/cross-reviews`
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("human claim review route", () => {
  function reviewApp(options: {
    role?: Role | null;
    createReview?: unknown;
    artifacts?: unknown;
    claimId?: string;
  }) {
    return buildApp({
      ...(options.role !== undefined ? { role: options.role } : {}),
      arena: {
        getSessionArtifacts: vi
          .fn()
          .mockResolvedValue(options.artifacts ?? artifacts())
      },
      evidence: {
        listEvidence: vi.fn().mockResolvedValue([evidenceFixture()])
      },
      reviews: {
        listReviews: vi.fn().mockResolvedValue([]),
        listReviewHistory: vi.fn().mockResolvedValue([]),
        createReview:
          options.createReview ??
          vi.fn(async (input: { review: ClaimReview }) => ({
            review: input.review,
            event: fakeEvent("CLAIM_REVIEW_RECORDED", {})
          }))
      }
    });
  }

  it("requires authentication and refuses viewers", async () => {
    const anonymous = buildApp({ role: null });
    const anonResponse = await anonymous.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`,
      headers: { "idempotency-key": "r1" },
      payload: {
        outcome: "confirmed",
        rationale: "looks right to me",
        expectedVerdictStatus: "supported"
      }
    });
    expect(anonResponse.statusCode).toBe(401);

    const viewer = reviewApp({ role: "viewer" });
    const viewerResponse = await viewer.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`,
      headers: { "idempotency-key": "r2" },
      payload: {
        outcome: "confirmed",
        rationale: "looks right to me",
        expectedVerdictStatus: "supported"
      }
    });
    expect(viewerResponse.statusCode).toBe(403);
  });

  it("rejects a ruling without a substantive reason", async () => {
    const app = reviewApp({});
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`,
      headers: { "idempotency-key": "r3" },
      payload: {
        outcome: "confirmed",
        rationale: "ok",
        expectedVerdictStatus: "supported"
      }
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an unknown outcome", async () => {
    const app = reviewApp({});
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`,
      headers: { "idempotency-key": "r4" },
      payload: {
        outcome: "approved",
        rationale: "This is a long enough reason.",
        expectedVerdictStatus: "supported"
      }
    });
    expect(response.statusCode).toBe(400);
  });

  it("takes the reviewer from the session, not from the body", async () => {
    const createReview = vi.fn(async (input: { review: ClaimReview }) => ({
      review: input.review,
      event: fakeEvent("CLAIM_REVIEW_RECORDED", {})
    }));
    const app = reviewApp({ createReview });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`,
      headers: { "idempotency-key": "r5" },
      payload: {
        outcome: "confirmed",
        rationale: "与年报第 14 页逐字核对一致。",
        expectedVerdictStatus: "supported",
        reviewer: "Someone Else (admin)"
      }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ review: ClaimReview }>();
    expect(body.review.reviewer).toBe("Researcher One (researcher)");
    expect(body.review.reviewer).not.toContain("Someone Else");
  });

  it("snapshots the derived verdict the ruling was made against", async () => {
    const createReview = vi.fn(async (input: { review: ClaimReview }) => ({
      review: input.review,
      event: fakeEvent("CLAIM_REVIEW_RECORDED", {})
    }));
    const app = reviewApp({ createReview });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`,
      headers: { "idempotency-key": "r6" },
      payload: {
        outcome: "rejected",
        rationale: "原始报表口径与主张不一致。",
        expectedVerdictStatus: "supported",
        evidenceIds: [EVIDENCE_ID],
        sourceIds: [SOURCE_ID]
      }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ review: ClaimReview }>();
    expect(body.review.verdictStatusAtReview).toBe("supported");
    expect(body.review.verdictConfidenceAtReview).toBeGreaterThan(0);
    expect(body.review.evidenceIds).toEqual([EVIDENCE_ID]);
  });

  it("refuses a ruling written against a verdict that has since changed", async () => {
    const createReview = vi.fn(async (input: { review: ClaimReview }) => ({
      review: input.review,
      event: fakeEvent("CLAIM_REVIEW_RECORDED", {})
    }));
    const app = reviewApp({ createReview });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`,
      headers: { "idempotency-key": "r6-stale" },
      payload: {
        outcome: "confirmed",
        rationale: "页面显示为证据不足时提交的裁定。",
        // The page thought the claim was unresolved; it is in fact supported.
        expectedVerdictStatus: "insufficient_evidence"
      }
    });
    expect(response.statusCode).toBe(409);
    const body = response.json<{
      code: string;
      expected: string;
      actual: string;
    }>();
    expect(body.code).toBe("stale_verdict");
    expect(body.expected).toBe("insufficient_evidence");
    expect(body.actual).toBe("supported");
    // Nothing was written: a stale ruling never reaches storage.
    expect(createReview).not.toHaveBeenCalled();
  });

  it("requires the reviewer to state the verdict they saw", async () => {
    const app = reviewApp({});
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`,
      headers: { "idempotency-key": "r6-missing-expected" },
      payload: {
        outcome: "confirmed",
        rationale: "This rationale is long enough to pass."
      }
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 404 when the claim is not part of this session", async () => {
    const app = reviewApp({
      artifacts: artifacts({ claims: [claimFixture({ id: OTHER_CLAIM_ID })] })
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`,
      headers: { "idempotency-key": "r7" },
      payload: {
        outcome: "confirmed",
        rationale: "This rationale is long enough to pass.",
        expectedVerdictStatus: "supported"
      }
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 400 when a ruling cites material from another research task", async () => {
    const app = reviewApp({
      createReview: vi
        .fn()
        .mockRejectedValue(new ReviewReferenceError("cross-session citation"))
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`,
      headers: { "idempotency-key": "r8" },
      payload: {
        outcome: "confirmed",
        rationale: "This rationale is long enough to pass.",
        expectedVerdictStatus: "supported",
        evidenceIds: [newId()]
      }
    });
    expect(response.statusCode).toBe(400);
  });

  it("replays a duplicate submission instead of recording it twice", async () => {
    const createReview = vi.fn(async (input: { review: ClaimReview }) => ({
      review: input.review,
      event: fakeEvent("CLAIM_REVIEW_RECORDED", {})
    }));
    const app = reviewApp({ createReview });
    const request = {
      method: "POST" as const,
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`,
      headers: { "idempotency-key": "r9" },
      payload: {
        outcome: "needs_more_evidence",
        rationale: "还缺采购记录，暂不能确认。",
        expectedVerdictStatus: "supported"
      }
    };
    const first = await app.inject(request);
    const second = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(createReview).toHaveBeenCalledTimes(1);
  });

  it("keeps the full ruling history for a claim", async () => {
    const history = [
      reviewFixture({ outcome: "needs_more_evidence" }),
      reviewFixture({ outcome: "confirmed" })
    ];
    const app = buildApp({
      arena: { getSessionArtifacts: vi.fn().mockResolvedValue(artifacts()) },
      reviews: {
        listReviews: vi.fn().mockResolvedValue(history),
        listReviewHistory: vi.fn().mockResolvedValue([...history].reverse())
      }
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      reviews: ClaimReview[];
      latest: ClaimReview | null;
    }>();
    expect(body.reviews).toHaveLength(2);
    expect(body.latest?.outcome).toBe("confirmed");
  });

  it("returns 404 for a claim that is not in the session", async () => {
    const app = buildApp({
      arena: {
        getSessionArtifacts: vi.fn().mockResolvedValue(
          artifacts({ claims: [claimFixture({ id: OTHER_CLAIM_ID })] })
        )
      },
      reviews: { listReviewHistory: vi.fn().mockResolvedValue([]) }
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("fact-check report route", () => {
  function reportApp(overrides: Record<string, unknown> = {}) {
    return buildApp({
      arena: {
        getSessionArtifacts: vi
          .fn()
          .mockResolvedValue(
            artifacts({ challenges: [challengeFixture()] })
          )
      },
      evidence: {
        listEvidence: vi.fn().mockResolvedValue([evidenceFixture()]),
        listSources: vi.fn().mockResolvedValue([sourceFixture()])
      },
      reviews: {
        listReviews: vi.fn().mockResolvedValue([reviewFixture()]),
        listAgentRuns: vi.fn().mockResolvedValue([agentRunFixture()])
      },
      events: {
        listAfter: vi
          .fn()
          .mockResolvedValue([fakeEvent("CLAIM_CREATED", {}, 7)])
      },
      ...overrides
    });
  }

  it("requires authentication", async () => {
    const response = await buildApp({ role: null }).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/fact-check-report`
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 404 for an unknown session", async () => {
    const response = await buildApp({ session: null }).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/fact-check-report`
    });
    expect(response.statusCode).toBe(404);
  });

  it("builds the report from persisted material with traceable provenance", async () => {
    const response = await reportApp({}).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/fact-check-report`
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      researchQuestion: string;
      materialsFingerprint: string;
      findings: Array<{
        verdict: { status: string; openQuestions: string[] };
        supporting: Array<{ source: { title: string } | null }>;
        challenges: Array<{ unverifiedReferences: string[] }>;
      }>;
      gaps: { unresolvedConflicts: unknown[] };
      provenance: { evidenceIds: string[]; lastEventSequence: number };
    }>();

    expect(body.researchQuestion).toBe("Did shipments grow last quarter?");
    expect(body.materialsFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(body.findings).toHaveLength(1);
    // A verified supporting excerpt with an open severe challenge.
    expect(body.findings[0]?.verdict.status).toBe("inconclusive");
    expect(body.findings[0]?.verdict.openQuestions).toHaveLength(1);
    expect(body.findings[0]?.supporting[0]?.source?.title).toBe(
      "Q4 shipment statistics"
    );
    // The challenger's free-text demand is not registered evidence.
    expect(body.findings[0]?.challenges[0]?.unverifiedReferences).toEqual([
      "采购记录"
    ]);
    expect(body.provenance.evidenceIds).toEqual([EVIDENCE_ID]);
    expect(body.provenance.lastEventSequence).toBe(7);
  });

  it("renders markdown from the same object", async () => {
    const response = await reportApp({}).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/fact-check-report?format=markdown`
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/markdown");
    const body = response.body;
    expect(body).toContain("# 事实核查报告");
    expect(body).toContain("交叉审查后仍未确定");
    expect(body).toContain("Q4 shipment statistics");
    expect(body).toContain("没有登记为证据");
  });

  it("exports the audit package with the event trail behind the report", async () => {
    const response = await reportApp({}).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/fact-check-report?format=audit&download=1`
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(String(response.headers["content-disposition"])).toContain(
      "-%E5%AE%A1%E8%AE%A1%E5%8C%85.json"
    );

    const bundle = response.json<{
      generatedAt: string;
      materialsFingerprint: string;
      session: { id: string; phase: string };
      report: { materialsFingerprint: string; provenance: { lastEventSequence: number } };
      events: Array<{ type: string; sequence: number }>;
    }>();

    expect(bundle.session.id).toBe(SESSION_ID);
    expect(bundle.events.map((event) => event.sequence)).toEqual([7]);
    // The package carries the report itself, not a second rendering of it.
    expect(bundle.report.materialsFingerprint).toBe(bundle.materialsFingerprint);
    expect(bundle.report.provenance.lastEventSequence).toBe(7);
  });

  it("agrees with the JSON report it packages", async () => {
    const app = reportApp({});
    const json = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/fact-check-report?format=json`
    });
    const audit = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/fact-check-report?format=audit`
    });

    const direct = json.json<{ materialsFingerprint: string; summary: unknown }>();
    const bundled = audit.json<{
      report: { materialsFingerprint: string; summary: unknown };
    }>();
    expect(bundled.report.materialsFingerprint).toBe(direct.materialsFingerprint);
    expect(bundled.report.summary).toEqual(direct.summary);
  });

  it("delivers every excerpt with a label by default, withholding nothing", async () => {
    const response = await reportApp({}).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/fact-check-report?format=audit`
    });

    expect(response.statusCode).toBe(200);
    const bundle = response.json<{
      delivery: {
        disclosure: {
          policy: string;
          scope: string;
          statement: string;
          withheld: { citations: number; materials: number };
        };
        claims: Array<{ claimId: string; verification: string }>;
      };
    }>();

    expect(bundle.delivery.disclosure.policy).toBe("retain-and-label");
    expect(bundle.delivery.disclosure.scope).toBe("all");
    expect(bundle.delivery.disclosure.withheld.citations).toBe(0);
    expect(bundle.delivery.disclosure.statement).toContain("保留在包内");
    // Every claim says where it stands, so nothing has to be inferred.
    expect(bundle.delivery.claims).toHaveLength(1);
    expect(bundle.delivery.claims[0]?.claimId).toBe(CLAIM_ID);
  });

  it("withholds unverified excerpts only when asked, and reports the count", async () => {
    const unverified = evidenceFixture({
      id: newId(),
      title: "Unchecked forum post",
      verificationStatus: "unverified",
      verifiedBy: undefined,
      verifiedAt: undefined,
      verificationNote: undefined
    });
    const app = reportApp({
      evidence: {
        listEvidence: vi
          .fn()
          .mockResolvedValue([evidenceFixture(), unverified]),
        listSources: vi.fn().mockResolvedValue([sourceFixture()])
      }
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/fact-check-report?format=audit&scope=verified`
    });

    const bundle = response.json<{
      delivery: { disclosure: { scope: string; statement: string; withheld: { citations: number } } };
      report: { findings: Array<{ supporting: Array<{ verificationStatus: string }> }> };
    }>();

    expect(bundle.delivery.disclosure.scope).toBe("verified");
    expect(bundle.delivery.disclosure.withheld.citations).toBeGreaterThan(0);
    expect(bundle.delivery.disclosure.statement).toContain(
      String(bundle.delivery.disclosure.withheld.citations)
    );
    for (const finding of bundle.report.findings) {
      for (const citation of finding.supporting) {
        expect(citation.verificationStatus).toBe("verified");
      }
    }
  });

  it("does not recompute a verdict from the withheld subset", async () => {
    // The conclusion is a fact about all the material. Filtering what a
    // recipient may see must not change what the research concluded.
    const app = reportApp({
      evidence: {
        listEvidence: vi
          .fn()
          .mockResolvedValue([
            evidenceFixture(),
            evidenceFixture({
              id: newId(),
              verificationStatus: "unverified",
              verifiedBy: undefined,
              verifiedAt: undefined,
              verificationNote: undefined
            })
          ]),
        listSources: vi.fn().mockResolvedValue([sourceFixture()])
      }
    });

    const all = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/fact-check-report?format=audit&scope=all`
    });
    const filtered = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/fact-check-report?format=audit&scope=verified`
    });

    const read = (body: string) =>
      JSON.parse(body) as {
        report: {
          summary: unknown;
          findings: Array<{ verdict: { status: string } }>;
        };
      };

    expect(read(filtered.body).report.summary).toEqual(
      read(all.body).report.summary
    );
    expect(
      read(filtered.body).report.findings.map((finding) => finding.verdict.status)
    ).toEqual(read(all.body).report.findings.map((finding) => finding.verdict.status));
  });

  it("refuses an audit scope it does not implement", async () => {
    const response = await reportApp({}).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/fact-check-report?format=audit&scope=verified-only`
    });
    expect(response.statusCode).toBe(400);
  });

  it("names each downloaded file after its own material fingerprint", async () => {
    const app = reportApp({});
    const json = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/fact-check-report?format=json&download=1`
    });
    const fingerprint = json.json<{ materialsFingerprint: string }>()
      .materialsFingerprint;

    expect(String(json.headers["content-disposition"])).toContain(
      `fact-check-report-${fingerprint}.json`
    );
  });

  it("never emits a citation for material with no source record", async () => {
    const response = await reportApp({
      evidence: {
        listEvidence: vi.fn().mockResolvedValue([
          evidenceFixture({ sourceId: undefined, sourceRef: undefined })
        ]),
        listSources: vi.fn().mockResolvedValue([])
      }
    }).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/fact-check-report`
    });
    const body = response.json<{
      findings: Array<{ supporting: Array<{ citationStatus: string }> }>;
      gaps: { unlinkedCitations: unknown[] };
      limits: string[];
    }>();
    expect(body.findings[0]?.supporting[0]?.citationStatus).toBe("unlinked");
    expect(body.gaps.unlinkedCitations).toHaveLength(1);
    expect(body.limits.join(" ")).toContain("没有来源记录");
  });
});
