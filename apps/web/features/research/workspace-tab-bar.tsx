"use client";

import type { KeyboardEvent } from "react";
import { TAB_GROUPS, type Panel, type WorkspaceTab } from "./workspace-nav";

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

/**
 * The panel every tab switches. One id because exactly one panel is mounted
 * at a time (each workspace mode returns its own subtree), so the reference
 * is never ambiguous — and the id exists so `aria-controls` points at a real
 * element rather than at nothing.
 */
const PANEL_ID = "research-workspace-panel";

/**
 * Arrow keys move between tabs, Home/End jump to the ends — the WAI-ARIA
 * tablist pattern. Without it the strip is sixteen Tab stops: a keyboard user
 * walks past every other control on the page to reach the fifth panel.
 *
 * Focus moves with the selection (automatic activation), which is what the
 * pattern prescribes for tabs that swap a panel immediately.
 */
function moveTab(
  event: KeyboardEvent<HTMLButtonElement>,
  index: number,
  tabs: readonly WorkspaceTab[],
  onSelect: (panel: Panel) => void
): void {
  const count = tabs.length;
  let next = index;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    next = (index + 1) % count;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    next = (index - 1 + count) % count;
  } else if (event.key === "Home") {
    next = 0;
  } else if (event.key === "End") {
    next = count - 1;
  } else {
    return;
  }
  event.preventDefault();
  const target = tabs[next];
  if (!target) return;
  onSelect(target.id);
  // The key lands on a tab; its strip is the parent that owns the roving
  // tabindex, so the sibling buttons are found from there.
  const strip = event.currentTarget.parentElement;
  const buttons = Array.from(
    strip?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []
  );
  buttons[next]?.focus();
}

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
              {group.tabs.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  className={`research-tab${item.narrowOnly ? " research-tab-narrow" : ""}`}
                  aria-selected={panel === item.id}
                  // Roving tabindex: the group is one stop for Tab, arrows walk
                  // inside it. Every tab being tabbable made the strip sixteen
                  // consecutive stops before any content.
                  tabIndex={panel === item.id ? 0 : -1}
                  aria-controls={PANEL_ID}
                  onKeyDown={(event) =>
                    moveTab(event, index, group.tabs, onSelect)
                  }
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
