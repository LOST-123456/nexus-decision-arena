/**
 * The Research Workspace's own navigation.
 *
 * It used to be sixteen buttons in a single flat strip. Finding 研究质量 meant
 * reading every label in turn, and on a laptop the strip wrapped onto three
 * rows with nothing to say which label belonged with which. Grouping gives the
 * reader two decisions instead of sixteen: which area, then which panel.
 *
 * The data lives here rather than inside the component so it can be asserted
 * on directly — the component pulls in every panel (the evidence map brings
 * React Flow with it), which a plain unit test has no reason to load.
 */

export const WORKSPACE_TABS = [
  // 内容 — reading the research and the material it rests on.
  { id: "claims", label: "主张", group: "content", narrowOnly: true },
  { id: "content", label: "研究内容", group: "content", narrowOnly: false },
  { id: "detail", label: "来源详情", group: "content", narrowOnly: true },
  { id: "reader", label: "原文阅读", group: "content", narrowOnly: false },

  // 核查 — deciding whether the material holds up.
  { id: "review", label: "审核中心", group: "verify", narrowOnly: false },
  { id: "cross", label: "交叉审查", group: "verify", narrowOnly: false },
  { id: "citations", label: "引用核查", group: "verify", narrowOnly: false },
  { id: "independence", label: "来源关系", group: "verify", narrowOnly: false },
  { id: "quality", label: "研究质量", group: "verify", narrowOnly: false },

  // 分析 — building the picture: what is missing, how it connects.
  { id: "map", label: "证据地图", group: "analyze", narrowOnly: false },
  { id: "analyze", label: "AI 拆解", group: "analyze", narrowOnly: false },
  { id: "plan", label: "研究计划", group: "analyze", narrowOnly: false },
  { id: "files", label: "文件导入", group: "analyze", narrowOnly: false },

  // 协作与运行 — who else works on it, and what the agents did.
  { id: "collaboration", label: "团队协作", group: "ops", narrowOnly: false },
  { id: "library", label: "资料库", group: "ops", narrowOnly: false },
  { id: "agentops", label: "运行中心", group: "ops", narrowOnly: false }
] as const;

/** Every panel the bar can open. */
export type GroupedPanel = (typeof WORKSPACE_TABS)[number]["id"];

/**
 * The panels of the workspace, including the one the bar does not carry.
 *
 * `filereader` is reached by opening a file in 文件导入, so a tab for it would
 * be a control that changes nothing. Deriving the union from the list above is
 * what keeps the two honest: a panel cannot exist here without being placed in
 * a group, because there would be no list entry to derive it from.
 */
export type Panel = GroupedPanel | "filereader";

export type TabGroupId = (typeof WORKSPACE_TABS)[number]["group"];

/**
 * `Record<TabGroupId, …>` is total on purpose: adding a group to the list
 * above without naming it here fails to compile.
 */
export const TAB_GROUP_LABELS: Record<TabGroupId, string> = {
  content: "内容",
  verify: "核查",
  analyze: "分析",
  ops: "协作与运行"
};

export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
export type TabGroup = { id: TabGroupId; label: string; tabs: readonly WorkspaceTab[] };

/**
 * The tabs bucketed by group, in the order the groups first appear above.
 * Built rather than hand-written so the two cannot disagree; bucketing by id
 * (instead of assuming the list is sorted) means an interleaved entry joins its
 * group rather than silently starting a second one with the same label.
 */
export const TAB_GROUPS: readonly TabGroup[] = (() => {
  const order: TabGroupId[] = [];
  const byGroup = new Map<TabGroupId, WorkspaceTab[]>();
  for (const tab of WORKSPACE_TABS) {
    let bucket = byGroup.get(tab.group);
    if (!bucket) {
      bucket = [];
      byGroup.set(tab.group, bucket);
      order.push(tab.group);
    }
    bucket.push(tab);
  }
  return order.map((id) => ({
    id,
    label: TAB_GROUP_LABELS[id],
    tabs: byGroup.get(id) ?? []
  }));
})();
