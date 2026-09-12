import {
  SESSION_PHASES,
  type ClaimInspectorDTO,
  type ExecutionEvent,
  type HumanDecision,
  type SessionPhase,
  type SessionView
} from "@nexus/shared";
import type { ReplayableSession } from "./event-reducer";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4100";

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
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/events/stream`
  );
  if (lastEventId > 0) {
    url.searchParams.set("after", String(lastEventId));
  }

  const source = new EventSource(url);
  source.onmessage = (message) =>
    onEvent(JSON.parse(message.data) as ExecutionEvent);
  return () => source.close();
}