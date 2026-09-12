import type { HumanDecision } from "@nexus/shared";
import type { HumanDecisionResponse } from "./api-client";
import {
  reduceSessionEvent,
  type ReplayableSession
} from "./event-reducer";

function putHumanDecision(
  decisions: HumanDecision[],
  next: HumanDecision
): HumanDecision[] {
  const index = decisions.findIndex((decision) => decision.id === next.id);
  if (index === -1) {
    return [...decisions, next];
  }
  return decisions.map((decision) =>
    decision.id === next.id ? next : decision
  );
}

export function applyHumanDecisionResponse(
  current: ReplayableSession,
  response: HumanDecisionResponse
): ReplayableSession {
  const reduced = reduceSessionEvent(current, response.event);
  return {
    ...reduced,
    phase: response.session.phase ?? reduced.phase,
    operationalStatus:
      response.session.operationalStatus ?? reduced.operationalStatus,
    currentConclusion:
      response.session.currentConclusion ?? reduced.currentConclusion,
    humanDecisions: putHumanDecision(
      reduced.humanDecisions,
      response.decision
    ),
    lastSequence: Math.max(reduced.lastSequence, response.event.sequence)
  };
}