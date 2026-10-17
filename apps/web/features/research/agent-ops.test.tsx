import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Agent Operations Center, checked against the real component with only
 * the API faked. The honesty contract pinned down here:
 *  - the list is read from the server (no invented runs);
 *  - a failed run shows its diagnosis and is retryable, but not cancellable;
 *  - a queued run can be cancelled;
 *  - a viewer cannot cancel or retry (the buttons are disabled, not hidden).
 */

const listAgentRuns = vi.fn();
const getAgentRun = vi.fn();
const cancelAgentRun = vi.fn();
const retryAgentRun = vi.fn();
const getCurrentUser = vi.fn();

vi.mock("./api", () => {
  /**
   * The component branches on this class to tell "the chain already moved on"
   * from a transport failure, so the mock has to ship the real shape — a bare
   * `Error` here would make the refusal path unreachable in tests.
   */
  class AgentRunRetryRefusedError extends Error {
    constructor(
      message: string,
      readonly code: string | undefined,
      readonly childRunId: string | null
    ) {
      super(message);
      this.name = "AgentRunRetryRefusedError";
    }
  }
  return {
    AgentRunRetryRefusedError,
    listAgentRuns: (...args: unknown[]) => listAgentRuns(...args),
    getAgentRun: (...args: unknown[]) => getAgentRun(...args),
    cancelAgentRun: (...args: unknown[]) => cancelAgentRun(...args),
    retryAgentRun: (...args: unknown[]) => retryAgentRun(...args)
  };
});

vi.mock("../arena/api-client", () => ({
  getCurrentUser: (...args: unknown[]) => getCurrentUser(...args)
}));

const { AgentOpsPanel } = await import("./agent-ops");
const retryApi = await import("./api");

const SESSION_ID = "0199e6d0-0000-7000-8000-000000000001";
const RUN_FAILED = "0199e6d0-0000-7000-8000-0000000000f1";
const RUN_QUEUED = "0199e6d0-0000-7000-8000-0000000000f2";
const RUN_RETRY = "0199e6d0-0000-7000-8000-0000000000f3";
const RUN_ANALYSIS = "0199e6d0-0000-7000-8000-0000000000f4";

function runView(over: Record<string, unknown>) {
  return {
    id: RUN_FAILED,
    sessionId: SESSION_ID,
    roleId: "role-1",
    promptVersionId: "pv-1",
    status: "failed",
    purpose: "cross_review",
    taskType: "cross_review",
    attempt: 1,
    tokenUsage: null,
    roleName: "审查员",
    startedAt: "2026-01-01T00:00:00.000Z",
    ...over
  };
}

const FAILED_RUN = runView({ id: RUN_FAILED, status: "failed", errorCode: "internal_error", error: "模型返回了无法解析的结果。" });
const QUEUED_RUN = runView({ id: RUN_QUEUED, status: "queued" });
const CANCELLED_RUN = runView({
  id: RUN_QUEUED,
  status: "cancelled",
  errorCode: "cancelled_by_user"
});

function detailOf(run: Record<string, unknown>, events: Array<Record<string, unknown>>) {
  return {
    ...run,
    events,
    outcome: { challengeIds: [], conflictIds: [], responseClaimIds: [] }
  };
}

function eventOf(type: string, sequence: number) {
  return {
    sequence,
    type,
    occurredAt: "2026-01-01T00:00:0" + sequence + ".000Z",
    payload: {}
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentOpsPanel", () => {
  it("lists real runs read from the server", async () => {
    listAgentRuns.mockResolvedValue({ runs: [FAILED_RUN, QUEUED_RUN] });
    render(<AgentOpsPanel sessionId={SESSION_ID} canEdit={true} />);
    expect(await screen.findByTestId("agent-run-list")).toBeTruthy();
    // Both seeded runs render their role name and token status (token usage is
    // absent → "未提供"), so these appear once per row, not just once.
    expect(screen.getAllByText("审查员").length).toBeGreaterThan(0);
    expect(screen.getAllByText("未提供").length).toBeGreaterThan(0);
  });

  it("shows failure diagnosis and a retryable (not cancellable) failed run", async () => {
    listAgentRuns.mockResolvedValue({ runs: [FAILED_RUN] });
    getAgentRun.mockResolvedValue({
      ...FAILED_RUN,
      events: [
        { sequence: 1, type: "AGENT_RUN_STARTED", occurredAt: "2026-01-01T00:00:00.000Z", payload: {} },
        { sequence: 2, type: "AGENT_RUN_FAILED", occurredAt: "2026-01-01T00:00:01.000Z", payload: {} }
      ],
      outcome: { challengeIds: [], conflictIds: [], responseClaimIds: [] }
    });
    render(<AgentOpsPanel sessionId={SESSION_ID} canEdit={true} />);
    const row = await screen.findByTestId("agent-run-row");
    fireEvent.click(row.querySelector("button")!);
    expect(await screen.findByText("失败诊断")).toBeTruthy();
    expect(screen.getByText("内部错误")).toBeTruthy();
    expect(screen.getByText("模型返回了无法解析的结果。")).toBeTruthy();
    expect(screen.getByTestId("agent-run-events").textContent).toContain("AGENT_RUN_FAILED");
    const retry = screen.getByTestId("agent-run-retry") as HTMLButtonElement;
    const cancel = screen.getByTestId("agent-run-cancel") as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    expect(cancel.disabled).toBe(true);
    expect(cancel.title).toContain("无法取消");
  });

  it("allows cancelling a queued run, but only after the confirmation", async () => {
    listAgentRuns.mockResolvedValue({ runs: [QUEUED_RUN] });
    getAgentRun.mockResolvedValue({
      ...QUEUED_RUN,
      events: [],
      outcome: { challengeIds: [], conflictIds: [], responseClaimIds: [] }
    });
    cancelAgentRun.mockResolvedValue({ run: { ...QUEUED_RUN, status: "cancelled", errorCode: "cancelled_by_user" }, alreadyCancelled: false });
    render(<AgentOpsPanel sessionId={SESSION_ID} canEdit={true} />);
    const row = await screen.findByTestId("agent-run-row");
    fireEvent.click(row.querySelector("button")!);
    const cancel = (await screen.findByTestId("agent-run-cancel")) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);

    // A cancel is terminal for that run, so the button only opens the question.
    fireEvent.click(cancel);
    const dialog = await screen.findByTestId("agent-run-cancel-dialog");
    expect(cancelAgentRun).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "取消运行" }));
    await waitFor(() =>
      expect(cancelAgentRun).toHaveBeenCalledWith(SESSION_ID, RUN_QUEUED, {
        reason: ""
      })
    );
  });

  it("sends the reason the operator typed, and nothing else", async () => {
    listAgentRuns.mockResolvedValue({ runs: [QUEUED_RUN] });
    getAgentRun.mockResolvedValue(detailOf(QUEUED_RUN, []));
    cancelAgentRun.mockResolvedValue({
      run: CANCELLED_RUN,
      alreadyCancelled: false,
      statusChanged: true,
      execution: "not_running_here",
      previousStatus: "queued",
      reason: "任务已作废"
    });
    render(<AgentOpsPanel sessionId={SESSION_ID} canEdit={true} />);
    const row = await screen.findByTestId("agent-run-row");
    fireEvent.click(row.querySelector("button")!);
    fireEvent.click(await screen.findByTestId("agent-run-cancel"));
    const dialog = await screen.findByTestId("agent-run-cancel-dialog");
    fireEvent.change(screen.getByTestId("agent-run-cancel-reason-input"), {
      target: { value: "任务已作废" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消运行" }));

    await waitFor(() =>
      expect(cancelAgentRun).toHaveBeenCalledWith(SESSION_ID, RUN_QUEUED, {
        reason: "任务已作废"
      })
    );
  });

  it("says the executor is still winding down, not that it stopped", async () => {
    listAgentRuns
      .mockResolvedValueOnce({ runs: [QUEUED_RUN] })
      .mockResolvedValue({ runs: [CANCELLED_RUN] });
    getAgentRun
      .mockResolvedValueOnce(detailOf(QUEUED_RUN, []))
      .mockResolvedValue(
        detailOf(CANCELLED_RUN, [
          eventOf("AGENT_RUN_STARTED", 1),
          eventOf("AGENT_RUN_CANCEL_REQUESTED", 2),
          eventOf("AGENT_RUN_CANCELLED", 3)
        ])
      );
    cancelAgentRun.mockResolvedValue({
      run: CANCELLED_RUN,
      alreadyCancelled: false,
      statusChanged: true,
      execution: "signal_delivered",
      previousStatus: "running",
      reason: null
    });
    render(<AgentOpsPanel sessionId={SESSION_ID} canEdit={true} />);
    const row = await screen.findByTestId("agent-run-row");
    fireEvent.click(row.querySelector("button")!);
    fireEvent.click(await screen.findByTestId("agent-run-cancel"));
    const dialog = await screen.findByTestId("agent-run-cancel-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消运行" }));

    const state = await screen.findByTestId("agent-run-cancel-state");
    // The row says cancelled, but the executor has not confirmed it stopped —
    // and the panel refuses to pretend otherwise.
    expect(state.dataset.cancelPhase).toBe("stopping");
    expect(state.textContent).toContain("取消处理中");
    expect(state.textContent).not.toContain("已确认停止");
  });

  it("upgrades to a confirmed stop only when the executor reports it", async () => {
    listAgentRuns.mockResolvedValue({ runs: [CANCELLED_RUN] });
    getAgentRun.mockResolvedValue(
      detailOf(CANCELLED_RUN, [
        eventOf("AGENT_RUN_STARTED", 1),
        eventOf("AGENT_RUN_CANCEL_REQUESTED", 2),
        eventOf("AGENT_RUN_CANCELLED", 3),
        eventOf("AGENT_RUN_EXECUTION_STOPPED", 4)
      ])
    );
    render(<AgentOpsPanel sessionId={SESSION_ID} canEdit={true} />);
    const row = await screen.findByTestId("agent-run-row");
    fireEvent.click(row.querySelector("button")!);

    const state = await screen.findByTestId("agent-run-cancel-state");
    expect(state.dataset.cancelPhase).toBe("stopped");
    expect(state.textContent).toContain("执行器已确认停止");
  });

  it("reports a cancel that never reached the server, and shows no verdict", async () => {
    listAgentRuns.mockResolvedValue({ runs: [QUEUED_RUN] });
    getAgentRun.mockResolvedValue(detailOf(QUEUED_RUN, []));
    cancelAgentRun.mockRejectedValue(
      new Error("该运行已处于终态（completed），无法取消。")
    );
    render(<AgentOpsPanel sessionId={SESSION_ID} canEdit={true} />);
    const row = await screen.findByTestId("agent-run-row");
    fireEvent.click(row.querySelector("button")!);
    fireEvent.click(await screen.findByTestId("agent-run-cancel"));
    const dialog = await screen.findByTestId("agent-run-cancel-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消运行" }));

    expect(await screen.findByText(/取消失败/)).toBeTruthy();
    // No acknowledgement means no cancellation claim at all.
    expect(screen.queryByTestId("agent-run-cancel-state")).toBeNull();
    expect(screen.getByTestId("agent-run-cancel").textContent).toBe("取消运行");
  });

  it("leaves the run running when the cancellation is dismissed", async () => {
    listAgentRuns.mockResolvedValue({ runs: [QUEUED_RUN] });
    getAgentRun.mockResolvedValue({
      ...QUEUED_RUN,
      events: [],
      outcome: { challengeIds: [], conflictIds: [], responseClaimIds: [] }
    });
    render(<AgentOpsPanel sessionId={SESSION_ID} canEdit={true} />);
    const row = await screen.findByTestId("agent-run-row");
    fireEvent.click(row.querySelector("button")!);
    fireEvent.click(await screen.findByTestId("agent-run-cancel"));
    const dialog = await screen.findByTestId("agent-run-cancel-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByTestId("agent-run-cancel-dialog")).toBeNull());
    expect(cancelAgentRun).not.toHaveBeenCalled();
  });

  it("hides cancel/retry actions from a viewer", async () => {
    listAgentRuns.mockResolvedValue({ runs: [QUEUED_RUN] });
    getAgentRun.mockResolvedValue({
      ...QUEUED_RUN,
      events: [],
      outcome: { challengeIds: [], conflictIds: [], responseClaimIds: [] }
    });
    render(<AgentOpsPanel sessionId={SESSION_ID} canEdit={false} />);
    const row = await screen.findByTestId("agent-run-row");
    fireEvent.click(row.querySelector("button")!);
    const cancel = (await screen.findByTestId("agent-run-cancel")) as HTMLButtonElement;
    const retry = (await screen.findByTestId("agent-run-retry")) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    expect(cancel.title).toContain("观众");
    expect(retry.disabled).toBe(true);
  });

  it("says a task type has no retry path, instead of offering a dead button", async () => {
    const analysis = runView({
      id: RUN_ANALYSIS,
      status: "failed",
      purpose: "analysis",
      input: { kind: "analysis" }
    });
    listAgentRuns.mockResolvedValue({ runs: [analysis] });
    getAgentRun.mockResolvedValue(detailOf(analysis, []));
    render(<AgentOpsPanel sessionId={SESSION_ID} canEdit={true} />);
    const row = await screen.findByTestId("agent-run-row");
    fireEvent.click(row.querySelector("button")!);

    const retry = (await screen.findByTestId("agent-run-retry")) as HTMLButtonElement;
    // The status is retryable; the task type is not. Pressing this would earn a
    // 501, so the panel refuses to offer it — and says why.
    expect(retry.disabled).toBe(true);
    expect(screen.getByTestId("agent-run-retry-reason").textContent).toContain(
      "暂不支持重试"
    );
  });

  it("names the attempt and the new runs the server created", async () => {
    listAgentRuns
      .mockResolvedValueOnce({ runs: [FAILED_RUN] })
      .mockResolvedValue({
        runs: [
          runView({ id: RUN_RETRY, attempt: 2, parentRunId: RUN_FAILED, status: "failed" }),
          FAILED_RUN
        ]
      });
    getAgentRun.mockResolvedValue(detailOf(FAILED_RUN, []));
    retryAgentRun.mockResolvedValue({
      sessionId: SESSION_ID,
      claimId: "0199e6d0-0000-7000-8000-0000000000c1",
      status: "failed",
      runs: [
        {
          run: runView({ id: RUN_RETRY, attempt: 2, parentRunId: RUN_FAILED }),
          challenges: [],
          status: "failed",
          failure: "provider down"
        }
      ],
      challenges: [],
      responseClaims: [],
      conflicts: [],
      failures: [{ runId: RUN_RETRY, roleId: "role-1", reason: "provider down" }],
      retry: { originalRunId: RUN_FAILED, attempt: 2, runIds: [RUN_RETRY] }
    });

    render(<AgentOpsPanel sessionId={SESSION_ID} canEdit={true} />);
    const row = await screen.findByTestId("agent-run-row");
    fireEvent.click(row.querySelector("button")!);
    fireEvent.click(await screen.findByTestId("agent-run-retry"));

    const state = await screen.findByTestId("agent-run-retry-state");
    expect(state.dataset.retryAttempt).toBe("2");
    // The id is real and comes from the response; the panel does not invent one.
    expect(state.textContent).toContain(RUN_RETRY.slice(0, 8));
    // Creating a run is not the same as finishing one.
    expect(state.textContent).toContain("执行结果以各运行的当前状态为准");
  });

  it("links to the retry that already exists when the chain moved on", async () => {
    listAgentRuns.mockResolvedValue({ runs: [FAILED_RUN] });
    getAgentRun.mockResolvedValue(detailOf(FAILED_RUN, []));
    retryAgentRun.mockRejectedValue(
      new retryApi.AgentRunRetryRefusedError(
        "该运行所属的尝试（第 2 次）已经产生过重试。",
        "already_retried",
        RUN_RETRY
      )
    );

    render(<AgentOpsPanel sessionId={SESSION_ID} canEdit={true} />);
    const row = await screen.findByTestId("agent-run-row");
    fireEvent.click(row.querySelector("button")!);
    fireEvent.click(await screen.findByTestId("agent-run-retry"));

    const refusal = await screen.findByTestId("agent-run-retry-refusal");
    expect(refusal.dataset.retryCode).toBe("already_retried");
    expect(refusal.textContent).toContain("已经产生过重试");
    // Actionable: the run that exists can be opened from the refusal.
    expect(within(refusal).getByRole("button", { name: "查看已有的重试" })).toBeTruthy();
    // Nothing claims a retry succeeded.
    expect(screen.queryByTestId("agent-run-retry-state")).toBeNull();
  });

  it("shows the chain from the server's rows, including the parent", async () => {
    const child = runView({
      id: RUN_RETRY,
      attempt: 2,
      parentRunId: RUN_FAILED,
      status: "failed"
    });
    listAgentRuns.mockResolvedValue({ runs: [child, FAILED_RUN] });
    getAgentRun.mockResolvedValue(detailOf(child, []));

    render(<AgentOpsPanel sessionId={SESSION_ID} canEdit={true} />);
    // The newest run is first in the list.
    fireEvent.click((await screen.findAllByTestId("agent-run-row"))[0]!.querySelector("button")!);

    const summary = await screen.findByTestId("agent-run-chain-summary");
    expect(summary.textContent).toContain("第 2 次尝试");
    expect(screen.getByTestId("agent-run-attempt").textContent).toContain("第 2 次");
    expect(screen.getByTestId("agent-run-open-parent")).toBeTruthy();

    // From the root, the retry it produced is listed — read from the same rows,
    // so a page refresh cannot change the answer.
    getAgentRun.mockResolvedValue(detailOf(FAILED_RUN, []));
    fireEvent.click(screen.getByTestId("agent-run-open-parent"));
    const children = await screen.findByTestId("agent-run-retry-children");
    expect(children.textContent).toContain(RUN_RETRY.slice(0, 8));
    expect(screen.getByTestId("agent-run-chain-summary").textContent).toContain(
      "已产生 1 个重试运行"
    );
  });

  it("never reports a retry as successful when the request failed", async () => {
    listAgentRuns.mockResolvedValue({ runs: [FAILED_RUN] });
    getAgentRun.mockResolvedValue(detailOf(FAILED_RUN, []));
    retryAgentRun.mockRejectedValue(new Error("无法连接到核心 API。"));

    render(<AgentOpsPanel sessionId={SESSION_ID} canEdit={true} />);
    const row = await screen.findByTestId("agent-run-row");
    fireEvent.click(row.querySelector("button")!);
    fireEvent.click(await screen.findByTestId("agent-run-retry"));

    expect(await screen.findByText("无法连接到核心 API。")).toBeTruthy();
    expect(screen.queryByTestId("agent-run-retry-state")).toBeNull();
    expect(screen.queryByTestId("agent-run-retry-refusal")).toBeNull();
  });
});
