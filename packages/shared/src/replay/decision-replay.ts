import type { Challenge } from "../domain/challenge";
import type { Claim } from "../domain/claim";
import type { Conflict } from "../domain/conflict";
import type { ExecutionEvent } from "../domain/event";
import type { HumanDecision } from "../domain/human-decision";
import {
  SESSION_PHASES,
  type SessionPhase
} from "../workflow/state-machine";

type OperationalStatus = "ACTIVE" | "PAUSED" | "FAILED" | "COMPLETED";

export type ReplayState = {
  phase: SessionPhase;
  operationalStatus: OperationalStatus;
  currentConclusion: string | null;
  claims: Claim[];
  challenges: Challenge[];
  conflicts: Conflict[];
  humanDecisions: HumanDecision[];
  lastSequence: number;
};

type SessionStatePayload = {
  phase?: unknown;
  operationalStatus?: unknown;
  currentConclusion?: unknown;
  humanDecision?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSessionPhase(value: unknown): value is SessionPhase {
  return (
    typeof value === "string" &&
    SESSION_PHASES.includes(value as SessionPhase)
  );
}

function isOperationalStatus(value: unknown): value is OperationalStatus {
  return (
    value === "ACTIVE" ||
    value === "PAUSED" ||
    value === "FAILED" ||
    value === "COMPLETED"
  );
}

function isHumanDecision(value: unknown): value is HumanDecision {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.conflictId === "string"
  );
}

function clonePayload<T>(value: T): T {
  return structuredClone(value);
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) {
    return [...items, next];
  }

  return items.map((item) => (item.id === next.id ? next : item));
}

/**
 * Reconstructs a session snapshot from the durable event stream without
 * mutating the source event array or any event payload.
 */
export class DecisionReplay {
  private readonly events: ExecutionEvent[];

  constructor(events: readonly ExecutionEvent[]) {
    this.events = [...events].sort(
      (left, right) =>
        left.sequence - right.sequence ||
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.id.localeCompare(right.id)
    );
  }

  snapshotAt(sequence: number): ReplayState {
    const state: ReplayState = {
      phase: "CREATED",
      operationalStatus: "ACTIVE",
      currentConclusion: null,
      claims: [],
      challenges: [],
      conflicts: [],
      humanDecisions: [],
      lastSequence: 0
    };

    for (const event of this.events) {
      if (event.sequence > sequence) {
        break;
      }

      switch (event.type) {
        case "SESSION_STATE_CHANGED": {
          const payload = isObject(event.payload)
            ? (event.payload as SessionStatePayload)
            : {};
          if (isSessionPhase(payload.phase)) {
            state.phase = payload.phase;
          }
          if (isOperationalStatus(payload.operationalStatus)) {
            state.operationalStatus = payload.operationalStatus;
          }
          if ("currentConclusion" in payload) {
            state.currentConclusion =
              typeof payload.currentConclusion === "string"
                ? payload.currentConclusion
                : null;
          }
          if (isHumanDecision(payload.humanDecision)) {
            state.humanDecisions = upsertById(
              state.humanDecisions,
              clonePayload(payload.humanDecision)
            );
          }
          break;
        }
        case "CLAIM_CREATED": {
          if (isObject(event.payload)) {
            state.claims = upsertById(
              state.claims,
              clonePayload(event.payload as Claim)
            );
          }
          break;
        }
        case "CHALLENGE_CREATED":
        case "CHALLENGE_RESOLVED": {
          if (isObject(event.payload)) {
            state.challenges = upsertById(
              state.challenges,
              clonePayload(event.payload as Challenge)
            );
          }
          break;
        }
        case "CONFLICT_DETECTED": {
          if (isObject(event.payload)) {
            state.conflicts = upsertById(
              state.conflicts,
              clonePayload(event.payload as Conflict)
            );
          }
          break;
        }
        case "HUMAN_REVIEW_REQUIRED": {
          state.phase = "HUMAN_REVIEW";
          state.operationalStatus = "PAUSED";
          break;
        }
        case "SESSION_COMPLETED": {
          state.phase = "REPORT_READY";
          state.operationalStatus = "COMPLETED";
          if (
            isObject(event.payload) &&
            "currentConclusion" in event.payload &&
            typeof event.payload.currentConclusion === "string"
          ) {
            state.currentConclusion = event.payload.currentConclusion;
          }
          break;
        }
        default:
          break;
      }

      state.lastSequence = event.sequence;
    }

    return {
      ...state,
      claims: [...state.claims],
      challenges: [...state.challenges],
      conflicts: [...state.conflicts],
      humanDecisions: [...state.humanDecisions]
    };
  }
}
