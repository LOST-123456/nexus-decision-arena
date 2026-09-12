import { describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import type { HumanDecisionResponse } from "./api-client";
import { reduceSessionEvent, type ReplayableSession } from "./event-reducer";
import { applyHumanDecisionResponse } from "./human-decision-sync";

function responseFor(
  decisionId: string,
  eventId: string,
  sessionId: string
): HumanDecisionResponse {
  const event = {
    id: eventId,
    sessionId,
    sequence: 6,
    correlationId: decisionId,
    type: "SESSION_STATE_CHANGED" as const,
    payload: {
      phase: "DECIDED" as const,
      operationalStatus: "COMPLETED" as const,
      currentConclusion: "有限立项"
    },
    occurredAt: new Date().toISOString()
  };
  return {
    session: {
      id: sessionId,
      phase: "DECIDED",
      operationalStatus: "COMPLETED",
      currentConclusion: "有限立项",
      lastSequence: 6
    },
    decision: {
      id: decisionId,
      sessionId,
      conflictId: newId(),
      action: "accept_challenge",
      rationale: "Adopt the evidence challenge",
      affectedClaimIds: [],
      affectedAgentRoleIds: [],
      previousConclusion: "暂缓规模化扩张",
      newConclusion: "有限立项",
      operatorId: "operator-1",
      createdAt: new Date().toISOString()
    },
    event: {
      ...event,
      payload: {
        ...event.payload,
        humanDecision: {
          id: decisionId,
          sessionId,
          conflictId: newId(),
          action: "accept_challenge",
          rationale: "Adopt the evidence challenge",
          affectedClaimIds: [],
          affectedAgentRoleIds: [],
          previousConclusion: "暂缓规模化扩张",
          newConclusion: "有限立项",
          operatorId: "operator-1",
          createdAt: new Date().toISOString()
        }
      }
    }
  };
}

describe("human decision response synchronization", () => {
  it("does not duplicate a decision already applied through SSE", () => {
    const sessionId = newId();
    const decisionId = newId();
    const eventId = newId();
    const response = responseFor(decisionId, eventId, sessionId);
    const initial: ReplayableSession = {
      sessionId,
      phase: "HUMAN_REVIEW",
      operationalStatus: "PAUSED",
      agents: [],
      claims: [],
      evidence: [],
      challenges: [],
      conflicts: [],
      humanDecisions: [],
      currentConclusion: "暂缓规模化扩张",
      lastSequence: 5
    };

    const afterSse = reduceSessionEvent(initial, response.event);
    const afterResponse = applyHumanDecisionResponse(afterSse, response);

    expect(afterResponse.humanDecisions).toHaveLength(1);
    expect(afterResponse.humanDecisions[0]?.id).toBe(decisionId);
    expect(afterResponse.lastSequence).toBe(6);
  });

  it("applies a response event that has not arrived through SSE yet", () => {
    const sessionId = newId();
    const response = responseFor(newId(), newId(), sessionId);
    const initial: ReplayableSession = {
      sessionId,
      phase: "HUMAN_REVIEW",
      operationalStatus: "PAUSED",
      agents: [],
      claims: [],
      evidence: [],
      challenges: [],
      conflicts: [],
      humanDecisions: [],
      currentConclusion: "暂缓规模化扩张",
      lastSequence: 5
    };

    const afterResponse = applyHumanDecisionResponse(initial, response);

    expect(afterResponse.humanDecisions).toHaveLength(1);
    expect(afterResponse.phase).toBe("DECIDED");
    expect(afterResponse.lastSequence).toBe(6);
  });
});