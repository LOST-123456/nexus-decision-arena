"use client";

import { TAB_GROUPS, type Panel } from "./workspace-nav";

/**
 * The Research Workspace's navigation bar.
 *
 * It lives in its own file for two reasons. It has no dependency beyond the
 * navigation model, so it can be rendered and asserted on directly instead of
 * dragging every panel (and React Flow with them) into a unit test. And the
 * grouping is a decision worth being able to point at: sixteen buttons in one
 * strip gave no clue which labels belonged together.
 *
 * Each group is its own `tablist`, named by its own visible heading, so the
 * grouping is announced rather than only seen.
 */
export function WorkspaceTabBar({
  panel,
  onSelect
}: {
  /** The panel currently open, which is the one marked selected. */
  panel: Panel;
  onSelect: (panel: Panel) => void;
}) {
  return (
    <div
      // `research-tabs` stays on this element on purpose: the print rule that
      // hides the bar matches on that class.
      className="research-tabs research-tab-groups"
      data-testid="research-tabs"
    >
      {TAB_GROUPS.map((group) => (
        <div className="research-tab-group" key={group.id}>
          <span
            className="research-tab-group-label"
            id={`ws-tabgroup-${group.id}`}
          >
            {group.label}
          </span>
          <div
            className="research-tab-strip"
            role="tablist"
            aria-labelledby={`ws-tabgroup-${group.id}`}
          >
            {group.tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                className={`research-tab${item.narrowOnly ? " research-tab-narrow" : ""}`}
                aria-selected={panel === item.id}
                onClick={() => onSelect(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
