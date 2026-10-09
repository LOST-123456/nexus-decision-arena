import type { Conflict, ConflictStatus } from "../domain/conflict";
import type { HumanDecision } from "../domain/human-decision";

export const CONFLICT_STATUSES = [
  "detected",
  "human_review",
  "resolved"
] as const satisfies readonly ConflictStatus[];

/**
 * Conflict lifecycle:
 *   detected      -> identified by the conflict detector, no human ruling yet
 *   human_review  -> the session is paused and a human ruling is pending
 *   resolved      -> a human ruling has been recorded (terminal)
 *
 * `human_review -> detected` models the single supplement round: the human asks
 * for more analysis, so the conflict is handed back to the analysis loop instead
 * of being terminated.
 */
const transitions: Record<ConflictStatus, readonly ConflictStatus[]> = {
  detected: ["human_review", "resolved"],
  human_review: ["detected", "resolved"],
  resolved: []
};

export function canTransitionConflict(
  from: ConflictStatus,
  to: ConflictStatus
): boolean {
  return transitions[from].includes(to);
}

export function transitionConflictStatus(
  from: ConflictStatus,
  to: ConflictStatus
): ConflictStatus {
  if (!canTransitionConflict(from, to)) {
    throw new Error(`Invalid conflict transition: ${from} -> ${to}`);
  }
  return to;
}

export function isFinalConflictStatus(status: ConflictStatus): boolean {
  return status === "resolved";
}

/**
 * A conflict still demands human attention while it has not been terminated.
 * This is the single rule shared by the workflow, the report and the UI so that
 * a resolved conflict can never be presented as an open checkpoint.
 */
export function isConflictAwaitingHumanDecision(
  conflict: Pick<Conflict, "humanDecisionRequired" | "status">
): boolean {
  return (
    conflict.humanDecisionRequired &&
    !isFinalConflictStatus(conflict.status)
  );
}

/**
 * Status a conflict must hold once a human ruling has been recorded.
 * `request_more_analysis` is not a ruling on the substance: the conflict goes
 * back to `detected` so the supplement round can re-surface it.
 */
export function nextConflictStatusForDecision(
  action: HumanDecision["action"]
): ConflictStatus {
  return action === "request_more_analysis" ? "detected" : "resolved";
}
