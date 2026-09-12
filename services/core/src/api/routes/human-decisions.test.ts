import { describe, expect, it, vi } from "vitest";
import { newId, type HumanDecision } from "@nexus/shared";
import { SessionNotInHumanReviewError } from "@nexus/db";
import { createApp } from "../../app";
import { EventBus } from "../../execution/event-bus";

const decisionBody = {
  conflictId: "0198f3c0-0000-7000-8000-000000000003",
  action: "accept_challenge",
  rationale: "Challenge evidence is sufficient",
  affectedClaimIds: [],
  affectedAgentRoleIds: [],
  newConclusion: "Limited pilot",
  operatorId: "operator-1"
} as const;

type CapturedInput = {
  decision: HumanDecision;
  transition: {
    phase: string;
    operationalStatus: string;
    conclusion: string;
  };
  event: {
    correlationId: string;
    type: string;
    payload: unknown;
  };
};

function recordingRepository(sessionId: string) {
  return vi.fn(async (input: CapturedInput) => ({
    session: {
      id: sessionId,
      phase: input.transition.phase,
      operationalStatus: input.transition.operationalStatus,
      currentConclusion: input.transition.conclusion
    },
    decision: input.decision,
    event: {
      ...input.event,
      id: newId(),
      sessionId,
      sequence: 7,
      occurredAt: new Date().toISOString()
    }
  }));
}

describe("human decision route", () => {
  it("loads previous conclusion and persists a complete transition idempotently", async () => {
    const sessionId = newId();
    const recordHumanDecision = recordingRepository(sessionId);
    const app = createApp({
      sessions: {
        getById: vi.fn().mockResolvedValue({
          id: sessionId,
          phase: "HUMAN_REVIEW",
          currentConclusion: "Hold scale-up"
        }),
        recordHumanDecision
      } as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never
    });

    const first = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/human-decisions`,
      headers: { "idempotency-key": "decision-1" },
      payload: {
        ...decisionBody,
        previousConclusion: "Forged client value"
      }
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/human-decisions`,
      headers: { "idempotency-key": "decision-1" },
      payload: decisionBody
    });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(recordHumanDecision).toHaveBeenCalledTimes(1);
    expect(recordHumanDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          sessionId,
          ...decisionBody,
          previousConclusion: "Hold scale-up",
          id: expect.any(String),
          createdAt: expect.any(String)
        }),
        transition: {
          phase: "DECIDED",
          operationalStatus: "COMPLETED",
          conclusion: "Limited pilot"
        }
      })
    );
  });

  it("rejects a session that is not awaiting human review", async () => {
    const sessionId = newId();
    const recordHumanDecision = vi.fn();
    const app = createApp({
      sessions: {
        getById: vi.fn().mockResolvedValue({
          id: sessionId,
          phase: "ANALYZING",
          currentConclusion: "Initial conclusion"
        }),
        recordHumanDecision
      } as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/human-decisions`,
      headers: { "idempotency-key": "decision-not-review" },
      payload: decisionBody
    });

    expect(response.statusCode).toBe(409);
    expect(recordHumanDecision).not.toHaveBeenCalled();
  });

  it("requires an idempotency key and valid decision payload", async () => {
    const app = createApp({
      sessions: {} as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never
    });
    const sessionId = newId();

    const missingKey = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/human-decisions`,
      payload: decisionBody
    });
    const invalid = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/human-decisions`,
      headers: { "idempotency-key": "decision-invalid" },
      payload: { ...decisionBody, rationale: "" }
    });

    expect(missingKey.statusCode).toBe(400);
    expect(invalid.statusCode).toBe(400);
  });

  it("returns reassessment decisions to the active phase", async () => {
    const sessionId = newId();
    const recordHumanDecision = recordingRepository(sessionId);
    const app = createApp({
      sessions: {
        getById: vi.fn().mockResolvedValue({
          id: sessionId,
          phase: "HUMAN_REVIEW",
          currentConclusion: "Hold scale-up"
        }),
        recordHumanDecision
      } as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/human-decisions`,
      headers: { "idempotency-key": "decision-more-analysis" },
      payload: {
        ...decisionBody,
        action: "request_more_analysis",
        rationale: "Request more evidence",
        newConclusion: "Reassess procurement evidence"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().session).toMatchObject({
      phase: "REASSESSING",
      operationalStatus: "ACTIVE",
      currentConclusion: "Reassess procurement evidence"
    });
  });

  it("publishes the committed event to subscribers", async () => {
    const sessionId = newId();
    const eventBus = new EventBus();
    const listener = vi.fn();
    eventBus.subscribe(sessionId, listener);
    const app = createApp(
      {
        sessions: {
          getById: vi.fn().mockResolvedValue({
            id: sessionId,
            phase: "HUMAN_REVIEW",
            currentConclusion: "Hold scale-up"
          }),
          recordHumanDecision: recordingRepository(sessionId)
        } as never,
        inspector: {} as never,
        events: {} as never,
        runSession: {} as never
      },
      undefined,
      { eventBus }
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/human-decisions`,
      headers: { "idempotency-key": "decision-publish" },
      payload: decisionBody
    });

    expect(response.statusCode).toBe(201);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        type: "SESSION_STATE_CHANGED"
      })
    );
  });

  it("keeps a committed response when event publication fails", async () => {
    const sessionId = newId();
    const eventBus = new EventBus();
    eventBus.subscribe(sessionId, () => {
      throw new Error("subscriber failed");
    });
    const recordHumanDecision = recordingRepository(sessionId);
    const app = createApp(
      {
        sessions: {
          getById: vi.fn().mockResolvedValue({
            id: sessionId,
            phase: "HUMAN_REVIEW",
            currentConclusion: "Hold scale-up"
          }),
          recordHumanDecision
        } as never,
        inspector: {} as never,
        events: {} as never,
        runSession: {} as never
      },
      undefined,
      { eventBus }
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/human-decisions`,
      headers: { "idempotency-key": "decision-publish-failure" },
      payload: decisionBody
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().session).toMatchObject({
      phase: "DECIDED",
      currentConclusion: "Limited pilot"
    });
    expect(recordHumanDecision).toHaveBeenCalledTimes(1);
  });
  it("maps a lost compare-and-set race to 409", async () => {
    const sessionId = newId();
    const recordHumanDecision = vi
      .fn()
      .mockRejectedValue(new SessionNotInHumanReviewError());
    const app = createApp({
      sessions: {
        getById: vi.fn().mockResolvedValue({
          id: sessionId,
          phase: "HUMAN_REVIEW",
          currentConclusion: "Hold scale-up"
        }),
        recordHumanDecision
      } as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/human-decisions`,
      headers: { "idempotency-key": "decision-race" },
      payload: decisionBody
    });

    expect(response.statusCode).toBe(409);
    expect(recordHumanDecision).toHaveBeenCalledTimes(1);
  });
});