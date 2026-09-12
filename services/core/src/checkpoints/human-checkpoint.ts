import {
  SESSION_PHASES,
  transitionSession,
  type HumanDecision,
  type SessionPhase
} from "@nexus/shared";

export type HumanDecisionTransition = {
  phase: SessionPhase;
  conclusion: string;
};

function requireSessionPhase(value: string): SessionPhase {
  if (!SESSION_PHASES.includes(value as SessionPhase)) {
    throw new Error(`Invalid session phase: ${value}`);
  }
  return value as SessionPhase;
}

export function applyHumanDecision(input: {
  decision: HumanDecision;
  currentPhase: string;
}): HumanDecisionTransition {
  const targetPhase =
    input.decision.action === "request_more_analysis"
      ? "REASSESSING"
      : "DECIDED";

  return {
    phase: transitionSession(
      requireSessionPhase(input.currentPhase),
      targetPhase
    ),
    conclusion: input.decision.newConclusion
  };
}