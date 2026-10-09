import { describe, expect, it, vi } from "vitest";
import {
  ClaimLinkError,
  EvidenceNotFoundError,
  SourceNotFoundError,
  SourceTitleConflictError
} from "@nexus/db";
import {
  newId,
  type Claim,
  type Evidence,
  type ExecutionEvent,
  type Source
} from "@nexus/shared";
import { createApp } from "../../app";
import { EventBus } from "../../execution/event-bus";

const SESSION_ID = newId();
const CLAIM_ID = newId();
const EVIDENCE_ID = newId();
const SOURCE_ID = newId();

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

function evidenceRecord(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: EVIDENCE_ID,
    sessionId: SESSION_ID,
    claimIds: [CLAIM_ID],
    kind: "external_reference",
    title: "Quarterly figures",
    content: "Shipments rose 12% year over year.",
    description: "Vendor-reported quarterly growth.",
    sourceRef: "https://example.org/report",
    direction: "supports",
    reliability: 0.6,
    verificationStatus: "unverified",
    retrievedAt: new Date().toISOString(),
    createdBy: "human",
    ...overrides
  };
}

function fakeEvent(type: ExecutionEvent["type"], payload: unknown): ExecutionEvent {
  return {
    id: newId(),
    sessionId: SESSION_ID,
    sequence: 3,
    correlationId: newId(),
    type,
    payload,
    occurredAt: new Date().toISOString()
  };
}

function buildApp(options: {
  role?: Role | null;
  evidence?: Partial<{
    createSource: unknown;
    listSources: unknown;
    createEvidence: unknown;
    listEvidence: unknown;
    getEvidence: unknown;
    getEvidenceContext: unknown;
    updateEvidence: unknown;
    setVerification: unknown;
  }>;
  arena?: Partial<{ createResearchClaim: unknown; getSessionArtifacts: unknown }>;
  reviews?: Partial<{ listReviews: unknown; listAgentRuns: unknown }>;
  session?: Record<string, unknown> | null;
}) {
  const role = options.role === undefined ? "reviewer" : options.role;
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
                ...(options.session ?? {})
              }
        )
      } as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never,
      evidence: (options.evidence ?? {}) as never,
      arena: (options.arena ?? {}) as never,
      reviews: options.reviews as never
    },
    undefined,
    { eventBus: new EventBus() }
  );
}

describe("evidence routes", () => {
  it("records evidence as unverified even when the body asks otherwise", async () => {
    const createEvidence = vi.fn(async (input: { evidence: Evidence }) => ({
      evidence: input.evidence,
      event: fakeEvent("EVIDENCE_RECORDED", {})
    }));
    const app = buildApp({ evidence: { createEvidence } });

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence`,
      headers: { "idempotency-key": "evidence-1" },
      payload: {
        kind: "external_reference",
        title: "Quarterly figures",
        content: "Shipments rose 12% year over year.",
        description: "Vendor-reported quarterly growth.",
        sourceRef: "https://example.org/report",
        direction: "supports",
        reliability: 0.6,
        claimIds: [CLAIM_ID],
        // A client must not be able to mint verified material.
        verificationStatus: "verified"
      }
    });

    expect(response.statusCode).toBe(201);
    const created = createEvidence.mock.calls[0]![0].evidence as Evidence;
    expect(created.verificationStatus).toBe("unverified");
    expect(created.verifiedBy).toBeUndefined();
    expect(created.claimIds).toEqual([CLAIM_ID]);
  });

  it("requires an idempotency key", async () => {
    const app = buildApp({ evidence: { createEvidence: vi.fn() } });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence`,
      payload: {
        kind: "external_reference",
        title: "t",
        content: "c",
        description: "d",
        direction: "supports",
        reliability: 0.5,
        claimIds: [CLAIM_ID]
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: /Idempotency-Key/i });
  });

  it("rejects evidence attached to no claim", async () => {
    const app = buildApp({ evidence: { createEvidence: vi.fn() } });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence`,
      headers: { "idempotency-key": "evidence-empty" },
      payload: {
        kind: "external_reference",
        title: "t",
        content: "c",
        description: "d",
        direction: "supports",
        reliability: 0.5,
        claimIds: []
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Invalid evidence request/i);
  });

  it("reports an untraceable external reference as a client error, not a crash", async () => {
    const app = buildApp({ evidence: { createEvidence: vi.fn() } });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence`,
      headers: { "idempotency-key": "evidence-untraceable" },
      payload: {
        kind: "external_reference",
        title: "t",
        content: "c",
        description: "d",
        direction: "supports",
        reliability: 0.5,
        claimIds: [CLAIM_ID]
      }
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses claims that are not part of this research", async () => {
    const app = buildApp({
      evidence: {
        createEvidence: vi.fn(async () => {
          throw new ClaimLinkError("Claim(s) not part of this research: x");
        })
      }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence`,
      headers: { "idempotency-key": "evidence-foreign" },
      payload: {
        kind: "external_reference",
        title: "t",
        content: "c",
        description: "d",
        sourceRef: "https://example.org/report",
        direction: "supports",
        reliability: 0.5,
        claimIds: [newId()]
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/not part of this research/i);
  });

  it("refuses a source that does not belong to this research", async () => {
    const app = buildApp({
      evidence: {
        createEvidence: vi.fn(async () => {
          throw new SourceNotFoundError(SOURCE_ID);
        })
      }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence`,
      headers: { "idempotency-key": "evidence-bad-source" },
      payload: {
        kind: "external_reference",
        title: "t",
        content: "c",
        description: "d",
        sourceId: SOURCE_ID,
        direction: "supports",
        reliability: 0.5,
        claimIds: [CLAIM_ID]
      }
    });
    expect(response.statusCode).toBe(400);
  });

  it("blocks viewers from recording evidence", async () => {
    const app = buildApp({ role: "viewer", evidence: { createEvidence: vi.fn() } });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence`,
      headers: { "idempotency-key": "evidence-viewer" },
      payload: {
        kind: "external_reference",
        title: "t",
        content: "c",
        description: "d",
        direction: "supports",
        reliability: 0.5,
        claimIds: [CLAIM_ID]
      }
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects anonymous writes", async () => {
    const app = buildApp({ role: null, evidence: { createEvidence: vi.fn() } });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence`,
      headers: { "idempotency-key": "evidence-anon" },
      payload: {
        kind: "external_reference",
        title: "t",
        content: "c",
        description: "d",
        direction: "supports",
        reliability: 0.5,
        claimIds: [CLAIM_ID]
      }
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("evidence verification route", () => {
  it("attributes the verification to the authenticated reviewer", async () => {
    const setVerification = vi.fn(async (input: { patch: unknown }) => ({
      evidence: evidenceRecord({
        ...(input.patch as Record<string, unknown>)
      }),
      event: fakeEvent("EVIDENCE_VERIFICATION_CHANGED", {})
    }));
    const app = buildApp({
      evidence: {
        getEvidence: vi.fn().mockResolvedValue(evidenceRecord()),
        setVerification
      }
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence/${EVIDENCE_ID}/verification`,
      headers: { "idempotency-key": "verify-1" },
      payload: {
        status: "verified",
        verificationNote: "Excerpt matches the published table.",
        // Ignored: identity comes from the session.
        verifiedBy: "someone else"
      }
    });

    expect(response.statusCode).toBe(200);
    const patch = setVerification.mock.calls[0]![0].patch as {
      verifiedBy: string;
      verificationStatus: string;
    };
    expect(patch.verifiedBy).toBe("Researcher One (researcher)");
    expect(patch.verificationStatus).toBe("verified");
    expect(response.json().verification).toEqual({
      from: "unverified",
      to: "verified"
    });
  });

  it("emits a verification change event", async () => {
    const setVerification = vi.fn(async (input: {
      patch: Record<string, unknown>;
      event: { type: string; payload: unknown };
    }) => ({
      evidence: evidenceRecord(input.patch),
      event: fakeEvent(input.event.type as ExecutionEvent["type"], input.event.payload)
    }));
    const app = buildApp({
      evidence: {
        getEvidence: vi.fn().mockResolvedValue(evidenceRecord()),
        setVerification
      }
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence/${EVIDENCE_ID}/verification`,
      headers: { "idempotency-key": "verify-2" },
      payload: {
        status: "verified",
        verificationNote: "Checked page 14."
      }
    });

    const body = response.json();
    expect(body.event.type).toBe("EVIDENCE_VERIFICATION_CHANGED");
    expect(body.event.payload).toMatchObject({
      from: "unverified",
      to: "verified",
      claimIds: [CLAIM_ID]
    });
  });

  it("refuses a verification without a reason", async () => {
    const app = buildApp({
      evidence: { getEvidence: vi.fn().mockResolvedValue(evidenceRecord()) }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence/${EVIDENCE_ID}/verification`,
      headers: { "idempotency-key": "verify-no-note" },
      payload: { status: "verified", verificationNote: "   " }
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses to verify an assumption", async () => {
    const app = buildApp({
      evidence: {
        getEvidence: vi
          .fn()
          .mockResolvedValue(evidenceRecord({ kind: "assumption" }))
      }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence/${EVIDENCE_ID}/verification`,
      headers: { "idempotency-key": "verify-assumption" },
      payload: { status: "verified", verificationNote: "seems sound" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/Assumptions cannot be verified/i);
  });

  it("refuses a no-op verification", async () => {
    const app = buildApp({
      evidence: {
        getEvidence: vi
          .fn()
          .mockResolvedValue(evidenceRecord({ verificationStatus: "verified" }))
      }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence/${EVIDENCE_ID}/verification`,
      headers: { "idempotency-key": "verify-noop" },
      payload: { status: "verified", verificationNote: "again" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/already verified/i);
  });

  it("returns 404 for unknown evidence", async () => {
    const app = buildApp({
      evidence: {
        getEvidence: vi.fn().mockResolvedValue(null)
      }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence/${EVIDENCE_ID}/verification`,
      headers: { "idempotency-key": "verify-missing" },
      payload: { status: "verified", verificationNote: "checked" }
    });
    expect(response.statusCode).toBe(404);
  });

  it("blocks viewers from verifying", async () => {
    const app = buildApp({
      role: "viewer",
      evidence: { getEvidence: vi.fn().mockResolvedValue(evidenceRecord()) }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence/${EVIDENCE_ID}/verification`,
      headers: { "idempotency-key": "verify-viewer" },
      payload: { status: "verified", verificationNote: "checked" }
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("source routes", () => {
  it("creates a citable source with publication metadata", async () => {
    const createSource = vi.fn(async (input: Source) => input);
    const app = buildApp({ evidence: { createSource } });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/sources`,
      headers: { "idempotency-key": "source-1" },
      payload: {
        title: "Statistical yearbook",
        kind: "document",
        url: "https://example.org/yearbook.pdf",
        publisher: "National Bureau of Statistics",
        author: "Editorial board",
        publishedAt: "2025-03-04T00:00:00.000Z",
        note: "Print edition."
      }
    });
    expect(response.statusCode).toBe(201);
    const source = createSource.mock.calls[0]![0];
    expect(source.publisher).toBe("National Bureau of Statistics");
    expect(source.publishedAt).toBe("2025-03-04T00:00:00.000Z");
  });

  it("rejects a url source with no url", async () => {
    const app = buildApp({ evidence: { createSource: vi.fn() } });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/sources`,
      headers: { "idempotency-key": "source-2" },
      payload: { title: "Broken", kind: "url" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Invalid source request/i);
  });

  it("reports a duplicate source title as a conflict", async () => {
    const app = buildApp({
      evidence: {
        createSource: vi.fn(async () => {
          throw new SourceTitleConflictError("Statistical yearbook");
        })
      }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/sources`,
      headers: { "idempotency-key": "source-3" },
      payload: { title: "Statistical yearbook", kind: "manual" }
    });
    expect(response.statusCode).toBe(409);
  });
});

describe("research claim route", () => {
  it("creates a claim with no agent run behind it", async () => {
    const createResearchClaim = vi.fn(async (input: {
      claim: Claim;
      event: { type: string; payload: unknown };
    }) => ({
      claim: input.claim,
      event: fakeEvent(input.event.type as ExecutionEvent["type"], input.event.payload)
    }));
    const app = buildApp({ arena: { createResearchClaim } });

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims`,
      headers: { "idempotency-key": "claim-1" },
      payload: {
        statement: "Shipments grew 12% year over year.",
        type: "fact",
        stance: "support",
        importance: 4
      }
    });

    expect(response.statusCode).toBe(201);
    const claim = createResearchClaim.mock.calls[0]![0].claim;
    expect(claim.agentRunId).toBeUndefined();
    expect(claim.roleId).toBeUndefined();
    expect(claim.status).toBe("proposed");
    expect(claim.rootClaimId).toBe(claim.id);
    expect(response.json().event.type).toBe("CLAIM_CREATED");
  });

  it("blocks viewers from adding claims", async () => {
    const app = buildApp({ role: "viewer", arena: { createResearchClaim: vi.fn() } });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims`,
      headers: { "idempotency-key": "claim-viewer" },
      payload: { statement: "x", type: "fact", stance: "support", importance: 2 }
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("research workspace route", () => {
  it("derives one verdict per claim and never claims certainty", async () => {
    const claim: Claim = {
      id: CLAIM_ID,
      sessionId: SESSION_ID,
      lens: "market",
      statement: "Shipments grew 12% year over year.",
      type: "fact",
      stance: "support",
      importance: 4,
      confidence: 0.5,
      evidenceIds: [],
      status: "proposed",
      rootClaimId: CLAIM_ID,
      revision: 1,
      relations: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const app = buildApp({
      evidence: {
        listEvidence: vi.fn().mockResolvedValue([evidenceRecord()]),
        listSources: vi.fn().mockResolvedValue([])
      },
      arena: {
        getSessionArtifacts: vi.fn().mockResolvedValue({
          claims: [claim],
          evidence: [],
          challenges: [],
          conflicts: []
        })
      },
      reviews: {
        listReviews: vi.fn().mockResolvedValue([]),
        listAgentRuns: vi.fn().mockResolvedValue([])
      }
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/research`
    });

    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.session.researchQuestion).toBe(
      "Did shipments grow last quarter?"
    );
    expect(body.verdicts).toHaveLength(1);
    // Nothing is verified yet, so the claim must stay unresolved.
    expect(body.verdicts[0].status).toBe("insufficient_evidence");
    expect(body.verdicts[0].confidence).toBe(0);
    expect(body.summary.openVerdicts).toBe(1);
    // Cross-examination and human rulings are part of the workspace payload,
    // even when the session has none yet.
    expect(body.challenges).toEqual([]);
    expect(body.agentRuns).toEqual([]);
    expect(body.reviews).toEqual([]);
  });

  it("returns 404 when the session does not exist", async () => {
    const app = buildApp({
      session: null,
      reviews: {
        listReviews: vi.fn().mockResolvedValue([]),
        listAgentRuns: vi.fn().mockResolvedValue([])
      }
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/research`
    });
    expect(response.statusCode).toBe(404);
  });

  it("reports 501 when review storage is not wired", async () => {
    const app = buildApp({
      evidence: {
        listEvidence: vi.fn().mockResolvedValue([]),
        listSources: vi.fn().mockResolvedValue([])
      },
      arena: {
        getSessionArtifacts: vi.fn().mockResolvedValue({
          claims: [],
          evidence: [],
          challenges: [],
          conflicts: []
        })
      }
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/research`
    });
    expect(response.statusCode).toBe(501);
  });

  it("reports 501 when evidence storage is not wired", async () => {
    const app = createApp({
      auth: fakeAuth("reviewer"),
      sessions: { getById: vi.fn() } as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/research`
    });
    expect(response.statusCode).toBe(501);
  });
});

describe("evidence detail route", () => {
  it("exposes the source, linked claims and conflicts", async () => {
    const app = buildApp({
      evidence: {
        getEvidenceContext: vi.fn().mockResolvedValue({
          evidence: evidenceRecord(),
          source: { id: SOURCE_ID, title: "Yearbook" },
          claims: [{ id: CLAIM_ID }],
          conflicts: [{ id: newId(), status: "human_review" }]
        })
      }
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/evidence/${EVIDENCE_ID}`
    });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.source.title).toBe("Yearbook");
    expect(body.claims).toHaveLength(1);
    expect(body.conflicts).toHaveLength(1);
  });

  it("returns 404 for unknown evidence", async () => {
    const app = buildApp({
      evidence: { getEvidenceContext: vi.fn().mockResolvedValue(null) }
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/evidence/${EVIDENCE_ID}`
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("evidence update route", () => {
  it("rejects an empty patch", async () => {
    const app = buildApp({ evidence: { updateEvidence: vi.fn() } });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${SESSION_ID}/evidence/${EVIDENCE_ID}`,
      headers: { "idempotency-key": "patch-empty" },
      payload: {}
    });
    expect(response.statusCode).toBe(400);
  });

  it("maps a missing evidence row to 404", async () => {
    const app = buildApp({
      evidence: {
        updateEvidence: vi.fn(async () => {
          throw new EvidenceNotFoundError(EVIDENCE_ID);
        })
      }
    });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${SESSION_ID}/evidence/${EVIDENCE_ID}`,
      headers: { "idempotency-key": "patch-missing" },
      payload: { locator: "p. 14" }
    });
    expect(response.statusCode).toBe(404);
  });

  it("relinks an excerpt to several claims", async () => {
    const secondClaim = newId();
    const updateEvidence = vi.fn(async (input: { patch: Record<string, unknown> }) => ({
      evidence: evidenceRecord(input.patch),
      event: fakeEvent("EVIDENCE_RECORDED", {})
    }));
    const app = buildApp({ evidence: { updateEvidence } });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${SESSION_ID}/evidence/${EVIDENCE_ID}`,
      headers: { "idempotency-key": "patch-link" },
      payload: { claimIds: [CLAIM_ID, secondClaim] }
    });
    expect(response.statusCode).toBe(200);
    expect(
      (updateEvidence.mock.calls[0]![0].patch.claimIds as string[])
    ).toEqual([CLAIM_ID, secondClaim]);
  });
});
