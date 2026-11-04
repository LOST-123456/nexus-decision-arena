import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_OVERSIGHT_COUNTS, type OversightCounts } from "@nexus/shared";

/**
 * 治理页那一节的诚实契约。
 *
 * 三件只有界面能保证的事：
 *
 *  1. **没有分母时不说 0%。** 一个从没被裁决过的工作区，画一根 0% 的柱等于说
 *     「AI 从不被推翻」，那是相反的结论。
 *  2. **「没有可统计的研究」不等于「数字都是 0」。** 前者是空工作区，后者是
 *     一个发生了很多事但都不涉及你的工作区。两句不能混。
 *  3. **未登录不给重试按钮。** 数字按账户统计，重试必然再 401。
 */

const getOversightCounts = vi.fn();

vi.mock("./oversight-api", () => ({
  getOversightCounts: (...args: unknown[]) => getOversightCounts(...args)
}));

const { OversightPanel } = await import("./oversight-panel");
const { ApiTransportError } = await import("../../lib/api-transport");

function counts(over: Partial<OversightCounts> = {}): OversightCounts {
  return {
    ...EMPTY_OVERSIGHT_COUNTS,
    sessionCount: 3,
    conflicts: { total: 5, requiringHuman: 3, awaitingHuman: 2, resolved: 1 },
    decisions: {
      total: 4,
      acceptChallenge: 1,
      upholdClaim: 2,
      requestMoreAnalysis: 1
    },
    runs: {
      total: 10,
      completed: 6,
      failed: 2,
      timedOut: 1,
      cancelled: 1,
      retried: 3
    },
    ...over
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OversightPanel", () => {
  it("reports what a person decided, without scoring it", async () => {
    getOversightCounts.mockResolvedValue(counts());
    render(<OversightPanel />);

    const panel = await screen.findByTestId("oversight-panel");

    expect(panel.textContent).toContain("人工裁决 4 次");
    expect(panel.textContent).toContain("采纳质询 1 次");
    expect(panel.textContent).toContain("维持主张 2 次");
    expect(screen.getByTestId("oversight-awaiting").textContent).toBe("2");
    // The rate is stated as a share of decisions taken, and the panel says
    // what it does not mean.
    expect(screen.getByTestId("oversight-accept-rate").textContent).toContain("25%");
    expect(panel.textContent).toContain("不说明主张是错的");
  });

  it("says 暂无数据 rather than 0% when nothing was ever decided", async () => {
    getOversightCounts.mockResolvedValue(
      counts({
        decisions: {
          total: 0,
          acceptChallenge: 0,
          upholdClaim: 0,
          requestMoreAnalysis: 0
        }
      })
    );
    render(<OversightPanel />);

    const rate = await screen.findByTestId("oversight-accept-rate");
    expect(rate.textContent).toContain("暂无数据");
    // The old failure mode: a 0% bar reading as "AI is never overruled".
    expect(rate.textContent).not.toContain("0%");
    expect(screen.queryByTestId("oversight-decision-bar")).toBeNull();
  });

  it("counts cancelled runs as not completed, not as success", async () => {
    getOversightCounts.mockResolvedValue(
      counts({ runs: { total: 10, completed: 6, failed: 2, timedOut: 1, cancelled: 1, retried: 3 } })
    );
    render(<OversightPanel />);

    const panel = await screen.findByTestId("oversight-panel");
    expect(panel.textContent).toContain("跑完的比例：");
    expect(panel.textContent).toContain("60%");
    expect(screen.getByTestId("oversight-retried").textContent).toBe("3");
  });

  it("separates an empty workspace from a workspace with no numbers about you", async () => {
    getOversightCounts.mockResolvedValue(EMPTY_OVERSIGHT_COUNTS);
    render(<OversightPanel />);

    const empty = await screen.findByTestId("oversight-empty");
    expect(empty.textContent).toContain("还没有可统计的研究");
    // Not the panel: zero counts inside a scope of three researches is a
    // different sentence from "there is nothing here at all".
    expect(screen.queryByTestId("oversight-panel")).toBeNull();
  });

  it("asks a signed-out visitor to sign in, and offers no doomed retry", async () => {
    getOversightCounts.mockRejectedValue(
      new ApiTransportError("http", "Authentication required", { status: 401 })
    );
    render(<OversightPanel />);

    const panel = await screen.findByTestId("oversight-error");
    expect(panel.textContent).toContain("需要登录");
    expect(screen.getByRole("link", { name: "去登录" }).getAttribute("href")).toBe(
      "/login"
    );
    expect(panel.textContent).not.toContain("Authentication required");
    // Retrying without signing in asks the same 401 again.
    expect(screen.queryByRole("button", { name: "重新加载" })).toBeNull();
  });

  it("offers a retry when the numbers could not be read", async () => {
    getOversightCounts
      .mockRejectedValueOnce(new Error("无法连接到核心 API。"))
      .mockResolvedValue(counts());
    render(<OversightPanel />);

    const panel = await screen.findByTestId("oversight-error");
    expect(panel.textContent).toContain("无法读取治理数据");

    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));

    await waitFor(() =>
      expect(screen.getByTestId("oversight-panel")).toBeTruthy()
    );
  });

  it("keeps the caveat on screen, because the numbers are not proof", async () => {
    getOversightCounts.mockResolvedValue(counts());
    render(<OversightPanel />);

    const caveat = await screen.findByTestId("oversight-caveat");
    expect(caveat.textContent).toContain("不能证明任何结论正确");
  });
});
