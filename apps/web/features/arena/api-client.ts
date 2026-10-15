import {
  ExecutionEventTypeSchema,
  SESSION_PHASES,
  type ClaimInspectorDTO,
  type ExecutionEvent,
  type HumanDecision,
  type SessionPhase,
  type SessionView
} from "@nexus/shared";
import { ApiTransportError, fetchJson } from "../../lib/api-transport";
import type { ReplayableSession } from "./event-reducer";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

export type CreateSessionCommand = {
  project: {
    name: string;
    summary: string;
    targetUsers: string;
    businessModel: string;
    expectedData: string;
  };
  locale: "zh-CN" | "en-US";
  /** The question this research has to answer. */
  researchQuestion?: string;
};

export type CreatedSession = {
  id: string;
};

export type RuntimeInfo = {
  mode: "mock" | "openai-compatible";
  provider: string;
  model: string;
};

export type SessionSummary = {
  id: string;
  projectId: string;
  projectName: string;
  phase: string;
  operationalStatus: string;
  currentConclusion: string | null;
  conflictCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  role: "owner" | "reviewer" | "viewer";
};


type SessionPayload = Partial<SessionView> & {
  id?: string;
  nextEventSequence?: number;
  lastSequence?: number;
};

export type HumanDecisionCommand = Pick<
  HumanDecision,
  | "conflictId"
  | "action"
  | "rationale"
  | "affectedClaimIds"
  | "affectedAgentRoleIds"
  | "newConclusion"
  | "operatorId"
>;

export type HumanDecisionResponse = {
  session: SessionPayload & { id: string };
  decision: HumanDecision;
  event: ExecutionEvent;
};

/** Live connection state of the execution-event stream. */
export type EventStreamStatus = "connecting" | "open" | "error";

function isSessionPhase(value: unknown): value is SessionPhase {
  return (
    typeof value === "string" &&
    SESSION_PHASES.includes(value as SessionPhase)
  );
}

function normalizeSession(
  payload: SessionPayload,
  fallbackSessionId: string
): ReplayableSession {
  const persistedSequence =
    payload.lastSequence ??
    (typeof payload.nextEventSequence === "number"
      ? Math.max(0, payload.nextEventSequence - 1)
      : 0);

  return {
    sessionId: payload.sessionId ?? payload.id ?? fallbackSessionId,
    phase: isSessionPhase(payload.phase) ? payload.phase : "CREATED",
    operationalStatus:
      payload.operationalStatus === "PAUSED" ||
      payload.operationalStatus === "FAILED" ||
      payload.operationalStatus === "COMPLETED"
        ? payload.operationalStatus
        : "ACTIVE",
    agents: payload.agents ?? [],
    claims: payload.claims ?? [],
    evidence: payload.evidence ?? [],
    challenges: payload.challenges ?? [],
    conflicts: payload.conflicts ?? [],
    humanDecisions: payload.humanDecisions ?? [],
    currentConclusion:
      typeof payload.currentConclusion === "string"
        ? payload.currentConclusion
        : null,
    lastSequence: persistedSequence
  };
}

export async function createSession(
  command: CreateSessionCommand,
  idempotencyKey: string
): Promise<CreatedSession> {
  const payload = await fetchJson<CreatedSession>(`${apiUrl}/api/sessions`, {
    method: "POST",
    body: JSON.stringify(command),
    idempotencyKey
  });
  if (!payload.id) {
    throw new Error("Create session response did not contain an id");
  }
  return payload;
}

export async function startSession(
  sessionId: string,
  idempotencyKey: string
): Promise<{ id: string; status: string }> {
  return fetchJson<{ id: string; status: string }>(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/start`,
    {
      method: "POST",
      body: "{}",
      idempotencyKey
    }
  );
}

export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  return fetchJson<RuntimeInfo>(`${apiUrl}/api/runtime`, { cache: "no-store" });
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    return await fetchJson<AuthUser>(`${apiUrl}/api/auth/me`, {
      cache: "no-store"
    });
  } catch (error) {
    // Anonymous is the normal answer here, not a failure.
    if (error instanceof ApiTransportError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export async function login(username: string, password: string): Promise<AuthUser> {
  return fetchJson<AuthUser>(`${apiUrl}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
}

export async function logout(): Promise<void> {
  await fetchJson<null>(`${apiUrl}/api/auth/logout`, { method: "POST" });
}

export async function listUsers(): Promise<AuthUser[]> {
  return fetchJson<AuthUser[]>(`${apiUrl}/api/auth/users`, { cache: "no-store" });
}

export async function createUser(command: { username: string; displayName: string; role: AuthUser["role"]; password: string; }): Promise<AuthUser> {
  return fetchJson<AuthUser>(`${apiUrl}/api/auth/users`, {
    method: "POST",
    body: JSON.stringify(command)
  });
}

export async function listSessions(): Promise<SessionSummary[]> {
  return fetchJson<SessionSummary[]>(`${apiUrl}/api/sessions?limit=50`, {
    cache: "no-store"
  });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetchJson<null>(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" }
  );
}

export async function getSession(
  sessionId: string
): Promise<ReplayableSession> {
  const payload = await fetchJson<SessionPayload>(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}`,
    { cache: "no-store" }
  );
  return normalizeSession(payload, sessionId);
}

export async function getInspector(
  sessionId: string,
  claimId: string
): Promise<ClaimInspectorDTO> {
  return fetchJson<ClaimInspectorDTO>(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/claims/${encodeURIComponent(claimId)}/inspector`,
    { cache: "no-store" }
  );
}

export async function getEvents(
  sessionId: string
): Promise<ExecutionEvent[]> {
  return fetchJson<ExecutionEvent[]>(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/events`,
    { cache: "no-store" }
  );
}

export async function submitHumanDecision(
  sessionId: string,
  command: HumanDecisionCommand,
  idempotencyKey: string
): Promise<HumanDecisionResponse> {
  return fetchJson<HumanDecisionResponse>(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/human-decisions`,
    {
      method: "POST",
      body: JSON.stringify(command),
      idempotencyKey
    }
  );
}

/**
 * Opens the execution-event stream.
 *
 * `onStatus` reports the browser's own view of the connection. The browser
 * reconnects by itself, so "error" is a status to show ("live updates paused,
 * reconnecting"), never a reason to tear the subscription down — silently
 * stopping the timeline is how a dead stream looks like a quiet session.
 */
export function subscribeToEvents(
  sessionId: string,
  lastEventId: number,
  onEvent: (event: ExecutionEvent) => void,
  onStatus?: (status: EventStreamStatus) => void
): () => void {
  const url = new URL(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/events/stream`,
    window.location.origin
  );
  if (lastEventId > 0) {
    url.searchParams.set("after", String(lastEventId));
  }

  const source = new EventSource(url);
  const listener = (message: MessageEvent<string>): void => {
    onEvent(JSON.parse(message.data) as ExecutionEvent);
  };
  for (const eventType of ExecutionEventTypeSchema.options) {
    source.addEventListener(eventType, listener as EventListener);
  }
  source.onopen = (): void => {
    onStatus?.("open");
  };
  source.onerror = (): void => {
    onStatus?.("error");
  };

  return () => {
    for (const eventType of ExecutionEventTypeSchema.options) {
      source.removeEventListener(eventType, listener as EventListener);
    }
    source.onopen = null;
    source.onerror = null;
    source.close();
  };
}
