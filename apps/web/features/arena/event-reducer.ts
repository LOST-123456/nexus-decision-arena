import type {
  Claim,
  HumanDecision,
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
  humanDecision?: HumanDecision;
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
        : payload.currentConclusion,
    humanDecisions: payload.humanDecision
      ? putById(current.humanDecisions, payload.humanDecision)
      : current.humanDecisions
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
    case "AGENT_RUN_CANCELLED":
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
    // Evidence changes are not folded incrementally: the workspace reloads the
    // session so the evidence table, verdicts and source list stay accurate.
    case "EVIDENCE_RECORDED":
    case "EVIDENCE_VERIFICATION_CHANGED": {
      return { ...current, lastSequence: event.sequence };
    }
    // Source intake follows the same rule. A retrieval that failed is still an
    // event worth showing, but it must not be read as evidence arriving, and it
    // changes nothing about the debate phase. Monitoring events join them: a
    // check that found drift records work for a person, not material for the
    // debate, and a re-check being closed is likewise a record about work.
    case "SOURCE_REGISTERED":
    case "SOURCE_RETRIEVED":
    case "SOURCE_RETRIEVAL_FAILED":
    case "SOURCE_EXCERPTS_RECHECKED":
    case "SOURCE_CHECK_STARTED":
    case "SOURCE_CHECK_COMPLETED":
    case "SOURCE_CONTENT_CHANGED":
    case "SOURCE_CHECK_FAILED":
    case "REVALIDATION_TASK_CREATED":
    case "REVALIDATION_TASK_RESOLVED": {
      return { ...current, lastSequence: event.sequence };
    }
    // Analysis produces candidates, not material: a result here changes nothing
    // about the debate phase or the verdict inputs, so it must not be folded
    // into the session state any more than a failed retrieval would be.
    case "CLAIM_EXTRACTION_STARTED":
    case "CLAIM_EXTRACTION_COMPLETED":
    case "CLAIM_EXTRACTION_FAILED":
    case "CLAIM_CANDIDATES_DECIDED": {
      return { ...current, lastSequence: event.sequence };
    }
    // Citation checks and support assessments are advisory records about an
    // excerpt. They change neither the phase nor the verdict inputs, so they
    // only advance the replay cursor.
    case "CITATION_INTEGRITY_CHECKED":
    case "SUPPORT_ASSESSMENT_RECORDED":
    case "CITATION_CORRECTION_RECORDED":
    // A person's ruling about how two sources relate, and an override of a
    // source's provenance kind, are append-only research records too. They move
    // neither the phase nor a verdict, so they only advance the replay cursor.
    case "SOURCE_RELATION_RECORDED":
    case "SOURCE_PROFILE_OVERRIDDEN": {
      return { ...current, lastSequence: event.sequence };
    }
    // A human fact-check ruling is an append-only research record. It does not
    // change the debate phase, and the research surfaces re-read it from the
    // backend instead of guessing at it here.
    case "CLAIM_REVIEW_RECORDED": {
      return { ...current, lastSequence: event.sequence };
    }
    // Research-plan records are a person's decisions about work, not material:
    // they move neither the phase nor a verdict, so they only advance the
    // replay cursor. (SEARCH_STARTED/FAILED never fire in this build — there is
    // no controlled search — but the reducer stays exhaustive.)
    case "RESEARCH_PLAN_ITEM_ADDED":
    case "RESEARCH_PLAN_QUERY_EDITED":
    case "RESEARCH_PLAN_SEARCH_STARTED":
    case "RESEARCH_PLAN_SEARCH_FAILED":
    case "RESEARCH_PLAN_OUTCOME_RECORDED":
    case "RESEARCH_PLAN_ITEM_CLOSED": {
      return { ...current, lastSequence: event.sequence };
    }
    // Controlled search produces candidates, not material. A task being created,
    // a search completing or failing, and a candidate being surfaced are
    // research records about work, not about the debate — they move neither the
    // phase nor a verdict, so they only advance the replay cursor. Crucially,
    // these events change nothing that would let a candidate read as verified.
    case "SEARCH_TASK_CREATED":
    case "SEARCH_COMPLETED":
    case "SEARCH_FAILED":
    case "SOURCE_CANDIDATE_FOUND":
    // A saved report version is a record about a document, not about the
    // debate: it freezes what the material supported at one moment and
    // changes neither the phase nor any verdict input. The report surfaces
    // re-read the snapshot list from the backend, so here it only advances
    // the replay cursor.
    case "REPORT_SNAPSHOT_CREATED": {
      return { ...current, lastSequence: event.sequence };
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
