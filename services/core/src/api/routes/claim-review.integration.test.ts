import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ArenaRepository,
  claimReviews,
  claims,
  createTestDatabase,
  DecisionSessionRepository,
  EvidenceRepository,
  EventRepository,
  projects,
  ReviewRepository,
  type Database
} from "@nexus/db";
import { newId } from "@nexus/shared";
import { createApp } from "../../app";

/**
 * DB-backed integration test for the human fact-check ruling route.
 *
 * Two things can only be proven against a real database: that a ruling is
 * actually persisted as its own row (never folded into the claim), and that a
 * ruling written against a verdict that has since changed is refused before it
 * reaches storage.
 *
 * Runs only on the dedicated test database (`TEST_DATABASE_URL`); the fail-
 * closed guard in `@nexus/db` refuses anything else.
 */
const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const arena = new ArenaRepository(database);
const evidenceRepository = new EvidenceRepository(database);
const reviewRepository = new ReviewRepository(database);
const events = new EventRepository(database);

const SESSION_ID = newId();
const CLAIM_ID = newId();
const PROJECT_ID = newId();

function fakeAuth() {
  return {
    userFromRequest: () => ({
      id: "user-1",
      username: "researcher",
      displayName: "Researcher One",
      role: "reviewer" as const
    })
  };
}

function testApp() {
  return createApp({
    auth: fakeAuth() as never,
    sessions,
    inspector: {} as never,
    events,
    runSession: { start: async () => undefined },
    evidence: evidenceRepository,
    reviews: reviewRepository,
    arena
  });
}

async function seedSession() {
  const timestamp = new Date().toISOString();
  await database.execute("TRUNCATE projects CASCADE");
  await database.insert(projects).values({
    id: PROJECT_ID,
    name: "Claim review integration",
    input: {}
  });
  await sessions.create({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    locale: "zh-CN",
    phase: "HUMAN_REVIEW",
    operationalStatus: "PAUSED",
    currentConclusion: null,
    // The research belongs to the signed-in reviewer: access is decided from
    // the recorded owner, never from the request.
    ownerUserId: "user-1"
  });
  await arena.createResearchClaim({
    claim: {
      id: CLAIM_ID,
      sessionId: SESSION_ID,
      lens: "market",
      statement: "出货量同比增长 12%。",
      type: "fact",
      stance: "support",
      importance: 4,
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
}

async function addEvidence(
  verificationStatus: "unverified" | "verified"
): Promise<string> {
  const evidenceId = newId();
  const timestamp = new Date().toISOString();
  await evidenceRepository.createEvidence({
    evidence: {
      id: evidenceId,
      sessionId: SESSION_ID,
      claimIds: [CLAIM_ID],
      kind: "project_input",
      title: "出货量台账",
      content: "2025 年出货量 12.4 万台。",
      description: "内部台账摘录。",
      direction: "supports",
      reliability: 0.8,
      verificationStatus,
      ...(verificationStatus === "verified"
        ? {
            verifiedBy: "Researcher One (researcher)",
            verifiedAt: timestamp,
            verificationNote: "与台账第 3 行逐字核对一致。"
          }
        : {}),
      retrievedAt: timestamp,
      createdBy: "human"
    },
    event: {
      correlationId: newId(),
      type: "EVIDENCE_RECORDED",
      payload: { evidenceId }
    }
  });
  return evidenceId;
}

async function reviewCount(): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(claimReviews);
  return row?.count ?? 0;
}

async function claimStatus(): Promise<string | undefined> {
  const [row] = await database
    .select({ status: claims.status })
    .from(claims)
    .where(eq(claims.id, CLAIM_ID));
  return row?.status;
}

beforeEach(async () => {
  await seedSession();
});

afterAll(async () => {
  await database.end();
});

describe("claim review route integration", () => {
  it("persists a ruling as its own row without touching the claim", async () => {
    const app = testApp();
    await addEvidence("unverified");

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`,
      headers: { "idempotency-key": "review-persist" },
      payload: {
        outcome: "needs_more_evidence",
        rationale: "还缺采购记录，暂不能确认。",
        expectedVerdictStatus: "insufficient_evidence"
      }
    });

    expect(response.statusCode).toBe(201);

    // The ruling is stored, with the derived verdict it was made against.
    const stored = await reviewRepository.listReviews(SESSION_ID);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      claimId: CLAIM_ID,
      outcome: "needs_more_evidence",
      verdictStatusAtReview: "insufficient_evidence",
      reviewer: "Researcher One (researcher)"
    });

    // The claim's own business status is a different axis and is untouched:
    // a human asking for more evidence is not the same as the claim being
    // resolved.
    expect(await claimStatus()).toBe("proposed");

    // And the ruling is on the event log, so it is auditable in order.
    const recorded = await events.listAfter(SESSION_ID, 0);
    expect(
      recorded.filter((event) => event.type === "CLAIM_REVIEW_RECORDED")
    ).toHaveLength(1);
  });

  it("refuses a ruling written against a verdict that has since changed", async () => {
    const app = testApp();
    await addEvidence("unverified");

    // The reviewer loaded the page while the claim was still unresolved…
    const before = await reviewCount();

    // …but verified evidence lands before they submit, so the derived verdict
    // is now `supported`.
    await addEvidence("verified");

    const stale = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`,
      headers: { "idempotency-key": "review-stale" },
      payload: {
        outcome: "confirmed",
        rationale: "页面显示结论为证据不足时提交的裁定。",
        expectedVerdictStatus: "insufficient_evidence"
      }
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: "stale_verdict",
      expected: "insufficient_evidence",
      actual: "supported"
    });
    // Nothing was written: a stale ruling never reaches storage.
    expect(await reviewCount()).toBe(before);
  });

  it("accepts the same ruling once the reviewer's expectation matches", async () => {
    const app = testApp();
    await addEvidence("verified");

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`,
      headers: { "idempotency-key": "review-current" },
      payload: {
        outcome: "confirmed",
        rationale: "已对照台账第 3 行逐字核对，认可当前结论。",
        expectedVerdictStatus: "supported"
      }
    });

    expect(response.statusCode).toBe(201);
  });

  it("reports 501 instead of guessing when review storage is absent", async () => {
    const app = createApp({
      auth: fakeAuth() as never,
      sessions,
      inspector: {} as never,
      events,
      runSession: { start: async () => undefined },
      evidence: evidenceRepository,
      arena
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims/${CLAIM_ID}/reviews`,
      headers: { "idempotency-key": "review-unwired" },
      payload: {
        outcome: "confirmed",
        rationale: "当前没有接线，服务应拒绝而不是假装成功。",
        expectedVerdictStatus: "unsupported"
      }
    });

    expect(response.statusCode).toBe(501);
  });
});
