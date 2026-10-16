import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabBar } from "./workspace-tab-bar";
import { TAB_GROUPS } from "./workspace-nav";

/**
 * The rendered bar.
 *
 * `workspace-nav.test.ts` checks the model; this checks that the model is what
 * actually reaches the DOM. Two things can only be seen here: that the grouping
 * is announced (one named `tablist` per group, rather than sixteen tabs in a
 * single anonymous one) and that exactly one tab is marked selected.
 */

afterEach(cleanup);

describe("WorkspaceTabBar", () => {
  it("把 16 个标签渲染成 4 个带标题的分组", () => {
    render(<WorkspaceTabBar panel="content" onSelect={() => {}} />);

    expect(screen.getAllByRole("tablist")).toHaveLength(TAB_GROUPS.length);
    expect(screen.getAllByRole("tab")).toHaveLength(16);
  });

  it("每个分组以自己可见的标题命名，分组才会被读屏播报", () => {
    render(<WorkspaceTabBar panel="content" onSelect={() => {}} />);

    for (const group of TAB_GROUPS) {
      // `getByRole(..., { name })` resolves `aria-labelledby`, so this fails if
      // the heading and the list are wired to different text.
      const list = screen.getByRole("tablist", { name: group.label });
      expect(
        list.querySelectorAll('[role="tab"]'),
        `${group.label} 的标签数`
      ).toHaveLength(group.tabs.length);
    }
  });

  it("恰好把当前面板标记为选中", () => {
    render(<WorkspaceTabBar panel="quality" onSelect={() => {}} />);

    const selected = screen
      .getAllByRole("tab")
      .filter((tab) => tab.getAttribute("aria-selected") === "true");

    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toBe("研究质量");
  });

  it("只有主张与来源详情带窄屏专属类（宽屏上它们常驻栏位）", () => {
    render(<WorkspaceTabBar panel="content" onSelect={() => {}} />);

    const narrow = Array.from(
      document.querySelectorAll(".research-tab-narrow")
    ).map((element) => element.textContent);

    expect(narrow).toEqual(["主张", "来源详情"]);
  });

  it("点击上报被点的面板", () => {
    const onSelect = vi.fn();
    render(<WorkspaceTabBar panel="content" onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("tab", { name: "团队协作" }));

    expect(onSelect).toHaveBeenCalledWith("collaboration");
  });

  it("保留 research-tabs 这个类：打印规则靠它整条隐藏导航", () => {
    render(<WorkspaceTabBar panel="content" onSelect={() => {}} />);

    const bar = screen.getByTestId("research-tabs");

    expect(bar.classList.contains("research-tabs")).toBe(true);
    expect(bar.classList.contains("research-tab-groups")).toBe(true);
  });
});
