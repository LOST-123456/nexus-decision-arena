import { describe, expect, it, vi } from "vitest";
import {
  AgentRunNotFoundError,
  AgentRunNotRetryableError,
  AgentRunRetryLimitError,
  AgentRunRetryUnsupportedError,
  AgentRunService,
  AgentRunTerminalError,
  MAX_AGENT_RUN_RETRIES
} from "./agent-run-service";
import type { AgentRunView } from "@nexus/shared";
import { RunCancellationRegistry } from "./run-cancellation";

function makeRun(over: Partial<AgentRunView> = {}): AgentRunView {
  return {
    id: "run-1",
    sessionId: "session-1",
    roleId: "role-1",
    promptVersionId: "pv-1",
    status: "completed",
    purpose: "cross_review",
    taskType: "cross_review",
    attempt: 1,
    tokenUsage: null,
    roleName: "审查员",
    startedAt: "2026-01-01T00:00:00.000Z",
    ...over
  };
}

function makeDeps(over: Record<string, unknown> = {}) {
  const reviews = {
    getAgentRunById: vi.fn(),
    listAgentRunsDetailed: vi.fn(),
    listAgentRunEvents: vi.fn(),
    cancelAgentRun: vi.fn(),
    setRunRetryMeta: vi.fn()
  };
  const arena = { getSessionArtifacts: vi.fn() };
  const events = { append: vi.fn().mockResolvedValue(undefined) };
  const crossReview = {
    runForClaim: vi.fn()
  };
  const cancellations = new RunCancellationRegistry();
  return {
    reviews,
    arena,
    events,
    crossReview,
    cancellations,
    service: new AgentRunService({
      reviews,
      arena,
      events,
      cancellations,
      crossReview
    }),
    ...over
  };
}

describe("AgentRunService", () => {
  it("listRuns delegates to the repository's detailed list", async () => {
    const d = makeDeps();
    d.reviews.listAgentRunsDetailed.mockResolvedValue([makeRun()]);
    const runs = await d.service.listRuns("session-1");
    expect(runs).toHaveLength(1);
    expect(d.reviews.listAgentRunsDetailed).toHaveBeenCalledWith("session-1");
  });

  it("getRunDetail throws NotFound when the run is absent", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(null);
    await expect(d.service.getRunDetail("session-1", "run-1")).rejects.toBeInstanceOf(
      AgentRunNotFoundError
    );
  });

  it("getRunDetail links challenges, response claims and conflicts", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(
      makeRun({ status: "completed", targetClaimId: "claim-1" })
    );
    d.reviews.listAgentRunEvents.mockResolvedValue([
      { sequence: 1, type: "AGENT_RUN_STARTED", occurredAt: "t", payload: {} }
    ]);
    d.arena.getSessionArtifacts.mockResolvedValue({
      challenges: [
        { id: "ch-1", challengerRunId: "run-1" },
        { id: "ch-2", challengerRunId: "other" }
      ],
      conflicts: [{ id: "cf-1", challengeIds: ["ch-1"] }],
      claims: [{ id: "cl-1", agentRunId: "run-1" }]
    });
    const detail = await d.service.getRunDetail("session-1", "run-1");
    expect(detail.events).toHaveLength(1);
    expect(detail.outcome).toEqual({
      challengeIds: ["ch-1"],
      conflictIds: ["cf-1"],
      responseClaimIds: ["cl-1"]
    });
  });

  it("cancelRun emits an audit event on a fresh cancel", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById
      .mockResolvedValueOnce(makeRun({ status: "queued" }))
      .mockResolvedValueOnce(
        makeRun({ status: "cancelled", errorCode: "cancelled_by_user" })
      );
    d.reviews.cancelAgentRun.mockResolvedValue(
      makeRun({ status: "cancelled", errorCode: "cancelled_by_user" })
    );
    const result = await d.service.cancelRun("session-1", "run-1", "Owner");
    expect(result.alreadyCancelled).toBe(false);
    expect(d.events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "AGENT_RUN_CANCELLED",
        correlationId: "run-1",
        payload: expect.objectContaining({ requestedBy: "Owner" })
      })
    );
  });

  it("cancelRun is idempotent for an already-cancelled run", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(
      makeRun({ status: "cancelled", errorCode: "cancelled_by_user" })
    );
    d.reviews.cancelAgentRun.mockResolvedValue(null);
    const result = await d.service.cancelRun("session-1", "run-1", "Owner");
    expect(result.alreadyCancelled).toBe(true);
    expect(d.events.append).not.toHaveBeenCalled();
  });

  it("cancelRun refuses a terminal (non-cancelled) run", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(makeRun({ status: "completed" }));
    d.reviews.cancelAgentRun.mockResolvedValue(null);
    await expect(d.service.cancelRun("session-1", "run-1", "Owner")).rejects.toBeInstanceOf(
      AgentRunTerminalError
    );
  });

  it("cancelRun records the request before the verdict, with who, when and why", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(makeRun({ status: "running" }));
    d.reviews.cancelAgentRun.mockResolvedValue(
      makeRun({ status: "cancelled", errorCode: "cancelled_by_user" })
    );

    await d.service.cancelRun("session-1", "run-1", "Owner (owner)", {
      reason: "  结果已经不需要了  "
    });

    const types = d.events.append.mock.calls.map(
      (call) => (call[0] as { type: string }).type
    );
    expect(types).toEqual(["AGENT_RUN_CANCEL_REQUESTED", "AGENT_RUN_CANCELLED"]);
    const requested = d.events.append.mock.calls[0]?.[0] as {
      payload: Record<string, unknown>;
    };
    expect(requested.payload.requestedBy).toBe("Owner (owner)");
    // The reason is trimmed before it is stored, and attributed to the session
    // identity rather than to anything the client sent.
    expect(requested.payload.reason).toBe("结果已经不需要了");
    expect(requested.payload.previousStatus).toBe("running");
    expect(typeof requested.payload.requestedAt).toBe("string");
  });

  it("cancelRun reports whether this process could actually abort the work", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(makeRun({ status: "running" }));
    d.reviews.cancelAgentRun.mockResolvedValue(
      makeRun({ status: "cancelled", errorCode: "cancelled_by_user" })
    );
    const signal = d.cancellations.begin("run-1");

    const result = await d.service.cancelRun("session-1", "run-1", "Owner");

    expect(result.statusChanged).toBe(true);
    expect(result.execution).toBe("signal_delivered");
    // The signal the executor is holding is the thing that fired — not a new one.
    expect(signal.aborted).toBe(true);
  });

  it("cancelRun admits when the work is not running in this process", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(makeRun({ status: "running" }));
    d.reviews.cancelAgentRun.mockResolvedValue(
      makeRun({ status: "cancelled", errorCode: "cancelled_by_user" })
    );

    const result = await d.service.cancelRun("session-1", "run-1", "Owner");

    // Nothing was aborted here, and the answer says so instead of implying the
    // execution stopped. The database is the part that is guaranteed.
    expect(result.execution).toBe("not_running_here");
    expect(result.statusChanged).toBe(true);
    const verdict = d.events.append.mock.calls[1]?.[0] as {
      payload: Record<string, unknown>;
    };
    expect(verdict.payload.execution).toBe("not_running_here");
  });

  it("cancelRun logs nothing for a repeat request that loses the race", async () => {
    const d = makeDeps();
    // The row was still running when we looked…
    d.reviews.getAgentRunById
      .mockResolvedValueOnce(makeRun({ status: "running" }))
      // …but a concurrent cancel committed first, so our update moved nothing.
      .mockResolvedValueOnce(
        makeRun({ status: "cancelled", errorCode: "cancelled_by_user" })
      );
    d.reviews.cancelAgentRun.mockResolvedValue(null);

    const result = await d.service.cancelRun("session-1", "run-1", "Owner");

    expect(result.alreadyCancelled).toBe(true);
    expect(result.statusChanged).toBe(false);
    // Exactly one request, exactly one verdict — from whichever call won.
    expect(d.events.append).not.toHaveBeenCalled();
  });

  it("retryRun re-runs cross-review and records the parent", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(
      makeRun({ status: "failed", purpose: "cross_review", targetClaimId: "claim-1", attempt: 1 })
    );
    d.reviews.setRunRetryMeta.mockResolvedValue(undefined);
    d.crossReview.runForClaim.mockResolvedValue({
      status: "completed",
      runs: [{ run: { id: "run-2" }, status: "completed", challenges: [], failure: null }],
      challenges: [],
      responseClaims: [],
      conflicts: [],
      failures: []
    });
    const result = await d.service.retryRun("session-1", "run-1", "Owner");
    expect(result.status).toBe("completed");
    expect(d.crossReview.runForClaim).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-1",
      actor: "Owner"
    });
    expect(d.reviews.setRunRetryMeta).toHaveBeenCalledWith("run-2", {
      attempt: 2,
      parentRunId: "run-1"
    });
  });

  it("retryRun refuses a non-retryable status", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(makeRun({ status: "completed" }));
    await expect(d.service.retryRun("session-1", "run-1", "Owner")).rejects.toBeInstanceOf(
      AgentRunNotRetryableError
    );
  });

  it("retryRun refuses an unsupported purpose", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(
      makeRun({ status: "failed", purpose: "analysis" })
    );
    await expect(d.service.retryRun("session-1", "run-1", "Owner")).rejects.toBeInstanceOf(
      AgentRunRetryUnsupportedError
    );
  });

  it("retryRun enforces the attempt ceiling", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(
      makeRun({
        status: "failed",
        purpose: "cross_review",
        targetClaimId: "claim-1",
        attempt: MAX_AGENT_RUN_RETRIES
      })
    );
    await expect(d.service.retryRun("session-1", "run-1", "Owner")).rejects.toBeInstanceOf(
      AgentRunRetryLimitError
    );
  });

  it("retryRun is unavailable without a cross-review service", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(
      makeRun({ status: "failed", purpose: "cross_review", targetClaimId: "claim-1" })
    );
    const service = new AgentRunService({
      reviews: d.reviews,
      arena: d.arena,
      events: d.events
    });
    await expect(service.retryRun("session-1", "run-1", "Owner")).rejects.toBeInstanceOf(
      AgentRunRetryUnsupportedError
    );
  });
});
