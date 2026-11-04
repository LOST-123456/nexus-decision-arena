import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Timeline } from "./timeline";

// vitest 没有开 globals，RTL 的自动清理不会注册：不手动清，上一个用例的
// DOM 会留下来，第二个 describe 里的查询就会撞上"找到多个"。
afterEach(cleanup);

describe("Timeline", () => {
  it("selects a historical sequence with a real button", () => {
    const onSelect = vi.fn();

    render(
      <Timeline
        events={[
          { id: "event-1", sequence: 1, type: "SESSION_STATE_CHANGED" },
          { id: "event-8", sequence: 8, type: "CLAIM_CREATED" }
        ]}
        selectedSequence={8}
        onSelect={onSelect}
      />
    );

    const historical = screen.getByRole("button", {
      name: /Sequence 1 SESSION_STATE_CHANGED/i
    });
    expect(historical.getAttribute("aria-current")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: /Sequence 8 CLAIM_CREATED/i })
        .getAttribute("aria-current")
    ).toBe("step");

    fireEvent.click(historical);
    expect(onSelect).toHaveBeenCalledWith(1);
  });
});

/**
 * 时间线是一排横向滚动的卡片。
 *
 * 实测在 1080px 窗口里第 8 张正好被右边缘切成半张，滚动条又被样式收进去了，
 * 看上去就是"只记了 8 条"——真实有几十条。所以溢出必须说出来。
 */
describe("Timeline · 横向溢出", () => {
  const many = Array.from({ length: 12 }, (_, index) => ({
    id: `event-${index + 1}`,
    sequence: index + 1,
    type: "AGENT_RUN_STARTED"
  }));

  it("装得下时不吓人", () => {
    render(
      <Timeline events={many.slice(0, 2)} selectedSequence={1} onSelect={() => {}} />
    );
    expect(screen.queryByTestId("timeline-overflow")).toBeNull();
    expect(screen.getByTestId("timeline").getAttribute("data-overflow")).toBe(
      "false"
    );
  });

  it("溢出时说清楚还有内容，并给出滚动方式", () => {
    render(<Timeline events={many} selectedSequence={1} onSelect={() => {}} />);
    const list = screen.getByRole("list", { name: "执行事件时间线" });
    // jsdom 里没有布局，宽度靠打桩：600 可视 / 1800 内容。
    Object.defineProperty(list, "scrollWidth", {
      configurable: true,
      value: 1800
    });
    Object.defineProperty(list, "clientWidth", {
      configurable: true,
      value: 600
    });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    const hint = screen.getByTestId("timeline-overflow");
    expect(hint.textContent).toContain("12 条");
    expect(screen.getByTestId("timeline").getAttribute("data-overflow")).toBe(
      "true"
    );
  });

  it("滚动区可以用键盘进入", () => {
    render(<Timeline events={many} selectedSequence={1} onSelect={() => {}} />);
    expect(
      screen.getByRole("list", { name: "执行事件时间线" }).getAttribute("tabindex")
    ).toBe("0");
  });
});
