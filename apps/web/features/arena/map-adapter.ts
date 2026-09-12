import type { Edge, Node } from "@xyflow/react";
import type { Challenge, Claim, Conflict } from "@nexus/shared";
import type { ReplayableSession } from "./event-reducer";

export type DecisionMapStatus =
  | "idle"
  | "running"
  | "completed"
  | "challenged"
  | "paused"
  | "conflict"
  | "failed";

export type DecisionMapNodeKind =
  | "agent"
  | "claim"
  | "challenge"
  | "conflict"
  | "conclusion";

export type DecisionMapNodeData = {
  label: string;
  status: DecisionMapStatus;
  detail: string;
  entityId: string;
  kind: DecisionMapNodeKind;
  meta?: string;
  checkpoint?: boolean;
};

export type DecisionMapEdgeData = {
  semantic:
    | "neutral"
    | "running"
    | "resolved"
    | "challenged"
    | "conflict"
    | "failed";
};

export type DecisionMapNode = Node<
  DecisionMapNodeData,
  DecisionMapNodeKind
>;
export type DecisionMapEdge = Edge<DecisionMapEdgeData>;

const edgeColors = {
  neutral: "var(--line-strong)",
  running: "var(--running)",
  resolved: "var(--success)",
  challenged: "var(--danger)",
  conflict: "var(--warning)",
  failed: "var(--danger)"
} as const;

function createEdge(input: {
  id: string;
  source: string;
  target: string;
  semantic: DecisionMapEdgeData["semantic"];
  animated?: boolean;
  width?: number;
}): DecisionMapEdge {
  return {
    id: input.id,
    source: input.source,
    target: input.target,
    type: "smoothstep",
    animated: input.animated ?? false,
    style: {
      stroke: edgeColors[input.semantic],
      strokeWidth: input.width ?? 1.6
    },
    data: { semantic: input.semantic }
  };
}

function claimStatus(
  claim: Claim,
  challenges: Challenge[]
): DecisionMapStatus {
  if (claim.status === "rejected") {
    return "failed";
  }
  if (claim.status === "accepted") {
    return "completed";
  }

  const relatedChallenges = challenges.filter(
    (challenge) => challenge.targetClaimId === claim.id
  );
  if (
    claim.status === "contested" ||
    relatedChallenges.some((challenge) =>
      ["open", "unresolved"].includes(challenge.status)
    )
  ) {
    return "challenged";
  }
  if (
    relatedChallenges.some((challenge) =>
      ["answered", "validating"].includes(challenge.status)
    )
  ) {
    return "running";
  }
  return "idle";
}

function challengeStatus(challenge: Challenge): DecisionMapStatus {
  switch (challenge.status) {
    case "resolved":
      return "completed";
    case "answered":
    case "validating":
      return "running";
    case "unresolved":
      return "failed";
    case "open":
      return "challenged";
  }
}

function conflictStatus(conflict: Conflict): DecisionMapStatus {
  if (conflict.status === "resolved") {
    return "completed";
  }
  return "conflict";
}

function edgeForChallenge(
  challengeId: string,
  status: DecisionMapStatus
): DecisionMapEdgeData["semantic"] {
  if (status === "completed") {
    return "resolved";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "running") {
    return "running";
  }
  return "challenged";
}

function conclusionStatus(
  session: ReplayableSession,
  checkpoint: boolean
): DecisionMapStatus {
  if (session.operationalStatus === "FAILED") {
    return "failed";
  }
  if (checkpoint) {
    return "conflict";
  }
  if (session.operationalStatus === "PAUSED") {
    return "paused";
  }
  if (
    session.operationalStatus === "COMPLETED" ||
    session.phase === "DECIDED" ||
    session.phase === "REPORT_READY"
  ) {
    return "completed";
  }
  return "running";
}

function agentStatus(
  session: ReplayableSession,
  checkpoint: boolean
): DecisionMapStatus {
  if (session.operationalStatus === "FAILED") {
    return "failed";
  }
  if (checkpoint || session.operationalStatus === "PAUSED") {
    return "paused";
  }
  if (
    session.operationalStatus === "COMPLETED" ||
    session.phase === "DECIDED" ||
    session.phase === "REPORT_READY"
  ) {
    return "completed";
  }
  return session.phase === "CREATED" ? "idle" : "running";
}

export function toDecisionMap(session: ReplayableSession): {
  nodes: DecisionMapNode[];
  edges: DecisionMapEdge[];
} {
  const humanCheckpoint =
    session.phase === "HUMAN_REVIEW" ||
    session.conflicts.some(
      (conflict) =>
        conflict.humanDecisionRequired || conflict.status === "human_review"
    );
  const visibleClaims = session.claims.slice(0, 5);
  const visibleChallenges = session.challenges.slice(0, 5);
  const visibleClaimIds = new Set(visibleClaims.map((claim) => claim.id));
  const nodes: DecisionMapNode[] = [];
  const edges: DecisionMapEdge[] = [];

  session.agents.forEach((agent, index) => {
    nodes.push({
      id: `agent:${agent.id}`,
      type: "agent",
      position: { x: 0, y: 40 + index * 118 },
      data: {
        label: agent.name,
        status: agentStatus(session, humanCheckpoint),
        detail: agent.perspective,
        entityId: agent.id,
        kind: "agent",
        meta: agent.key.replaceAll("_", " ").toUpperCase()
      }
    });
  });

  visibleClaims.forEach((claim, index) => {
    nodes.push({
      id: `claim:${claim.id}`,
      type: "claim",
      position: { x: 300, y: 40 + index * 128 },
      data: {
        label: claim.statement,
        status: claimStatus(claim, session.challenges),
        detail: `${Math.round(claim.confidence * 100)}% confidence`,
        entityId: claim.id,
        kind: "claim",
        meta: `CLAIM ${claim.importance}/5`
      }
    });
  });

  visibleChallenges.forEach((challenge, index) => {
    nodes.push({
      id: `challenge:${challenge.id}`,
      type: "challenge",
      position: { x: 600, y: 70 + index * 122 },
      data: {
        label: challenge.question,
        status: challengeStatus(challenge),
        detail: challenge.requiredEvidence.join(" · "),
        entityId: challenge.id,
        kind: "challenge",
        meta: `CHALLENGE ${challenge.severity}/5`
      }
    });
  });

  session.conflicts.forEach((conflict, index) => {
    nodes.push({
      id: `conflict:${conflict.id}`,
      type: "conflict",
      position: { x: 900, y: 150 + index * 150 },
      data: {
        label: conflict.summary,
        status: conflictStatus(conflict),
        detail: conflict.resolutionSuggestion,
        entityId: conflict.id,
        kind: "conflict",
        meta: `CONFLICT ${conflict.severity}/5`,
        checkpoint: conflict.humanDecisionRequired
      }
    });
  });

  nodes.push({
    id: "conclusion",
    type: "conclusion",
    position: { x: 1_220, y: 280 },
    data: {
      label: session.currentConclusion ?? "正在形成结论",
      status: conclusionStatus(session, humanCheckpoint),
      detail: session.phase.replaceAll("_", " "),
      entityId: session.sessionId,
      kind: "conclusion",
      meta: humanCheckpoint ? "HUMAN CHECKPOINT" : "DECISION",
      checkpoint: humanCheckpoint
    }
  });

  for (const claim of visibleClaims) {
    const status = claimStatus(claim, session.challenges);
    const relatedAgents = session.agents.filter(
      (agent) => agent.id === claim.roleId
    );

    for (const agent of relatedAgents) {
      edges.push(
        createEdge({
          id: `agent-claim:${agent.id}:${claim.id}`,
          source: `agent:${agent.id}`,
          target: `claim:${claim.id}`,
          semantic:
            claim.stance === "oppose"
              ? "challenged"
              : claim.stance === "support"
                ? "resolved"
                : "neutral"
        })
      );
    }

    edges.push(
      createEdge({
        id: `claim-edge:${claim.id}`,
        source: `claim:${claim.id}`,
        target: "conclusion",
        semantic:
          status === "completed"
            ? "resolved"
            : status === "failed"
              ? "failed"
              : status === "challenged"
                ? "challenged"
                : "neutral"
      })
    );
  }

  for (const challenge of visibleChallenges) {
    if (!visibleClaimIds.has(challenge.targetClaimId)) {
      continue;
    }

    const status = challengeStatus(challenge);
    const semantic = edgeForChallenge(challenge.id, status);
    edges.push(
      createEdge({
        id: `challenge-edge:${challenge.id}`,
        source: `challenge:${challenge.id}`,
        target: `claim:${challenge.targetClaimId}`,
        semantic,
        animated: status === "challenged" || status === "running",
        width: challenge.severity >= 4 ? 2.4 : 1.6
      })
    );
  }

  for (const conflict of session.conflicts) {
    const status = conflictStatus(conflict);
    edges.push(
      createEdge({
        id: `conflict-edge:${conflict.id}`,
        source: `conflict:${conflict.id}`,
        target: "conclusion",
        semantic: status === "completed" ? "resolved" : "conflict",
        animated: status !== "completed",
        width: conflict.severity >= 4 ? 2.6 : 1.6
      })
    );
  }

  return { nodes, edges };
}
