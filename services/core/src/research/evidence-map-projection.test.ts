import { describe, expect, it } from "vitest";
import {
  deriveClaimVerdicts,
  type Challenge,
  type Claim,
  type ClaimReview,
  type Conflict,
  type Evidence,
  type Source
} from "@nexus/shared";
import { projectEvidenceMap } from "./evidence-map-projection";
import type { ResearchWorkspace } from "./workspace-service";

/*
 * Unit tests for the Evidence Map projection (pure function, no database).
 *
 * What they pin down:
 *  - every node is a projection of a real row, carrying the recorded status;
 *  - the Evidence→Claim relation IS the recorded direction (opposes is never
 *    renamed and context is never promoted to support);
 *  - an edge is only drawn when both endpoints exist in the same session, so
 *    a stale or foreign claim id can never dangle (the "no nonexistent claim"
 *    and "no cross-session evidence" data rules);
 *  - a source's reliability is the mean of recorded excerpt reliabilities;
 *  - coverage is the documented display metric and nothing more.
 */

const SESSION_ID = "0199e6d0-0000-7000-8000-000000000001";
const OTHER_SESSION_ID = "0199e6d0-0000-7000-8000-0000000000aa";
const CLAIM_ID = "0199e6d0-0000-7000-8000-000000000101";
const EVIDENCE_ID = "0199e6d0-0000-7000-8000-000000000201";
const OPPOSING_ID = "0199e6d0-0000-7000-8000-000000000202";
const ORPHAN_EVIDENCE_ID = "0199e6d0-0000-7000-8000-000000000203";
const FOREIGN_EVIDENCE_ID = "0199e6d0-0000-7000-8000-000000000204";
const SOURCE_ID = "0199e6d0-0000-7000-8000-000000000301";
const CONFLICT_ID = "0199e6d0-0000-7000-8000-000000000401";
const CHALLENGE_ID = "0199e6d0-0000-7000-8000-000000000501";
const UNRELATED_CLAIM_ID = "0199e6d0-0000-7000-8000-000000000901";
const AGENT_RUN_ID = "0199e6d0-0000-7000-8000-000000000601";
const AGENT_ROLE_ID = "0199e6d0-0000-7000-8000-000000000602";
const CORRELATION_ID = "0199e6d0-0000-7000-8000-000000000603";
const NOW = "2026-10-11T06:00:00.000Z";

const timestamp = "2026-10-10T00:00:00.000Z";

function claimFixture(id: string): Claim {
  return {
    id,
    sessionId: SESSION_ID,
    lens: "market",
    statement: "企业市场将同比增长 12%。",
    type: "fact",
    stance: "support",
    importance: 4,
    confidence: 0.5,
    evidenceIds: [],
    status: "proposed",
    rootClaimId: id,
    revision: 1,
    relations: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function evidenceFixture(input: {
  id: string;
  claimIds: string[];
  direction: Evidence["direction"];
  reliability: number;
  verificationStatus: Evidence["verificationStatus"];
  sessionId?: string;
  sourceId?: string;
}): Evidence {
  const base: Evidence = {
    id: input.id,
    sessionId: input.sessionId ?? SESSION_ID,
    claimIds: input.claimIds,
    kind: "external_reference",
    title: "市场报告摘录",
    content: "报告原文第 12 页指出出货量同比增长 12%。",
    description: "摘录描述",
    direction: input.direction,
    reliability: input.reliability,
    verificationStatus: input.verificationStatus,
    retrievedAt: timestamp,
    createdBy: "human"
  };
  if (input.sourceId) {
    base.sourceId = input.sourceId;
  }
  if (input.verificationStatus !== "unverified") {
    base.verifiedBy = "Owner";
    base.verificationNote = "与已保存快照逐字一致";
    base.verifiedAt = timestamp;
  }
  return base;
}

function sourceFixture(id: string): Source {
  return {
    id,
    sessionId: SESSION_ID,
    title: "Gartner 市场报告",
    kind: "url",
    url: "https://example.com/report",
    publisher: "Gartner",
    retrievalStatus: "fetched",
    createdBy: "human",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function conflictFixture(): Conflict {
  return {
    id: CONFLICT_ID,
    sessionId: SESSION_ID,
    claimIds: [CLAIM_ID],
    challengeIds: [CHALLENGE_ID],
    type: "evidence",
    summary: "支持与反对摘录同时存在，需要人工裁定。",
    severity: 4,
    status: "detected",
    humanDecisionRequired: true,
    resolutionSuggestion: "核对两份摘录的统计口径。",
    impactScope: { analysisAreas: ["market"], stakeholders: [] },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function challengeFixture(): Challenge {
  return {
    id: CHALLENGE_ID,
    sessionId: SESSION_ID,
    targetClaimId: CLAIM_ID,
    challengerRunId: AGENT_RUN_ID,
    challengerRoleId: AGENT_ROLE_ID,
    type: "evidence_gap",
    question: "12% 的同比口径是否为同行业可比口径？",
    context: {
      triggerClaimIds: [CLAIM_ID],
      explanation: "增速缺少口径说明。"
    },
    requiredEvidence: ["口径说明或原始统计表"],
    severity: 4,
    resolutionStrategy: "provide_evidence",
    status: "open",
    responseClaimId: undefined,
    correlationId: CORRELATION_ID,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function buildWorkspace(input: {
  claims?: Claim[];
  evidence?: Evidence[];
  sources?: Source[];
  conflicts?: Conflict[];
  challenges?: Challenge[];
}): ResearchWorkspace {
  const claims = input.claims ?? [];
  const evidence = input.evidence ?? [];
  const challenges = input.challenges ?? [];
  const reviews: ClaimReview[] = [];
  return {
    session: {
      id: SESSION_ID,
      phase: "EVIDENCE",
      operationalStatus: "ACTIVE",
      researchQuestion: "市场增长是否可信",
      currentConclusion: null
    },
    claims,
    evidence,
    sources: input.sources ?? [],
    conflicts: input.conflicts ?? [],
    challenges,
    agentRuns: [],
    reviews,
    // Same derivation the workspace service runs — the map reuses it verbatim.
    verdicts: deriveClaimVerdicts(claims, evidence, { challenges, reviews }),
    gaps: [],
    openReviewRequests: [],
    summary: {
      claims: claims.length,
      evidence: evidence.length,
      sources: (input.sources ?? []).length,
      challenges: challenges.length,
      unresolvedChallenges: 0,
      reviews: 0,
      failedRuns: 0,
      verified: 0,
      unverified: 0,
      rejected: 0,
      openVerdicts: 0,
      needsMoreEvidence: 0,
      blockingGaps: 0
    }
  };
}

const fullGraph = () =>
  projectEvidenceMap(
    buildWorkspace({
      claims: [claimFixture(CLAIM_ID)],
      evidence: [
        evidenceFixture({
          id: EVIDENCE_ID,
          claimIds: [CLAIM_ID],
          direction: "supports",
          reliability: 0.8,
          verificationStatus: "verified",
          sourceId: SOURCE_ID
        }),
        evidenceFixture({
          id: OPPOSING_ID,
          claimIds: [CLAIM_ID],
          direction: "opposes",
          reliability: 0.4,
          verificationStatus: "unverified"
        })
      ],
      sources: [sourceFixture(SOURCE_ID)],
      conflicts: [conflictFixture()],
      challenges: [challengeFixture()]
    }),
    { now: NOW }
  );

describe("projectEvidenceMap", () => {
  it("projects all five node types with their recorded statuses", () => {
    const graph = fullGraph();
    const byType = new Map(graph.nodes.map((node) => [node.type, node]));

    const claim = byType.get("claim");
    expect(claim?.label).toBe("企业市场将同比增长 12%。");
    expect(claim?.id).toBe(`claim:${CLAIM_ID}`);
    // The verdict is the derived one, not a new judgement made by the map.
    const derived = deriveClaimVerdicts(
      [claimFixture(CLAIM_ID)],
      [
        evidenceFixture({
          id: EVIDENCE_ID,
          claimIds: [CLAIM_ID],
          direction: "supports",
          reliability: 0.8,
          verificationStatus: "verified",
          sourceId: SOURCE_ID
        }),
        evidenceFixture({
          id: OPPOSING_ID,
          claimIds: [CLAIM_ID],
          direction: "opposes",
          reliability: 0.4,
          verificationStatus: "unverified"
        })
      ],
      { challenges: [challengeFixture()], reviews: [] }
    );
    expect(
      claim && "verdict" in claim ? claim.verdict : undefined
    ).toBe(derived[0]?.status);

    const evidenceNode = graph.nodes.find(
      (node) => node.entityId === EVIDENCE_ID
    );
    expect(evidenceNode && "direction" in evidenceNode
      ? evidenceNode.direction
      : undefined).toBe("supports");

    const sourceNode = byType.get("source");
    expect(sourceNode && "publisher" in sourceNode
      ? sourceNode.publisher
      : undefined).toBe("Gartner");

    const conflictNode = byType.get("conflict");
    expect(conflictNode && "severity" in conflictNode
      ? conflictNode.severity
      : undefined).toBe(4);

    const challengeNode = byType.get("challenge");
    expect(challengeNode && "resolution" in challengeNode
      ? challengeNode.resolution
      : undefined).toBeNull();
  });

  it("keeps the recorded direction as the relation and the recorded reliability as confidence", () => {
    const graph = fullGraph();
    const supports = graph.edges.find(
      (edge) => edge.from === `evidence:${EVIDENCE_ID}`
    );
    expect(supports?.relation).toBe("supports");
    expect(supports?.to).toBe(`claim:${CLAIM_ID}`);
    expect(supports?.confidence).toBe(0.8);

    const opposes = graph.edges.find(
      (edge) => edge.from === `evidence:${OPPOSING_ID}`
    );
    expect(opposes?.relation).toBe("opposes");
    expect(opposes?.confidence).toBe(0.4);
  });

  it("draws the structural edges: provided_by, involved_in, generated_by, questions", () => {
    const graph = fullGraph();
    const relationOf = (from: string, to: string) =>
      graph.edges.find((edge) => edge.from === from && edge.to === to)
        ?.relation;

    expect(
      relationOf(`source:${SOURCE_ID}`, `evidence:${EVIDENCE_ID}`)
    ).toBe("provided_by");
    expect(
      relationOf(`claim:${CLAIM_ID}`, `conflict:${CONFLICT_ID}`)
    ).toBe("involved_in");
    expect(
      relationOf(`conflict:${CONFLICT_ID}`, `challenge:${CHALLENGE_ID}`)
    ).toBe("generated_by");
    expect(
      relationOf(`challenge:${CHALLENGE_ID}`, `claim:${CLAIM_ID}`)
    ).toBe("questions");

    // Structural links carry no fabricated confidence.
    const providedBy = graph.edges.find(
      (edge) => edge.relation === "provided_by"
    );
    expect(providedBy?.confidence).toBeNull();
  });

  it("projects a source's reliability as the mean of its recorded excerpt reliabilities", () => {
    const graph = fullGraph();
    const source = graph.nodes.find((node) => node.type === "source");
    expect(source && "reliability" in source
      ? source.reliability
      : undefined).toBe(0.8);

    const lonely = projectEvidenceMap(
      buildWorkspace({
        claims: [claimFixture(CLAIM_ID)],
        sources: [sourceFixture(SOURCE_ID)]
      })
    );
    const sourceWithoutEvidence = lonely.nodes.find(
      (node) => node.type === "source"
    );
    expect(sourceWithoutEvidence && "reliability" in sourceWithoutEvidence
      ? sourceWithoutEvidence.reliability
      : undefined).toBeNull();
  });

  it("never creates an edge to a claim that is not a node (no nonexistent claim)", () => {
    const graph = projectEvidenceMap(
      buildWorkspace({
        claims: [claimFixture(CLAIM_ID)],
        evidence: [
          evidenceFixture({
            id: ORPHAN_EVIDENCE_ID,
            claimIds: [UNRELATED_CLAIM_ID],
            direction: "supports",
            reliability: 0.9,
            verificationStatus: "verified"
          })
        ]
      })
    );
    expect(
      graph.nodes.some((node) => node.entityId === UNRELATED_CLAIM_ID)
    ).toBe(false);
    expect(
      graph.edges.some((edge) => edge.to === `claim:${UNRELATED_CLAIM_ID}`)
    ).toBe(false);
    // The evidence itself still exists in the session, so the node stays.
    expect(
      graph.nodes.some((node) => node.entityId === ORPHAN_EVIDENCE_ID)
    ).toBe(true);
  });

  it("excludes rows stamped with another session id (no cross-session reference)", () => {
    const graph = projectEvidenceMap(
      buildWorkspace({
        claims: [claimFixture(CLAIM_ID)],
        evidence: [
          evidenceFixture({
            id: FOREIGN_EVIDENCE_ID,
            claimIds: [CLAIM_ID],
            direction: "supports",
            reliability: 0.9,
            verificationStatus: "verified",
            sessionId: OTHER_SESSION_ID
          })
        ]
      })
    );
    expect(
      graph.nodes.some((node) => node.entityId === FOREIGN_EVIDENCE_ID)
    ).toBe(false);
    expect(
      graph.edges.some((edge) => edge.from === `evidence:${FOREIGN_EVIDENCE_ID}`)
    ).toBe(false);
    expect(
      graph.edges.some((edge) => edge.to === `claim:${CLAIM_ID}`)
    ).toBe(false);
  });

  it("computes coverage as (verified/related) × mean recorded reliability", () => {
    const graph = fullGraph();
    const coverage = graph.coverage.find(
      (entry) => entry.claimId === CLAIM_ID
    );
    // 2 related, 1 verified, mean reliability (0.8 + 0.4) / 2 = 0.6
    expect(coverage?.evidenceCount).toBe(2);
    expect(coverage?.verifiedCount).toBe(1);
    expect(coverage?.supportingCount).toBe(1);
    expect(coverage?.contradictingCount).toBe(1);
    expect(coverage?.sourceCount).toBe(1);
    expect(coverage?.meanReliability).toBe(0.6);
    expect(coverage?.coverage).toBe(0.3);
  });

  it("returns an empty graph for a session without material", () => {
    const graph = projectEvidenceMap(buildWorkspace({}), { now: NOW });
    expect(graph.sessionId).toBe(SESSION_ID);
    expect(graph.generatedAt).toBe(NOW);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.coverage).toEqual([]);
  });

  it("shows a resolved challenge as resolved", () => {
    const challenge = {
      ...challengeFixture(),
      status: "resolved" as const
    };
    const graph = projectEvidenceMap(
      buildWorkspace({
        claims: [claimFixture(CLAIM_ID)],
        challenges: [challenge]
      })
    );
    const node = graph.nodes.find((item) => item.type === "challenge");
    expect(node && "resolution" in node ? node.resolution : undefined).toBe(
      "已解决"
    );
  });
});
