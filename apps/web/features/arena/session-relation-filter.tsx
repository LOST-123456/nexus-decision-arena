"use client";

import type { SessionRelation } from "./api-client";
import { RELATION_HINTS, RELATION_LABELS } from "./session-relation";

export interface SessionRelationFilterProps {
  /** Only the relations that actually occur; an empty list renders nothing. */
  relations: readonly SessionRelation[];
  /** `null` is "全部" — the unfiltered list. */
  value: SessionRelation | null;
  onChange: (next: SessionRelation | null) => void;
}

/**
 * The "which of these are mine?" control, shared by both research lists.
 *
 * A stateless atom on purpose. `/history` and `/research` are separate product
 * surfaces and stay that way; what they share is the vocabulary for *why* a
 * research is on a list, and duplicating that vocabulary into two files is how
 * the two screens end up calling the same thing by different names.
 *
 * Rendered as buttons with `aria-pressed` rather than a `<select>`: the number
 * of options is small, the state matters while reading the rows below, and a
 * closed dropdown would hide both. No `tabIndex` juggling — each button is
 * natively focusable, so keyboard and screen-reader paths are the browser's
 * own.
 */
export function SessionRelationFilter({
  relations,
  value,
  onChange
}: SessionRelationFilterProps) {
  // Nothing to separate: the operator deployment has no accounts, and a list
  // holding only one kind needs no filter either.
  if (relations.length < 2) return null;

  return (
    <div
      className="relation-filter"
      role="group"
      aria-label="按来源筛选研究"
      data-testid="relation-filter"
    >
      <button
        type="button"
        className="relation-filter-option"
        aria-pressed={value === null}
        data-testid="relation-filter-all"
        onClick={() => onChange(null)}
      >
        全部
      </button>
      {relations.map((relation) => (
        <button
          key={relation}
          type="button"
          className="relation-filter-option"
          aria-pressed={value === relation}
          title={RELATION_HINTS[relation]}
          data-testid={`relation-filter-${relation}`}
          onClick={() => onChange(relation)}
        >
          {RELATION_LABELS[relation]}
        </button>
      ))}
    </div>
  );
}
