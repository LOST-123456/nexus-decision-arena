import type {
  Claim,
  Conflict,
  ExecutionEvent,
  SessionPhase,
  SessionView
} from "@nexus/shared";

export type ReplayableSession = SessionView & {
  lastSequence: number;
  pendingEvents?: Record<number, ExecutionEvent>;
};

type SessionStatePayload = {
  phase?: SessionPhase;
  operationalStatus?: ReplayableSession["operationalStatus"];
  currentConclusion?: string | null | undefined;
};

function putById<T extends { id: string }>(items: T[], next: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === next.id);
  if (existingIndex === -1) {
    return [...items, next];
  }

  return items.map((item) => (item.id === next.id ? next : item));
}

function applySessionState(
  current: ReplayableSession,
  payload: SessionStatePayload
): ReplayableSession {
  return {
    ...current,
    phase: payload.phase ?? current.phase,
    operationalStatus:
      payload.operationalStatus ?? current.operationalStatus,
    currentConclusion:
      payload.currentConclusion === undefined
        ? current.currentConclusion
        : payload.currentConclusion
  };
}

function applyContiguousEvent(
  current: ReplayableSession,
  event: ExecutionEvent
): ReplayableSession {
  switch (event.type) {
    case "SESSION_STATE_CHANGED": {
      return {
        ...applySessionState(
          current,
          event.payload as SessionStatePayload
        ),
        lastSequence: event.sequence
      };
    }
    case "AGENT_RUN_STARTED":
    case "AGENT_RUN_COMPLETED":
    case "AGENT_RUN_FAILED":
    case "CHALLENGE_FAILED": {
      return { ...current, lastSequence: event.sequence };
    }
    case "CLAIM_CREATED": {
      const claim = event.payload as Claim;
      return {
        ...current,
        claims: putById(current.claims, claim),
        lastSequence: event.sequence
      };
    }
    case "CHALLENGE_CREATED":
    case "CHALLENGE_RESOLVED": {
      const challenge =
        event.payload as ReplayableSession["challenges"][number];
      return {
        ...current,
        challenges: putById(current.challenges, challenge),
        lastSequence: event.sequence
      };
    }
    case "CONFLICT_DETECTED": {
      const conflict = event.payload as Conflict;
      return {
        ...current,
        conflicts: putById(current.conflicts, conflict),
        lastSequence: event.sequence
      };
    }
    case "HUMAN_REVIEW_REQUIRED": {
      return {
        ...current,
        phase: "HUMAN_REVIEW",
        operationalStatus: "PAUSED",
        lastSequence: event.sequence
      };
    }
    case "SESSION_COMPLETED": {
      const payload = event.payload as SessionStatePayload;
      return {
        ...applySessionState(current, {
          phase: payload.phase ?? "REPORT_READY",
          operationalStatus: "COMPLETED",
          currentConclusion: payload.currentConclusion
        }),
        lastSequence: event.sequence
      };
    }
    default: {
      const exhaustiveEvent: never = event.type;
      void exhaustiveEvent;
      return { ...current, lastSequence: event.sequence };
    }
  }
}

export function reduceSessionEvent(
  current: ReplayableSession,
  event: ExecutionEvent
): ReplayableSession {
  if (event.sessionId !== current.sessionId) {
    return current;
  }

  if (event.sequence <= current.lastSequence) {
    return current;
  }

  const pendingEvents = { ...(current.pendingEvents ?? {}) };
  if (pendingEvents[event.sequence]) {
    return current;
  }

  pendingEvents[event.sequence] = event;
  let next = current;
  let expectedSequence = current.lastSequence + 1;

  while (pendingEvents[expectedSequence]) {
    const pendingEvent = pendingEvents[expectedSequence]!;
    delete pendingEvents[expectedSequence];
    next = applyContiguousEvent(next, pendingEvent);
    expectedSequence += 1;
  }

  return { ...next, pendingEvents };
}
