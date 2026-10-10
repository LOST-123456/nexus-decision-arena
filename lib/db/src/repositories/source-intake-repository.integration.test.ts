import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  newId,
  type Evidence,
  type Source,
  type SourceSnapshot
} from "@nexus/shared";
import type { Database } from "../client";
import { createTestDatabase } from "../testing/test-database";
import { decisionSessions, projects } from "../schema";
import { EvidenceRepository, SourceNotFoundError } from "./evidence-repository";

/**
 * Persistence for the intake slice: retrieval results, versioned snapshots and
 * the locator anchors that keep an excerpt re-checkable.
 *
 * Runs only against a dedicated test database: the guard refuses before
 * connecting when TEST_DATABASE_URL is missing or points anywhere unsafe.
 */
const database: Database = createTestDatabase();
const repository = new EvidenceRepository(database);

beforeEach(async () => {
  await database.execute(
    "TRUNCATE source_snapshots, execution_events, conflicts, evidence, sources, claims, decision_sessions, projects CASCADE"
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
  return sessionId;
}

async function seedImportedSource(
  sessionId: string,
  canonicalUrl = "https://example.test/report"
): Promise<Source> {
  const now = new Date().toISOString();
  const registered = await repository.createSource({
    id: newId(),
    sessionId,
    title: "Example report",
    kind: "url",
    url: canonicalUrl,
    canonicalUrl,
    retrievalStatus: "pending",
    retrievalAttempts: 0,
    createdBy: "human",
    createdAt: now,
    updatedAt: now
  });
  return registered.source;
}

function snapshotFor(
  sessionId: string,
  sourceId: string,
  input: { hash: string; content: string; title?: string; retrievedAt?: string }
): SourceSnapshot {
  const now = input.retrievedAt ?? new Date().toISOString();
  return {
    id: newId(),
    sessionId,
    sourceId,
    canonicalUrl: "https://example.test/report",
    contentHash: input.hash,
    contentType: "text/html",
    content: input.content,
    contentBytes: Buffer.byteLength(input.content, "utf8"),
    charCount: input.content.length,
    retrievedAt: now,
    createdAt: now,
    ...(input.title ? { title: input.title } : {})
  };
}

const event = (sessionId: string, correlationId: string) => {
  void sessionId;
  return {
    correlationId,
    type: "SOURCE_RETRIEVED" as const,
    payload: { sourceId: correlationId }
  };
};

describe("retrieval state", () => {
  it("records a successful retrieval and points the source at it", async () => {
    const sessionId = await seedSession();
    const source = await seedImportedSource(sessionId);

    const result = await repository.recordRetrievalSuccess({
      snapshot: snapshotFor(sessionId, source.id, {
        hash: "hash-v1",
        content: "first capture",
        title: "Read off the page"
      }),
      source: { title: "Read off the page", publisher: "Stats Office" },
      event: event(sessionId, source.id)
    });

    expect(result.created).toBe(true);
    expect(result.source.retrievalStatus).toBe("fetched");
    expect(result.source.contentHash).toBe("hash-v1");
    expect(result.source.retrievalAttempts).toBe(1);
    expect(result.source.retrievalError).toBeUndefined();
    expect(result.source.retrievedAt).not.toBeUndefined();
    // The retrieval fact is its own axis: nothing here says the excerpts are
    // verified.
    expect(result.source.contentType).toBe("text/html");
  });

  it("keeps the older version when the page changes", async () => {
    const sessionId = await seedSession();
    const source = await seedImportedSource(sessionId);

    await repository.recordRetrievalSuccess({
      snapshot: snapshotFor(sessionId, source.id, {
        hash: "hash-v1",
        content: "first capture"
      }),
      source: {},
      event: event(sessionId, source.id)
    });
    const second = await repository.recordRetrievalSuccess({
      snapshot: snapshotFor(sessionId, source.id, {
        hash: "hash-v2",
        content: "second capture"
      }),
      source: {},
      event: event(sessionId, source.id)
    });

    expect(second.created).toBe(true);
    expect(second.source.contentHash).toBe("hash-v2");
    expect(second.source.retrievalAttempts).toBe(2);

    const versions = await repository.listSnapshots(sessionId, source.id);
    expect(versions.map((item) => item.contentHash).sort()).toEqual([
      "hash-v1",
      "hash-v2"
    ]);
    // The older text is still readable, which is what lets an excerpt confirmed
    // against it be re-checked after the page moved on.
    expect(versions.find((item) => item.contentHash === "hash-v1")?.content).toBe(
      "first capture"
    );
    const current = await repository.getCurrentSnapshot(sessionId, source.id);
    expect(current?.contentHash).toBe("hash-v2");
  });

  it("does not create a second version for unchanged text", async () => {
    const sessionId = await seedSession();
    const source = await seedImportedSource(sessionId);

    await repository.recordRetrievalSuccess({
      snapshot: snapshotFor(sessionId, source.id, {
        hash: "same",
        content: "same text"
      }),
      source: {},
      event: event(sessionId, source.id)
    });
    const again = await repository.recordRetrievalSuccess({
      snapshot: snapshotFor(sessionId, source.id, {
        hash: "same",
        content: "same text"
      }),
      source: {},
      event: event(sessionId, source.id)
    });

    expect(again.created).toBe(false);
    // Re-reading a page still counts as an attempt, so "we tried" stays honest.
    expect(again.source.retrievalAttempts).toBe(2);
    expect(await repository.listSnapshots(sessionId, source.id)).toHaveLength(1);
  });

  it("persists a failed retrieval with its reason and attempt count", async () => {
    const sessionId = await seedSession();
    const source = await seedImportedSource(sessionId);

    const failed = await repository.recordRetrievalFailure({
      sessionId,
      sourceId: source.id,
      error: "Only text pages can be imported (got application/pdf)",
      attemptedAt: new Date().toISOString(),
      event: event(sessionId, source.id)
    });

    const stored = await repository.getSource(sessionId, source.id);
    expect(failed.source.retrievalStatus).toBe("failed");
    expect(stored?.retrievalStatus).toBe("failed");
    expect(stored?.retrievalError).toContain("application/pdf");
    expect(stored?.retrievalAttempts).toBe(1);
    // Nothing was captured, so the source still has no content hash.
    expect(stored?.contentHash).toBeUndefined();
    expect(await repository.listSnapshots(sessionId, source.id)).toHaveLength(0);
  });

  it("finds a re-imported page by its canonical url", async () => {
    const sessionId = await seedSession();
    const source = await seedImportedSource(sessionId);

    const found = await repository.findSourceByCanonicalUrl(
      sessionId,
      "https://example.test/report"
    );
    expect(found?.id).toBe(source.id);
    expect(
      await repository.findSourceByCanonicalUrl(sessionId, "https://example.test/other")
    ).toBeNull();
  });

  it("refuses to write retrieval state across sessions", async () => {
    const owner = await seedSession();
    const other = await seedSession();
    const source = await seedImportedSource(owner);

    await expect(
      repository.recordRetrievalSuccess({
        snapshot: snapshotFor(other, source.id, {
          hash: "hash-v1",
          content: "x"
        }),
        source: {},
        event: event(other, source.id)
      })
    ).rejects.toThrow(SourceNotFoundError);

    await expect(
      repository.recordRetrievalFailure({
        sessionId: other,
        sourceId: source.id,
        error: "nope",
        attemptedAt: new Date().toISOString(),
        event: event(other, source.id)
      })
    ).rejects.toThrow(SourceNotFoundError);

    // The other session cannot read it through its own scope either.
    expect(await repository.getCurrentSnapshot(other, source.id)).toBeNull();
    expect(await repository.listSnapshots(other, source.id)).toHaveLength(0);
  });
});

describe("excerpt anchors", () => {
  async function seedClaim(sessionId: string): Promise<string> {
    const claimId = newId();
    const now = new Date().toISOString();
    await database.execute(
      `INSERT INTO claims (id, session_id, lens, statement, type, stance, importance, confidence, evidence_ids, status, root_claim_id, revision, relations, created_at, updated_at)
       VALUES ('${claimId}', '${sessionId}', 'research', 'Shipments grew.', 'fact', 'support', 3, 0.5, '[]'::jsonb, 'proposed', '${claimId}', 1, '[]'::jsonb, '${now}', '${now}')`
    );
    return claimId;
  }

  it("stores the anchor and keeps a confirmed excerpt unverified", async () => {
    const sessionId = await seedSession();
    const source = await seedImportedSource(sessionId);
    const captured = await repository.recordRetrievalSuccess({
      snapshot: snapshotFor(sessionId, source.id, {
        hash: "hash-v1",
        content: "Shipments grew 12% year over year according to the report."
      }),
      source: {},
      event: event(sessionId, source.id)
    });
    const claimId = await seedClaim(sessionId);
    const now = new Date().toISOString();

    const created = await repository.createEvidence({
      evidence: {
        id: newId(),
        sessionId,
        claimIds: [claimId],
        kind: "external_reference",
        title: "Shipment growth",
        content: "Shipments grew 12% year over year",
        description: "Confirmed against the imported page text.",
        sourceId: source.id,
        locator: "第 1 段",
        locatorKind: "quote",
        locatorStatus: "anchored",
        anchorText: "Shipments grew 12% year over year",
        sourceContentHash: captured.snapshot.contentHash,
        direction: "supports",
        reliability: 0.7,
        // Confirming a candidate excerpt records a citation, not a verdict.
        verificationStatus: "unverified",
        retrievedAt: now,
        createdBy: "human"
      } satisfies Evidence,
      event: {
        correlationId: newId(),
        type: "EVIDENCE_RECORDED",
        payload: {}
      }
    });

    expect(created.evidence.locatorStatus).toBe("anchored");
    expect(created.evidence.locatorKind).toBe("quote");
    expect(created.evidence.anchorText).toBe("Shipments grew 12% year over year");
    expect(created.evidence.sourceContentHash).toBe("hash-v1");
    expect(created.evidence.verificationStatus).toBe("unverified");

    const context = await repository.getEvidenceContext(sessionId, created.evidence.id);
    expect(context?.snapshot?.contentHash).toBe("hash-v1");
    expect(context?.source?.id).toBe(source.id);
  });

  it("can mark an anchor as missing without touching verification", async () => {
    const sessionId = await seedSession();
    const source = await seedImportedSource(sessionId);
    await repository.recordRetrievalSuccess({
      snapshot: snapshotFor(sessionId, source.id, {
        hash: "hash-v2",
        content: "The page was rewritten and no longer says this."
      }),
      source: {},
      event: event(sessionId, source.id)
    });
    const claimId = await seedClaim(sessionId);
    const now = new Date().toISOString();

    const created = await repository.createEvidence({
      evidence: {
        id: newId(),
        sessionId,
        claimIds: [claimId],
        kind: "external_reference",
        title: "Old quote",
        content: "a quote from the previous version of the page",
        description: "Recorded against an earlier capture.",
        sourceId: source.id,
        locatorKind: "quote",
        locatorStatus: "anchored",
        anchorText: "a quote from the previous version of the page",
        sourceContentHash: "hash-v1",
        direction: "supports",
        reliability: 0.6,
        verificationStatus: "unverified",
        retrievedAt: now,
        createdBy: "human"
      } satisfies Evidence,
      event: { correlationId: newId(), type: "EVIDENCE_RECORDED", payload: {} }
    });

    const updated = await repository.updateEvidence({
      sessionId,
      evidenceId: created.evidence.id,
      patch: { locatorStatus: "missing" },
      event: {
        correlationId: created.evidence.id,
        type: "EVIDENCE_RECORDED",
        payload: {}
      }
    });

    expect(updated.evidence.locatorStatus).toBe("missing");
    // A locator problem is not a verification verdict: the two stay separate.
    expect(updated.evidence.verificationStatus).toBe("unverified");
    expect(updated.evidence.verifiedBy).toBeUndefined();
    expect(updated.evidence.sourceContentHash).toBe("hash-v1");
  });

  it("lists the excerpts drawn from one source", async () => {
    const sessionId = await seedSession();
    const source = await seedImportedSource(sessionId);
    const claimId = await seedClaim(sessionId);
    const now = new Date().toISOString();

    for (const title of ["first", "second"]) {
      await repository.createEvidence({
        evidence: {
          id: newId(),
          sessionId,
          claimIds: [claimId],
          kind: "external_reference",
          title,
          content: `excerpt ${title}`,
          description: "d",
          sourceId: source.id,
          direction: "context",
          reliability: 0.5,
          verificationStatus: "unverified",
          retrievedAt: now,
          createdBy: "human"
        } satisfies Evidence,
        event: { correlationId: newId(), type: "EVIDENCE_RECORDED", payload: {} }
      });
    }

    const items = await repository.listEvidenceForSource(sessionId, source.id);
    expect(items.map((item) => item.title).sort()).toEqual(["first", "second"]);
  });
});
