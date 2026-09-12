export const SESSION_PHASES = [
  "CREATED",
  "PLANNING",
  "ANALYZING",
  "CHALLENGING",
  "CONFLICT_DETECTED",
  "HUMAN_REVIEW",
  "REASSESSING",
  "DECIDED",
  "REPORT_READY"
] as const;

export type SessionPhase = (typeof SESSION_PHASES)[number];

const transitions: Record<SessionPhase, readonly SessionPhase[]> = {
  CREATED: ["PLANNING"],
  PLANNING: ["ANALYZING"],
  ANALYZING: ["CHALLENGING"],
  CHALLENGING: ["CONFLICT_DETECTED", "DECIDED"],
  CONFLICT_DETECTED: ["HUMAN_REVIEW", "DECIDED"],
  HUMAN_REVIEW: ["REASSESSING", "DECIDED"],
  REASSESSING: ["CHALLENGING", "DECIDED"],
  DECIDED: ["REPORT_READY"],
  REPORT_READY: []
};

export function canTransition(
  from: SessionPhase,
  to: SessionPhase
): boolean {
  return transitions[from].includes(to);
}

export function transitionSession(
  from: SessionPhase,
  to: SessionPhase
): SessionPhase {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid session transition: ${from} -> ${to}`);
  }
  return to;
}
