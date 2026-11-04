import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ArenaRepository,
  createTestDatabase,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  projects,
  ResearchPlanRepository,
  ResearchSearchRepository,
  RevalidationTaskRepository,
  ReviewRepository,
  SourceIndependenceRepository,
  type Database
} from "@nexus/db";
import { newId, ResearchQualityAssessmentSchema } from "@nexus/shared";
import { createApp } from "../../app";
import { ResearchQualityService } from "../../research/research-quality-service";
import { ResearchWorkspaceService } from "../../research/workspace-service";
import { SourceIndependenceService } from "../../research/source-independence-service";

/**
 * DB-backed integration test for the research-quality routes.
 *
 * What only a real database can prove: that the assessment really is a
 * projection of the session's own rows (and of nobody else's), that a viewer
 * may read it while an anonymous caller may not, that an unknown session
 * answers 404 rather than an empty assessment, that the findings filter
 * narrows without inventing a total, and — the point of the whole feature —
 * that reading writes nothing at all: no row changes, no event is appended,
 * the session's event sequence does not move.
 *
 * No model and no network are involved. The database is the dedicated test
 * database named by TEST_DATABASE_URL; the guard refuses anything else.
 */
const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const arena = new ArenaRepository(database);
const evidenceRepository = new EvidenceRepository(database);
const reviewRepository = new ReviewRepository(database);
const events = new EventRepository(database);
const planRepository = new ResearchPlanRepository(database);
const searchRepository = new ResearchSearchRepository(database);
const revalidationTasks = new RevalidationTaskRepository(database);
const independenceAssertions = new SourceIndependenceRepository(database);

const PROJECT_ID = newId();
const SESSION_ID = newId();
const OTHER_SESSION_ID = newId();
const CLAIM_ID = newId();
/** A second claim with no material behind it, so findings have something to say. */
const SECOND_CLAIM_ID = newId();
const EVIDENCE_ID = newId();
const SOURCE_ID = newId();

let role: "owner" | "reviewer" | "viewer" = "reviewer";

const workspaceService = new ResearchWorkspaceService({
  evidence: evidenceRepository,
  arena,
  reviews: reviewRepository,
  getSession: async (sessionId) => {
    const session = await sessions.getById(sessionId);
    if (!session) return null;
    return {
      id: session.id,
      phase: session.phase,
      operationalStatus: session.operationalStatus,
      researchQuestion: session.researchQuestion ?? null,
      currentConclusion: session.currentConclusion ?? null
    };
  }
});

const sourceIndependence = new SourceIndependenceService({
  sources: evidenceRepository,
  assertions: independenceAssertions
});

/** The same wiring server.ts uses, on the test database. */
const researchQuality = new ResearchQualityService({
  workspace: async (sessionId) => workspaceService.getWorkspace(sessionId),
  independence: sourceIndependence,
  monitoring: { tasks: revalidationTasks, snapshots: evidenceRepository },
  planItems: planRepository,
  searchTasks: searchRepository
});

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
    arena,
    researchQuality
  });
}

async function seedSession() {
  const timestamp = new Date().toISOString();
  await database.execute("TRUNCATE projects CASCADE");
  await database.insert(projects).values({
    id: PROJECT_ID,
    name: "Research quality integration",
    input: {}
  });
  for (const sessionId of [SESSION_ID, OTHER_SESSION_ID]) {
    await sessions.create({
      id: sessionId,
      projectId: PROJECT_ID,
      locale: "zh-CN",
      phase: "EVIDENCE",
      operationalStatus: "ACTIVE",
      currentConclusion: null,
      // The research belongs to the signed-in reviewer: access is decided from
      // the recorded owner, never from the request.
      ownerUserId: "user-1"
    });
  }
  await arena.createResearchClaim({
    claim: {
      id: CLAIM_ID,
      sessionId: SESSION_ID,
      lens: "market",
      statement: "出货量同比增长 12%。",
      type: "fact",
      stance: "support",
      importance: 5,
      confidence: 0.5,
      evidenceIds: [],
      status: "proposed",
      rootClaimId: CLAIM_ID,
      revision: 1,
      relations: [],
      createdAt: timestamp,
      updatedAt: timestamp
    },
    event: {
      correlationId: newId(),
      type: "CLAIM_CREATED",
      payload: { claimId: CLAIM_ID }
    }
  });
  // A registered source, so the excerpt has provenance behind it.
  await evidenceRepository.createSource({
    id: SOURCE_ID,
    sessionId: SESSION_ID,
    title: "季度出货统计",
    kind: "document",
    publisher: "Example Bureau",
    createdBy: "human",
    createdAt: timestamp,
    updatedAt: timestamp
  });
  // A second, important claim with no material at all: the kind of finding
  // the assessment exists to surface.
  await arena.createResearchClaim({
    claim: {
      id: SECOND_CLAIM_ID,
      sessionId: SESSION_ID,
      lens: "market",
      statement: "单条采购记录可以证明全部增长。",
      type: "fact",
      stance: "support",
      importance: 5,
      confidence: 0.5,
      evidenceIds: [],
      status: "proposed",
      rootClaimId: SECOND_CLAIM_ID,
      revision: 1,
      relations: [],
      createdAt: timestamp,
      updatedAt: timestamp
    },
    event: {
      correlationId: newId(),
      type: "CLAIM_CREATED",
      payload: { claimId: SECOND_CLAIM_ID }
    }
  });
  await evidenceRepository.createEvidence({
    evidence: {
      id: EVIDENCE_ID,
      sessionId: SESSION_ID,
      claimIds: [CLAIM_ID],
      kind: "external_reference",
      title: "季度出货统计",
      content: "报告第 12 页：出货量同比增长 12%。",
      description: "增长数据的原始摘录",
      sourceId: SOURCE_ID,
      direction: "supports",
      reliability: 0.8,
      verificationStatus: "verified",
      verifiedBy: "Owner (owner)",
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
}

beforeEach(async () => {
  role = "reviewer";
  await seedSession();
});

afterAll(async () => {
  await database.execute("TRUNCATE projects CASCADE");
});

async function getQuality(sessionId = SESSION_ID) {
  const response = await testApp().inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/research-quality`
  });
  return { status: response.statusCode, body: response.json() };
}

async function getFindings(
  sessionId = SESSION_ID,
  query = ""
) {
  const response = await testApp().inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/research-quality/findings${query}`
  });
  return { status: response.statusCode, body: response.json() };
}

describe("GET /research-quality", () => {
  it("answers a valid assessment for a session with material", async () => {
    const response = await getQuality();
    expect(response.status).toBe(200);

    // The body really is an assessment: schema-validated, rule-versioned.
    const assessment = ResearchQualityAssessmentSchema.parse(response.body);
    expect(assessment.sessionId).toBe(SESSION_ID);
    expect(assessment.ruleVersion).toBe("research-quality-v1");
    expect(assessment.dimensions).toHaveLength(6);

    const coverage = assessment.dimensions.find(
      (item) => item.id === "evidence_coverage"
    );
    expect(coverage?.inputMetrics.claims).toBe(2);
    expect(coverage?.inputMetrics.claimsWithVerifiedEvidence).toBe(1);
    expect(coverage?.inputMetrics.claimsWithoutEvidence).toBe(1);
    // One source-less session: independence is unknown, not zero.
    const independence = assessment.dimensions.find(
      (item) => item.id === "source_independence"
    );
    expect(independence?.status).toBe("insufficient_data");
    expect(assessment.overall.explanation).toContain("不是结论正确的概率");
  });

  it("reads only the session it was asked about", async () => {
    const mine = await getQuality(SESSION_ID);
    const other = await getQuality(OTHER_SESSION_ID);
    expect(mine.status).toBe(200);
    expect(other.status).toBe(200);
    expect(other.body.claimFindings).toEqual([]);
    expect(
      other.body.dimensions.find((item: { id: string }) => item.id === "evidence_coverage")
        .inputMetrics.claims
    ).toBe(0);
  });

  it("answers 404 for a session that does not exist", async () => {
    const response = await getQuality(newId());
    expect(response.status).toBe(404);
  });

  it("lets a viewer read and refuses an anonymous caller", async () => {
    role = "viewer";
    const viewer = await getQuality();
    expect(viewer.status).toBe(200);

    const anonymous = await testApp(false).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/research-quality`
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("is deterministic: the same rows read the same way twice", async () => {
    const first = await getQuality();
    const second = await getQuality();
    const { assessedAt: _first, ...restFirst } = first.body;
    const { assessedAt: _second, ...restSecond } = second.body;
    expect(restFirst).toEqual(restSecond);
    expect(first.body.inputFingerprint).toHaveLength(16);
  });
});

describe("GET /research-quality/claims", () => {
  it("returns the claim-level diagnostics for the session's own claims", async () => {
    const response = await testApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/research-quality/claims`
    });
    expect(response.statusCode).toBe(200);
    const claimFindings = response.json().claimFindings;
    expect(claimFindings).toHaveLength(2);
    expect(claimFindings.map((item: { claimId: string }) => item.claimId).sort()).toEqual(
      [CLAIM_ID, SECOND_CLAIM_ID].sort()
    );
    expect(response.json().ruleVersion).toBe("research-quality-v1");
  });

  it("answers 404 for an unknown session", async () => {
    const response = await testApp().inject({
      method: "GET",
      url: `/api/sessions/${newId()}/research-quality/claims`
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /research-quality/findings", () => {
  it("narrows by severity and category while reporting the full total", async () => {
    const all = await getFindings(SESSION_ID);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(all.body.findings.length);
    expect(all.body.total).toBeGreaterThan(0);

    const critical = await getFindings(SESSION_ID, "?severity=critical");
    expect(critical.status).toBe(200);
    expect(
      critical.body.findings.every(
        (item: { severity: string }) => item.severity === "critical"
      )
    ).toBe(true);

    const missing = await getFindings(SESSION_ID, "?category=missing_evidence");
    expect(
      missing.body.findings.every(
        (item: { category: string }) => item.category === "missing_evidence"
      )
    ).toBe(true);
    expect(missing.body.total).toBeGreaterThan(0);
  });

  it("caps what it returns without capping what it counted", async () => {
    const limited = await getFindings(SESSION_ID, "?limit=1");
    expect(limited.body.findings).toHaveLength(1);
    expect(limited.body.total).toBeGreaterThan(1);
  });

  it("rejects a filter that names no real category", async () => {
    const response = await getFindings(SESSION_ID, "?category=not_a_category");
    expect(response.status).toBe(400);
  });
});

describe("GET /research-quality · reads write nothing", () => {
  /** Row counts the way this suite reads them: `execute` hands back the rows. */
  async function countOf(table: string): Promise<number> {
    const rows = (await database.execute(
      `SELECT count(*)::int AS n FROM ${table}`
    )) as unknown as Array<{ n: number }>;
    return rows[0]!.n;
  }

  async function sequenceOf(sessionId: string): Promise<number> {
    const rows = (await database.execute(
      `SELECT next_event_sequence::int AS n FROM decision_sessions WHERE id = '${sessionId}'`
    )) as unknown as Array<{ n: number }>;
    return rows[0]!.n;
  }

  it("leaves every row, event and the session sequence untouched", async () => {
    const before = {
      claims: await countOf("claims"),
      evidence: await countOf("evidence"),
      sources: await countOf("sources"),
      events: await countOf("execution_events"),
      sequence: await sequenceOf(SESSION_ID)
    };

    await getQuality();
    await testApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/research-quality/claims`
    });
    await getFindings(SESSION_ID, "?severity=critical");
    await getFindings(SESSION_ID, "?category=missing_evidence&limit=2");

    const after = {
      claims: await countOf("claims"),
      evidence: await countOf("evidence"),
      sources: await countOf("sources"),
      events: await countOf("execution_events"),
      sequence: await sequenceOf(SESSION_ID)
    };

    expect(after).toEqual(before);
  });
});
