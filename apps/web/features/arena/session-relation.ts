import type { SessionRelation } from "./api-client";

/**
 * What each reason is called on screen.
 *
 * The wording is about *whose* the research is, not about permission, because
 * every value here already means "you may read it". A label like "只读" or
 * "可编辑" would describe what the guard decided; these describe what the
 * person did to end up on the list — created it, was invited to it, was given
 * material from it — which is what the "which of these are mine?" question is
 * actually asking.
 */
export const RELATION_LABELS: Record<SessionRelation, string> = {
  owner: "我创建的",
  collaborator: "我参与的",
  granted: "共享给我",
  unowned: "无归属"
};

/**
 * One line explaining what the label entitles you to, for the filter's
 * tooltip and for the empty state after filtering.
 *
 * `granted` is deliberately not called "shared with me" only — the point worth
 * stating is that a grant gives you the material, not the research.
 */
export const RELATION_HINTS: Record<SessionRelation, string> = {
  owner: "由你创建，可以编辑、共享和删除。",
  collaborator: "你在该研究团队里，可以阅读并参与协作。",
  granted: "有人把该研究的材料共享给你，能读，但不是你的。",
  unowned: "早期记录没有保存创建人，由部署管理员代管。"
};

/**
 * The order the filter offers them in.
 *
 * Most personal first, because the first tab a user reaches for is the one
 * that answers "what did I make". `unowned` is last and only ever appears when
 * there are such rows: it is an administrator's cleanup category, not a place
 * where normal work lives.
 */
export const RELATION_ORDER: readonly SessionRelation[] = [
  "owner",
  "collaborator",
  "granted",
  "unowned"
];

/**
 * Which relations actually occur in a page of rows.
 *
 * The filter is built from the data rather than from the full vocabulary
 * because a tab that can only ever show an empty list is a dead end: offering
 * "共享给我" to someone nothing was ever shared with is a promise the screen
 * cannot keep. `null` rows (no identity system) contribute nothing, which is
 * also what hides the filter entirely in operator mode.
 */
export function presentRelations(
  rows: readonly { relation: SessionRelation | null }[]
): SessionRelation[] {
  const seen = new Set<SessionRelation>();
  for (const row of rows) {
    if (row.relation !== null) seen.add(row.relation);
  }
  return RELATION_ORDER.filter((relation) => seen.has(relation));
}

/**
 * The tabs to draw, given what has been seen so far and what is selected.
 *
 * The active filter is always kept even if the current page no longer contains
 * it — filtering to 共享给我 returns only shared rows, so a list rebuilt from
 * those rows alone would drop the other tabs and leave the user on a filter
 * with no way to switch it off. `known` is therefore accumulated across loads
 * and never shrinks.
 */
export function visibleRelations(
  known: readonly SessionRelation[],
  active: SessionRelation | null
): SessionRelation[] {
  const seen = new Set<SessionRelation>(known);
  if (active !== null) seen.add(active);
  return RELATION_ORDER.filter((relation) => seen.has(relation));
}
