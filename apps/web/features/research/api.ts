import { candidateClaimTypeToClaimType } from "@nexus/shared";
import type {
  CandidateClaimType,
  CandidateDecision,
  CandidateStatus,
  ClaimCandidate,
  ClaimExtractionResult,
  ClaimExtractionRun,
  EvidenceCandidate,
  ExtractionFailureCode,
  AgentRun,
  Challenge,
  Claim,
  ClaimReview,
  ClaimSupportAssessment,
  ClaimSupportSummary,
  CitationIntegrityCheck,
  CitationReviewFailureCode,
  ClaimVerdict,
  ClaimVerdictStatus,
  Conflict,
  Evidence,
  EvidenceGap,
  EvidenceLocatorKind,
  EvidenceLocatorStatus,
  ExecutionEvent,
  Source,
  SourceLink,
  SourceProfile,
  SourceProfileOverride,
  SourceRelation,
  SourceRelationDraft,
  SourceSnapshot,
  SourceAnalysisFailureCode,
  IndependenceSummary,
  ResearchPlanFailureCode,
  ResearchPlanItem,
  ResearchPlanAction,
  ResearchPlanStatus
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
    independentSources: number;
    challenges: number;
    reviews: number;
    agentRuns: number;
  };
  independence: {
    pages: number;
    independentSources: number;
    headline: string;
    groupedSources: number;
    note: string;
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

/**
 * Candidate review — what an analysis proposed and how the researcher ruled.
 *
 * A candidate is a proposal, not material. Accepting one is recorded here; the
 * claim and excerpt themselves are created through `createResearchClaim` and
 * `createEvidence` below, so there is exactly one write path into the domain and
 * an accepted excerpt still arrives `unverified` like any other.
 */
export type AnalysisError = { error: string; code?: ExtractionFailureCode };

export type AcceptCandidateResult = {
  claimId: string;
  evidenceIds: string[];
  verificationStatuses: Evidence["verificationStatus"][];
};

export class AnalysisFailedError extends Error {
  constructor(
    message: string,
    readonly code?: ExtractionFailureCode
  ) {
    super(message);
    this.name = "AnalysisFailedError";
  }
}

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

/**
 * Why this route gets its own fetch instead of the shared `request()`.
 *
 * A failed analysis carries a machine-readable `code` alongside its message, so
 * the workspace can say "the model timed out, try again" rather than a bare
 * error. Losing that code would turn a retryable failure into a dead end.
 */
async function requestWithFailureCode<T>(
  path: string,
  init: RequestInit & { idempotencyKey?: string }
): Promise<T> {
  const { idempotencyKey, ...rest } = init;
  // Same rule as `request()`: a POST with no body must not claim a JSON
  // content-type, or the API answers 400 before the route is ever reached.
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
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      code?: ExtractionFailureCode;
    } | null;
    throw new AnalysisFailedError(
      payload?.error ?? `Request failed: ${response.status}`,
      payload?.code
    );
  }
  return response.json() as Promise<T>;
}

/**
 * Asks the backend to read the saved capture and propose claims.
 *
 * Safe to call twice: the server recognises an identical question and returns
 * the earlier answer instead of producing a second copy of the same candidates.
 */
export function extractClaims(
  sessionId: string,
  sourceId: string
): Promise<ClaimExtractionResult> {
  return requestWithFailureCode<ClaimExtractionResult>(
    `/api/sessions/${encodeURIComponent(sessionId)}/sources/${encodeURIComponent(sourceId)}/extract-claims`,
    { method: "POST", idempotencyKey: idempotencyKey("claim-extraction") }
  );
}

export function listExtractionRuns(
  sessionId: string,
  sourceId: string
): Promise<{ runs: ClaimExtractionRun[] }> {
  const query = new URLSearchParams({ sourceId });
  return request<{ runs: ClaimExtractionRun[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/extraction-runs?${query}`
  );
}

export function getExtractionRun(
  sessionId: string,
  runId: string
): Promise<ClaimExtractionResult> {
  return request<ClaimExtractionResult>(
    `/api/sessions/${encodeURIComponent(sessionId)}/extraction-runs/${encodeURIComponent(runId)}`
  );
}

/** Records the ruling only; see `acceptClaimCandidate` for the writes. */
export function recordCandidateDecisions(
  sessionId: string,
  runId: string,
  decisions: CandidateDecision[]
): Promise<ClaimExtractionResult> {
  return request<ClaimExtractionResult>(
    `/api/sessions/${encodeURIComponent(sessionId)}/extraction-runs/${encodeURIComponent(runId)}/decisions`,
    {
      method: "POST",
      body: JSON.stringify({ decisions }),
      idempotencyKey: idempotencyKey("candidate-decisions")
    }
  );
}

/**
 * Turns one candidate claim into a real claim, plus an excerpt for each of its
 * candidate excerpts that the researcher kept.
 *
 * Every idempotency key is derived from the candidate id, so pressing "accept"
 * twice cannot create two claims — the second call replays the first response.
 * The excerpt is fingerprinted by the server against the stored capture, so an
 * accepted quote is recorded as located only if it really is there. Neither step
 * verifies it; that stays a separate human act.
 */
export async function acceptClaimCandidate(input: {
  sessionId: string;
  candidate: ClaimCandidate;
  statement: string;
  evidence: EvidenceCandidate[];
  sourceTitle: string;
  snapshotHash: string | null;
}): Promise<AcceptCandidateResult> {
  const { sessionId, candidate, statement, evidence, sourceTitle, snapshotHash } =
    input;
  const { claim } = await createResearchClaimRaw(
    sessionId,
    {
      statement,
      lens: "research",
      type: candidateClaimTypeToClaimType(candidate.type),
      stance: "neutral",
      importance: candidate.suggestedImportance
    },
    `extract-claim-${candidate.id}`
  );

  const evidenceIds: string[] = [];
  const verificationStatuses: Evidence["verificationStatus"][] = [];
  for (const item of evidence) {
    const created = await createEvidenceRaw(
      sessionId,
      {
        kind: "external_reference",
        title: item.title,
        content: item.excerpt,
        description: `由 AI 辅助分析从《${sourceTitle}》提出${
          snapshotHash ? `（版本 ${snapshotHash.slice(0, 8)}）` : ""
        }，尚未核实`,
        sourceId: candidate.sourceId,
        locatorKind: "quote",
        anchorText: item.excerpt,
        direction: item.direction,
        reliability: item.suggestedReliability,
        claimIds: [claim.id]
      },
      `extract-evidence-${item.id}`
    );
    evidenceIds.push(created.evidence.id);
    verificationStatuses.push(created.evidence.verificationStatus);
  }

  return { claimId: claim.id, evidenceIds, verificationStatuses };
}

/**
 * Same as `acceptClaimCandidate`, but attaches the excerpt to a claim the
 * researcher already has rather than creating a new one.
 */
export async function acceptEvidenceCandidate(input: {
  sessionId: string;
  claimId: string;
  candidate: EvidenceCandidate;
  sourceTitle: string;
  snapshotHash: string | null;
}): Promise<{ evidenceId: string; verificationStatus: Evidence["verificationStatus"] }> {
  const { sessionId, claimId, candidate, sourceTitle, snapshotHash } = input;
  const created = await createEvidenceRaw(
    sessionId,
    {
      kind: "external_reference",
      title: candidate.title,
      content: candidate.excerpt,
      description: `由 AI 辅助分析从《${sourceTitle}》提出${
        snapshotHash ? `（版本 ${snapshotHash.slice(0, 8)}）` : ""
      }，尚未核实`,
      sourceId: candidate.sourceId,
      locatorKind: "quote",
      anchorText: candidate.excerpt,
      direction: candidate.direction,
      reliability: candidate.suggestedReliability,
      claimIds: [claimId]
    },
    `extract-evidence-${candidate.id}`
  );
  return {
    evidenceId: created.evidence.id,
    verificationStatus: created.evidence.verificationStatus
  };
}

function createResearchClaimRaw(
  sessionId: string,
  command: CreateClaimCommand,
  key: string
): Promise<{ claim: Claim; event: ExecutionEvent }> {
  return request<{ claim: Claim; event: ExecutionEvent }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/claims`,
    {
      method: "POST",
      body: JSON.stringify(command),
      idempotencyKey: key
    }
  );
}

function createEvidenceRaw(
  sessionId: string,
  command: CreateEvidenceCommand,
  key: string
): Promise<{ evidence: Evidence; event: ExecutionEvent }> {
  return request<{ evidence: Evidence; event: ExecutionEvent }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/evidence`,
    {
      method: "POST",
      body: JSON.stringify(command),
      idempotencyKey: key
    }
  );
}

/* ------------------------------------------------------------------ *
 * Citation integrity (A) and claim-evidence support (B)
 * ------------------------------------------------------------------ */

export type CitationReviewSnapshot = {
  checks: CitationIntegrityCheck[];
  assessments: ClaimSupportAssessment[];
  summaries: ClaimSupportSummary[];
};

export type CitationHistoryResponse = {
  kind: "integrity" | "support";
  items: CitationIntegrityCheck[] | ClaimSupportAssessment[];
};

export class CitationReviewFailedError extends Error {
  constructor(
    message: string,
    readonly code?: CitationReviewFailureCode
  ) {
    super(message);
    this.name = "CitationReviewFailedError";
  }
}

/**
 * Same contract as `requestWithFailureCode`, for the citation endpoints: a
 * body-less POST must not declare a JSON content-type, and a failure carries
 * the server's own failure code so the UI can say what to do next.
 */
async function requestWithCitationCode<T>(
  path: string,
  init: RequestInit & { idempotencyKey?: string }
): Promise<T> {
  const { idempotencyKey: key, ...rest } = init;
  const hasBody = rest.body !== undefined && rest.body !== null;
  const response = await fetch(`${apiUrl}${path}`, {
    cache: "no-store",
    ...rest,
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(key ? { "idempotency-key": key } : {}),
      ...(rest.headers ?? {})
    }
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      code?: CitationReviewFailureCode;
    } | null;
    throw new CitationReviewFailedError(
      payload?.error ?? `Request failed: ${response.status}`,
      payload?.code
    );
  }
  return response.json() as Promise<T>;
}

/**
 * Re-checks every citation against the stored captures.
 *
 * Deterministic on the server — no model is involved — so this can safely be
 * pressed again after a source is re-fetched.
 */
export function checkCitations(
  sessionId: string,
  evidenceIds?: string[]
): Promise<{ checks: CitationIntegrityCheck[]; event: ExecutionEvent }> {
  return requestWithCitationCode<{
    checks: CitationIntegrityCheck[];
    event: ExecutionEvent;
  }>(`/api/sessions/${encodeURIComponent(sessionId)}/citations/check`, {
    method: "POST",
    ...(evidenceIds && evidenceIds.length > 0
      ? { body: JSON.stringify({ evidenceIds }) }
      : {}),
    idempotencyKey: idempotencyKey("citation-check")
  });
}

/**
 * Asks for a model-assisted reading of how each excerpt bears on one claim.
 *
 * The answer is advice. It cannot verify an excerpt and it cannot change a
 * verdict; the UI says so next to every result.
 */
export function assessClaimSupport(
  sessionId: string,
  claimId: string
): Promise<{
  assessments: ClaimSupportAssessment[];
  summary: ClaimSupportSummary;
  event: ExecutionEvent;
}> {
  return requestWithCitationCode<{
    assessments: ClaimSupportAssessment[];
    summary: ClaimSupportSummary;
    event: ExecutionEvent;
  }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/claims/${encodeURIComponent(claimId)}/support-assessment`,
    {
      method: "POST",
      idempotencyKey: idempotencyKey("support-assessment")
    }
  );
}

export function getCitationReview(
  sessionId: string
): Promise<CitationReviewSnapshot> {
  return request<CitationReviewSnapshot>(
    `/api/sessions/${encodeURIComponent(sessionId)}/citations`
  );
}

export function getCitationHistory(
  sessionId: string,
  input: { kind: "integrity"; evidenceId: string } | {
    kind: "support";
    claimId: string;
    evidenceId: string;
  }
): Promise<CitationHistoryResponse> {
  const query = new URLSearchParams({ kind: input.kind, evidenceId: input.evidenceId });
  if (input.kind === "support") {
    query.set("claimId", input.claimId);
  }
  return request<CitationHistoryResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/citations/history?${query}`
  );
}

/**
 * Records a human correction.
 *
 * The previous conclusion is kept: the server writes a new record that points
 * back at it, so the panel can show what was overridden and by whom.
 */
export function correctCitation(
  sessionId: string,
  command: {
    kind: "integrity" | "support";
    targetId: string;
    status: string;
    rationale: string;
  }
): Promise<{
  check?: CitationIntegrityCheck;
  assessment?: ClaimSupportAssessment;
  event: ExecutionEvent;
}> {
  return requestWithCitationCode<{
    check?: CitationIntegrityCheck;
    assessment?: ClaimSupportAssessment;
    event: ExecutionEvent;
  }>(`/api/sessions/${encodeURIComponent(sessionId)}/citation-corrections`, {
    method: "POST",
    body: JSON.stringify(command),
    idempotencyKey: idempotencyKey("citation-correction")
  });
}

/* ------------------------------------------------------------------ *
 * Source independence
 * ------------------------------------------------------------------ */

export type SourceAnalysisResult = {
  sessionId: string;
  algorithm: string;
  generatedAt: string;
  summary: IndependenceSummary;
  links: SourceLink[];
  profiles: SourceProfile[];
  humanRelations: SourceRelation[];
};

export type SourceRelationHistoryResponse = { items: SourceRelation[] };
export type SourceProfileHistoryResponse = { items: SourceProfileOverride[] };

export class SourceIndependenceFailedError extends Error {
  constructor(
    message: string,
    readonly code?: SourceAnalysisFailureCode
  ) {
    super(message);
    this.name = "SourceIndependenceFailedError";
  }
}

/**
 * Same contract as the other typed failure helpers: a body-less request must
 * not declare a JSON content-type, and a failure carries the server's own code
 * so the panel can say what to do next instead of showing a bare error.
 */
async function requestWithSourceCode<T>(
  path: string,
  init: RequestInit & { idempotencyKey?: string }
): Promise<T> {
  const { idempotencyKey: key, ...rest } = init;
  const hasBody = rest.body !== undefined && rest.body !== null;
  const response = await fetch(`${apiUrl}${path}`, {
    cache: "no-store",
    ...rest,
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(key ? { "idempotency-key": key } : {}),
      ...(rest.headers ?? {})
    }
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      code?: SourceAnalysisFailureCode;
    } | null;
    throw new SourceIndependenceFailedError(
      payload?.error ?? `Request failed: ${response.status}`,
      payload?.code
    );
  }
  return response.json() as Promise<T>;
}

/**
 * The computed reading for a session.
 *
 * Recomputed on the server on every read — nothing is cached here — so pressing
 * this again after importing a source always reflects the current rows.
 */
export function getSourceAnalysis(
  sessionId: string
): Promise<SourceAnalysisResult> {
  return requestWithSourceCode<SourceAnalysisResult>(
    `/api/sessions/${encodeURIComponent(sessionId)}/sources/analysis`,
    {}
  );
}

/**
 * Records a person's ruling about a pair of sources.
 *
 * The previous statement for that pair is kept: the server writes a new row
 * pointing back at it, so the panel can show what was overridden and by whom.
 */
export function declareSourceRelation(
  sessionId: string,
  draft: SourceRelationDraft
): Promise<{ relation: SourceRelation; event: ExecutionEvent }> {
  return requestWithSourceCode<{
    relation: SourceRelation;
    event: ExecutionEvent;
  }>(`/api/sessions/${encodeURIComponent(sessionId)}/source-relations`, {
    method: "POST",
    body: JSON.stringify(draft),
    idempotencyKey: idempotencyKey("source-relation")
  });
}

/** Records a person's override of one source's provenance kind. */
export function overrideSourceProfile(
  sessionId: string,
  draft: { sourceId: string; provenanceKind: string; note: string }
): Promise<{ override: SourceProfileOverride; event: ExecutionEvent }> {
  return requestWithSourceCode<{
    override: SourceProfileOverride;
    event: ExecutionEvent;
  }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/source-profile-overrides`,
    {
      method: "POST",
      body: JSON.stringify(draft),
      idempotencyKey: idempotencyKey("source-profile-override")
    }
  );
}

export function getSourceRelationHistory(
  sessionId: string,
  firstSourceId: string,
  secondSourceId: string
): Promise<SourceRelationHistoryResponse> {
  const query = new URLSearchParams({ firstSourceId, secondSourceId });
  return request<SourceRelationHistoryResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/source-relations/history?${query}`
  );
}

export function getSourceProfileHistory(
  sessionId: string,
  sourceId: string
): Promise<SourceProfileHistoryResponse> {
  const query = new URLSearchParams({ sourceId });
  return request<SourceProfileHistoryResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/source-profile-overrides/history?${query}`
  );
}

/* ------------------------------------------------------------------ *
 * Research plan
 * ------------------------------------------------------------------ */

export type ResearchPlanView = {
  sessionId: string;
  generatedAt: string;
  searchAvailable: boolean;
  items: Array<
    ResearchPlanItem & { availableActions: ResearchPlanAction[] }
  >;
  availableGaps: EvidenceGap[];
  summary: {
    total: number;
    byStatus: Record<ResearchPlanStatus, number>;
    notStarted: number;
    completed: number;
    open: number;
    dismissed: number;
  };
  headline: string;
};

export type PlanItemHistoryResponse = { items: ResearchPlanItem[] };

export class ResearchPlanFailedError extends Error {
  constructor(
    message: string,
    readonly code?: ResearchPlanFailureCode
  ) {
    super(message);
    this.name = "ResearchPlanFailedError";
  }
}

/**
 * Same contract as the other typed failure helpers: a body-less request must
 * not declare a JSON content-type, and a failure carries the server's own
 * failure code so the panel can say what to do next.
 */
async function requestWithPlanCode<T>(
  path: string,
  init: RequestInit & { idempotencyKey?: string }
): Promise<T> {
  const { idempotencyKey: key, ...rest } = init;
  const hasBody = rest.body !== undefined && rest.body !== null;
  const response = await fetch(`${apiUrl}${path}`, {
    cache: "no-store",
    ...rest,
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(key ? { "idempotency-key": key } : {}),
      ...(rest.headers ?? {})
    }
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      code?: ResearchPlanFailureCode;
    } | null;
    throw new ResearchPlanFailedError(
      payload?.error ?? `Request failed: ${response.status}`,
      payload?.code
    );
  }
  return response.json() as Promise<T>;
}

export function getResearchPlan(sessionId: string): Promise<ResearchPlanView> {
  return requestWithPlanCode<ResearchPlanView>(
    `/api/sessions/${encodeURIComponent(sessionId)}/research-plan`,
    {}
  );
}

/** Adds one diagnosed gap to the plan as a queued item. */
export function addToResearchPlan(
  sessionId: string,
  draft: { gapId: string; priority?: number }
): Promise<{ item: ResearchPlanItem; alreadyPlanned: boolean }> {
  return requestWithPlanCode<{
    item: ResearchPlanItem;
    alreadyPlanned: boolean;
  }>(`/api/sessions/${encodeURIComponent(sessionId)}/research-plan`, {
    method: "POST",
    body: JSON.stringify(draft),
    idempotencyKey: idempotencyKey("research-plan-add")
  });
}

/** Rewrites the query skeleton of one item. */
export function editPlanItemQuery(
  sessionId: string,
  itemId: string,
  edit: Record<string, unknown>
): Promise<{ item: ResearchPlanItem }> {
  return requestWithPlanCode<{ item: ResearchPlanItem }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/research-plan/${encodeURIComponent(itemId)}/query`,
    {
      method: "POST",
      body: JSON.stringify(edit),
      idempotencyKey: idempotencyKey("research-plan-query")
    }
  );
}

/** Marks an item not applicable, or closes it. A reason is mandatory. */
export function decidePlanItem(
  sessionId: string,
  itemId: string,
  body: { result: "not_applicable" | "closed"; reason: string }
): Promise<{ item: ResearchPlanItem }> {
  return requestWithPlanCode<{ item: ResearchPlanItem }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/research-plan/${encodeURIComponent(itemId)}/decision`,
    {
      method: "POST",
      body: JSON.stringify(body),
      idempotencyKey: idempotencyKey("research-plan-decision")
    }
  );
}

/** Records what a person actually found, completing the item. */
export function recordPlanOutcome(
  sessionId: string,
  itemId: string,
  body: { summary: string; sourceIds?: string[]; evidenceIds?: string[] }
): Promise<{ item: ResearchPlanItem }> {
  return requestWithPlanCode<{ item: ResearchPlanItem }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/research-plan/${encodeURIComponent(itemId)}/outcome`,
    {
      method: "POST",
      body: JSON.stringify(body),
      idempotencyKey: idempotencyKey("research-plan-outcome")
    }
  );
}

export function listPlanItemHistory(
  sessionId: string,
  gapId: string
): Promise<PlanItemHistoryResponse> {
  const query = new URLSearchParams({ gapId });
  return requestWithPlanCode<PlanItemHistoryResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/research-plan/history?${query}`,
    {}
  );
}

export type {
  CandidateClaimType,
  CandidateDecision,
  CandidateStatus,
  ClaimCandidate,
  ClaimExtractionResult,
  ClaimExtractionRun,
  ClaimSupportAssessment,
  ClaimSupportSummary,
  CitationIntegrityCheck,
  CitationReviewFailureCode,
  EvidenceCandidate,
  ExtractionFailureCode
};