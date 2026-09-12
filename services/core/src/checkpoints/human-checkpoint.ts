import type { HumanDecision, SessionPhase } from "@nexus/shared";

export type HumanDecisionTransition = {
  phase: SessionPhase;
  conclusion: string;
};

export function applyHumanDecision(input: {
  decision: HumanDecision;
  currentPhase: string;
}): HumanDecisionTransition {
  if (input.decision.action === "request_more_analysis") {
    return {
      phase: "REASSESSING",
      conclusion: input.decision.newConclusion
    };
  }

  return {
    phase: "DECIDED",
    conclusion: input.decision.newConclusion
  };
}