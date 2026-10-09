import type {
  Claim,
  ClaimVerdict,
  Conflict,
  Evidence,
  ExecutionEvent,
  Source
} from "@nexus/shared";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

export type ResearchSessionState = {
  id: string;
  phase: string;
  operationalStatus: string;
  researchQuestion: string | null;
  currentConclusion: string | null;
};

export type ResearchSummary = {
  claims: number;
  evidence: number;
  sources: number;
  verified: number;
  unverified: number;
  rejected: number;
  openVerdicts: number;
};

export type ResearchWorkspace = {
  session: ResearchSessionState;
  claims: Claim[];
  evidence: Evidence[];
  sources: Source[];
  conflicts: Conflict[];
  verdicts: ClaimVerdict[];
  summary: ResearchSummary;
};

export type EvidenceContext = {
  evidence: Evidence;
  source: Source | null;
  claims: Claim[];
  conflicts: Conflict[];
};

export type CreateSourceCommand = {
  title: string;
  kind: "url" | "document" | "dataset" | "manual";
  url?: string;
  publisher?: string;
  author?: string;
  publishedAt?: string;
  note?: string;
};

export type CreateEvidenceCommand = {
  kind: "project_input" | "calculation" | "external_reference" | "assumption";
  title: string;
  content: string;
  description: string;
  sourceId?: string;
  sourceRef?: string;
  locator?: string;
  direction: "supports" | "opposes" | "context";
  reliability: number;
  claimIds: string[];
};

export type UpdateEvidenceCommand = Partial<CreateEvidenceCommand>;

export type VerificationCommand = {
  status: "unverified" | "verified" | "rejected";
  verificationNote: string;
};

export type CreateClaimCommand = {
  statement: string;
  lens?: string;
  type: "fact" | "assumption" | "prediction" | "recommendation";
  stance: "support" | "oppose" | "neutral";
  importance: number;
  confidence?: number;
};

async function request<T>(
  path: string,
  init?: RequestInit & { idempotencyKey?: string }
): Promise<T> {
  const { idempotencyKey, ...rest } = init ?? {};
  const response = await fetch(`${apiUrl}${path}`, {
    cache: "no-store",
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      ...(rest.headers ?? {})
    }
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(payload?.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function idempotencyKey(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}`;
}

export function getResearchWorkspace(
  sessionId: string
): Promise<ResearchWorkspace> {
  return request<ResearchWorkspace>(
    `/api/sessions/${encodeURIComponent(sessionId)}/research`
  );
}

export function listSources(sessionId: string): Promise<{ sources: Source[] }> {
  return request<{ sources: Source[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/sources`
  );
}

export function createSource(
  sessionId: string,
  command: CreateSourceCommand
): Promise<{ source: Source }> {
  return request<{ source: Source }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/sources`,
    {
      method: "POST",
      body: JSON.stringify(command),
      idempotencyKey: idempotencyKey("source")
    }
  );
}

export function listEvidence(
  sessionId: string,
  filter: {
    claimId?: string;
    verificationStatus?: string;
    direction?: string;
  } = {}
): Promise<{ evidence: Evidence[] }> {
  const query = new URLSearchParams();
  if (filter.claimId) query.set("claimId", filter.claimId);
  if (filter.verificationStatus) {
    query.set("verificationStatus", filter.verificationStatus);
  }
  if (filter.direction) query.set("direction", filter.direction);
  const suffix = query.toString();
  return request<{ evidence: Evidence[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/evidence${suffix ? `?${suffix}` : ""}`
  );
}

export function createEvidence(
  sessionId: string,
  command: CreateEvidenceCommand
): Promise<{ evidence: Evidence; event: ExecutionEvent }> {
  return request<{ evidence: Evidence; event: ExecutionEvent }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/evidence`,
    {
      method: "POST",
      body: JSON.stringify(command),
      idempotencyKey: idempotencyKey("evidence")
    }
  );
}

export function updateEvidence(
  sessionId: string,
  evidenceId: string,
  command: UpdateEvidenceCommand
): Promise<{ evidence: Evidence; event: ExecutionEvent }> {
  return request<{ evidence: Evidence; event: ExecutionEvent }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(evidenceId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(command),
      idempotencyKey: idempotencyKey("evidence-update")
    }
  );
}

export function setVerification(
  sessionId: string,
  evidenceId: string,
  command: VerificationCommand
): Promise<{
  evidence: Evidence;
  event: ExecutionEvent;
  verification: { from: string; to: string };
}> {
  return request<{
    evidence: Evidence;
    event: ExecutionEvent;
    verification: { from: string; to: string };
  }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(evidenceId)}/verification`,
    {
      method: "POST",
      body: JSON.stringify(command),
      idempotencyKey: idempotencyKey("verification")
    }
  );
}

export function getEvidenceContext(
  sessionId: string,
  evidenceId: string
): Promise<EvidenceContext> {
  return request<EvidenceContext>(
    `/api/sessions/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(evidenceId)}`
  );
}

export function createResearchClaim(
  sessionId: string,
  command: CreateClaimCommand
): Promise<{ claim: Claim; event: ExecutionEvent }> {
  return request<{ claim: Claim; event: ExecutionEvent }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/claims`,
    {
      method: "POST",
      body: JSON.stringify(command),
      idempotencyKey: idempotencyKey("claim")
    }
  );
}

export function getEvents(sessionId: string): Promise<ExecutionEvent[]> {
  return request<ExecutionEvent[]>(
    `/api/sessions/${encodeURIComponent(sessionId)}/events`
  );
}
