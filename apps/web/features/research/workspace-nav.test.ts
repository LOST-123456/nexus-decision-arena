import { describe, expect, it } from "vitest";
import { TAB_GROUPS, TAB_GROUP_LABELS, WORKSPACE_TABS } from "./workspace-nav";

/**
 * The workspace bar's contract.
 *
 * This is a test rather than a comment because the bar is generated from this
 * list, so a mistake in it is a mistake in the only navigation the research
 * workspace has: a duplicated id renders a tab that can never be selected, a
 * tab left out of every group becomes unreachable, and an unlabelled group
 * renders an empty heading.
 */

const EXPECTED_TABS: readonly string[] = [
  "claims",
  "content",
  "detail",
  "reader",
  "review",
  "cross",
  "citations",
  "independence",
  "quality",
  "map",
  "analyze",
  "plan",
  "files",
  "collaboration",
  "library",
  "agentops"
];

describe("Research Workspace 导航模型", () => {
  it("每个面板出现且只出现一次", () => {
    const ids = WORKSPACE_TABS.map((tab) => tab.id);

    expect(new Set(ids).size, `重复的面板：${ids.join(", ")}`).toBe(ids.length);
    expect([...ids].sort()).toEqual([...EXPECTED_TABS].sort());
  });

  it("每个标签都有非空名称", () => {
    for (const tab of WORKSPACE_TABS) {
      expect(tab.label.trim(), `${tab.id} 的名称`).not.toBe("");
    }
  });

  it("分组不丢标签：并起来仍等于全集", () => {
    const grouped = TAB_GROUPS.flatMap((group) =>
      group.tabs.map((tab) => tab.id)
    );

    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...EXPECTED_TABS].sort());
  });

  it("每组都有标题、至少一个标签，且标签自报的分组与所在组一致", () => {
    for (const group of TAB_GROUPS) {
      expect(TAB_GROUP_LABELS[group.id].trim(), `${group.id} 的标题`).not.toBe("");
      expect(group.tabs.length, `${group.id} 的标签数`).toBeGreaterThan(0);

      for (const tab of group.tabs) {
        expect(tab.group, `${tab.id} 自报的分组`).toBe(group.id);
      }
    }
  });

  it("按设计分成四个区域，顺序稳定", () => {
    expect(TAB_GROUPS.map((group) => group.id)).toEqual([
      "content",
      "verify",
      "analyze",
      "ops"
    ]);
    expect(WORKSPACE_TABS.length).toBe(16);
  });

  it("只有主张与来源详情是窄屏专属标签（宽屏上它们常驻栏位）", () => {
    const narrow = WORKSPACE_TABS.filter((tab) => tab.narrowOnly).map(
      (tab) => tab.id
    );

    expect([...narrow].sort()).toEqual(["claims", "detail"]);
  });
});
