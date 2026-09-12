import { describe, expect, it, vi } from "vitest";
import { ReportNotReadyError } from "@nexus/db";
import { newId, type FinalReport } from "@nexus/shared";
import { createApp } from "../../app";

function reportFixture(sessionId: string): FinalReport {
  const timestamp = new Date().toISOString();
  return {
    id: newId(),
    sessionId,
    projectName: "Live project",
    executiveSummary: "Summary",
    initialConclusion: "建议立项",
    postChallengeConclusion: "暂缓规模化扩张",
    humanAction: "Adopt the decisive challenge",
    finalConclusion: "有限立项",
    decisionExplanation: "Run a limited pilot.",
    requiredNextActions: ["Collect evidence"],
    decisiveChallengeIds: [newId()],
    evidenceIds: [newId()],
    humanDecisionId: newId(),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function createTestApp(input: {
  sessionId: string;
  getBySessionId: ReturnType<typeof vi.fn>;
  generateAndPersist: ReturnType<typeof vi.fn>;
}) {
  return createApp({
    sessions: {
      getById: vi.fn().mockResolvedValue({ id: input.sessionId })
    } as never,
    inspector: {} as never,
    events: {} as never,
    reports: {
      getBySessionId: input.getBySessionId,
      generateAndPersist: input.generateAndPersist
    } as never,
    runSession: {} as never
  });
}

describe("report route", () => {
  it("returns a persisted report without regenerating it", async () => {
    const sessionId = newId();
    const report = reportFixture(sessionId);
    const getBySessionId = vi.fn().mockResolvedValue(report);
    const generateAndPersist = vi.fn();
    const app = createTestApp({
      sessionId,
      getBySessionId,
      generateAndPersist
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/report`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(report);
    expect(generateAndPersist).not.toHaveBeenCalled();
  });

  it("generates and persists the report when it is absent", async () => {
    const sessionId = newId();
    const report = reportFixture(sessionId);
    const getBySessionId = vi.fn().mockResolvedValue(null);
    const generateAndPersist = vi.fn().mockResolvedValue(report);
    const app = createTestApp({
      sessionId,
      getBySessionId,
      generateAndPersist
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/report`
    });

    expect(response.statusCode).toBe(200);
    expect(generateAndPersist).toHaveBeenCalledWith(sessionId);
  });

  it("returns 409 until a human decision is recorded", async () => {
    const sessionId = newId();
    const app = createTestApp({
      sessionId,
      getBySessionId: vi.fn().mockResolvedValue(null),
      generateAndPersist: vi
        .fn()
        .mockRejectedValue(new ReportNotReadyError())
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/report`
    });

    expect(response.statusCode).toBe(409);
  });
});
