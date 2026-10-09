import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  newId,
  type Claim,
  type Evidence,
  type Source
} from "@nexus/shared";
import type { Database } from "../client";
import { createTestDatabase } from "../testing/test-database";
import {
  claims,
  conflicts,
  decisionSessions,
  executionEvents,
  projects
} from "../schema";
import {
  ClaimLinkError,
  EvidenceRepository,
  SourceNotFoundError,
  SourceTitleConflictError
} from "./evidence-repository";

// fail-closed: without TEST_DATABASE_URL this throws before connecting, and the
// target has to be a dedicated test database.
const database: Database = createTestDatabase();
const repository = new EvidenceRepository(database);

beforeEach(async () => {
  await database.execute(
    "TRUNCATE execution_events, conflicts, evidence, sources, claims, decision_sessions, projects CASCADE"
  );
});

afterAll(async () => {
  await database.end();
});

async function seedSession(): Promise<{ sessionId: string; projectId: string }> {
  const projectId = newId();
  const sessionId = newId();
  await database.insert(projects).values({
    id: projectId,
    name: "Research",
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
  return { sessionId, projectId };
}

/** Human-authored claim: no agent run, no role. */
async function seedClaim(
  sessionId: string,
  overrides: Partial<Claim> = {}
): Promise<string> {
  const claimId = newId();
  const now = new Date().toISOString();
  await database.insert(claims).values({
    id: claimId,
    sessionId,
    lens: "market",
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
    updatedAt: now,
    ...overrides
  } as never);
  return claimId;
}

function sourceDraft(
  sessionId: string,
  overrides: Partial<Source> = {}
): Source {
  const now = new Date().toISOString();
  return {
    id: newId(),
    sessionId,
    title: "Statistical yearbook",
    kind: "document",
    url: "https://example.org/yearbook.pdf",
    publisher: "National Bureau of Statistics",
    author: "Editorial board",
    publishedAt: "2025-03-04T00:00:00.000Z",
    note: "Print edition.",
    createdBy: "human",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function evidenceDraft(
  sessionId: string,
  claimIds: string[],
  overrides: Partial<Evidence> = {}
): Evidence {
  return {
    id: newId(),
    sessionId,
    claimIds,
    kind: "external_reference",
    title: "Quarterly shipment figures",
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

async function eventsOfType(sessionId: string, type: string) {
  return database
    .select()
    .from(executionEvents)
    .where(eq(executionEvents.sessionId, sessionId))
    .then((rows) =>
      rows.filter((row) => row.type === type).sort((a, b) => a.sequence - b.sequence)
    );
}

describe("EvidenceRepository (isolated test database)", () => {
  it("persists a citable source and lists it back", async () => {
    const { sessionId } = await seedSession();
    const source = sourceDraft(sessionId);
    await repository.createSource(source);

    const listed = await repository.listSources(sessionId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      title: "Statistical yearbook",
      publisher: "National Bureau of Statistics",
      author: "Editorial board",
      publishedAt: "2025-03-04T00:00:00.000Z",
      kind: "document"
    });
  });

  it("refuses a duplicate source title inside the same research", async () => {
    const { sessionId } = await seedSession();
    await repository.createSource(sourceDraft(sessionId));
    await expect(
      repository.createSource(sourceDraft(sessionId, { id: newId() }))
    ).rejects.toBeInstanceOf(SourceTitleConflictError);
  });

  it("does not return a source from another session", async () => {
    const { sessionId } = await seedSession();
    const other = await seedSession();
    const source = sourceDraft(sessionId);
    await repository.createSource(source);

    expect(await repository.getSource(other.sessionId, source.id)).toBeNull();
    expect(await repository.getSource(sessionId, source.id)).not.toBeNull();
  });

  it("records evidence together with an EVIDENCE_RECORDED event", async () => {
    const { sessionId } = await seedSession();
    const claimId = await seedClaim(sessionId);
    const draft = evidenceDraft(sessionId, [claimId]);

    const { evidence, event } = await repository.createEvidence({
      evidence: draft,
      event: {
        correlationId: draft.id,
        type: "EVIDENCE_RECORDED",
        payload: { evidenceId: draft.id }
      }
    });

    expect(evidence.id).toBe(draft.id);
    expect(evidence.claimIds).toEqual([claimId]);
    expect(event.type).toBe("EVIDENCE_RECORDED");
    expect(event.sequence).toBeGreaterThan(0);
    await expect(eventsOfType(sessionId, "EVIDENCE_RECORDED")).resolves.toHaveLength(1);
  });

  it("refuses to link evidence to a claim outside the session", async () => {
    const { sessionId } = await seedSession();
    const other = await seedSession();
    const foreignClaim = await seedClaim(other.sessionId);

    await expect(
      repository.createEvidence({
        evidence: evidenceDraft(sessionId, [foreignClaim]),
        event: { correlationId: newId(), type: "EVIDENCE_RECORDED", payload: {} }
      })
    ).rejects.toBeInstanceOf(ClaimLinkError);
  });

  it("refuses a source that belongs to another session", async () => {
    const { sessionId } = await seedSession();
    const other = await seedSession();
    const claimId = await seedClaim(sessionId);
    const foreignSource = sourceDraft(other.sessionId);
    await repository.createSource(foreignSource);

    await expect(
      repository.createEvidence({
        evidence: evidenceDraft(sessionId, [claimId], {
          sourceId: foreignSource.id
        }),
        event: { correlationId: newId(), type: "EVIDENCE_RECORDED", payload: {} }
      })
    ).rejects.toBeInstanceOf(SourceNotFoundError);
  });

  it("filters evidence by claim, direction and verification status", async () => {
    const { sessionId } = await seedSession();
    const claimA = await seedClaim(sessionId);
    const claimB = await seedClaim(sessionId, {
      statement: "Growth was flat.",
      stance: "oppose"
    });

    await repository.createEvidence({
      evidence: evidenceDraft(sessionId, [claimA]),
      event: { correlationId: newId(), type: "EVIDENCE_RECORDED", payload: {} }
    });
    await repository.createEvidence({
      evidence: evidenceDraft(sessionId, [claimB], { direction: "opposes" }),
      event: { correlationId: newId(), type: "EVIDENCE_RECORDED", payload: {} }
    });

    await expect(repository.listEvidence(sessionId)).resolves.toHaveLength(2);
    await expect(
      repository.listEvidence(sessionId, { claimId: claimA })
    ).resolves.toHaveLength(1);
    await expect(
      repository.listEvidence(sessionId, { direction: "opposes" })
    ).resolves.toHaveLength(1);
    await expect(
      repository.listEvidence(sessionId, { verificationStatus: "verified" })
    ).resolves.toHaveLength(0);
  });

  it("persists a verification decision and its audit event", async () => {
    const { sessionId } = await seedSession();
    const claimId = await seedClaim(sessionId);
    const { evidence } = await repository.createEvidence({
      evidence: evidenceDraft(sessionId, [claimId]),
      event: { correlationId: newId(), type: "EVIDENCE_RECORDED", payload: {} }
    });

    const verifiedAt = new Date().toISOString();
    const { evidence: updated, event } = await repository.setVerification({
      sessionId,
      evidenceId: evidence.id,
      patch: {
        verificationStatus: "verified",
        verifiedBy: "Researcher One",
        verifiedAt,
        verificationNote: "Excerpt matches page 14."
      },
      event: {
        correlationId: evidence.id,
        type: "EVIDENCE_VERIFICATION_CHANGED",
        payload: { from: "unverified", to: "verified" }
      }
    });

    expect(updated.verificationStatus).toBe("verified");
    expect(updated.verifiedBy).toBe("Researcher One");
    expect(updated.verifiedAt).toBe(verifiedAt);
    expect(updated.verificationNote).toBe("Excerpt matches page 14.");
    expect(event.type).toBe("EVIDENCE_VERIFICATION_CHANGED");

    // Reload from the database: the change must survive the round trip.
    const reloaded = await repository.getEvidence(sessionId, evidence.id);
    expect(reloaded?.verificationStatus).toBe("verified");
    expect(reloaded?.verifiedBy).toBe("Researcher One");
  });

  it("keeps one excerpt reachable from every claim it bears on", async () => {
    const { sessionId } = await seedSession();
    const claimA = await seedClaim(sessionId);
    const claimB = await seedClaim(sessionId, { statement: "Second claim." });
    const { evidence } = await repository.createEvidence({
      evidence: evidenceDraft(sessionId, [claimA]),
      event: { correlationId: newId(), type: "EVIDENCE_RECORDED", payload: {} }
    });

    const { evidence: relinked } = await repository.updateEvidence({
      sessionId,
      evidenceId: evidence.id,
      patch: { claimIds: [claimA, claimB] },
      event: { correlationId: evidence.id, type: "EVIDENCE_RECORDED", payload: {} }
    });
    expect(relinked.claimIds).toHaveLength(2);

    await expect(
      repository.listEvidenceForClaim(sessionId, claimA)
    ).resolves.toHaveLength(1);
    await expect(
      repository.listEvidenceForClaim(sessionId, claimB)
    ).resolves.toHaveLength(1);
  });

  it("refuses to relink an excerpt to a foreign claim", async () => {
    const { sessionId } = await seedSession();
    const other = await seedSession();
    const claimId = await seedClaim(sessionId);
    const foreignClaim = await seedClaim(other.sessionId);
    const { evidence } = await repository.createEvidence({
      evidence: evidenceDraft(sessionId, [claimId]),
      event: { correlationId: newId(), type: "EVIDENCE_RECORDED", payload: {} }
    });

    await expect(
      repository.updateEvidence({
        sessionId,
        evidenceId: evidence.id,
        patch: { claimIds: [foreignClaim] },
        event: { correlationId: evidence.id, type: "EVIDENCE_RECORDED", payload: {} }
      })
    ).rejects.toBeInstanceOf(ClaimLinkError);
  });

  it("returns the source, linked claims and conflicts for one excerpt", async () => {
    const { sessionId } = await seedSession();
    const claimId = await seedClaim(sessionId);
    const source = sourceDraft(sessionId);
    await repository.createSource(source);
    const { evidence } = await repository.createEvidence({
      evidence: evidenceDraft(sessionId, [claimId], { sourceId: source.id }),
      event: { correlationId: newId(), type: "EVIDENCE_RECORDED", payload: {} }
    });
    const conflictId = newId();
    await database.insert(conflicts).values({
      id: conflictId,
      sessionId,
      claimIds: [claimId],
      challengeIds: [],
      type: "evidence",
      summary: "Sources disagree.",
      severity: 4,
      status: "human_review",
      humanDecisionRequired: true,
      resolutionSuggestion: "Reconcile the figures.",
      impactScope: { analysisAreas: ["market"], stakeholders: ["team"] }
    });

    const context = await repository.getEvidenceContext(sessionId, evidence.id);
    expect(context).not.toBeNull();
    expect(context!.source?.id).toBe(source.id);
    expect(context!.claims.map((claim) => claim.id)).toEqual([claimId]);
    expect(context!.conflicts.map((conflict) => conflict.id)).toEqual([conflictId]);
  });

  it("returns null for an excerpt in another session", async () => {
    const { sessionId } = await seedSession();
    const other = await seedSession();
    const claimId = await seedClaim(sessionId);
    const { evidence } = await repository.createEvidence({
      evidence: evidenceDraft(sessionId, [claimId]),
      event: { correlationId: newId(), type: "EVIDENCE_RECORDED", payload: {} }
    });
    expect(await repository.getEvidenceContext(other.sessionId, evidence.id)).toBeNull();
  });
});
