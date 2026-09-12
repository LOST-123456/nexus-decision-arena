import { describe, expect, it, vi } from "vitest";
import { newId, type HumanDecision } from "@nexus/shared";
import { createApp } from "../../app";

const decisionBody = {
  conflictId: "0198f3c0-0000-7000-8000-000000000003",
  action: "accept_challenge",
  rationale: "Challenge evidence is sufficient",
  affectedClaimIds: [],
  affectedAgentRoleIds: [],
  previousConclusion: "Hold scale-up",
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

describe("human decision route", () => {
  it("persists a complete checkpoint transition idempotently", async () => {
    const sessionId = newId();
    const recordHumanDecision = vi.fn(async (input: CapturedInput) => ({
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
      payload: decisionBody
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
          id: expect.any(String),
          createdAt: expect.any(String)
        }),
        transition: {
          phase: "DECIDED",
          operationalStatus: "COMPLETED",
          conclusion: "Limited pilot"
        },
        event: expect.objectContaining({
          type: "SESSION_STATE_CHANGED",
          payload: expect.objectContaining({
            phase: "DECIDED",
            operationalStatus: "COMPLETED",
            currentConclusion: "Limited pilot"
          })
        })
      })
    );
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
    const recordHumanDecision = vi.fn(async (input: CapturedInput) => ({
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
        sequence: 8,
        occurredAt: new Date().toISOString()
      }
    }));
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
});
