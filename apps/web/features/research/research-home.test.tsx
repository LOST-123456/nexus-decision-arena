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
const routerPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() })
}));

vi.mock("../arena/api-client", () => ({
  listSessions: (...args: unknown[]) => listSessions(...args),
  deleteSession: (...args: unknown[]) => deleteSession(...args),
  createSession: (...args: unknown[]) => createSession(...args)
}));

const { ResearchHome } = await import("./research-home");
const { ApiTransportError } = await import("../../lib/api-transport");

const SESSION = {
  id: "s-1",
  projectId: "p-1",
  projectName: "危化品安全平台",
  phase: "CREATED",
  operationalStatus: "ACTIVE",
  currentConclusion: null,
  conflictCount: 0,
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
  relation: "owner" as
    | "owner"
    | "collaborator"
    | "granted"
    | "unowned"
    | null
};

/**
 * The list endpoint answers with a window, not a bare array. Every mock in this
 * file goes through here so a test cannot accidentally keep asserting the old
 * shape — the shape that let the header print a page size as a total.
 */
const page = (
  sessions: (typeof SESSION)[],
  extra: { nextCursor?: string | null; hasNextPage?: boolean } = {}
) => ({
  sessions,
  nextCursor: extra.nextCursor ?? null,
  hasNextPage: extra.hasNextPage ?? false
});

beforeEach(() => {
  listSessions.mockReset();
  deleteSession.mockReset();
  createSession.mockReset();
  routerPush.mockReset();
  listSessions.mockResolvedValue(page([SESSION]));
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
    listSessions.mockResolvedValueOnce(page([SESSION]));
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));

    const count = await screen.findByTestId("research-list-count");
    expect(count.textContent).toContain("1 项");
    expect(screen.queryByTestId("research-list-error")).toBeNull();
  });

  it("确实为空时才显示空态", async () => {
    listSessions.mockResolvedValue(page([]));
    render(<ResearchHome />);

    expect(await screen.findByTestId("research-list-empty")).toBeTruthy();
    expect(screen.queryByTestId("research-list-error")).toBeNull();
  });
});

/**
 * 分页。
 *
 * 列表以前一次最多返回 50 条，界面上却印着「{n} 项」——把一页当成总数。现在
 * 有下一页时头部写「已加载」，没有下一页时才敢写「共」：翻到最后一页时，
 * 加载到的条数确实就是总数。
 */
describe("ResearchHome · 分页", () => {
  it("有下一页时头部说「已加载」，不把一页说成总数", async () => {
    listSessions.mockResolvedValue(
      page([SESSION, { ...SESSION, id: "s-2", projectName: "另一场研究" }], {
        nextCursor: "1700000000000000|s-2",
        hasNextPage: true
      })
    );
    render(<ResearchHome />);

    const count = await screen.findByTestId("research-list-count");
    expect(count.textContent).toBe("已加载 2 项");
  });

  it("最后一页时说「共」，因为此时加载到的就是全部", async () => {
    listSessions.mockResolvedValue(page([SESSION]));
    render(<ResearchHome />);

    const count = await screen.findByTestId("research-list-count");
    expect(count.textContent).toBe("共 1 项");
  });

  it("没有下一页时不显示「加载更早的研究」", async () => {
    listSessions.mockResolvedValue(page([SESSION]));
    render(<ResearchHome />);

    await screen.findByTestId("research-list-count");
    expect(screen.queryByTestId("research-list-more")).toBeNull();
  });

  it("加载更多把下一页追加在后面，不替换已加载的行", async () => {
    listSessions
      .mockResolvedValueOnce(
        page([SESSION], { nextCursor: "c1", hasNextPage: true })
      )
      .mockResolvedValueOnce(
        page([{ ...SESSION, id: "s-2", projectName: "更早的研究" }])
      );
    render(<ResearchHome />);

    fireEvent.click(await screen.findByTestId("research-list-more"));

    await waitFor(() => expect(screen.getByText("更早的研究")).toBeTruthy());
    // 第一页的行还在：追加而不是替换。
    expect(screen.getByText("危化品安全平台")).toBeTruthy();
    expect(listSessions).toHaveBeenLastCalledWith({ after: "c1" });
    // 到最后一页后按钮消失，头部改口为「共」。
    expect(screen.queryByTestId("research-list-more")).toBeNull();
    expect(screen.getByTestId("research-list-count").textContent).toBe("共 2 项");
  });

  it("加载更多失败时说明原因，已加载的行不丢", async () => {
    listSessions
      .mockResolvedValueOnce(
        page([SESSION], { nextCursor: "c1", hasNextPage: true })
      )
      .mockRejectedValueOnce(new Error("网络中断"));
    render(<ResearchHome />);

    fireEvent.click(await screen.findByTestId("research-list-more"));

    const failure = await screen.findByTestId("research-list-action-error");
    expect(failure.textContent).toContain("网络中断");
    expect(screen.getByText("危化品安全平台")).toBeTruthy();
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

  it("创建成功后真的进入研究工作台，而不是原地留一行小字", async () => {
    createSession.mockResolvedValue({ id: "s-9" });
    render(<ResearchHome />);

    fireEvent.change(screen.getByLabelText(/研究名称/), {
      target: { value: "危化品安全平台" }
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并进入工作台" }));

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    // 按钮写的是「创建并进入工作台」，只创建不进入就是名不副实。
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/research/s-9"));
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
/**
 * 未登录不是「服务故障」。
 *
 * 研究列表是按账户隔离的，匿名的读被答 401。以前这个 401 和其它失败共用一句
 * 「请确认核心 API 正在运行（默认 4100 端口）」，等于让一个只是没登录的访客
 * 去检查一个跑得好好的进程，旁边的「重新加载」点一百次也不会好。
 */
describe("ResearchHome · 未登录与连接失败必须分开说", () => {
  it("未登录时请人登录，不叫人去查端口", async () => {
    listSessions.mockRejectedValue(
      new ApiTransportError("http", "Authentication required", { status: 401 })
    );
    render(<ResearchHome />);

    const panel = await screen.findByTestId("research-list-error");
    expect(panel.textContent).toContain("需要登录");
    expect(screen.getByRole("link", { name: "去登录" }).getAttribute("href")).toBe(
      "/login"
    );

    // The old lie must not come back, in any of its forms.
    expect(panel.textContent).not.toContain("4100");
    expect(panel.textContent).not.toContain("核心 API");
    expect(panel.textContent).not.toContain("Authentication required");
    // And no retry button: retrying without signing in can only fail again.
    expect(screen.queryByRole("button", { name: "重新加载" })).toBeNull();
  });

  it("连不上时才说服务问题，并且不提端口号", async () => {
    listSessions.mockRejectedValue(new Error("无法连接到核心 API。"));
    render(<ResearchHome />);

    const panel = await screen.findByTestId("research-list-error");
    expect(panel.textContent).toContain("无法读取研究列表");
    expect(panel.textContent).not.toContain("4100");
    expect(panel.textContent).not.toContain("需要登录");
    expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy();
  });

  it("空态指向旁边的创建表单，而不只是报告「这里空」", async () => {
    listSessions.mockResolvedValue(page([]));
    render(<ResearchHome />);

    const empty = await screen.findByTestId("research-list-empty");
    expect(empty.textContent).toContain("还没有研究任务");
    expect(empty.textContent).toContain("在左边写下第一个研究问题");
  });
});

/**
 * 这张列表上每一行都是「你有权读的」，所以来源标签说明的不是权限，而是
 * 「它为什么在这里」——自己建的、被拉进团队的、别人把材料共享过来的。
 * 三者在权限上一样，在要不要点开上完全不一样。
 */
describe("ResearchHome · 来源", () => {
  it("每行标出来源，筛选按服务端参数取数", async () => {
    listSessions.mockResolvedValue(
      page([
        SESSION,
        { ...SESSION, id: "s-2", projectName: "合作方的调研", relation: "granted" },
        { ...SESSION, id: "s-3", projectName: "我参与的调研", relation: "collaborator" }
      ])
    );
    render(<ResearchHome />);

    const badges = await screen.findAllByTestId("relation-badge");
    expect(badges.map((node) => node.textContent)).toEqual([
      "我创建的",
      "共享给我",
      "我参与的"
    ]);

    // Three relations means the filter is worth drawing; one would not be.
    fireEvent.click(screen.getByTestId("relation-filter-granted"));
    await waitFor(() =>
      expect(listSessions).toHaveBeenLastCalledWith({ relation: "granted" })
    );
  });

  it("只有一种来源时不画筛选条", async () => {
    listSessions.mockResolvedValue(page([SESSION, { ...SESSION, id: "s-2" }]));
    render(<ResearchHome />);

    expect((await screen.findAllByTestId("relation-badge")).length).toBe(2);
    // A tab strip with one real option is furniture, not a control.
    expect(screen.queryByTestId("relation-filter")).toBeNull();
  });

  it("筛选后为空时不说「还没有研究任务」", async () => {
    listSessions
      .mockResolvedValueOnce(
        page([SESSION, { ...SESSION, id: "s-2", relation: "granted" }])
      )
      .mockResolvedValue(page([]));
    render(<ResearchHome />);

    fireEvent.click(await screen.findByTestId("relation-filter-granted"));

    const empty = await screen.findByTestId("research-list-filter-empty");
    expect(empty.textContent).toContain("没有「共享给我」的研究");
    // The workspace is not empty; this one filtered view is.
    expect(screen.queryByText("还没有研究任务")).toBeNull();
    // And the way back is in the empty state itself.
    expect(screen.getByRole("button", { name: "清除筛选" })).toBeTruthy();
  });
});
