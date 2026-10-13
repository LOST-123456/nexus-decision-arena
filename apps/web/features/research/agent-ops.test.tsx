import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("./api", () => ({
  listAgentRuns: (...args: unknown[]) => listAgentRuns(...args),
  getAgentRun: (...args: unknown[]) => getAgentRun(...args),
  cancelAgentRun: (...args: unknown[]) => cancelAgentRun(...args),
  retryAgentRun: (...args: unknown[]) => retryAgentRun(...args)
}));

vi.mock("../arena/api-client", () => ({
  getCurrentUser: (...args: unknown[]) => getCurrentUser(...args)
}));

const { AgentOpsPanel } = await import("./agent-ops");

const SESSION_ID = "0199e6d0-0000-7000-8000-000000000001";
const RUN_FAILED = "0199e6d0-0000-7000-8000-0000000000f1";
const RUN_QUEUED = "0199e6d0-0000-7000-8000-0000000000f2";

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

  it("allows cancelling a queued run", async () => {
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
    fireEvent.click(cancel);
    await waitFor(() => expect(cancelAgentRun).toHaveBeenCalledWith(SESSION_ID, RUN_QUEUED));
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
});
