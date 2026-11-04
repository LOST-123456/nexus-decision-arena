import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RevalidationTask, SourceCheckOutcome } from "@nexus/shared";

/**
 * 来源监控面板的规矩，逐条钉在渲染上。
 *
 * 这里最容易写错、又最不容易被发现的三件事：
 *  1. 一次检查不能顺带改核实状态——面板只能说"字变了"，不能说"结论要变"；
 *  2. 检查失败（打不开 / 没检成）必须与"内容变了"分开写；
 *  3. 关闭任务必须有理由，理由是这条待办存在的意义。
 */

const listRevalidationTasks = vi.fn();
const checkSourceDrift = vi.fn();
const getSourceDiff = vi.fn();
const resolveRevalidationTask = vi.fn();

vi.mock("./api", () => ({
  listRevalidationTasks: (...args: unknown[]) => listRevalidationTasks(...args),
  checkSourceDrift: (...args: unknown[]) => checkSourceDrift(...args),
  getSourceDiff: (...args: unknown[]) => getSourceDiff(...args),
  resolveRevalidationTask: (...args: unknown[]) =>
    resolveRevalidationTask(...args)
}));

const { SourceMonitoringPanel } = await import("./source-monitoring");

const SOURCE = { id: "src-1", title: "Example Domain", kind: "url" };

const TASK: RevalidationTask = {
  id: "task-1",
  sessionId: "session-1",
  sourceId: "src-1",
  sourceTitle: "Example Domain",
  triggerContentHash: "hash-new",
  previousSnapshotId: "snap-1",
  currentSnapshotId: "snap-2",
  affectedEvidenceIds: ["ev-1"],
  affectedClaimIds: ["claim-1"],
  reason: "页面内容与已存版本不同",
  status: "open",
  createdAt: "2026-11-03T10:00:00.000Z",
  updatedAt: "2026-11-03T10:00:00.000Z",
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null
};

function changedOutcome(): SourceCheckOutcome {
  return {
    sourceId: "src-1",
    sessionId: "session-1",
    status: "changed",
    reasonCode: "content_changed",
    message: "页面的正文与已存版本不同，已存为新版本",
    checkedAt: "2026-11-03T11:00:00.000Z",
    checkedBy: "Owner (owner)",
    previousSnapshotId: "snap-1",
    currentSnapshotId: "snap-2",
    previousContentHash: "hash-old",
    currentContentHash: "hash-new",
    httpStatus: 200,
    newVersionStored: true,
    evidenceImpacts: [],
    claimImpacts: [],
    revalidationTask: TASK,
    remainingChecks: 4
  };
}

beforeEach(() => {
  listRevalidationTasks.mockReset();
  checkSourceDrift.mockReset();
  getSourceDiff.mockReset();
  resolveRevalidationTask.mockReset();
  listRevalidationTasks.mockResolvedValue({ tasks: [] });
});

afterEach(() => {
  cleanup();
});

describe("SourceMonitoringPanel", () => {
  it("没有待处理任务时说明任务从哪来，而不是留一片空白", async () => {
    render(
      <SourceMonitoringPanel sessionId="session-1" sources={[SOURCE]} canEdit />
    );

    expect(
      (await screen.findByTestId("monitoring-no-open-tasks")).textContent ?? ""
    ).toContain("内容与已存版本不同时，这里才会出现一条");
  });

  it("检查结果说清楚只是内容变化，且不改结论", async () => {
    checkSourceDrift.mockResolvedValue(changedOutcome());

    render(
      <SourceMonitoringPanel sessionId="session-1" sources={[SOURCE]} canEdit />
    );

    await screen.findByTestId("monitoring-no-open-tasks");
    fireEvent.click(screen.getByTestId("check-src-1"));

    expect(await screen.findByText("内容有变化")).toBeTruthy();
    expect(
      screen.getByText(/报告不会自动改口，需要你判断是否重新核实/)
    ).toBeTruthy();
    // 新任务立刻出现在队列里，不需要用户再点刷新。
    expect(await screen.findByTestId("revalidation-tasks")).toBeTruthy();
  });

  it("检查失败只记失败，不冒充内容变化", async () => {
    checkSourceDrift.mockResolvedValue({
      ...changedOutcome(),
      status: "unavailable",
      reasonCode: "fetch_failed",
      message: "无法读取该地址（连接超时）",
      httpStatus: null,
      newVersionStored: false,
      revalidationTask: null
    });

    render(
      <SourceMonitoringPanel sessionId="session-1" sources={[SOURCE]} canEdit />
    );

    await screen.findByTestId("monitoring-no-open-tasks");
    fireEvent.click(screen.getByTestId("check-src-1"));

    expect(await screen.findByText("页面打不开")).toBeTruthy();
    expect(screen.queryByText("内容有变化")).toBeNull();
    // 没有变化就没有任务。
    expect(screen.getByTestId("monitoring-no-open-tasks")).toBeTruthy();
  });

  it("关闭任务必须先写理由，空理由不发请求", async () => {
    listRevalidationTasks.mockResolvedValue({ tasks: [TASK] });

    render(
      <SourceMonitoringPanel sessionId="session-1" sources={[SOURCE]} canEdit />
    );

    await screen.findByTestId("revalidation-tasks");
    fireEvent.click(screen.getByRole("button", { name: "已重核" }));

    expect(
      await screen.findByText(/关闭这条任务需要写一句理由/)
    ).toBeTruthy();
    expect(resolveRevalidationTask).not.toHaveBeenCalled();
  });

  it("写了理由就能关闭，并说明关闭的不是结论", async () => {
    listRevalidationTasks.mockResolvedValue({ tasks: [TASK] });
    resolveRevalidationTask.mockResolvedValue({
      ...TASK,
      status: "resolved",
      resolutionNote: "重读后确认该段落未变"
    });

    render(
      <SourceMonitoringPanel sessionId="session-1" sources={[SOURCE]} canEdit />
    );

    await screen.findByTestId("revalidation-tasks");
    fireEvent.change(screen.getByLabelText(/处理理由/), {
      target: { value: "重读后确认该段落未变" }
    });
    fireEvent.click(screen.getByRole("button", { name: "已重核" }));

    await waitFor(() =>
      expect(resolveRevalidationTask).toHaveBeenCalledWith(
        "session-1",
        "task-1",
        { status: "resolved", note: "重读后确认该段落未变" }
      )
    );
    expect(
      await screen.findByText(/关闭的是这条待办，不是结论/)
    ).toBeTruthy();
  });

  it("只读账号看得到面板，但检查按钮被禁用并说明原因", async () => {
    render(
      <SourceMonitoringPanel
        sessionId="session-1"
        sources={[SOURCE]}
        canEdit={false}
      />
    );

    await screen.findByTestId("monitoring-no-open-tasks");
    const check = screen.getByTestId("check-src-1") as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    expect(screen.getByText(/检查需要 Reviewer 权限/)).toBeTruthy();
  });
});
