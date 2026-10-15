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
  submitHumanDecision: vi.fn()
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
