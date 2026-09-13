import {
  ExecutionEventTypeSchema,
  SESSION_PHASES,
  type ClaimInspectorDTO,
  type ExecutionEvent,
  type HumanDecision,
  type SessionPhase,
  type SessionView
} from "@nexus/shared";
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

async function responseError(
  response: Response,
  fallback: string
): Promise<Error> {
  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | null;
  return new Error(payload?.error ?? `${fallback}: ${response.status}`);
}

export async function createSession(
  command: CreateSessionCommand,
  idempotencyKey: string
): Promise<CreatedSession> {
  const response = await fetch(`${apiUrl}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey
    },
    body: JSON.stringify(command)
  });

  if (!response.ok) {
    throw await responseError(response, "Create session request failed");
  }

  const payload = (await response.json()) as CreatedSession;
  if (!payload.id) {
    throw new Error("Create session response did not contain an id");
  }
  return payload;
}

export async function startSession(
  sessionId: string,
  idempotencyKey: string
): Promise<{ id: string; status: string }> {
  const response = await fetch(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/start`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey
      },
      body: "{}"
    }
  );

  if (!response.ok) {
    throw await responseError(response, "Start session request failed");
  }

  return response.json() as Promise<{ id: string; status: string }>;
}

export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  const response = await fetch(`${apiUrl}/api/runtime`, {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Runtime request failed: ${response.status}`);
  }
  return response.json() as Promise<RuntimeInfo>;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const response = await fetch(`${apiUrl}/api/auth/me`, { cache: "no-store" });
  if (response.status === 401) return null;
  if (!response.ok) throw await responseError(response, "Auth request failed");
  return response.json() as Promise<AuthUser>;
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const response = await fetch(`${apiUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  if (!response.ok) throw await responseError(response, "Login failed");
  return response.json() as Promise<AuthUser>;
}

export async function logout(): Promise<void> {
  const response = await fetch(`${apiUrl}/api/auth/logout`, { method: "POST" });
  if (!response.ok) throw await responseError(response, "Logout failed");
}

export async function listUsers(): Promise<AuthUser[]> {
  const response = await fetch(`${apiUrl}/api/auth/users`, { cache: "no-store" });
  if (!response.ok) throw await responseError(response, "User list failed");
  return response.json() as Promise<AuthUser[]>;
}

export async function createUser(command: { username: string; displayName: string; role: AuthUser["role"]; password: string; }): Promise<AuthUser> {
  const response = await fetch(`${apiUrl}/api/auth/users`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
  if (!response.ok) throw await responseError(response, "Create user failed");
  return response.json() as Promise<AuthUser>;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const response = await fetch(`${apiUrl}/api/sessions?limit=50`, { cache: "no-store" });
  if (!response.ok) throw await responseError(response, "List sessions request failed");
  return response.json() as Promise<SessionSummary[]>;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const response = await fetch(`${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  if (!response.ok) throw await responseError(response, "Delete session request failed");
}

export async function getSession(
  sessionId: string
): Promise<ReplayableSession> {
  const response = await fetch(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}`,
    {
      cache: "no-store"
    }
  );
  if (!response.ok) {
    throw new Error(`Session request failed: ${response.status}`);
  }

  const payload = (await response.json()) as SessionPayload;
  return normalizeSession(payload, sessionId);
}

export async function getInspector(
  sessionId: string,
  claimId: string
): Promise<ClaimInspectorDTO> {
  const response = await fetch(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/claims/${encodeURIComponent(claimId)}/inspector`,
    { cache: "no-store" }
  );
  if (!response.ok) {
    throw new Error(`Inspector request failed: ${response.status}`);
  }
  return response.json() as Promise<ClaimInspectorDTO>;
}

export async function getEvents(
  sessionId: string
): Promise<ExecutionEvent[]> {
  const response = await fetch(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/events`,
    { cache: "no-store" }
  );
  if (!response.ok) {
    throw new Error(`Event request failed: ${response.status}`);
  }
  return response.json() as Promise<ExecutionEvent[]>;
}

export async function submitHumanDecision(
  sessionId: string,
  command: HumanDecisionCommand,
  idempotencyKey: string
): Promise<HumanDecisionResponse> {
  const response = await fetch(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/human-decisions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey
      },
      body: JSON.stringify(command)
    }
  );

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(
      payload?.error ?? `Human decision request failed: ${response.status}`
    );
  }

  return response.json() as Promise<HumanDecisionResponse>;
}

export function subscribeToEvents(
  sessionId: string,
  lastEventId: number,
  onEvent: (event: ExecutionEvent) => void
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
  return () => {
    for (const eventType of ExecutionEventTypeSchema.options) {
      source.removeEventListener(eventType, listener as EventListener);
    }
    source.close();
  };
}
