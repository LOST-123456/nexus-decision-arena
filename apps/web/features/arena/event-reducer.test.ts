import { describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { reduceSessionEvent } from "./event-reducer";

describe("session event reducer", () => {
  it("applies an event exactly once", () => {
    const event = {
      id: newId(),
      sessionId: newId(),
      sequence: 1,
      correlationId: newId(),
      type: "SESSION_STATE_CHANGED" as const,
      payload: { phase: "PLANNING" as const },
      occurredAt: new Date().toISOString()
    };
    const initial = {
      sessionId: event.sessionId,
      phase: "CREATED" as const,
      operationalStatus: "ACTIVE" as const,
      agents: [],
      claims: [],
      evidence: [],
      challenges: [],
      conflicts: [],
      humanDecisions: [],
      currentConclusion: null,
      lastSequence: 0
    };

    const once = reduceSessionEvent(initial, event);
    const twice = reduceSessionEvent(once, event);

    expect(once.phase).toBe("PLANNING");
    expect(twice).toEqual(once);
  });

  it("does not skip over a missing event sequence", () => {
    const sessionId = newId();
    const initial = {
      sessionId,
      phase: "CREATED" as const,
      operationalStatus: "ACTIVE" as const,
      agents: [],
      claims: [],
      evidence: [],
      challenges: [],
      conflicts: [],
      humanDecisions: [],
      currentConclusion: null,
      lastSequence: 0
    };
    const outOfOrder = {
      id: newId(),
      sessionId,
      sequence: 3,
      correlationId: newId(),
      type: "SESSION_STATE_CHANGED" as const,
      payload: { phase: "ANALYZING" as const },
      occurredAt: new Date().toISOString()
    };

    const ignored = reduceSessionEvent(initial, outOfOrder);
    const recovered = reduceSessionEvent(ignored, {
      ...outOfOrder,
      id: newId(),
      sequence: 1,
      payload: { phase: "PLANNING" }
    });

    expect(ignored).toBe(initial);
    expect(recovered.phase).toBe("PLANNING");
    expect(recovered.lastSequence).toBe(1);
  });

  it("moves a human review event into a paused checkpoint", () => {
    const sessionId = newId();
    const initial = {
      sessionId,
      phase: "CONFLICT_DETECTED" as const,
      operationalStatus: "ACTIVE" as const,
      agents: [],
      claims: [],
      evidence: [],
      challenges: [],
      conflicts: [],
      humanDecisions: [],
      currentConclusion: null,
      lastSequence: 4
    };

    const next = reduceSessionEvent(initial, {
      id: newId(),
      sessionId,
      sequence: 5,
      correlationId: newId(),
      type: "HUMAN_REVIEW_REQUIRED",
      payload: { reason: "High-severity conflict" },
      occurredAt: new Date().toISOString()
    });

    expect(next.phase).toBe("HUMAN_REVIEW");
    expect(next.operationalStatus).toBe("PAUSED");
    expect(next.lastSequence).toBe(5);
  });
});
