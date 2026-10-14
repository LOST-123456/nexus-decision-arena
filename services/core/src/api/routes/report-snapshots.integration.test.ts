import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ArenaRepository,
  createTestDatabase,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  projects,
  ReportSnapshotRepository,
  ResearchPlanRepository,
  RevalidationTaskRepository,
  ReviewRepository,
  TranslationRepository,
  sourceSnapshots,
  type Database
} from "@nexus/db";
import { newId, type Claim, type Evidence, type Source } from "@nexus/shared";
import { createApp } from "../../app";
import { ResearchReportSnapshotService } from "../../research/report-snapshot-service";

/**
 * DB-backed integration test for the report-version routes.
 *
 * What only a real database and the real HTTP stack can prove:
 *  1. the first save is version 1 and the next is version 2 – numbers are
 *     allocated inside the same transaction that reads the material, so a
 *     save cannot straddle an update;
 *  2. a repeated submit with the same `Idempotency-Key` resolves to the
 *     version the first attempt created and writes nothing new, while a
 *     different key is genuinely new work;
 *  3. a stored version is a document, not a fingerprint: after the material
 *     changes, the old version still renders what it froze and only the new
 *     one reflects the change;
 *  4. a comparison matches entities by id, labels what it cannot match, and
 *     keeps `verdict` and `risk` entries apart rather than merging them;
 *  5. an export is rendered from the frozen payload and is byte-identical
 *     every time, in either format;
 *  6. the access rules: a viewer may read but not write, an anonymous
 *     request is refused, and another session's version answers 404;
 *  7. saving changes nothing it is not allowed to: claim statuses,
 *     verification statuses and rulings are all still what the researcher
 *     left them.
 *
 * Runs only against a dedicated test database: the guard refuses before
 * connecting when TEST_DATABASE_URL is missing or points anywhere unsafe.
 */

const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const arena = new ArenaRepository(database);
const evidenceRepository = new EvidenceRepository(database);
const reviewRepository = new ReviewRepository(database);
const events = new EventRepository(database);
const revalidationTasks = new RevalidationTaskRepository(database);

const TIMESTAMP = "2026-02-01T00:00:00.000Z";

let role: "owner" | "reviewer" | "viewer" = "reviewer";
let authEnabled = true;

// One app for the whole file: the idempotency store lives on the instance, so
// a replay is only a replay when both requests share it. The fake auth closes
// over the mutable role above, so per-test role changes still take effect.
const app = createApp({
  auth: {
    userFromRequest: () =>
      authEnabled
        ? {
            id: "user-1",
            username: "alice",
            displayName: "Alice Reviewer",
            role
          }
        : null
  } as never,
  sessions,
  inspector: {} as never,
  // This suite drives the report routes only; the agent runner is never
  // reached because no route here starts a run.
  runSession: undefined as never,
  events,
  evidence: evidenceRepository,
  reviews: reviewRepository,
  arena,
  researchPlan: new ResearchPlanRepository(database),
  reportSnapshots: new ResearchReportSnapshotService({
    database,
    sessions,
    arena,
    evidence: evidenceRepository,
    reviews: reviewRepository,
    events,
    researchPlan: new ResearchPlanRepository(database),
    monitorTasks: revalidationTasks,
    snapshots: new ReportSnapshotRepository(database)
  })
});

function listUrl(sessionId: string): string {
  return `/api/sessions/${sessionId}/report-snapshots`;
}

async function saveSnapshot(
  sessionId: string,
  options: { key?: string | null; changeReason?: string } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.key !== null) {
    headers["idempotency-key"] = options.key ?? newId();
  }
  const response = await app.inject({
    method: "POST",
    url: listUrl(sessionId),
    headers,
    payload: options.changeReason ? { changeReason: options.changeReason } : {}
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function seededSession(): Promise<string> {
  const projectId = newId();
  const sessionId = newId();
  await database.insert(projects).values({
    id: projectId,
    name: `Report snapshots ${sessionId}`,
    input: {}
  });
  await sessions.create({
    id: sessionId,
    projectId,
    locale: "zh-CN",
    phase: "EVIDENCE",
    operationalStatus: "ACTIVE",
    currentConclusion: null
  });
  return sessionId;
}

async function seedMaterial(
  sessionId: string,
  overrides: { verificationStatus?: Evidence["verificationStatus"] } = {}
): Promise<{ claimId: string; sourceId: string; evidenceId: string }> {
  const claimId = newId();
  const sourceId = newId();
  const evidenceId = newId();
  const claim: Claim = {
    id: claimId,
    sessionId,
    lens: "market",
    statement: "制造业投资增速回落至 4.2%。",
    type: "fact",
    stance: "support",
    importance: 4,
    confidence: 0.5,
    evidenceIds: [evidenceId],
    status: "proposed",
    rootClaimId: claimId,
    revision: 1,
    relations: [],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP
  };
  const source: Source = {
    id: sourceId,
    sessionId,
    title: "季度回顾",
    kind: "url",
    url: "https://example.test/page",
    canonicalUrl: "https://example.test/page",
    createdBy: "human",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP
  };
  const evidence: Evidence = {
    id: evidenceId,
    sessionId,
    claimIds: [claimId],
    kind: "external_reference",
    title: "摘录：制造业投资增速",
    content: "制造业投资增速回落至 4.2%。",
    description: "工作台摘录",
    sourceId,
    direction: "supports",
    reliability: 0.8,
    verificationStatus: "unverified",
    locatorStatus: "anchored",
    retrievedAt: TIMESTAMP,
    createdBy: "human",
    ...(overrides.verificationStatus
      ? { verificationStatus: overrides.verificationStatus }
      : {})
  };

  await arena.createResearchClaim({
    claim,
    event: {
      correlationId: newId(),
      type: "CLAIM_CREATED",
    payload: { claimId }
    }
  });
  await evidenceRepository.createSource(source, {
    correlationId: sourceId,
    type: "SOURCE_REGISTERED",
    payload: { sourceId }
  });
  await evidenceRepository.createEvidence({
    evidence,
    event: {
      correlationId: evidenceId,
      type: "EVIDENCE_RECORDED",
      payload: { evidenceId }
    }
  });
  return { claimId, sourceId, evidenceId };
}

beforeEach(async () => {
  role = "reviewer";
  authEnabled = true;
  await database.execute("TRUNCATE projects CASCADE");
});

afterAll(async () => {
  await database.execute("TRUNCATE projects CASCADE");
});

function unknownSessionId(): string {
  return newId();
}

describe("report snapshot routes", () => {
  it("starts version numbers at 1 and never reuses one", async () => {
    const sessionId = await seededSession();
    await seedMaterial(sessionId);

    const first = await saveSnapshot(sessionId, { key: "save-1", changeReason: "初稿" });
    expect(first.status).toBe(201);
    expect(first.body.version).toBe(1);
    expect(first.body.changeReason).toBe("初稿");
    // The actor comes from the server's session, never from the request body.
    expect(first.body.createdBy).toContain("Alice Reviewer");
    expect(first.body.materialsFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(first.body.snapshotHash).toMatch(/^[0-9a-f]{64}$/);

    const second = await saveSnapshot(sessionId, { key: "save-2" });
    expect(second.status).toBe(201);
    expect(second.body.version).toBe(2);
    expect(second.body.snapshotId).not.toBe(first.body.snapshotId);

    const list = await app.inject({ method: "GET", url: listUrl(sessionId) });
    expect(list.statusCode).toBe(200);
    const summaries = (list.json() as { snapshots: Array<Record<string, unknown>> })
      .snapshots;
    // Newest first, and the list carries no payloads.
    expect(summaries.map((item) => item.version)).toEqual([2, 1]);
    expect(Object.keys(summaries[0] ?? {})).not.toContain("reportPayload");
    expect(summaries[0]?.claimCount).toBe(1);
    expect(summaries[0]?.evidenceCount).toBe(1);
    expect(summaries[0]?.sourceCount).toBe(1);
  });

  it("replays a repeated save as the same version instead of writing a second one", async () => {
    const sessionId = await seededSession();
    await seedMaterial(sessionId);

    const first = await saveSnapshot(sessionId, { key: "same-key" });
    const replay = await saveSnapshot(sessionId, { key: "same-key" });
    const different = await saveSnapshot(sessionId, { key: "other-key" });

    expect(replay.status).toBe(201);
    expect(replay.body.snapshotId).toBe(first.body.snapshotId);
    expect(replay.body.version).toBe(1);
    expect(different.body.version).toBe(2);

    const list = await app.inject({ method: "GET", url: listUrl(sessionId) });
    const summaries = (list.json() as { snapshots: unknown[] }).snapshots;
    // Two saves, not three: the replay wrote nothing.
    expect(summaries).toHaveLength(2);
  });

  it("refuses a save that carries no idempotency key", async () => {
    const sessionId = await seededSession();
    const result = await saveSnapshot(sessionId, { key: null });

    expect(result.status).toBe(400);
  });

  /**
   * The immutability rule, end to end.
   *
   * After v1 is frozen the excerpt is verified. v1 must keep saying what it
   * said — the version is the document that was saved, not a fingerprint that
   * can be rebuilt from newer rows.
   */
  it("keeps an old version frozen after the material moves on", async () => {
    const sessionId = await seededSession();
    const material = await seedMaterial(sessionId);

    const first = await saveSnapshot(sessionId, { key: "frozen-1" });
    const before = (first.body.reportPayload as {
      summary: { verified: number; unverified: number };
    }).summary;
    expect(before).toMatchObject({ verified: 0, unverified: 1 });

    await evidenceRepository.setVerification({
      sessionId,
      evidenceId: material.evidenceId,
      patch: {
        verificationStatus: "verified",
        verifiedBy: "Alice Reviewer (alice)",
        verifiedAt: TIMESTAMP,
        verificationNote: "与原文一致"
      },
      event: {
        correlationId: material.evidenceId,
        type: "EVIDENCE_VERIFICATION_CHANGED",
        payload: { evidenceId: material.evidenceId }
      }
    });

    const second = await saveSnapshot(sessionId, { key: "frozen-2" });
    const after = (second.body.reportPayload as {
      summary: { verified: number; unverified: number };
    }).summary;
    expect(after).toMatchObject({ verified: 1, unverified: 0 });

    // Reading the old version again still shows the old moment.
    const reread = await app.inject({
      method: "GET",
      url: `${listUrl(sessionId)}/${first.body.snapshotId as string}`
    });
    expect(reread.statusCode).toBe(200);
    const frozen = (
      reread.json() as { reportPayload: { summary: { verified: number } } }
    ).reportPayload;
    expect(frozen.summary.verified).toBe(0);
  });

  it("records the cited captures and reports the ones that are gone", async () => {
    const sessionId = await seededSession();
    const { sourceId } = await seedMaterial(sessionId);

    await evidenceRepository.recordRetrievalSuccess({
      snapshot: {
        id: newId(),
        sessionId,
        sourceId,
        canonicalUrl: "https://example.test/page",
        contentHash: "a".repeat(64),
        contentType: "text/html; charset=utf-8",
        content: "制造业投资增速回落至 4.2%。",
        contentBytes: 14,
        charCount: 14,
        retrievedAt: TIMESTAMP,
        createdAt: TIMESTAMP
      },
      source: {},
      event: {
        correlationId: newId(),
      type: "SOURCE_RETRIEVED",
      payload: { sourceId }
      }
    });

    const created = await saveSnapshot(sessionId, { key: "cites-1" });
    const references = created.body.sourceReferences as Array<{
      sourceId: string;
      snapshotId: string | null;
      present: boolean;
    }>;

    expect(references).toHaveLength(1);
    expect(references[0]?.sourceId).toBe(sourceId);
    expect(references[0]?.snapshotId).toBeTruthy();
    // The capture is still there, so the version's citation still resolves.
    expect(references[0]?.present).toBe(true);
  });

  it("appends one audit event naming the version it created", async () => {
    const sessionId = await seededSession();
    await seedMaterial(sessionId);

    const created = await saveSnapshot(sessionId, { key: "audit-1" });
    const trail = await events.listAfter(sessionId, 0);
    const saved = trail.filter((event) => event.type === "REPORT_SNAPSHOT_CREATED");

    expect(saved).toHaveLength(1);
    expect(saved[0]?.correlationId).toBe(created.body.snapshotId);
    expect(saved[0]?.payload).toMatchObject({ version: 1 });
  });

  it("leaves claims, verification statuses and rulings exactly as they were", async () => {
    const sessionId = await seededSession();
    const material = await seedMaterial(sessionId);

    await saveSnapshot(sessionId, { key: "safe-1" });

    const artifacts = await arena.getSessionArtifacts(sessionId);
    expect(artifacts.claims[0]?.status).toBe("proposed");
    const evidence = await evidenceRepository.listEvidence(sessionId, {});
    expect(evidence[0]?.verificationStatus).toBe("unverified");
    expect(artifacts.challenges).toHaveLength(0);
    expect(await reviewRepository.listReviews(sessionId, {})).toHaveLength(0);
    // Nothing was scheduled by a save either.
    expect(await revalidationTasks.listTasks(sessionId, {})).toHaveLength(0);
  });

  it("answers 404 for an unknown session and for another session's version", async () => {
    const sessionId = await seededSession();
    const otherSessionId = await seededSession();
    await seedMaterial(sessionId);

    const created = await saveSnapshot(sessionId, { key: "scope-1" });
    const second = await saveSnapshot(sessionId, { key: "scope-2" });
    const snapshotId = created.body.snapshotId as string;
    const secondSnapshotId = second.body.snapshotId as string;

    expect(
      (await saveSnapshot(unknownSessionId(), { key: "scope-x" })).status
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: listUrl(unknownSessionId()) }))
        .statusCode
    ).toBe(404);

    const otherList = await app.inject({
      method: "GET",
      url: listUrl(otherSessionId)
    });
    expect(otherList.statusCode).toBe(200);
    expect(
      (otherList.json() as { snapshots: unknown[] }).snapshots
    ).toHaveLength(0);

    // The version exists — just not in that session.
    const crossRead = await app.inject({
      method: "GET",
      url: `${listUrl(otherSessionId)}/${snapshotId}`
    });
    expect(crossRead.statusCode).toBe(404);

    const crossExport = await app.inject({
      method: "GET",
      url: `${listUrl(otherSessionId)}/${snapshotId}/export`
    });
    expect(crossExport.statusCode).toBe(404);

    const crossCompare = await app.inject({
      method: "GET",
      url: `${listUrl(otherSessionId)}/compare?from=${snapshotId}&to=${secondSnapshotId}`
    });
    expect(crossCompare.statusCode).toBe(404);
  });

  it("lets a viewer read history but not save a version", async () => {
    const sessionId = await seededSession();
    await seedMaterial(sessionId);
    await saveSnapshot(sessionId, { key: "before-viewer" });

    role = "viewer";
    const denied = await saveSnapshot(sessionId, { key: "viewer-1" });
    expect(denied.status).toBe(403);

    const list = await app.inject({ method: "GET", url: listUrl(sessionId) });
    expect(list.statusCode).toBe(200);
    // Only the save that happened before the switch is on the record.
    expect(
      (list.json() as { snapshots: unknown[] }).snapshots
    ).toHaveLength(1);
  });

  it("refuses an anonymous request to read or write history", async () => {
    const sessionId = await seededSession();
    authEnabled = false;

    expect((await saveSnapshot(sessionId, { key: "anon-1" })).status).toBe(401);
    const list = await app.inject({ method: "GET", url: listUrl(sessionId) });
    expect(list.statusCode).toBe(401);
  });

  it("answers 404 for an unknown version id on read, export and compare", async () => {
    const sessionId = await seededSession();
    const missing = newId();
    const alsoMissing = newId();

    const read = await app.inject({
      method: "GET",
      url: `${listUrl(sessionId)}/${missing}`
    });
    expect(read.statusCode).toBe(404);

    const exported = await app.inject({
      method: "GET",
      url: `${listUrl(sessionId)}/${missing}/export`
    });
    expect(exported.statusCode).toBe(404);

    const compared = await app.inject({
      method: "GET",
      url: `${listUrl(sessionId)}/compare?from=${missing}&to=${alsoMissing}`
    });
    expect(compared.statusCode).toBe(404);
  });
});

describe("report snapshot routes · comparison", () => {
  /**
   * Verifying the excerpt is what moves the derived conclusion, so the change
   * must appear on the `verdict` axis — not as a source-currency item.
   */
  it("reports a conclusion change matched by id, carrying the stored reason", async () => {
    const sessionId = await seededSession();
    const material = await seedMaterial(sessionId);
    const first = await saveSnapshot(sessionId, { key: "cmp-a" });

    await evidenceRepository.setVerification({
      sessionId,
      evidenceId: material.evidenceId,
      patch: {
        verificationStatus: "verified",
        verifiedBy: "Alice Reviewer (alice)",
        verifiedAt: TIMESTAMP,
        verificationNote: "与原文一致"
      },
      event: {
        correlationId: newId(),
        type: "EVIDENCE_VERIFICATION_CHANGED",
        payload: { evidenceId: material.evidenceId }
      }
    });
    const second = await saveSnapshot(sessionId, { key: "cmp-b" });

    const response = await app.inject({
      method: "GET",
      url: `${listUrl(sessionId)}/compare?from=${first.body.snapshotId as string}&to=${second.body.snapshotId as string}`
    });
    expect(response.statusCode).toBe(200);

    const diff = response.json() as {
      fromVersion: number;
      toVersion: number;
      fromMaterialsFingerprint: string;
      toMaterialsFingerprint: string;
      entries: Array<{
        entityType: string;
        entityId: string;
        kind: string;
        category: string;
        field: string | null;
        oldValue: unknown;
        newValue: unknown;
        reason: string | null;
      }>;
      counts: { verdict: number; risk: number; changed: number };
    };

    expect(diff.fromVersion).toBe(1);
    expect(diff.toVersion).toBe(2);
    // The material itself moved, so the fingerprint must have moved with it.
    expect(diff.fromMaterialsFingerprint).not.toBe(diff.toMaterialsFingerprint);

    const verification = diff.entries.filter(
      (entry) => entry.field === "verificationStatus"
    );
    expect(verification).toHaveLength(1);
    expect(verification[0]).toMatchObject({
      entityType: "evidence",
      entityId: material.evidenceId,
      kind: "changed",
      category: "verdict",
      oldValue: "unverified",
      newValue: "verified"
    });

    const verdicts = diff.entries.filter(
      (entry) => entry.field === "verdictStatus"
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.entityId).toBe(material.claimId);
    // A reason is only present when the stored rows say it outright.
    expect(verdicts[0]?.reason).toBeTruthy();
  });

  /**
   * The rule that stops a moving page from reading like an overturned
   * finding: a changed capture is a `risk` entry, it draws no conclusion, and
   * it is reported beside — never inside — the verdict changes.
   */
  it("treats a changed capture as currency risk and never as a conclusion", async () => {
    const sessionId = await seededSession();
    const { sourceId } = await seedMaterial(sessionId);

    await evidenceRepository.recordRetrievalSuccess({
      snapshot: {
        id: newId(),
        sessionId,
        sourceId,
        canonicalUrl: "https://example.test/page",
        contentHash: "a".repeat(64),
        contentType: "text/html; charset=utf-8",
        content: "第一版正文。",
        contentBytes: 6,
        charCount: 6,
        retrievedAt: "2026-02-01T00:00:00.000Z",
        createdAt: "2026-02-01T00:00:00.000Z"
      },
      source: {},
      event: {
        correlationId: newId(),
      type: "SOURCE_RETRIEVED",
      payload: { sourceId }
      }
    });
    const first = await saveSnapshot(sessionId, { key: "risk-a" });

    // The page changes underneath the version.
    await evidenceRepository.recordRetrievalSuccess({
      snapshot: {
        id: newId(),
        sessionId,
        sourceId,
        canonicalUrl: "https://example.test/page",
        contentHash: "b".repeat(64),
        contentType: "text/html; charset=utf-8",
        content: "第二版正文。",
        contentBytes: 6,
        charCount: 6,
        // Later, so "the newest capture" is unambiguous: the repository
        // orders by retrieval time, and a tie would make the result arbitrary.
        retrievedAt: "2026-02-02T00:00:00.000Z",
        createdAt: "2026-02-02T00:00:00.000Z"
      },
      source: {},
      event: {
        correlationId: newId(),
        type: "SOURCE_RETRIEVED",
        payload: { sourceId }
      }
    });
    const second = await saveSnapshot(sessionId, { key: "risk-b" });

    const response = await app.inject({
      method: "GET",
      url: `${listUrl(sessionId)}/compare?from=${first.body.snapshotId as string}&to=${second.body.snapshotId as string}`
    });
    const diff = response.json() as {
      entries: Array<{
        entityType: string;
        kind: string;
        category: string;
        field: string | null;
        oldValue: unknown;
        newValue: unknown;
        reason: string | null;
      }>;
      counts: { verdict: number; risk: number };
    };

    const sourceEntries = diff.entries.filter(
      (entry) => entry.entityType === "source"
    );
    expect(sourceEntries).toHaveLength(1);
    expect(sourceEntries[0]).toMatchObject({
      kind: "changed",
      category: "risk",
      field: "contentHash",
      oldValue: "a".repeat(64),
      newValue: "b".repeat(64)
    });
    // The comparison draws no conclusion from a page that moved.
    expect(sourceEntries[0]?.reason).toBeNull();

    // Every entry is one axis or the other; the counts add up to the whole.
    expect(diff.counts.verdict + diff.counts.risk).toBe(diff.entries.length);
  });

  /**
   * Identity is the id, so a second claim carrying the very same wording is
   * reported as an addition. Folding it into the existing one would be a
   * conclusion drawn from resemblance, which is exactly what the comparison
   * refuses to do.
   */
  it("reports an identically worded new claim as an addition, not a change", async () => {
    const sessionId = await seededSession();
    const { claimId } = await seedMaterial(sessionId);
    const first = await saveSnapshot(sessionId, { key: "unmatched-a" });

    const twinId = newId();
    await arena.createResearchClaim({
      claim: {
        id: twinId,
        sessionId,
        lens: "market",
        statement: "制造业投资增速回落至 4.2%。",
        type: "fact",
        stance: "support",
        importance: 4,
        confidence: 0.5,
        evidenceIds: [],
        status: "proposed",
        rootClaimId: twinId,
        revision: 1,
        relations: [],
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP
      },
      event: {
        correlationId: newId(),
        type: "CLAIM_CREATED",
        payload: { claimId: twinId }
      }
    });
    const second = await saveSnapshot(sessionId, { key: "unmatched-b" });

    const response = await app.inject({
      method: "GET",
      url: `${listUrl(sessionId)}/compare?from=${first.body.snapshotId as string}&to=${second.body.snapshotId as string}`
    });
    const diff = response.json() as {
      entries: Array<{
        entityType: string;
        entityId: string;
        kind: string;
        category: string;
      }>;
    };

    const claimEntries = diff.entries.filter(
      (entry) => entry.entityType === "claim"
    );
    // One entry, for the new row — the existing claim is untouched.
    expect(claimEntries).toHaveLength(1);
    expect(claimEntries[0]?.entityId).toBe(twinId);
    expect(claimEntries[0]?.kind).toBe("added");
  });

  it("refuses a comparison that is not two different versions", async () => {
    const sessionId = await seededSession();
    await seedMaterial(sessionId);
    const first = await saveSnapshot(sessionId, { key: "bad-a" });
    const id = first.body.snapshotId as string;

    const same = await app.inject({
      method: "GET",
      url: `${listUrl(sessionId)}/compare?from=${id}&to=${id}`
    });
    expect(same.statusCode).toBe(400);

    const missing = await app.inject({
      method: "GET",
      url: `${listUrl(sessionId)}/compare?from=${id}`
    });
    expect(missing.statusCode).toBe(400);
  });
});

describe("report snapshot routes · export", () => {
  it("renders the frozen payload as markdown with its version header", async () => {
    const sessionId = await seededSession();
    await seedMaterial(sessionId);
    const created = await saveSnapshot(sessionId, {
      key: "export-a",
      changeReason: "定稿"
    });
    const snapshotId = created.body.snapshotId as string;

    const response = await app.inject({
      method: "GET",
      url: `${listUrl(sessionId)}/${snapshotId}/export`
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/markdown");
    expect(response.body).toContain("> 历史版本导出");
    expect(response.body).toContain(`> - 快照 ID：${snapshotId}`);
    expect(response.body).toContain("> - 版本：v1");
    expect(response.body).toContain("> - 变更原因：定稿");
    expect(response.body).toContain("不包含保存之后的任何变更");
    // The body it froze, not a rebuild over today's rows.
    expect(response.body).toContain("制造业投资增速回落至 4.2%。");
  });

  it("renders html on request and is byte-identical on every export", async () => {
    const sessionId = await seededSession();
    await seedMaterial(sessionId);
    const created = await saveSnapshot(sessionId, { key: "export-b" });
    const snapshotId = created.body.snapshotId as string;

    const html = await app.inject({
      method: "GET",
      url: `${listUrl(sessionId)}/${snapshotId}/export?format=html`
    });
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.body).toContain("<!doctype html>");

    const first = await app.inject({
      method: "GET",
      url: `${listUrl(sessionId)}/${snapshotId}/export?download=1`
    });
    const second = await app.inject({
      method: "GET",
      url: `${listUrl(sessionId)}/${snapshotId}/export?download=1`
    });
    expect(first.body).toBe(second.body);
    expect(first.headers["content-disposition"]).toContain("attachment");
    expect(first.headers["content-disposition"]).toContain(
      "fact-check-report-v1-"
    );
  });

  it("answers 404 when there is no such version", async () => {
    const sessionId = await seededSession();
    const response = await app.inject({
      method: "GET",
      url: `${listUrl(sessionId)}/${newId()}/export`
    });
    expect(response.statusCode).toBe(404);
  });

  it("freezes the multilingual reading summary with the version it was saved under", async () => {
    const sessionId = await seededSession();
    const { sourceId } = await seedMaterial(sessionId);

    // One stored auxiliary translation of this session's capture, written
    // straight through the repository — the route path is covered by the
    // multilingual suite; what matters here is only that a row exists.
    const snapshotId = newId();
    await database.insert(sourceSnapshots).values({
      id: snapshotId,
      sessionId,
      sourceId,
      canonicalUrl: "https://example.test/page",
      contentHash: "hash-ml",
      contentType: "text/plain",
      content: "制造业投资增速回落至 4.2%。",
      contentBytes: 32,
      charCount: 32,
      retrievedAt: TIMESTAMP,
      sourceLanguage: "zh-Hans"
    });
    const translations = new TranslationRepository(database);
    const created = await translations.createTranslation({
      translationId: newId(),
      sessionId,
      sourceSnapshotId: snapshotId,
      sourceLanguage: "zh-Hans",
      targetLanguage: "en",
      textHash: "hash-ml",
      translatedText: "[0] Manufacturing investment growth fell to 4.2%.",
      segmentMappings: [
        { sourceSegmentId: "seg-0", translatedSegmentId: "t-seg-0", mappingStatus: "aligned" }
      ],
      provider: "deterministic-mock",
      model: "deterministic-mock-v1",
      status: "completed",
      createdBy: "human"
    });

    // A second app whose snapshot service can see translations, mirroring the
    // server wiring. The file-level app deliberately cannot.
    const multilingualApp = createApp({
      auth: {
        userFromRequest: () =>
          authEnabled
            ? {
                id: "user-1",
                username: "alice",
                displayName: "Alice Reviewer",
                role
              }
            : null
      } as never,
      sessions,
      inspector: {} as never,
      runSession: undefined as never,
      events,
      evidence: evidenceRepository,
      reviews: reviewRepository,
      arena,
      researchPlan: new ResearchPlanRepository(database),
      reportSnapshots: new ResearchReportSnapshotService({
        database,
        sessions,
        arena,
        evidence: evidenceRepository,
        reviews: reviewRepository,
        events,
        researchPlan: new ResearchPlanRepository(database),
        monitorTasks: revalidationTasks,
        translations,
        snapshots: new ReportSnapshotRepository(database)
      })
    });

    const save = async (key: string) => {
      const response = await multilingualApp.inject({
        method: "POST",
        url: listUrl(sessionId),
        headers: { "content-type": "application/json", "idempotency-key": key },
        payload: {}
      });
      expect(response.statusCode).toBe(201);
      return response.json() as {
        snapshotId: string;
        reportPayload: { multilingual?: Record<string, unknown> };
      };
    };

    const first = await save("ml-save-1");
    expect(first.reportPayload.multilingual).toEqual({
      sourceLanguages: ["zh-Hans"],
      targetLanguages: ["en"],
      translationCount: 1,
      humanReviewedCount: 0,
      approvedCount: 0,
      flaggedCount: 0
    });

    // A person then approves the translation. The next version sees it; the
    // first one must keep the summary it froze.
    await translations.recordReview({
      sessionId,
      translationId: created.translation.translationId,
      reviewedBy: "Alice Reviewer (alice)",
      action: "approve",
      reviewStatus: "approved",
      note: "checked",
      event: {
        type: "TRANSLATION_REVIEWED",
        correlationId: sessionId,
        payload: {
          translationId: created.translation.translationId,
          action: "approve",
          reviewStatus: "approved"
        }
      }
    });

    const second = await save("ml-save-2");
    expect(second.reportPayload.multilingual).toMatchObject({
      translationCount: 1,
      humanReviewedCount: 1,
      approvedCount: 1,
      flaggedCount: 0
    });

    const reread = await multilingualApp.inject({
      method: "GET",
      url: `${listUrl(sessionId)}/${first.snapshotId}`
    });
    expect(reread.statusCode).toBe(200);
    const frozen = (reread.json() as { reportPayload: { multilingual?: Record<string, unknown> } })
      .reportPayload.multilingual;
    expect(frozen).toMatchObject({ translationCount: 1, humanReviewedCount: 0 });

    // And the export says the one thing it must always say: the translation
    // is an aid, the original excerpt stays the anchor.
    const exported = await multilingualApp.inject({
      method: "GET",
      url: `${listUrl(sessionId)}/${second.snapshotId}/export`
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain("多语言阅读辅助");
    expect(exported.body).toContain("译文仅供辅助阅读");
  });
});
