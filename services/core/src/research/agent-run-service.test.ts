import { describe, expect, it, vi } from "vitest";
import {
  AgentRunAlreadyRetriedError,
  AgentRunNotFoundError,
  AgentRunNotRetryableError,
  AgentRunRetryLimitError,
  AgentRunRetryUnsupportedError,
  AgentRunService,
  AgentRunTerminalError,
  MAX_AGENT_RUN_RETRIES,
  RETRY_STALE_RUN_MS
} from "./agent-run-service";
import type { AgentRunView } from "@nexus/shared";
import { CrossReviewRetryRefusedError } from "./cross-review-service";
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
    abandonStaleRun: vi.fn()
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

  it("retryRun hands the lineage to the executor instead of writing it afterwards", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(
      makeRun({ status: "failed", purpose: "cross_review", targetClaimId: "claim-1", attempt: 1 })
    );
    d.crossReview.runForClaim.mockResolvedValue({
      status: "completed",
      runs: [
        {
          run: { id: "run-2", attempt: 2, parentRunId: "run-1" },
          status: "completed",
          challenges: [],
          failure: null
        }
      ],
      challenges: [],
      responseClaims: [],
      conflicts: [],
      failures: []
    });

    const result = await d.service.retryRun("session-1", "run-1", "Owner");

    // The attempt and the parent are decided *before* execution: the executor
    // receives them, so the rows it opens already carry their lineage.
    expect(d.crossReview.runForClaim).toHaveBeenCalledWith({
      sessionId: "session-1",
      claimId: "claim-1",
      actor: "Owner",
      retryOf: { runId: "run-1", ceiling: MAX_AGENT_RUN_RETRIES }
    });
    // Nothing is patched onto the rows after the fact.
    expect(d.reviews).not.toHaveProperty("setRunRetryMeta");
    expect(result.status).toBe("completed");
    expect(result.retry).toEqual({
      originalRunId: "run-1",
      attempt: 2,
      runIds: ["run-2"]
    });
  });

  it("retryRun records the request before the run exists, so a refusal still leaves a trail", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(
      makeRun({ status: "failed", purpose: "cross_review", targetClaimId: "claim-1" })
    );
    d.crossReview.runForClaim.mockRejectedValue(
      new CrossReviewRetryRefusedError("limit_reached", { attempt: 4, ceiling: 3 })
    );

    await expect(
      d.service.retryRun("session-1", "run-1", "Owner")
    ).rejects.toBeInstanceOf(AgentRunRetryLimitError);

    const types = d.events.append.mock.calls.map(
      (call) => (call[0] as { type: string }).type
    );
    expect(types).toEqual(["AGENT_RUN_RETRY_REQUESTED"]);
    const requested = d.events.append.mock.calls[0]?.[0] as {
      correlationId: string;
      payload: Record<string, unknown>;
    };
    expect(requested.correlationId).toBe("run-1");
    expect(requested.payload.requestedBy).toBe("Owner");
    // The request says nothing about an attempt that was never opened.
    expect(requested.payload).not.toHaveProperty("attempt");
  });

  it("retryRun refuses a run the chain has already moved past, and names the child", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(
      makeRun({ status: "failed", purpose: "cross_review", targetClaimId: "claim-1", attempt: 1 })
    );
    d.crossReview.runForClaim.mockRejectedValue(
      new CrossReviewRetryRefusedError("already_retried", {
        deepestAttempt: 2,
        childRunId: "run-9"
      })
    );

    const error = await d.service
      .retryRun("session-1", "run-1", "Owner")
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AgentRunAlreadyRetriedError);
    expect((error as AgentRunAlreadyRetriedError).childRunId).toBe("run-9");
    expect((error as AgentRunAlreadyRetriedError).deepestAttempt).toBe(2);
  });

  it("retryRun refuses a non-retryable status", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(makeRun({ status: "completed" }));
    await expect(d.service.retryRun("session-1", "run-1", "Owner")).rejects.toBeInstanceOf(
      AgentRunNotRetryableError
    );
    expect(d.crossReview.runForClaim).not.toHaveBeenCalled();
  });

  it("retryRun refuses an unsupported purpose even when the status is retryable", async () => {
    const d = makeDeps();
    // A failed *analysis* run: retryable by status, but there is no executor to
    // invoke again, so the answer must be "unsupported" rather than a promise.
    d.reviews.getAgentRunById.mockResolvedValue(
      makeRun({ status: "failed", purpose: "analysis" })
    );
    await expect(d.service.retryRun("session-1", "run-1", "Owner")).rejects.toBeInstanceOf(
      AgentRunRetryUnsupportedError
    );
    expect(d.crossReview.runForClaim).not.toHaveBeenCalled();
  });

  it("retryRun refuses a run that is still running and only just started", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(
      makeRun({
        status: "running",
        purpose: "cross_review",
        targetClaimId: "claim-1",
        startedAt: new Date().toISOString()
      })
    );

    await expect(d.service.retryRun("session-1", "run-1", "Owner")).rejects.toBeInstanceOf(
      AgentRunNotRetryableError
    );
    // A live run is never abandoned: that would refuse the writes it is making.
    expect(d.reviews.abandonStaleRun).not.toHaveBeenCalled();
    expect(d.crossReview.runForClaim).not.toHaveBeenCalled();
  });

  it("retryRun abandons a run that was opened but never settled, then retries", async () => {
    const d = makeDeps();
    const staleStart = new Date(Date.now() - RETRY_STALE_RUN_MS - 60_000).toISOString();
    d.reviews.getAgentRunById.mockResolvedValue(
      makeRun({
        status: "running",
        purpose: "cross_review",
        targetClaimId: "claim-1",
        startedAt: staleStart
      })
    );
    d.reviews.abandonStaleRun.mockResolvedValue(true);
    d.crossReview.runForClaim.mockResolvedValue({
      status: "failed",
      runs: [
        {
          run: { id: "run-2", attempt: 2, parentRunId: "run-1" },
          status: "failed",
          challenges: [],
          failure: "provider down"
        }
      ],
      challenges: [],
      responseClaims: [],
      conflicts: [],
      failures: [{ runId: "run-2", roleId: "role-1", reason: "provider down" }]
    });

    const result = await d.service.retryRun("session-1", "run-1", "Owner");

    expect(d.reviews.abandonStaleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        runId: "run-1",
        errorCode: "internal_error"
      })
    );
    const types = d.events.append.mock.calls.map(
      (call) => (call[0] as { type: string }).type
    );
    // The abandoned run gets a terminal event of its own before the retry is
    // recorded: "we gave up on it" is a different fact from "we retried".
    expect(types).toEqual(["AGENT_RUN_FAILED", "AGENT_RUN_RETRY_REQUESTED"]);
    expect(result.retry.attempt).toBe(2);
  });

  it("retryRun does not abandon a stale run that settled while we looked", async () => {
    const d = makeDeps();
    d.reviews.getAgentRunById.mockResolvedValue(
      makeRun({
        status: "running",
        purpose: "cross_review",
        targetClaimId: "claim-1",
        startedAt: new Date(Date.now() - RETRY_STALE_RUN_MS - 60_000).toISOString()
      })
    );
    // The conditional update matched nothing: the executor finished first.
    d.reviews.abandonStaleRun.mockResolvedValue(false);

    await expect(d.service.retryRun("session-1", "run-1", "Owner")).rejects.toBeInstanceOf(
      AgentRunNotRetryableError
    );
    expect(d.crossReview.runForClaim).not.toHaveBeenCalled();
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
