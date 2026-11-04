import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionInProgress } from "./decision-in-progress";

afterEach(cleanup);

/**
 * 后台跑的那一轮没有"失败回执"可拿。
 *
 * 补充分析从 HTTP 请求里挪到后台之后，唯一能告诉用户"它可能已经停了"的，
 * 就是这个停在原地的计时器。所以超过阈值必须说话，而不是一直转。
 */
describe("DecisionInProgress · 长时间无进展", () => {
  it("超过阈值时给出可操作的提示", () => {
    vi.useFakeTimers();
    try {
      render(
        <DecisionInProgress
          phase="REASSESSING"
          round={2}
          pendingAction={null}
          stallAfterSeconds={2}
        />
      );
      // 计时器回调里 setState，必须包在 act 里才会 flush 到 DOM。
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      const hint = screen.getByRole("status");
      expect(hint.textContent).toContain("没有进展");
      expect(hint.textContent).toContain("要求补充分析");
    } finally {
      vi.useRealTimers();
    }
  });

  it("没到阈值之前不吓人", () => {
    render(
      <DecisionInProgress phase="REASSESSING" round={2} pendingAction={null} />
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("后台报错时立刻说清楚，而不是等计时器走完", () => {
    render(
      <DecisionInProgress
        phase="REASSESSING"
        round={2}
        pendingAction={null}
        failureMessage="model unreachable"
      />
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("没有跑起来");
    expect(alert.textContent).toContain("model unreachable");
    // 已经有确定结论就不该再叠一条"可能在转圈"的猜测。
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("显示这一轮质询的提出数与完成数", () => {
    render(
      <DecisionInProgress
        phase="REASSESSING"
        round={2}
        pendingAction={null}
        progress={{ asked: 5, done: 3, total: 10 }}
      />
    );
    const progress = screen.getByRole("status");
    expect(progress.textContent).toContain("本轮共 10 条质询");
    expect(progress.textContent).toContain("已提出 5 条");
    expect(progress.textContent).toContain("已完成 3 条");
  });

  it("全部走完之后说收尾，不再往前数", () => {
    render(
      <DecisionInProgress
        phase="REASSESSING"
        round={2}
        pendingAction={null}
        progress={{ asked: 10, done: 10, total: 10 }}
      />
    );
    const progress = screen.getByRole("status");
    expect(progress.textContent).toContain("已完成 10 条");
    expect(progress.textContent).toContain("收尾");
  });
});

/**
 * 首屏 3–11 秒只有阶段名和时针在动，看着像卡死。
 * 步序号是"在推进"的可见证据，所以它必须跟着阶段走。
 */
describe("DecisionInProgress · 阶段步序号", () => {
  const stepLabel = (): string | null | undefined =>
    document.querySelector(".decision-in-progress-step-label")?.textContent;

  it("多角色分析中显示第 2 步 / 共 4 步", () => {
    render(
      <DecisionInProgress phase="ANALYZING" round={1} pendingAction={null} />
    );
    expect(stepLabel()).toContain("第 2 步 / 共 4 步");
    expect(stepLabel()).toContain("多角色分析中");
    // 四格进度条：第 2 格是当前格。
    const track = document.querySelector(".decision-in-progress-step-track");
    expect(track?.querySelectorAll("li")).toHaveLength(4);
    expect(track?.querySelectorAll("li.is-current")).toHaveLength(1);
    expect(track?.querySelector("li.is-current")).toBe(
      track?.querySelectorAll("li")[1]
    );
  });

  it("补充分析说明是回头重跑，而不是悄无声息地退回第 2 步", () => {
    render(
      <DecisionInProgress phase="REASSESSING" round={2} pendingAction={null} />
    );
    expect(stepLabel()).toContain("第 2 步 / 共 4 步");
    expect(stepLabel()).toContain("回头");
  });

  it("不在机器步上的阶段不硬凑分母", () => {
    render(
      <DecisionInProgress phase="HUMAN_REVIEW" round={1} pendingAction={null} />
    );
    expect(document.querySelector(".decision-in-progress-step")).toBeNull();
  });
});
