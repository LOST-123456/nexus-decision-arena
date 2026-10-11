import {
  type EvidenceCoverage,
  type EvidenceMapEdge,
  type EvidenceMapGraph,
  type EvidenceMapNode,
  type EvidenceMapNodeType,
  type Challenge
} from "@nexus/shared";
import type { ResearchWorkspace } from "./workspace-service";

/*
 * Evidence Map projection.
 *
 * A pure, read-only function over the research workspace the UI already
 * shows. It adds NO table, NO write path and NO verdict logic: every node and
 * every edge is a projection of rows that already exist, and the verdict
 * shown on a claim node is the same derived ClaimVerdict the workspace
 * computes. If this file disappeared, nothing would be lost except the
 * picture.
 *
 * Honesty rules encoded here:
 *  - an Evidence→Claim edge means "this excerpt bears on that claim", never
 *    "this claim is proven" (the relation is the recorded direction);
 *  - only entities belonging to the session may enter the graph, and an edge
 *    is only drawn when BOTH endpoints exist as nodes — so a stale reference
 *    (a claim id from another session, a deleted row) can never dangle;
 *  - a source's `reliability` is the mean of RECORDED excerpt reliabilities,
 *    not a trust score;
 *  - coverage is a display metric and never feeds back into verdicts.
 */

function nodeKey(type: EvidenceMapNodeType, entityId: string): string {
  return `${type}:${entityId}`;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Challenge resolution, projected from recorded fields only. Null means the
 * challenge is still open (open / validating / unresolved) — the graph never
 * marks a challenge settled that the data does not say is settled.
 */
function challengeResolution(challenge: Challenge): string | null {
  if (challenge.status === "resolved") {
    return "已解决";
  }
  if (challenge.status === "answered") {
    return challenge.responseClaimId
      ? "已由回应主张答复，待核实"
      : "已答复，待核实";
  }
  return null;
}

export function projectEvidenceMap(
  workspace: ResearchWorkspace,
  options: { now?: string } = {}
): EvidenceMapGraph {
  const sessionId = workspace.session.id;

  // Session guard: a row stamped with another session id can never enter.
  const claims = workspace.claims.filter(
    (claim) => claim.sessionId === sessionId
  );
  const evidence = workspace.evidence.filter(
    (item) => item.sessionId === sessionId
  );
  const sources = workspace.sources.filter(
    (source) => source.sessionId === sessionId
  );
  const conflicts = workspace.conflicts.filter(
    (conflict) => conflict.sessionId === sessionId
  );
  const challenges = workspace.challenges.filter(
    (challenge) => challenge.sessionId === sessionId
  );

  const claimIds = new Set(claims.map((claim) => claim.id));
  const sourceIds = new Set(sources.map((source) => source.id));
  const challengeIds = new Set(challenges.map((challenge) => challenge.id));

  const verdictByClaimId = new Map(
    workspace.verdicts.map((verdict) => [verdict.claimId, verdict])
  );

  const nodes: EvidenceMapNode[] = [];

  for (const claim of claims) {
    const verdict = verdictByClaimId.get(claim.id);
    nodes.push({
      id: nodeKey("claim", claim.id),
      sessionId,
      entityId: claim.id,
      type: "claim",
      label: claim.statement,
      status: claim.status,
      statement: claim.statement,
      verdict: verdict?.status ?? "unsupported"
    });
  }

  for (const item of evidence) {
    nodes.push({
      id: nodeKey("evidence", item.id),
      sessionId,
      entityId: item.id,
      type: "evidence",
      label: item.title,
      status: item.verificationStatus,
      excerpt: item.content,
      verificationStatus: item.verificationStatus,
      direction: item.direction
    });
  }

  // Recorded per-excerpt reliabilities, grouped by the source they came from.
  const reliabilityBySource = new Map<string, { sum: number; count: number }>();
  for (const item of evidence) {
    if (!item.sourceId) continue;
    const current = reliabilityBySource.get(item.sourceId) ?? {
      sum: 0,
      count: 0
    };
    reliabilityBySource.set(item.sourceId, {
      sum: current.sum + item.reliability,
      count: current.count + 1
    });
  }

  for (const source of sources) {
    const reliability = reliabilityBySource.get(source.id);
    nodes.push({
      id: nodeKey("source", source.id),
      sessionId,
      entityId: source.id,
      type: "source",
      label: source.title,
      status: source.retrievalStatus ?? "not_requested",
      title: source.title,
      publisher: source.publisher ?? null,
      sourceType: source.kind,
      reliability:
        reliability && reliability.count > 0
          ? round4(reliability.sum / reliability.count)
          : null
    });
  }

  for (const conflict of conflicts) {
    nodes.push({
      id: nodeKey("conflict", conflict.id),
      sessionId,
      entityId: conflict.id,
      type: "conflict",
      label: conflict.summary,
      status: conflict.status,
      severity: conflict.severity
    });
  }

  for (const challenge of challenges) {
    nodes.push({
      id: nodeKey("challenge", challenge.id),
      sessionId,
      entityId: challenge.id,
      type: "challenge",
      label: challenge.question,
      status: challenge.status,
      question: challenge.question,
      resolution: challengeResolution(challenge)
    });
  }

  // An edge exists only when both endpoints are nodes of this session.
  const edges: EvidenceMapEdge[] = [];
  const seenEdges = new Set<string>();
  const addEdge = (input: {
    from: string;
    to: string;
    relation: EvidenceMapEdge["relation"];
    confidence: number | null;
  }): void => {
    const key = `${input.relation}|${input.from}|${input.to}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({
      id: `${input.relation}:${input.from}:${input.to}`,
      sessionId,
      from: input.from,
      to: input.to,
      relation: input.relation,
      confidence: input.confidence
    });
  };

  for (const item of evidence) {
    const from = nodeKey("evidence", item.id);
    // The relation IS the recorded direction — supports/opposes/context are
    // never renamed, and context is never silently promoted to support.
    for (const claimId of item.claimIds) {
      if (!claimIds.has(claimId)) continue;
      addEdge({
        from,
        to: nodeKey("claim", claimId),
        relation: item.direction,
        confidence: item.reliability
      });
    }
    if (item.sourceId && sourceIds.has(item.sourceId)) {
      addEdge({
        from: nodeKey("source", item.sourceId),
        to: from,
        relation: "provided_by",
        confidence: null
      });
    }
  }

  for (const conflict of conflicts) {
    const conflictNode = nodeKey("conflict", conflict.id);
    for (const claimId of conflict.claimIds) {
      if (!claimIds.has(claimId)) continue;
      addEdge({
        from: nodeKey("claim", claimId),
        to: conflictNode,
        relation: "involved_in",
        confidence: null
      });
    }
    for (const challengeId of conflict.challengeIds) {
      if (!challengeIds.has(challengeId)) continue;
      addEdge({
        from: conflictNode,
        to: nodeKey("challenge", challengeId),
        relation: "generated_by",
        confidence: null
      });
    }
  }

  for (const challenge of challenges) {
    if (!claimIds.has(challenge.targetClaimId)) continue;
    addEdge({
      from: nodeKey("challenge", challenge.id),
      to: nodeKey("claim", challenge.targetClaimId),
      relation: "questions",
      confidence: null
    });
  }

  // Display metric only. Nothing derived here is ever written back.
  const coverage: EvidenceCoverage[] = claims.map((claim) => {
    const related = evidence.filter((item) => item.claimIds.includes(claim.id));
    const verified = related.filter(
      (item) => item.verificationStatus === "verified"
    );
    const relatedSourceIds = new Set(
      related
        .map((item) => item.sourceId)
        .filter((sourceId): sourceId is string => Boolean(sourceId))
    );
    const meanReliability =
      related.length === 0
        ? null
        : round4(
            related.reduce((sum, item) => sum + item.reliability, 0) /
              related.length
          );
    return {
      claimId: claim.id,
      evidenceCount: related.length,
      verifiedCount: verified.length,
      supportingCount: related.filter((item) => item.direction === "supports")
        .length,
      contradictingCount: related.filter((item) => item.direction === "opposes")
        .length,
      sourceCount: relatedSourceIds.size,
      meanReliability,
      coverage:
        related.length === 0
          ? 0
          : round4((verified.length / related.length) * (meanReliability ?? 0))
    };
  });

  return {
    sessionId,
    generatedAt: options.now ?? new Date().toISOString(),
    nodes,
    edges,
    coverage
  };
}
