import type {
  AgentRun,
  Challenge,
  Claim,
  ClaimReview,
  ClaimVerdict,
  ClaimVerdictStatus,
  Conflict,
  Evidence,
  EvidenceGap,
  EvidenceLocatorKind,
  EvidenceLocatorStatus,
  ExecutionEvent,
  Source,
  SourceSnapshot
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
  challenges: number;
  unresolvedChallenges: number;
  reviews: number;
  failedRuns: number;
  verified: number;
  unverified: number;
  rejected: number;
  openVerdicts: number;
  needsMoreEvidence: number;
  blockingGaps: number;
};

export type ResearchWorkspace = {
  session: ResearchSessionState;
  claims: Claim[];
  evidence: Evidence[];
  sources: Source[];
  conflicts: Conflict[];
  challenges: Challenge[];
  agentRuns: AgentRun[];
  reviews: ClaimReview[];
  verdicts: ClaimVerdict[];
  /** Rule-based "what is still missing" diagnoses, each tagged with a claimId. */
  gaps: EvidenceGap[];
  /** Latest ruling per claim whose outcome was `needs_more_evidence`. */
  openReviewRequests: ClaimReview[];
  summary: ResearchSummary;
};

export type CrossReviewRunOutcome = {
  run: AgentRun;
  challenges: Challenge[];
  status: "completed" | "failed";
  failure: string | null;
};

export type CrossReviewResult = {
  sessionId: string;
  claimId: string;
  status: "completed" | "partial" | "failed";
  runs: CrossReviewRunOutcome[];
  challenges: Challenge[];
  responseClaims: Claim[];
  conflicts: Conflict[];
  failures: Array<{ runId: string; roleId: string; reason: string }>;
};

export type RecordReviewCommand = {
  outcome: "confirmed" | "rejected" | "needs_more_evidence";
  rationale: string;
  /**
   * The verdict the reviewer saw when they made the ruling. The server refuses
   * the ruling if the derived verdict has since moved, so a stale page cannot
   * decide a claim nobody actually reviewed.
   */
  expectedVerdictStatus: ClaimVerdictStatus;
  evidenceIds?: string[];
  sourceIds?: string[];
};

/** Structured citation as returned inside the fact-check report. */
export type ReportCitation = {
  evidenceId: string;
  title: string;
  excerpt: string;
  locator: string | null;
  direction: "supports" | "opposes" | "context";
  verificationStatus: "unverified" | "verified" | "rejected";
  reliability: number;
  verifiedBy: string | null;
  verificationNote: string | null;
  source: {
    id: string;
    title: string;
    kind: "url" | "document" | "dataset" | "manual";
    publisher: string | null;
    url: string | null;
    publishedAt: string | null;
  } | null;
  sourceRef: string | null;
  citationStatus: "linked" | "url_only" | "unlinked";
};

export type ReportChallenge = {
  challengeId: string;
  type: Challenge["type"];
  question: string;
  severity: number;
  status: Challenge["status"];
  resolutionStrategy: Challenge["resolutionStrategy"];
  requiredEvidence: string[];
  unverifiedReferences: string[];
  registeredEvidenceIds: string[];
  responseClaimId: string | null;
  challengerRoleId: string;
  challengerRunId: string;
  unresolved: boolean;
  createdAt: string;
};

export type ReportFinding = {
  claimId: string;
  statement: string;
  type: Claim["type"];
  stance: Claim["stance"];
  importance: number;
  claimStatus: Claim["status"];
  verdict: ClaimVerdict;
  review: ClaimReview | null;
  reviewHistory: ClaimReview[];
  supporting: ReportCitation[];
  opposing: ReportCitation[];
  context: ReportCitation[];
  excluded: ReportCitation[];
  challenges: ReportChallenge[];
  runs: AgentRun[];
  /** Rule-based diagnoses of what this claim is still missing. */
  gaps: EvidenceGap[];
  blockingGapCount: number;
};

/** The window the examined material covers, so a stale report is recognisable. */
export type MaterialsTimeRange = {
  publishedAt: { earliest: string | null; latest: string | null };
  validity: { earliestFrom: string | null; latestTo: string | null };
  retrievedAt: { earliest: string | null; latest: string | null };
  empty: boolean;
};

export type FactCheckReport = {
  sessionId: string;
  researchQuestion: string | null;
  generatedAt: string;
  reportVersion: number;
  materialsTimeRange: MaterialsTimeRange;
  materialsFingerprint: string;
  workflow: {
    phase: string;
    operationalStatus: string;
    currentConclusion: string | null;
  };
  scope: {
    claims: number;
    evidence: number;
    sources: number;
    challenges: number;
    reviews: number;
    agentRuns: number;
  };
  summary: {
    byStatus: Record<string, number>;
    openVerdicts: number;
    verified: number;
    unverified: number;
    rejected: number;
    inconclusive: number;
  };
  findings: ReportFinding[];
  crossExamination: {
    runs: AgentRun[];
    failedRuns: AgentRun[];
    challenges: ReportChallenge[];
  };
  gaps: {
    insufficientEvidence: Array<{ claimId: string; statement: string }>;
    unresolvedConflicts: Array<{
      conflictId: string;
      summary: string;
      severity: number;
    }>;
    assumptions: Array<{ claimId: string; statement: string }>;
    unlinkedCitations: Array<{ evidenceId: string; title: string }>;
    evidenceGaps: {
      total: number;
      bySeverity: { blocking: number; important: number; advisory: number };
      byKind: Record<string, number>;
    };
  };
  limits: string[];
  provenance: {
    evidenceIds: string[];
    sourceIds: string[];
    challengeIds: string[];
    agentRunIds: string[];
    reviewIds: string[];
    claimIds: string[];
    lastEventSequence: number;
  };
};

export type EvidenceContext = {
  evidence: Evidence;
  source: Source | null;
  /** The stored page text this excerpt can be checked against, if any. */
  snapshot: SourceSnapshot | null;
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

export type ImportSourceCommand = {
  url: string;
  title?: string;
};

export type ImportSourceResult = {
  source: Source;
  snapshot: SourceSnapshot | null;
  /** True when this capture is a content version that was not stored before. */
  versionCreated: boolean;
  /** True when a source for this page already existed and was refreshed. */
  reused: boolean;
  truncated: boolean;
  redirects: string[];
  finalUrl: string;
};

export type SourceDetailRecord = {
  source: Source;
  snapshots: SourceSnapshot[];
  excerpts: Evidence[];
  currentSnapshotId: string | null;
};

export type RecheckResult = {
  checked: number;
  anchored: number;
  missing: number;
  unchanged: number;
  skipped: number;
  items: Array<{
    evidenceId: string;
    title: string;
    locatorStatus: EvidenceLocatorStatus | undefined;
    verificationStatus: Evidence["verificationStatus"];
    locator: string | null;
    current: boolean;
  }>;
};

export type CreateEvidenceCommand = {
  kind: "project_input" | "calculation" | "external_reference" | "assumption";
  title: string;
  content: string;
  description: string;
  sourceId?: string;
  sourceRef?: string;
  locator?: string;
  locatorKind?: EvidenceLocatorKind;
  /**
   * The exact text selected in the source reader. The server locates it in the
   * stored page text — the client never gets to declare that it was found.
   */
  anchorText?: string;
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
  // A body-less POST must not carry a JSON content-type: the API rejects an
  // empty JSON payload, which would turn a valid action into a 400.
  const hasBody = rest.body !== undefined && rest.body !== null;
  const response = await fetch(`${apiUrl}${path}`, {
    cache: "no-store",
    ...rest,
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      ...(rest.headers ?? {})
    }
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    throw new Error(
      payload?.message ?? payload?.error ?? `Request failed: ${response.status}`
    );
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

/**
 * Sends a url to the server to be read and stored.
 *
 * The import is asynchronous in the sense that the server has to go and fetch
 * the page, so the response reports what actually happened: whether a source
 * already existed for that page, and whether the text was a new version.
 * A refusal (an unsafe target, a non-text page, a timeout) comes back as a
 * non-2xx response whose message explains why; the attempt is still recorded
 * server-side so the workspace can show it.
 */
export function importSource(
  sessionId: string,
  command: ImportSourceCommand
): Promise<ImportSourceResult> {
  return request<ImportSourceResult>(
    `/api/sessions/${encodeURIComponent(sessionId)}/sources/import`,
    {
      method: "POST",
      body: JSON.stringify(command),
      idempotencyKey: idempotencyKey("source-import")
    }
  );
}

/** The stored captures and excerpts of one source. */
export function getSourceDetail(
  sessionId: string,
  sourceId: string
): Promise<SourceDetailRecord> {
  return request<SourceDetailRecord>(
    `/api/sessions/${encodeURIComponent(sessionId)}/sources/${encodeURIComponent(sourceId)}`
  );
}

/**
 * Re-checks every excerpt of a source against its current capture. This is how
 * a page that was rewritten turns a previously fine citation into a visible
 * "cannot be located" marker.
 */
export function recheckSourceExcerpts(
  sessionId: string,
  sourceId: string
): Promise<RecheckResult> {
  return request<RecheckResult>(
    `/api/sessions/${encodeURIComponent(sessionId)}/sources/${encodeURIComponent(sourceId)}/recheck`,
    { method: "POST", idempotencyKey: idempotencyKey("source-recheck") }
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

/**
 * Asks the backend to cross-examine one claim. This starts real agent runs, so
 * it is a write: the response carries per-run status and any failure reason.
 */
export function runCrossReview(
  sessionId: string,
  claimId: string
): Promise<CrossReviewResult> {
  return request<CrossReviewResult>(
    `/api/sessions/${encodeURIComponent(sessionId)}/claims/${encodeURIComponent(claimId)}/cross-review`,
    { method: "POST", idempotencyKey: idempotencyKey("cross-review") }
  );
}

export function listClaimReviews(
  sessionId: string,
  claimId: string
): Promise<{ reviews: ClaimReview[]; latest: ClaimReview | null }> {
  return request<{ reviews: ClaimReview[]; latest: ClaimReview | null }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/claims/${encodeURIComponent(claimId)}/reviews`
  );
}

export function recordClaimReview(
  sessionId: string,
  claimId: string,
  command: RecordReviewCommand
): Promise<{ review: ClaimReview; event: ExecutionEvent }> {
  return request<{ review: ClaimReview; event: ExecutionEvent }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/claims/${encodeURIComponent(claimId)}/reviews`,
    {
      method: "POST",
      body: JSON.stringify(command),
      idempotencyKey: idempotencyKey("claim-review")
    }
  );
}

export function getFactCheckReport(
  sessionId: string
): Promise<FactCheckReport> {
  return request<FactCheckReport>(
    `/api/sessions/${encodeURIComponent(sessionId)}/fact-check-report`
  );
}

/** Absolute url for the Markdown export, so it can be a real download link. */
export function factCheckReportMarkdownUrl(sessionId: string): string {
  return `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/fact-check-report?format=markdown&download=1`;
}
