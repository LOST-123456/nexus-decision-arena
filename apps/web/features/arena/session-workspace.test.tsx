import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiTransportError } from "../../lib/api-transport";
import { SessionWorkspace } from "./session-workspace";

const sessionId = "3f6b1c2e-9a44-4d1e-8a7f-2b5c9d0e1f23";

const emptySession = {
  sessionId,
  phase: "HUMAN_REVIEW",
  operationalStatus: "PAUSED",
  agents: [],
  claims: [],
  evidence: [],
  challenges: [],
  conflicts: [],
  humanDecisions: [],
  currentConclusion: null,
  lastSequence: 0
};

const apiMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getEvents: vi.fn(),
  getInspector: vi.fn(),
  // RuntimeModeBadge lives in the workspace header and reads the runtime on
  // mount; without this the mock factory leaves the export undefined and
  // Vitest reports an unhandled error that fails the whole run.
  getRuntimeInfo: vi.fn(),
  subscribeToEvents: vi.fn(),
  submitHumanDecision: vi.fn(),
  /**
   * 工作区挂载时会问一次"我是谁"，好决定要不要把补充材料表单摆出来。
   * 不在这里给出，mock 工厂会让这个导出变成 undefined，整个文件报错。
   */
  getCurrentUser: vi.fn(),
  listMaterials: vi.fn(),
  addMaterial: vi.fn(),
  /**
   * 还没开始的评审，这一页要自己给一个「开始评审」按钮。
   * 新建表单现在会立刻跳过来、分析在后台起跑，所以这一页必须先接住
   * 「刚建好、还没动」这个状态。
   */
  startSession: vi.fn()
}));

vi.mock("./api-client", () => apiMocks);

beforeEach(() => {
  // `clearAllMocks` would leave a permanent rejection from one test leaking
  // into the next, so each mock is reset and then given a sane default.
  apiMocks.getSession.mockReset();
  apiMocks.getEvents.mockReset();
  apiMocks.getInspector.mockReset();
  apiMocks.getRuntimeInfo.mockReset();
  apiMocks.subscribeToEvents.mockReset();
  apiMocks.submitHumanDecision.mockReset();
  apiMocks.getEvents.mockResolvedValue([]);
  apiMocks.getInspector.mockResolvedValue(null);
  apiMocks.getRuntimeInfo.mockResolvedValue(null);
  apiMocks.subscribeToEvents.mockReturnValue(() => {});
  apiMocks.getCurrentUser.mockReset();
  apiMocks.getCurrentUser.mockResolvedValue(null);
  apiMocks.listMaterials.mockReset();
  apiMocks.listMaterials.mockResolvedValue({ materials: [] });
  apiMocks.startSession.mockReset();
});

afterEach(() => {
  // Auto-cleanup never registers (vitest runs without `globals`), so without
  // this every test would see the previous test's DOM — a stale "session
  // unavailable" panel would outlive the retry that replaced it.
  cleanup();
  vi.clearAllMocks();
});

describe("SessionWorkspace when the core API cannot be reached", () => {
  it("says the session could not be loaded instead of showing an empty one", async () => {
    apiMocks.getSession.mockRejectedValue(
      new Error("无法连接到核心 API。请确认服务仍在运行，然后重新检查。")
    );

    render(<SessionWorkspace sessionId={sessionId} />);

    expect(await screen.findByTestId("session-load-error")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "无法加载会话" })).toBeTruthy();
    expect(
      screen.getByText(/无法连接到核心 API/)
    ).toBeTruthy();
    // The empty workspace must NOT be rendered: an unreadable session is not
    // the same thing as a session with no agents and no claims.
    expect(screen.queryByLabelText("Decision workspace")).toBeNull();
    expect(screen.queryByRole("button", { name: /Timeline/i })).toBeNull();
  });

  it("offers a retry that re-reads the session", async () => {
    apiMocks.getSession
      .mockRejectedValueOnce(new Error("无法连接到核心 API。"))
      .mockResolvedValue(emptySession);

    render(<SessionWorkspace sessionId={sessionId} />);

    const retry = await screen.findByRole("button", { name: "重新加载" });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(screen.queryByTestId("session-load-error")).toBeNull();
    });
    expect(apiMocks.getSession).toHaveBeenCalledTimes(2);
  });

  it("shows a loading state while the session is being read", async () => {
    let release: (() => void) | undefined;
    apiMocks.getSession.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve(emptySession);
      })
    );

    render(<SessionWorkspace sessionId={sessionId} />);

    expect(await screen.findByTestId("session-loading")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "正在载入会话" })).toBeTruthy();

    release?.();
    await waitFor(() => {
      expect(screen.queryByTestId("session-loading")).toBeNull();
    });
  });
});

describe("SessionWorkspace when the session does not exist", () => {
  it("says the session is gone and offers a way out instead of a retry", async () => {
    apiMocks.getSession.mockRejectedValue(
      new ApiTransportError("http", "Session not found", {
        status: 404,
        payload: { error: "Session not found" }
      })
    );

    render(<SessionWorkspace sessionId={sessionId} />);

    expect(await screen.findByTestId("session-not-found")).toBeTruthy();
    // Even the refusal is the page landmark, so the skip link still has a
    // target when a session is missing.
    expect(screen.getByTestId("session-not-found").id).toBe("main");
    expect(screen.getByRole("heading", { name: "会话不存在" })).toBeTruthy();
    // A dead link must not offer a retry whose only outcome is failing again.
    expect(screen.queryByRole("button", { name: "重新加载" })).toBeNull();
    expect(screen.getByRole("link", { name: "返回最近会话" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "新建评审" })).toBeTruthy();
    // The service-outage wording belongs to the other branch; the server's
    // developer-facing English must not be what the operator reads either.
    expect(screen.queryByRole("heading", { name: "无法加载会话" })).toBeNull();
    expect(screen.queryByText(/Session not found/)).toBeNull();
  });
});

/**
 * Reads are owner-scoped, so `401` is now an ordinary answer here rather than
 * an exotic one. It must not reuse the outage wording: "check that the core is
 * running on 4100" sends a signed-out visitor to inspect a process that is
 * running fine, and offers a retry that cannot possibly help.
 */
describe("SessionWorkspace when the caller is not signed in", () => {
  it("asks for a login instead of blaming the service", async () => {
    apiMocks.getSession.mockRejectedValue(
      new ApiTransportError("http", "Authentication required", {
        status: 401,
        payload: { error: "Authentication required" }
      })
    );

    render(<SessionWorkspace sessionId={sessionId} />);

    expect(await screen.findByTestId("session-sign-in-required")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "需要登录" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "去登录" }).getAttribute("href")).toBe(
      "/login"
    );
    // No retry: re-issuing the same unauthenticated request answers 401 again.
    expect(screen.queryByRole("button", { name: "重新加载" })).toBeNull();
    // Neither of the other two stories may be told instead.
    expect(screen.queryByTestId("session-not-found")).toBeNull();
    expect(screen.queryByTestId("session-load-error")).toBeNull();
    expect(screen.queryByText(/4100/)).toBeNull();
    expect(screen.queryByText(/Authentication required/)).toBeNull();
  });
});

/**
 * 「刚建好、还没跑」这一屏。
 *
 * 新建表单现在创建成功就跳转、分析在后台起跑，于是这一页必然会短暂（或
 * 长久，如果启动失败）停在 CREATED。它不能是空白：空白读起来就是"坏了"。
 */
describe("SessionWorkspace · 还没开始的评审", () => {
  it("给一个能按的「开始评审」，并且真的把请求发出去", async () => {
    apiMocks.getSession.mockResolvedValue({
      ...emptySession,
      phase: "CREATED",
      operationalStatus: "ACTIVE"
    });
    apiMocks.startSession.mockResolvedValue({
      id: sessionId,
      status: "STARTED"
    });

    render(<SessionWorkspace sessionId={sessionId} />);

    fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));

    await waitFor(() =>
      expect(apiMocks.startSession).toHaveBeenCalledWith(
        sessionId,
        expect.anything()
      )
    );
  });

  it("启动失败时把原因写在这一页，而不是让人猜", async () => {
    apiMocks.getSession.mockResolvedValue({
      ...emptySession,
      phase: "CREATED",
      operationalStatus: "ACTIVE"
    });
    apiMocks.startSession.mockRejectedValue(
      new Error("还没有配置模型，无法启动分析。")
    );

    render(<SessionWorkspace sessionId={sessionId} />);

    fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("还没有配置模型");
  });
});

/**
 * 页头原来一律写「当前结论」。
 *
 * 实测第 3 秒显示「建议立项」，第 13 秒 AI 自己改成「暂缓规模化扩张」。
 * 把中间态叫结论，读的人自然认为系统在改口；所以 DECIDED 之前只能叫
 * 「初步倾向」，并且把步序号摆出来，让那十几秒的等待有长度。
 */
describe("SessionWorkspace · 结论还没定稿", () => {
  it("分析中给出的是「初步倾向 · 未定稿」，同时标出第几步", async () => {
    apiMocks.getSession.mockResolvedValue({
      ...emptySession,
      phase: "ANALYZING",
      operationalStatus: "ACTIVE",
      currentConclusion: "建议立项"
    });

    render(<SessionWorkspace sessionId={sessionId} />);

    expect(await screen.findByText("初步倾向 · 未定稿")).toBeTruthy();
    expect(screen.queryByText("当前结论")).toBeNull();
    // 现状内容仍然要看得见——只是换了称呼，不是藏起来。
    expect(screen.getAllByText("建议立项").length).toBeGreaterThan(0);
    // 多角色分析中是第 2 步，共 4 步。
    expect(screen.getByText("2/4")).toBeTruthy();
  });

  it("出了结论之后才叫「当前结论」，步序号收起来", async () => {
    apiMocks.getSession.mockResolvedValue({
      ...emptySession,
      phase: "DECIDED",
      operationalStatus: "COMPLETED",
      currentConclusion: "暂缓规模化扩张"
    });

    render(<SessionWorkspace sessionId={sessionId} />);

    expect(await screen.findByText("当前结论")).toBeTruthy();
    expect(screen.queryByText("初步倾向 · 未定稿")).toBeNull();
    expect(screen.queryByText("2/4")).toBeNull();
  });
});
