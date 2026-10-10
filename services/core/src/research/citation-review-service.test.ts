import { beforeEach, describe, expect, it } from "vitest";
import {
  newId,
  type Claim,
  type ClaimSupportAssessment,
  type CitationIntegrityCheck,
  type Evidence,
  type ExecutionEvent
} from "@nexus/shared";
import type { CitationReviewRepository } from "@nexus/db";
import type { LlmProvider, LlmRequest } from "@nexus/llm";
import {
  CitationReviewError,
  CitationReviewService,
  type CitationReviewDependencies
} from "./citation-review-service";

/**
 * Behaviour of the two layers, with the model and the database faked.
 *
 * The boundary under test: layer A is decided by the server from stored text;
 * layer B is a model's reading and is stored as advice. Neither may verify an
 * excerpt, and layer B may not blur into a verdict.
 */

const SESSION_ID = newId();
const CLAIM_ID = newId();
const EVIDENCE_ID = newId();
const SOURCE_ID = newId();
const PAGE_TEXT =
  "Shipments grew 12% year over year.\n\n" +
  "The agency expects growth to continue.\n\n" +
  "Analysts remain cautious.";

type Stored = {
  checks: CitationIntegrityCheck[];
  assessments: ClaimSupportAssessment[];
};

function claim(): Claim {
  const now = new Date().toISOString();
  return {
    id: CLAIM_ID,
    sessionId: SESSION_ID,
    lens: "research",
    statement: "Shipments grew 12% year over year.",
    type: "fact",
    stance: "support",
    importance: 3,
    confidence: 0.5,
    evidenceIds: [EVIDENCE_ID],
    status: "accepted",
    rootClaimId: CLAIM_ID,
    revision: 1,
    relations: [],
    revisionOfClaimId: undefined,
    createdAt: now,
    updatedAt: now
  };
}

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: EVIDENCE_ID,
    sessionId: SESSION_ID,
    claimIds: [CLAIM_ID],
    kind: "external_reference",
    title: "Annual report",
    content: "Shipments grew 12% year over year.",
    description: "quoted from the report",
    sourceId: SOURCE_ID,
    direction: "supports",
    reliability: 0.8,
    locatorStatus: "anchored",
    anchorText: "Shipments grew 12% year over year.",
    sourceContentHash: "hash-current",
    verificationStatus: "unverified",
    retrievedAt: new Date().toISOString(),
    createdBy: "human",
    ...overrides
  } as Evidence;
}

type FakeWrites = {
  integrity: Array<Record<string, unknown>>;
  assessments: Array<Record<string, unknown>>;
  corrections: Array<Record<string, unknown>>;
};

/** Echoes the appended event so a test can assert on its type and payload. */
function fakeEvent(
  sessionId: string,
  sequence: number,
  input: { correlationId: string; type: string; payload?: unknown }
): ExecutionEvent {
  return {
    id: newId(),
    sessionId,
    sequence,
    correlationId: input.correlationId,
    type: input.type,
    payload: input.payload,
    occurredAt: new Date().toISOString()
  } as ExecutionEvent;
}

function fakeRepository(writes: FakeWrites): CitationReviewRepository {
  const stored: Stored = { checks: [], assessments: [] };
  return {
    recordIntegrityChecks: async (input: {
      sessionId: string;
      checks: Array<Record<string, unknown>>;
      event: { correlationId: string; type: string; payload?: unknown };
    }) => {
      writes.integrity.push(...input.checks);
      const created = input.checks.map((check) => ({
        ...check,
        sessionId: input.sessionId,
        snapshotId: check.snapshotId ?? null,
        matchKind: check.matchKind ?? null,
        anchorText: check.anchorText ?? null,
        expectedContentHash: check.expectedContentHash ?? null,
        snapshotContentHash: check.snapshotContentHash ?? null,
        matchedText: check.matchedText ?? null,
        contextText: check.contextText ?? null,
        supersedesId: null,
        isCurrent: true,
        createdAt: new Date().toISOString()
      })) as unknown as CitationIntegrityCheck[];
      stored.checks = created;
      return {
        checks: created,
        event: fakeEvent(input.sessionId, 1, input.event)
      };
    },
    recordAssessments: async (input: {
      sessionId: string;
      assessments: Array<Record<string, unknown>>;
      event: { correlationId: string; type: string; payload?: unknown };
    }) => {
      writes.assessments.push(...input.assessments);
      const created = input.assessments.map((item) => ({
        ...item,
        sessionId: input.sessionId,
        supersedesId: null,
        isCurrent: true,
        createdAt: new Date().toISOString()
      })) as unknown as ClaimSupportAssessment[];
      stored.assessments = created;
      return {
        assessments: created,
        event: fakeEvent(input.sessionId, 2, input.event)
      };
    },
    listCurrentIntegrity: async () => stored.checks,
    listCurrentAssessments: async () => stored.assessments,
    listIntegrityHistory: async () => stored.checks,
    listAssessmentHistory: async () => stored.assessments,
    listAssessmentsForClaim: async () => stored.assessments,
    getIntegrityCheck: async () => null,
    getAssessment: async () => null,
    correctIntegrity: async (input: { check: CitationIntegrityCheck }) =>
      ({ check: input.check, event: {} as ExecutionEvent }) as never,
    correctAssessment: async (input: { assessment: ClaimSupportAssessment }) =>
      ({ assessment: input.assessment, event: {} as ExecutionEvent }) as never
  } as unknown as CitationReviewRepository;
}

function fakeProvider(answers: string[]): LlmProvider {
  let index = 0;
  return {
    name: "FakeProvider",
    generate: async (_request: LlmRequest) => {
      const answer = answers[Math.min(index, answers.length - 1)] ?? "";
      index += 1;
      return answer;
    }
  } as unknown as LlmProvider;
}

function service(
  writes: FakeWrites,
  options: { provider?: LlmProvider | undefined } = {}
): CitationReviewService {
  const dependencies: CitationReviewDependencies = {
    readClaims: async () => [claim()],
    evidence: {
      listEvidence: async () => [evidence()],
      getCurrentSnapshot: async () => ({
        id: "snap-current",
        sessionId: SESSION_ID,
        sourceId: SOURCE_ID,
        canonicalUrl: "https://example.test/report",
        contentHash: "hash-current",
        title: "Annual report",
        author: null,
        publisher: null,
        publishedAt: null,
        contentType: "text/html",
        content: PAGE_TEXT,
        contentBytes: PAGE_TEXT.length,
        charCount: PAGE_TEXT.length,
        retrievedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      }),
      listSnapshots: async () => []
    } as unknown as CitationReviewDependencies["evidence"],
    citations: fakeRepository(writes),
    ...(options.provider === undefined
      ? {}
      : { provider: options.provider }),
    providerName: "FakeProvider",
    model: "fake-model"
  };
  return new CitationReviewService(dependencies);
}

let writes: FakeWrites;

beforeEach(() => {
  writes = { integrity: [], assessments: [], corrections: [] };
});

describe("layer A — integrity is decided by the server", () => {
  it("anchors a quote that is present in the current capture", async () => {
    const result = await service(writes).checkIntegrity({
      sessionId: SESSION_ID,
      actor: "Researcher (researcher)",
      correlationId: newId()
    });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.status).toBe("anchored");
    expect(result.event.type).toBe("CITATION_INTEGRITY_CHECKED");
  });

  it("marks a quote missing when it is nowhere in the capture", async () => {
    const result = await service(writes).checkIntegrity({
      sessionId: SESSION_ID,
      actor: "Researcher (researcher)",
      correlationId: newId()
    });
    expect(result.checks[0]!.status).toBe("anchored");

    // A different excerpt that really is absent.
    const absentWrites: FakeWrites = {
      integrity: [],
      assessments: [],
      corrections: []
    };
    const absent = new CitationReviewService({
      readClaims: async () => [claim()],
      evidence: {
        listEvidence: async () => [
          evidence({ anchorText: "Demand collapsed in Q4." })
        ],
        getCurrentSnapshot: async () =>
          ({ contentHash: "hash-current", id: "s", content: PAGE_TEXT }) as never,
        listSnapshots: async () => []
      } as unknown as CitationReviewDependencies["evidence"],
      citations: fakeRepository(absentWrites),
      providerName: "FakeProvider",
      model: "fake-model"
    });
    const missing = await absent.checkIntegrity({
      sessionId: SESSION_ID,
      actor: "Researcher (researcher)",
      correlationId: newId()
    });
    expect(missing.checks[0]!.status).toBe("missing");
  });

  it("refuses to run at all when there is nothing to check", async () => {
    const empty = new CitationReviewService({
      readClaims: async () => [],
      evidence: {
        listEvidence: async () => [],
        getCurrentSnapshot: async () => null,
        listSnapshots: async () => []
      } as unknown as CitationReviewDependencies["evidence"],
      citations: fakeRepository(writes),
      providerName: "FakeProvider",
      model: "fake-model"
    });
    await expect(
      empty.checkIntegrity({
        sessionId: SESSION_ID,
        actor: "Researcher (researcher)",
        correlationId: newId()
      })
    ).rejects.toMatchObject({ code: "no_evidence", httpStatus: 422 });
  });

  it("does not need a model", async () => {
    const result = await service(writes).checkIntegrity({
      sessionId: SESSION_ID,
      actor: "Researcher (researcher)",
      correlationId: newId()
    });
    expect(result.checks).toHaveLength(1);
  });
});

describe("layer B — support is advice, never verification", () => {
  it("stores an assessment with its reason and located fragment", async () => {
    const provider = fakeProvider([
      JSON.stringify({
        assessments: [
          {
            evidenceId: EVIDENCE_ID,
            status: "support",
            confidence: 0.7,
            rationale: "The statement and the excerpt say the same thing.",
            matchedExcerpt: "Shipments grew 12% year over year.",
            signals: []
          }
        ]
      })
    ]);
    const result = await service(writes, { provider }).assessSupport({
      sessionId: SESSION_ID,
      claimId: CLAIM_ID,
      actor: "Researcher (researcher)",
      correlationId: newId()
    });
    expect(result.assessments).toHaveLength(1);
    expect(result.assessments[0]!.status).toBe("support");
    expect(result.assessments[0]!.matchedExcerptLocated).toBe(true);
    expect(result.summary.status).toBe("support");
    expect(result.event.type).toBe("SUPPORT_ASSESSMENT_RECORDED");
  });

  it("records a fragment the source does not contain as unlocated", async () => {
    const provider = fakeProvider([
      JSON.stringify({
        assessments: [
          {
            evidenceId: EVIDENCE_ID,
            status: "support",
            confidence: 0.9,
            rationale: "A confidently invented quotation.",
            matchedExcerpt: "Shipments tripled in the fourth quarter.",
            signals: []
          }
        ]
      })
    ]);
    const result = await service(writes, { provider }).assessSupport({
      sessionId: SESSION_ID,
      claimId: CLAIM_ID,
      actor: "Researcher (researcher)",
      correlationId: newId()
    });
    // The reading is kept, but it is not presented as something the page said.
    expect(result.assessments[0]!.matchedExcerptLocated).toBe(false);
  });

  it("reports mixed when the model finds both support and opposition", async () => {
    const secondId = newId();
    const provider = fakeProvider([
      JSON.stringify({
        assessments: [
          {
            evidenceId: EVIDENCE_ID,
            status: "support",
            confidence: 0.6,
            rationale: "It restates the growth figure.",
            matchedExcerpt: "Shipments grew 12% year over year.",
            signals: []
          },
          {
            evidenceId: secondId,
            status: "oppose",
            confidence: 0.6,
            rationale: "It contradicts the claim's scope.",
            matchedExcerpt: "Analysts remain cautious.",
            signals: []
          }
        ]
      })
    ]);
    const deps = new CitationReviewService({
      readClaims: async () => [claim()],
      evidence: {
        listEvidence: async () => [
          evidence(),
          evidence({
            id: secondId,
            claimIds: [CLAIM_ID],
            content: "Analysts remain cautious."
          })
        ],
        getCurrentSnapshot: async () =>
          ({ id: "s", contentHash: "hash-current", content: PAGE_TEXT }) as never,
        listSnapshots: async () => []
      } as unknown as CitationReviewDependencies["evidence"],
      citations: fakeRepository(writes),
      provider,
      providerName: "FakeProvider",
      model: "fake-model"
    });
    const result = await deps.assessSupport({
      sessionId: SESSION_ID,
      claimId: CLAIM_ID,
      actor: "Researcher (researcher)",
      correlationId: newId()
    });
    expect(result.summary.status).toBe("mixed");
  });

  it("drops assessments for ids it never handed over", async () => {
    const provider = fakeProvider([
      JSON.stringify({
        assessments: [
          {
            evidenceId: "some-other-evidence",
            status: "support",
            confidence: 0.9,
            rationale: "An id that was not part of the request.",
            matchedExcerpt: "Shipments grew 12% year over year.",
            signals: []
          }
        ]
      })
    ]);
    await expect(
      service(writes, { provider }).assessSupport({
        sessionId: SESSION_ID,
        claimId: CLAIM_ID,
        actor: "Researcher (researcher)",
        correlationId: newId()
      })
    ).rejects.toMatchObject({ code: "schema_rejected" });
  });

  it("surfaces invalid JSON as a failure instead of an empty success", async () => {
    const provider = fakeProvider(["not json at all"]);
    await expect(
      service(writes, { provider }).assessSupport({
        sessionId: SESSION_ID,
        claimId: CLAIM_ID,
        actor: "Researcher (researcher)",
        correlationId: newId()
      })
    ).rejects.toMatchObject({ code: "invalid_json" });
    expect(writes.assessments).toHaveLength(0);
  });

  it("refuses rather than pretending when no provider is configured", async () => {
    await expect(
      service(writes).assessSupport({
        sessionId: SESSION_ID,
        claimId: CLAIM_ID,
        actor: "Researcher (researcher)",
        correlationId: newId()
      })
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("answers 'not found' for a claim from another session", async () => {
    await expect(
      service(writes, { provider: fakeProvider(["{}"]) }).assessSupport({
        sessionId: SESSION_ID,
        claimId: newId(),
        actor: "Researcher (researcher)",
        correlationId: newId()
      })
    ).rejects.toMatchObject({ code: "claim_not_found", httpStatus: 404 });
  });

  it("never writes a verification status", async () => {
    const provider = fakeProvider([
      JSON.stringify({
        assessments: [
          {
            evidenceId: EVIDENCE_ID,
            status: "support",
            confidence: 0.9,
            rationale: "Looks right.",
            matchedExcerpt: "Shipments grew 12% year over year.",
            signals: []
          }
        ]
      })
    ]);
    await service(writes, { provider }).assessSupport({
      sessionId: SESSION_ID,
      claimId: CLAIM_ID,
      actor: "Researcher (researcher)",
      correlationId: newId()
    });
    // The repository surface has no verification write at all, so the failure
    // mode this guards against is a future field sneaking in.
    const serialized = JSON.stringify(writes.assessments);
    expect(serialized).not.toContain("verificationStatus");
    expect(serialized).not.toContain("verified");
  });

  it("reports a transport failure as unavailable, not as a model refusal", async () => {
    // "connection refused" contains "refused", and a classifier that reads it
    // as a refusal would tell the researcher to rephrase instead of checking
    // the endpoint. This is a regression test for exactly that mistake.
    const broken: LlmProvider = {
      name: "Broken",
      generate: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:9");
      }
    } as unknown as LlmProvider;
    await expect(
      service(writes, { provider: broken }).assessSupport({
        sessionId: SESSION_ID,
        claimId: CLAIM_ID,
        actor: "Researcher (researcher)",
        correlationId: newId()
      })
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("still reports a genuine refusal as a refusal", async () => {
    const refusing: LlmProvider = {
      name: "Refusing",
      generate: async () => {
        throw new Error("The model declined to answer this request.");
      }
    } as unknown as LlmProvider;
    await expect(
      service(writes, { provider: refusing }).assessSupport({
        sessionId: SESSION_ID,
        claimId: CLAIM_ID,
        actor: "Researcher (researcher)",
        correlationId: newId()
      })
    ).rejects.toMatchObject({ code: "refused" });
  });

  it("throws a named error carrying an HTTP status", async () => {
    const error = new CitationReviewError("timeout", "too slow", 504);
    expect(error.name).toBe("CitationReviewError");
    expect(error.httpStatus).toBe(504);
  });
});
