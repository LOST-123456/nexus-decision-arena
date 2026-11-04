import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ArenaRepository,
  conflicts,
  createTestDatabase,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  projects,
  ReviewRepository,
  type Database
} from "@nexus/db";
import { newId } from "@nexus/shared";
import { createApp } from "../../app";

/**
 * DB-backed integration tests for the read-only Evidence Map endpoint.
 *
 * What only a real database can prove:
 *  - the graph the endpoint returns is actually the persisted material
 *    (claims, evidence, sources, conflicts) projected — not invented;
 *  - a session's map never contains another session's nodes (cross-session
 *    isolation against real rows);
 *  - an empty session yields an empty graph rather than an error;
 *  - viewers may read it (the endpoint is read-only by construction) and
 *    unauthenticated requests are rejected.
 */
const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const arena = new ArenaRepository(database);
const evidenceRepository = new EvidenceRepository(database);
const reviewRepository = new ReviewRepository(database);
const events = new EventRepository(database);

const PROJECT_ID = newId();
const SESSION_ID = newId();
const SESSION_B_ID = newId();
const CLAIM_ID = newId();
const CLAIM_B_ID = newId();
const SOURCE_ID = newId();
const EVIDENCE_ID = newId();
const CONFLICT_ID = newId();

let role: "owner" | "reviewer" | "viewer" = "reviewer";

function fakeAuth(enabled = true) {
  return {
    userFromRequest: () =>
      enabled
        ? {
            id: "user-1",
            username: "researcher",
            displayName: "Researcher One",
            role
          }
        : null
  };
}

function testApp(enabled = true) {
  return createApp({
    auth: fakeAuth(enabled) as never,
    sessions,
    inspector: {} as never,
    events,
    runSession: { start: async () => undefined },
    evidence: evidenceRepository,
    reviews: reviewRepository,
    arena
  });
}

const timestamp = new Date().toISOString();

async function createClaim(claimId: string, sessionId: string) {
  await arena.createResearchClaim({
    claim: {
      id: claimId,
      sessionId,
      lens: "market",
      statement: "出货量同比增长 12%。",
      type: "fact",
      stance: "support",
      importance: 4,
      confidence: 0.5,
      evidenceIds: [],
      status: "proposed",
      rootClaimId: claimId,
      revision: 1,
      relations: [],
      createdAt: timestamp,
      updatedAt: timestamp
    },
    event: {
      correlationId: newId(),
      type: "CLAIM_CREATED",
      payload: { claimId }
    }
  });
}

async function seedMaterial(sessionId: string) {
  await createClaim(CLAIM_ID, sessionId);
  await evidenceRepository.createSource({
    id: SOURCE_ID,
    sessionId,
    title: "Gartner 市场报告",
    kind: "url",
    url: "https://example.com/report",
    publisher: "Gartner",
    retrievalStatus: "fetched",
    createdBy: "human",
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await evidenceRepository.createEvidence({
    evidence: {
      id: EVIDENCE_ID,
      sessionId,
      claimIds: [CLAIM_ID],
      kind: "external_reference",
      title: "市场报告摘录",
      content: "报告第 12 页：出货量同比增长 12%。",
      description: "增长数据的原始摘录",
      sourceId: SOURCE_ID,
      direction: "supports",
      reliability: 0.8,
      verificationStatus: "verified",
      verifiedBy: "Owner",
      verifiedAt: timestamp,
      verificationNote: "与已保存快照逐字一致",
      retrievedAt: timestamp,
      createdBy: "human"
    },
    event: {
      correlationId: newId(),
      type: "EVIDENCE_RECORDED",
      payload: { evidenceId: EVIDENCE_ID }
    }
  });
  await database.insert(conflicts).values({
    id: CONFLICT_ID,
    sessionId,
    claimIds: [CLAIM_ID],
    challengeIds: [],
    type: "evidence",
    summary: "缺少反向核查材料。",
    severity: 3,
    status: "detected",
    humanDecisionRequired: true,
    resolutionSuggestion: "补充反向核查。",
    impactScope: { analysisAreas: ["market"], stakeholders: [] },
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

beforeEach(async () => {
  role = "reviewer";
  await database.execute("TRUNCATE projects CASCADE");
  await database.insert(projects).values({
    id: PROJECT_ID,
    name: "Evidence map integration",
    input: {}
  });
  await sessions.create({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    locale: "zh-CN",
    phase: "EVIDENCE",
    operationalStatus: "ACTIVE",
    currentConclusion: null,
    // The research belongs to the signed-in reviewer: access is decided from
    // the recorded owner, never from the request.
    ownerUserId: "user-1"
  });
  await sessions.create({
    id: SESSION_B_ID,
    projectId: PROJECT_ID,
    locale: "zh-CN",
    phase: "EVIDENCE",
    operationalStatus: "ACTIVE",
    currentConclusion: null,
    // Same owner on purpose: these tests prove that a projection never mixes
    // two researches, which is a different layer from who may open them.
    ownerUserId: "user-1"
  });
});

afterAll(async () => {
  await database.execute("TRUNCATE projects CASCADE");
});

describe("GET /api/sessions/:id/evidence-map", () => {
  it("returns the persisted material as a graph", async () => {
    await seedMaterial(SESSION_ID);
    const response = await testApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/evidence-map`
    });
    expect(response.statusCode).toBe(200);
    const graph = response.json();

    expect(graph.sessionId).toBe(SESSION_ID);
    const types = new Set(graph.nodes.map((node: { type: string }) => node.type));
    expect(types.has("claim")).toBe(true);
    expect(types.has("evidence")).toBe(true);
    expect(types.has("source")).toBe(true);
    expect(types.has("conflict")).toBe(true);

    const supports = graph.edges.find(
      (edge: { relation: string }) => edge.relation === "supports"
    );
    expect(supports?.confidence).toBe(0.8);
    expect(
      graph.edges.some(
        (edge: { relation: string }) => edge.relation === "provided_by"
      )
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge: { relation: string }) => edge.relation === "involved_in"
      )
    ).toBe(true);

    const coverage = graph.coverage.find(
      (entry: { claimId: string }) => entry.claimId === CLAIM_ID
    );
    expect(coverage?.evidenceCount).toBe(1);
    expect(coverage?.verifiedCount).toBe(1);
    expect(coverage?.coverage).toBe(0.8);
  });

  it("returns an empty graph for a session without material", async () => {
    const response = await testApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/evidence-map`
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().nodes).toEqual([]);
    expect(response.json().edges).toEqual([]);
    expect(response.json().coverage).toEqual([]);
  });

  it("never leaks another session's nodes (cross-session isolation)", async () => {
    await seedMaterial(SESSION_ID);
    await createClaim(CLAIM_B_ID, SESSION_B_ID);

    const mapA = await testApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/evidence-map`
    });
    expect(mapA.statusCode).toBe(200);
    const nodesA = mapA.json().nodes;
    // Every node row is stamped with the requested session id…
    expect(nodesA.every((node: { sessionId: string }) => node.sessionId === SESSION_ID)).toBe(true);
    // …and session B's claim never appears in session A's graph.
    expect(
      nodesA.some((node: { id: string }) => node.id === `claim:${CLAIM_B_ID}`)
    ).toBe(false);

    const mapB = await testApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_B_ID}/evidence-map`
    });
    const nodeIdsB: string[] = mapB.json().nodes.map((node: { id: string }) => node.id);
    expect(nodeIdsB).toContain(`claim:${CLAIM_B_ID}`);
    expect(nodeIdsB).not.toContain(`claim:${CLAIM_ID}`);
    expect(nodeIdsB).not.toContain(`evidence:${EVIDENCE_ID}`);
    expect(nodeIdsB).not.toContain(`source:${SOURCE_ID}`);
  });

  it("lets a viewer read the map (read-only endpoint)", async () => {
    await seedMaterial(SESSION_ID);
    role = "viewer";
    const response = await testApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/evidence-map`
    });
    expect(response.statusCode).toBe(200);
  });

  it("requires authentication (401)", async () => {
    const response = await testApp(false).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/evidence-map`
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 404 for an unknown session", async () => {
    const response = await testApp().inject({
      method: "GET",
      url: `/api/sessions/${newId()}/evidence-map`
    });
    expect(response.statusCode).toBe(404);
  });
});
