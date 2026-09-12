import type { ClaimInspectorDTO } from "@nexus/shared";
import type { ReplayableSession } from "./event-reducer";

function decisionSummary(session: ReplayableSession): string {
  const action = session.humanDecisions.at(-1)?.action;
  if (action === "request_more_analysis") {
    return "\u8865\u5145\u91c7\u8d2d\u4e0e\u6210\u672c\u8bc1\u636e\u540e\u91cd\u65b0\u8bc4\u4f30\u3002";
  }
  if (action === "uphold_claim") {
    return "\u7ef4\u6301\u539f\u5224\u65ad\u3002";
  }
  if (session.phase === "DECIDED") {
    return "\u91c7\u8d2d\u3001\u6280\u672f\u548c\u8d22\u52a1\u8d28\u8be2\u5df2\u88ab\u91c7\u7eb3\uff0c\u7ed3\u8bba\u8c03\u6574\u4e3a\u6709\u9650\u7acb\u9879\u3002";
  }
  return "\u91c7\u8d2d\u7ba1\u9053\u8bc1\u636e\u4e0d\u8db3\uff0c\u9700\u8981\u4eba\u5de5\u88c1\u51b3\u3002";
}

export function toPreviewInspectorDTO(
  session: ReplayableSession
): ClaimInspectorDTO | null {
  const claim = session.claims[0];
  if (!claim) {
    return null;
  }

  return {
    claim,
    evidence: session.evidence,
    challenges: session.challenges.map((challenge) => ({ challenge })),
    conflicts: session.conflicts,
    provenance: {
      agentRun: undefined,
      promptVersion: undefined
    },
    decisionRationale: {
      outcome:
        session.phase === "DECIDED"
          ? "accepted"
          : session.phase === "HUMAN_REVIEW"
            ? "needs_human"
            : "contested",
      summary: decisionSummary(session),
      decisiveChallengeIds: session.challenges
        .filter((challenge) => challenge.severity >= 4)
        .map((challenge) => challenge.id),
      evidenceIds: claim.evidenceIds
    }
  };
}