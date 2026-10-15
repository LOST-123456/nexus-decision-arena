import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The honesty contract of the research home page.
 *
 * Only data access is faked; everything else is the real component. What these
 * pin down: a failure to read the list is never rendered as "you have no
 * research" (the bug this file exists for), a genuine empty list still says so,
 * and a destructive delete cannot fire without a second, explicit click — nor
 * fail silently.
 */

const listSessions = vi.fn();
const deleteSession = vi.fn();
const createSession = vi.fn();

vi.mock("../arena/api-client", () => ({
  listSessions: (...args: unknown[]) => listSessions(...args),
  deleteSession: (...args: unknown[]) => deleteSession(...args),
  createSession: (...args: unknown[]) => createSession(...args)
}));

const { ResearchHome } = await import("./research-home");

const SESSION = {
  id: "s-1",
  projectId: "p-1",
  projectName: "危化品安全平台",
  phase: "CREATED",
  operationalStatus: "ACTIVE",
  currentConclusion: null,
  conflictCount: 0,
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z"
};

beforeEach(() => {
  listSessions.mockReset();
  deleteSession.mockReset();
  createSession.mockReset();
  listSessions.mockResolvedValue([SESSION]);
  deleteSession.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("ResearchHome · 最近研究列表", () => {
  it("首次渲染先显示加载态，而不是断言列表为空", () => {
    listSessions.mockReturnValue(new Promise(() => {}));
    render(<ResearchHome />);

    expect(screen.getByTestId("research-list-loading")).toBeTruthy();
    expect(screen.queryByTestId("research-list-empty")).toBeNull();
  });

  it("读取失败时说明失败原因，绝不显示成空列表", async () => {
    listSessions.mockRejectedValue(new Error("无法连接到核心 API。"));
    render(<ResearchHome />);

    const failure = await screen.findByTestId("research-list-error");
    expect(failure.textContent).toContain("无法连接到核心 API。");
    expect(screen.queryByTestId("research-list-empty")).toBeNull();
    expect(screen.queryByText("还没有研究任务。")).toBeNull();
  });

  it("读取失败时提供可用的重新加载入口", async () => {
    listSessions.mockRejectedValueOnce(new Error("请求超时。"));
    render(<ResearchHome />);

    await screen.findByTestId("research-list-error");
    listSessions.mockResolvedValueOnce([SESSION]);
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));

    const count = await screen.findByTestId("research-list-count");
    expect(count.textContent).toContain("1 项");
    expect(screen.queryByTestId("research-list-error")).toBeNull();
  });

  it("确实为空时才显示空态", async () => {
    listSessions.mockResolvedValue([]);
    render(<ResearchHome />);

    expect(await screen.findByTestId("research-list-empty")).toBeTruthy();
    expect(screen.queryByTestId("research-list-error")).toBeNull();
  });
});

describe("ResearchHome · 删除研究", () => {
  it("删除必须二次确认，确认前绝不调用删除接口", async () => {
    render(<ResearchHome />);

    fireEvent.click(await screen.findByTestId("research-delete"));

    expect(screen.getByTestId("research-delete-confirm")).toBeTruthy();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("确认后才调用删除接口，并刷新列表", async () => {
    render(<ResearchHome />);

    fireEvent.click(await screen.findByTestId("research-delete"));
    fireEvent.click(screen.getByTestId("research-delete-confirm"));

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith("s-1"));
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
  });

  it("删除失败必须可见，不能静默吞掉", async () => {
    deleteSession.mockRejectedValue(
      new Error("没有权限执行该操作（403）。")
    );
    render(<ResearchHome />);

    fireEvent.click(await screen.findByTestId("research-delete"));
    fireEvent.click(screen.getByTestId("research-delete-confirm"));

    const failure = await screen.findByTestId("research-list-action-error");
    expect(failure.textContent).toContain("没有权限");
  });

  it("可以取消，取消后不触发删除", async () => {
    render(<ResearchHome />);

    fireEvent.click(await screen.findByTestId("research-delete"));
    fireEvent.click(screen.getByTestId("research-delete-cancel"));

    expect(screen.getByTestId("research-delete")).toBeTruthy();
    expect(deleteSession).not.toHaveBeenCalled();
  });
});
