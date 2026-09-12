import { describe, expect, it } from "vitest";
import type { ExecutionEvent } from "@nexus/shared";
import { newId } from "@nexus/shared";
import {
  reduceSessionEvent,
  type ReplayableSession
} from "./event-reducer";

function sessionStateEvent(
  sessionId: string,
  sequence: number,
  phase: ReplayableSession["phase"]
): ExecutionEvent {
  return {
    id: newId(),
    sessionId,
    sequence,
    correlationId: newId(),
    type: "SESSION_STATE_CHANGED",
    payload: { phase },
    occurredAt: new Date().toISOString()
  };
}

function initialSession(sessionId: string): ReplayableSession {
  return {
    sessionId,
    phase: "CREATED",
    operationalStatus: "ACTIVE",
    agents: [],
    claims: [],
    evidence: [],
    challenges: [],
    conflicts: [],
    humanDecisions: [],
    currentConclusion: null,
    lastSequence: 0
  };
}

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
    const initial = initialSession(event.sessionId);

    const once = reduceSessionEvent(initial, event);
    const twice = reduceSessionEvent(once, event);

    expect(once.phase).toBe("PLANNING");
    expect(twice).toEqual(once);
  });

  it("buffers 3 then 1 then 2 into the same state as 1 then 2 then 3", () => {
    const sessionId = newId();
    const initial = initialSession(sessionId);
    const events = [
      sessionStateEvent(sessionId, 1, "PLANNING"),
      sessionStateEvent(sessionId, 2, "ANALYZING"),
      sessionStateEvent(sessionId, 3, "CHALLENGING")
    ];

    const sequential = events.reduce(reduceSessionEvent, initial);
    const buffered = [events[2]!, events[0]!, events[1]!].reduce(
      reduceSessionEvent,
      initial
    );

    expect(buffered).toEqual(sequential);
    expect(buffered.phase).toBe("CHALLENGING");
    expect(buffered.lastSequence).toBe(3);
    expect(buffered.pendingEvents).toEqual({});
  });

  it("does not reapply duplicate contiguous or pending events", () => {
    const sessionId = newId();
    const initial = initialSession(sessionId);
    const first = sessionStateEvent(sessionId, 1, "PLANNING");
    const third = sessionStateEvent(sessionId, 3, "CHALLENGING");

    const applied = reduceSessionEvent(initial, first);
    expect(reduceSessionEvent(applied, first)).toBe(applied);

    const pending = reduceSessionEvent(initial, third);
    expect(reduceSessionEvent(pending, third)).toBe(pending);
    expect(pending.lastSequence).toBe(0);
    expect(pending.pendingEvents?.[3]).toEqual(third);

    const recovered = [
      sessionStateEvent(sessionId, 2, "ANALYZING"),
      sessionStateEvent(sessionId, 1, "PLANNING")
    ].reduce(reduceSessionEvent, pending);

    expect(recovered.lastSequence).toBe(3);
    expect(recovered.phase).toBe("CHALLENGING");
    expect(recovered.pendingEvents).toEqual({});
  });

  it("moves a human review event into a paused checkpoint", () => {
    const sessionId = newId();
    const initial = {
      ...initialSession(sessionId),
      phase: "CONFLICT_DETECTED" as const,
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

  it("projects the human decision carried by a state-change event", () => {
    const sessionId = newId();
    const initial = {
      ...initialSession(sessionId),
      phase: "HUMAN_REVIEW" as const,
      operationalStatus: "PAUSED" as const,
      currentConclusion: "Hold scale-up",
      lastSequence: 4
    };
    const humanDecision = {
      id: newId(),
      sessionId,
      conflictId: newId(),
      action: "accept_challenge" as const,
      rationale: "Challenge evidence is sufficient",
      affectedClaimIds: [],
      affectedAgentRoleIds: [],
      previousConclusion: "Hold scale-up",
      newConclusion: "Limited pilot",
      operatorId: "operator-1",
      createdAt: new Date().toISOString()
    };

    const next = reduceSessionEvent(initial, {
      id: newId(),
      sessionId,
      sequence: 5,
      correlationId: humanDecision.id,
      type: "SESSION_STATE_CHANGED",
      payload: {
        phase: "DECIDED",
        operationalStatus: "COMPLETED",
        currentConclusion: "Limited pilot",
        humanDecision
      },
      occurredAt: new Date().toISOString()
    });

    expect(next.phase).toBe("DECIDED");
    expect(next.operationalStatus).toBe("COMPLETED");
    expect(next.currentConclusion).toBe("Limited pilot");
    expect(next.humanDecisions).toEqual([humanDecision]);
  });
