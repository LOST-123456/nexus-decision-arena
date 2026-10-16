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

/**
 * 创建门槛。
 *
 * 模板要求五个字段全部非空，表单就照抄了五个 `required` —— 结果是用户在
 * 还没看到任何材料之前，先被要求编出「业务模式」「已有资料」。现在只有名称必填，
 * 其余留空时以一个**写明未填写**的值提交（而不是空串，也不是替用户编一个值）。
 */
describe("ResearchHome · 新建研究的门槛", () => {
  beforeEach(() => {
    createSession.mockResolvedValue({ id: "s-2" });
  });

  it("只有研究名称是必填字段", () => {
    render(<ResearchHome />);

    const required = (label: RegExp) =>
      (screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement)
        .required;

    expect(required(/研究名称/)).toBe(true);
    expect(required(/研究问题/)).toBe(false);
    expect(required(/背景摘要/)).toBe(false);
    expect(required(/涉及对象/)).toBe(false);
    expect(required(/业务模式/)).toBe(false);
    expect(required(/已有资料/)).toBe(false);
  });

  it("只填名称即可创建，留空字段以「未填写」提交而不是空串", async () => {
    render(<ResearchHome />);

    fireEvent.change(screen.getByLabelText(/研究名称/), {
      target: { value: "  危化品安全平台  " }
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并进入工作台" }));

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    const command = createSession.mock.calls[0]?.[0];

    expect(command.project.name).toBe("危化品安全平台");
    expect(command.project.summary).toBe("（未填写）");
    expect(command.project.targetUsers).toBe("（未填写）");
    expect(command.project.businessModel).toBe("（未填写）");
    expect(command.project.expectedData).toBe("（未填写）");
    // 研究问题本就是可选：留空时不带这个键，而不是发一个空串。
    expect("researchQuestion" in command).toBe(false);
  });

  it("填了的字段照原样提交，不被占位符覆盖", async () => {
    render(<ResearchHome />);

    fireEvent.change(screen.getByLabelText(/研究名称/), {
      target: { value: "危化品安全平台" }
    });
    fireEvent.change(screen.getByLabelText(/背景摘要/), {
      target: { value: "为采购决策提供依据" }
    });
    fireEvent.change(screen.getByLabelText(/已有资料/), {
      target: { value: "两年度出货报表" }
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并进入工作台" }));

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    const command = createSession.mock.calls[0]?.[0];

    expect(command.project.summary).toBe("为采购决策提供依据");
    expect(command.project.expectedData).toBe("两年度出货报表");
    expect(command.project.targetUsers).toBe("（未填写）");
  });

  it("名称只填空白时不发请求，并说明原因", async () => {
    render(<ResearchHome />);

    fireEvent.change(screen.getByLabelText(/研究名称/), {
      target: { value: "   " }
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并进入工作台" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("研究名称")
    );
    expect(createSession).not.toHaveBeenCalled();
  });
});
