import { candidateClaimTypeToClaimType } from "@nexus/shared";
import { ApiTransportError, fetchJson } from "../../lib/api-transport";
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
  AgentRunView,
  AgentRunDetail,
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
  ResearchPlanStatus,
  ResearchSearchTask,
  ResearchSearchTaskStatus,
  SearchCandidate,
  ResearchSearchFailureCode,
  EvidenceMapGraph,
  SourceFileRecord,
  FileIngestionFailureCode,
  CsvColumnType,
  ReportSnapshotSummary,
  ResearchReportSnapshot,
  ReportVersionDiff,
  ReportDiffEntry,
  ReportDiffEntityType,
  ReportDiffChangeKind,
  ReportDiffCategory,
  ResearchQualityAssessment,
  QualityFinding,
  QualityFindingCategory,
  QualitySeverity,
  ClaimQualityFinding,
  LanguageDetectionResult,
  SupportedLanguageCode,
  TerminologyEntry,
  TranslationFailureCode,
  TranslationFidelityAssessment,
  TranslationRecord,
  TranslationReview,
  LibrarySearchResult,
  LibrarySessionSummary,
  LibrarySourceDetail,
  ShareGrant,
  ShareGrantDraft,
  ShareGrantScope,
  ShareGrantSubjectType,
  SourceCopyRecord
} from "@nexus/shared";
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

export type ResearchSessionState = {
  id: string;
  phase: string;
  operationalStatus: string;
  researchQuestion: string | null;
  currentConclusion: string | null;
  /**
   * The owning project's name, when the server can supply it. The workspace
   * header names the research with it; absent for a session whose project row
   * cannot be read, in which case the header says so instead of inventing one.
   */
  title?: string | null;
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
  /**
   * The read-only research quality assessment this report was generated (or
   * frozen) with. Absent when the assessment is not configured, and — for a
   * stored version — exactly what that version froze, never a fresh reading.
   */
  researchQuality?: ResearchQualityAssessment | undefined;
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

/**
 * The one place a request leaves the browser.
 *
 * A body-less POST must not carry a JSON content-type: the API rejects an
 * empty JSON payload, which would turn a valid action into a 400. Timeout,
 * refused connection and non-2xx are separated in `api-transport`, so a page
 * can tell "the service is down" from "this action was refused" instead of
 * watching one indistinguishable spinner.
 */
async function request<T>(
  path: string,
  init?: RequestInit & { idempotencyKey?: string }
): Promise<T> {
  return fetchJson<T>(`${apiUrl}${path}`, { cache: "no-store", ...init });
}

/**
 * Re-labels a transport failure with the route's own error class, keeping the
 * server's machine-readable `code` so the UI can tell a retryable failure
 * ("the model timed out") from one that can never work ("no provider").
 */
function withCode<E extends Error>(
  error: unknown,
  build: (message: string, code: string | undefined) => E
): Error {
  if (error instanceof ApiTransportError && error.kind === "http") {
    const code =
      typeof error.payload?.code === "string" ? error.payload.code : undefined;
    return build(error.message, code);
  }
  return error instanceof Error ? error : new Error(String(error));
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

/**
 * Reads the Evidence Map: the session's material drawn as a relationship
 * graph. Read-only on both ends — an edge in the graph means "bears on", not
 * "proves", so nothing here can promote a claim's verdict.
 */
export function getEvidenceMap(sessionId: string): Promise<EvidenceMapGraph> {
  return request<EvidenceMapGraph>(
    `/api/sessions/${encodeURIComponent(sessionId)}/evidence-map`
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
  try {
    return await request<T>(path, init);
  } catch (error) {
    throw withCode(error, (message, code) =>
      new AnalysisFailedError(message, code as ExtractionFailureCode | undefined)
    );
  }
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
  try {
    return await request<T>(path, init);
  } catch (error) {
    throw withCode(error, (message, code) =>
      new CitationReviewFailedError(
        message,
        code as CitationReviewFailureCode | undefined
      )
    );
  }
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
  try {
    return await request<T>(path, init);
  } catch (error) {
    throw withCode(error, (message, code) =>
      new SourceIndependenceFailedError(
        message,
        code as SourceAnalysisFailureCode | undefined
      )
    );
  }
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
  try {
    return await request<T>(path, init);
  } catch (error) {
    throw withCode(error, (message, code) =>
      new ResearchPlanFailedError(
        message,
        code as ResearchPlanFailureCode | undefined
      )
    );
  }
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

/* ------------------------------------------------------------------ *
 * Controlled research search
 * ------------------------------------------------------------------ */

export type ResearchSearchTaskView = ResearchSearchTask & {
  candidates: SearchCandidate[];
};

export class ResearchSearchFailedError extends Error {
  constructor(
    message: string,
    readonly code?: ResearchSearchFailureCode
  ) {
    super(message);
    this.name = "ResearchSearchFailedError";
  }
}

/**
 * Same contract as the other typed failure helpers: a body-less request must
 * not declare a JSON content-type, and a failed search carries the server's own
 * code so the panel can say what to do next.
 */
async function requestWithSearchCode<T>(
  path: string,
  init: RequestInit & { idempotencyKey?: string }
): Promise<T> {
  try {
    return await request<T>(path, init);
  } catch (error) {
    throw withCode(error, (message, code) =>
      new ResearchSearchFailedError(
        message,
        code as ResearchSearchFailureCode | undefined
      )
    );
  }
}

/**
 * Creates a search task and runs the controlled search.
 *
 * The task comes back with the candidates the search surfaced — leads, not
 * evidence. Nothing here turns them into verified material; that is a separate
 * human act (approve, then verify the source) the UI makes explicit.
 */
export function createResearchSearchTask(
  sessionId: string,
  draft: {
    planItemId: string;
    query: string;
    purpose: string;
    keywords?: string[];
  }
): Promise<ResearchSearchTaskView> {
  return requestWithSearchCode<ResearchSearchTaskView>(
    `/api/sessions/${encodeURIComponent(sessionId)}/research-search-tasks`,
    {
      method: "POST",
      body: JSON.stringify(draft),
      idempotencyKey: idempotencyKey("research-search")
    }
  );
}

/** Reads a search task with the candidates it surfaced. */
export function getResearchSearchTask(
  sessionId: string,
  taskId: string
): Promise<ResearchSearchTaskView> {
  return requestWithSearchCode<ResearchSearchTaskView>(
    `/api/sessions/${encodeURIComponent(sessionId)}/research-search-tasks/${encodeURIComponent(taskId)}`,
    {}
  );
}

/**
 * Approves a completed task: each candidate becomes a Source.
 *
 * This is the human-in-the-loop step the server enforces — the UI never claims
 * a candidate was "verified" and never auto-creates evidence.
 */
export function approveResearchSearchTask(
  sessionId: string,
  taskId: string
): Promise<{ task: ResearchSearchTask; registeredSourceIds: string[] }> {
  return requestWithSearchCode<{
    task: ResearchSearchTask;
    registeredSourceIds: string[];
  }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/research-search-tasks/${encodeURIComponent(taskId)}/approve`,
    { method: "POST", idempotencyKey: idempotencyKey("research-search-approve") }
  );
}

/** Rejects a task's candidates without registering any source. */
export function rejectResearchSearchTask(
  sessionId: string,
  taskId: string
): Promise<{ task: ResearchSearchTask }> {
  return requestWithSearchCode<{ task: ResearchSearchTask }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/research-search-tasks/${encodeURIComponent(taskId)}/reject`,
    { method: "POST", idempotencyKey: idempotencyKey("research-search-reject") }
  );
}

export type ResearchSearchTaskListItem = ResearchSearchTask & {
  candidateCount: number;
};

/** Lists every search task for the session with candidate counts. */
export function listResearchSearchTasks(
  sessionId: string
): Promise<{ tasks: ResearchSearchTaskListItem[] }> {
  return requestWithSearchCode<{ tasks: ResearchSearchTaskListItem[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/research-search-tasks`,
    {}
  );
}

/* ------------------------------------------------------------------ *
 * Local research files (PDF / DOCX / TXT / Markdown / CSV)
 * ------------------------------------------------------------------ */

/** One row returned when the text of a file is read back. */
export type SourceFileTable = {
  columns: string[];
  columnTypes: CsvColumnType[];
  rows: string[][];
  rowCount: number;
};

export type SourceFileContent = {
  file: SourceFileRecord;
  source: Source | null;
  snapshot: SourceSnapshot | null;
  content: string;
  contentType: string;
  table?: SourceFileTable;
};

export type UploadSourceFileInput = {
  sessionId: string;
  file: File;
  /** Fires with 0–100 while the upload itself runs. */
  onProgress?: (percent: number) => void;
};

export type UploadSourceFileResult = {
  file: SourceFileRecord;
  source: Source | null;
  duplicated: boolean;
};

export class FileIngestionFailedError extends Error {
  constructor(
    message: string,
    readonly code?: FileIngestionFailureCode,
    /** Present when the failure still left a recorded row behind. */
    readonly file?: SourceFileRecord | null
  ) {
    super(message);
    this.name = "FileIngestionFailedError";
  }
}

/**
 * Uploads a local file.
 *
 * Why this one route does not use `fetch`: only XMLHttpRequest reports *upload*
 * progress, and an import that takes a while should say how far along it is
 * rather than sitting silent. Everything else matches the shared client: the
 * file name travels percent-encoded in a header (never as a path), and the row
 * that comes back is whatever the server recorded — including `needs_ocr` and
 * `failed`, which are outcomes rather than errors to swallow.
 */
export function uploadSourceFile(
  input: UploadSourceFileInput
): Promise<UploadSourceFileResult> {
  const { sessionId, file, onProgress } = input;
  const url = `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/files`;
  return new Promise<UploadSourceFileResult>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.setRequestHeader("content-type", "application/octet-stream");
    request.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    request.setRequestHeader(
      "idempotency-key",
      idempotencyKey("file-upload")
    );
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.addEventListener("load", () => {
      const payload = parseBody(request.responseText);
      if (request.status >= 200 && request.status < 300) {
        resolve(payload as UploadSourceFileResult);
        return;
      }
      reject(toFileIngestionError(request.status, payload));
    });
    request.addEventListener("error", () => {
      reject(new Error("上传失败：网络中断，请重试。"));
    });
    request.addEventListener("abort", () => {
      reject(new Error("上传已取消。"));
    });
    request.send(file);
  });
}

/** Same contract as the other typed helpers, scoped to the file failure codes. */
async function requestWithFileCode<T>(
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {}
): Promise<T> {
  try {
    return await request<T>(path, init);
  } catch (error) {
    if (error instanceof ApiTransportError && error.kind === "http") {
      const payload = error.payload ?? {};
      throw toFileIngestionError(error.status ?? 0, {
        ...(typeof payload.error === "string" ? { error: payload.error } : {}),
        ...(typeof payload.code === "string"
          ? { code: payload.code as FileIngestionFailureCode }
          : {}),
        ...(payload.file ? { file: payload.file as SourceFileRecord } : {})
      });
    }
    throw error;
  }
}

function parseBody(text: string): UploadSourceFileResult | {
  error?: string;
  code?: FileIngestionFailureCode;
  file?: SourceFileRecord;
} {
  try {
    return JSON.parse(text) as UploadSourceFileResult;
  } catch {
    return { error: "上传失败：服务器返回的内容无法解析。" };
  }
}

function toFileIngestionError(
  status: number,
  payload: {
    error?: string;
    code?: FileIngestionFailureCode;
    file?: SourceFileRecord;
  }
): FileIngestionFailedError {
  return new FileIngestionFailedError(
    payload.error ?? `Request failed: ${status}`,
    payload.code,
    payload.file ?? null
  );
}

/** Every file imported into the session, newest first. */
export function listSourceFiles(
  sessionId: string
): Promise<{ files: SourceFileRecord[] }> {
  return requestWithFileCode<{ files: SourceFileRecord[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/files`
  );
}

/** Reads one file: what it is, and how its parse settled. */
export function getSourceFile(
  sessionId: string,
  fileId: string
): Promise<{ file: SourceFileRecord }> {
  return requestWithFileCode<{ file: SourceFileRecord }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`
  );
}

/**
 * Reads the text of one file so a person can excerpt from it.
 *
 * Nothing here decides what the text means. Selecting words and saving them is
 * still a separate act — and an excerpt created from this page arrives
 * `unverified` like every other one, because the server decides that, not us.
 */
export function getSourceFileContent(
  sessionId: string,
  fileId: string
): Promise<SourceFileContent> {
  return requestWithFileCode<SourceFileContent>(
    `/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}/content`
  );
}

/** Asks the server to try again to read a file it could not read before. */
export function retrySourceFileParse(
  sessionId: string,
  fileId: string
): Promise<UploadSourceFileResult> {
  return requestWithFileCode<UploadSourceFileResult>(
    `/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}/retry`,
    { method: "POST", idempotencyKey: idempotencyKey("file-retry") }
  );
}

/* ------------------------------------------------------------------ *
 * Immutable report versions (snapshots)
 * ------------------------------------------------------------------ */

/**
 * Every saved version of the report, newest first.
 *
 * A version is a frozen document, not a fingerprint: the list carries what
 * each save recorded (who, when, why, what it covered) so the researcher can
 * pick the one they mean before reading or comparing it.
 */
export function listReportSnapshots(
  sessionId: string
): Promise<{ snapshots: ReportSnapshotSummary[] }> {
  return request<{ snapshots: ReportSnapshotSummary[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/report-snapshots`
  );
}

/**
 * Saves the current report as a new version.
 *
 * The idempotency key is generated here per submit, so a double press or a
 * retried request resolves to the version the first attempt created instead
 * of stacking a second copy. The server attributes the save to its own
 * session; nothing in this call claims who pressed the button.
 */
export function createReportSnapshot(
  sessionId: string,
  changeReason?: string
): Promise<ResearchReportSnapshot> {
  return request<ResearchReportSnapshot>(
    `/api/sessions/${encodeURIComponent(sessionId)}/report-snapshots`,
    {
      method: "POST",
      body: JSON.stringify(changeReason ? { changeReason } : {}),
      idempotencyKey: idempotencyKey("report-snapshot")
    }
  );
}

/**
 * One stored version, payload included.
 *
 * What comes back is what was frozen: reading an old version never rebuilds
 * the report from today's rows, which is the whole point of saving one.
 */
export function getReportSnapshot(
  sessionId: string,
  snapshotId: string
): Promise<ResearchReportSnapshot> {
  return request<ResearchReportSnapshot>(
    `/api/sessions/${encodeURIComponent(sessionId)}/report-snapshots/${encodeURIComponent(snapshotId)}`
  );
}

/**
 * Compares two saved versions.
 *
 * Entities are matched by id server-side and every entry is categorised as a
 * conclusion change or a source-currency change; the two never collapse into
 * one status, so a page that moved can never be read as a verdict that fell.
 */
export function compareReportSnapshots(
  sessionId: string,
  fromSnapshotId: string,
  toSnapshotId: string
): Promise<ReportVersionDiff> {
  const query = new URLSearchParams({
    from: fromSnapshotId,
    to: toSnapshotId
  });
  return request<ReportVersionDiff>(
    `/api/sessions/${encodeURIComponent(sessionId)}/report-snapshots/compare?${query.toString()}`
  );
}

/**
 * Absolute url for exporting one stored version, so it can be a real
 * download link. The body is rendered from the frozen payload, so an export
 * can never mix in material that arrived after the save.
 */
export function reportSnapshotExportUrl(
  sessionId: string,
  snapshotId: string,
  format: "markdown" | "html"
): string {
  return `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/report-snapshots/${encodeURIComponent(
    snapshotId
  )}/export?format=${format}&download=1`;
}

/* ------------------------------------------------------------------ *
 * Agent Operations Center
 * ------------------------------------------------------------------ */

/** Every agent run for the session, newest first, with its role name. */
export function listAgentRuns(
  sessionId: string
): Promise<{ runs: AgentRunView[] }> {
  return request<{ runs: AgentRunView[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/agent-runs`
  );
}

/** One run: its detail, event timeline and the work it produced. */
export function getAgentRun(
  sessionId: string,
  runId: string
): Promise<AgentRunDetail> {
  return request<AgentRunDetail>(
    `/api/sessions/${encodeURIComponent(sessionId)}/agent-runs/${encodeURIComponent(runId)}`
  );
}

/**
 * The server's answer to a cancel request. Three facts, deliberately not one:
 * the row state (`run`, `statusChanged`), whether the answer repeated an earlier
 * cancel (`alreadyCancelled`), and what this process did about the work in
 * flight (`execution`). `execution` never means "the executor stopped" — that is
 * reported separately by the executor as `AGENT_RUN_EXECUTION_STOPPED` in the
 * run's own timeline.
 */
export type AgentRunCancelResult = {
  run: AgentRunView;
  alreadyCancelled: boolean;
  statusChanged: boolean;
  execution: "signal_delivered" | "not_running_here";
  /** The status the row had when the cancel was accepted. */
  previousStatus: AgentRunView["status"];
  reason: string | null;
};

/**
 * Cancels a run.
 *
 * Safe: the server only cancels a run that is still `queued` or `running`; a
 * terminal run (other than one already cancelled) is refused with a 409, and a
 * run from another session is a 404. An already-cancelled run answers 200 again
 * instead of erroring, so a retry after a network blip does not look like a
 * failure. The reason travels with the request and lands in the audit trail —
 * the identity of the caller never comes from here, only from the session.
 */
export function cancelAgentRun(
  sessionId: string,
  runId: string,
  options: { reason?: string } = {}
): Promise<AgentRunCancelResult> {
  const body = options.reason?.trim()
    ? JSON.stringify({ reason: options.reason.trim().slice(0, 500) })
    : undefined;
  return request<AgentRunCancelResult>(
    `/api/sessions/${encodeURIComponent(sessionId)}/agent-runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      ...(body ? { body } : {}),
      idempotencyKey: idempotencyKey("agent-run-cancel")
    }
  );
}

/**
 * Retries a failed cross-review run.
 *
 * The server opens a *new* run (a new id, a higher attempt, a pointer back at
 * the run being retried) and reuses the same cross-examination engine. The
 * response is the same `CrossReviewResult` the panel already knows how to show.
 */
export function retryAgentRun(
  sessionId: string,
  runId: string
): Promise<CrossReviewResult> {
  return request<CrossReviewResult>(
    `/api/sessions/${encodeURIComponent(sessionId)}/agent-runs/${encodeURIComponent(runId)}/retry`,
    { method: "POST", idempotencyKey: idempotencyKey("agent-run-retry") }
  );
}

export type {
  ReportSnapshotSummary,
  ResearchReportSnapshot,
  ReportVersionDiff,
  ReportDiffEntry,
  ReportDiffEntityType,
  ReportDiffChangeKind,
  ReportDiffCategory
};

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

/* ------------------------------------------------------------------ *
 * Research quality assessment
 * ------------------------------------------------------------------ */

/**
 * The read-only quality assessment, plus the two narrower views of it.
 *
 * Every call here is a GET: the assessment is a projection over persisted
 * rows, so the client never sends material to be scored and never sends a
 * claim or evidence id — the server decides the session scope, which is what
 * keeps a cross-session read impossible.
 */

export type ResearchQualityClaimsResponse = {
  sessionId: string;
  assessedAt: string;
  ruleVersion: string;
  claimFindings: ClaimQualityFinding[];
};

export type ResearchQualityFindingsResponse = {
  sessionId: string;
  assessedAt: string;
  ruleVersion: string;
  /** The unfiltered count, so a limited view still says how much there is. */
  total: number;
  findings: QualityFinding[];
};

/**
 * Carries the HTTP status so the panel can tell "no such session" (404) from
 * "the assessment is not configured on this server" (501) from a plain read
 * failure — three different things to do next.
 */
export class ResearchQualityFailedError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ResearchQualityFailedError";
  }
}

async function requestQuality<T>(path: string): Promise<T> {
  try {
    return await request<T>(path);
  } catch (error) {
    if (error instanceof ApiTransportError && error.kind === "http") {
      throw new ResearchQualityFailedError(error.message, error.status ?? 0);
    }
    throw error;
  }
}

/** The full assessment: overall, six dimensions, findings and recommendations. */
export function getResearchQuality(
  sessionId: string
): Promise<ResearchQualityAssessment> {
  return requestQuality<ResearchQualityAssessment>(
    `/api/sessions/${encodeURIComponent(sessionId)}/research-quality`
  );
}

/** Claim-level diagnostics alone, for a claim-oriented reading. */
export function getResearchQualityClaims(
  sessionId: string
): Promise<ResearchQualityClaimsResponse> {
  return requestQuality<ResearchQualityClaimsResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/research-quality/claims`
  );
}

/** The findings list, optionally narrowed by severity or category. */
export function getResearchQualityFindings(
  sessionId: string,
  filter: {
    severity?: QualitySeverity;
    category?: QualityFindingCategory;
    limit?: number;
  } = {}
): Promise<ResearchQualityFindingsResponse> {
  const query = new URLSearchParams();
  if (filter.severity) query.set("severity", filter.severity);
  if (filter.category) query.set("category", filter.category);
  if (typeof filter.limit === "number") {
    query.set("limit", String(filter.limit));
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return requestQuality<ResearchQualityFindingsResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/research-quality/findings${suffix}`
  );
}

/* ------------------------------------------------------------------ *
 * Multilingual research & cross-language verification
 * ------------------------------------------------------------------ */

export class TranslationFailedError extends Error {
  constructor(
    message: string,
    readonly code?: TranslationFailureCode | string
  ) {
    super(message);
    this.name = "TranslationFailedError";
  }
}

/**
 * Same contract as the other typed failure helpers: a body-less request must
 * not declare a JSON content-type, and a failed translation carries the
 * server's own code so the panel can say whether to retry or wait for a
 * provider. A 503 (provider unavailable) is a controlled state, not a crash.
 */
async function requestWithTranslationCode<T>(
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {}
): Promise<T> {
  try {
    return await request<T>(path, init);
  } catch (error) {
    throw withCode(error, (message, code) =>
      new TranslationFailedError(message, code)
    );
  }
}

export type CreateTranslationResult = {
  translation: TranslationRecord;
  fidelity?: TranslationFidelityAssessment;
};

/**
 * Asks the server for an auxiliary translation of a snapshot.
 *
 * The result is a reading aid: `translation.status` may be `unavailable`
 * (no provider configured) or `failed`, in which case the UI says so instead of
 * showing a fabricated translation. A completed translation never verifies any
 * evidence — that remains a separate human act.
 */
export function createSnapshotTranslation(
  sessionId: string,
  input: {
    sourceSnapshotId: string;
    targetLanguage: SupportedLanguageCode;
    segmentIds?: string[];
  }
): Promise<CreateTranslationResult> {
  return requestWithTranslationCode<CreateTranslationResult>(
    `/api/sessions/${encodeURIComponent(sessionId)}/translations`,
    {
      method: "POST",
      body: JSON.stringify(input),
      idempotencyKey: idempotencyKey("translation")
    }
  );
}

export function listTranslations(
  sessionId: string,
  sourceSnapshotId?: string
): Promise<{ translations: TranslationRecord[] }> {
  const query = sourceSnapshotId
    ? `?sourceSnapshotId=${encodeURIComponent(sourceSnapshotId)}`
    : "";
  return request<{ translations: TranslationRecord[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/translations${query}`
  );
}

export function getTranslation(
  sessionId: string,
  translationId: string
): Promise<{ translation: TranslationRecord; reviews: TranslationReview[] }> {
  return request<{ translation: TranslationRecord; reviews: TranslationReview[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/translations/${encodeURIComponent(translationId)}`
  );
}

export type ReviewTranslationInput = {
  action: "approve" | "flag" | "request-retranslation" | "add-correction";
  reviewStatus:
    | "pending"
    | "approved"
    | "flagged"
    | "needs-retranslation"
    | "corrected";
  correctionText?: string;
  note?: string;
};

/** Records a human review of a translation; it never changes evidence. */
export function reviewTranslation(
  sessionId: string,
  translationId: string,
  input: ReviewTranslationInput
): Promise<{ review: TranslationReview }> {
  return requestWithTranslationCode<{ review: TranslationReview }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/translations/${encodeURIComponent(translationId)}/review`,
    {
      method: "POST",
      body: JSON.stringify(input),
      idempotencyKey: idempotencyKey("translation-review")
    }
  );
}

export type SourceLanguageView = {
  sourceId: string;
  sourceSnapshotId: string;
  detection: LanguageDetectionResult;
  storedSourceLanguage: string | null;
};

/** Detects the language of a source's current capture (read-only). */
export function getSourceLanguages(
  sessionId: string,
  sourceId: string
): Promise<SourceLanguageView> {
  return request<SourceLanguageView>(
    `/api/sessions/${encodeURIComponent(sessionId)}/sources/${encodeURIComponent(sourceId)}/languages`
  );
}

export function listTerminology(
  sessionId: string
): Promise<{ entries: TerminologyEntry[] }> {
  return request<{ entries: TerminologyEntry[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/terminology`
  );
}

/** Upserts a glossary entry (suggested and/or confirmed translation). */
export function upsertTerminology(
  sessionId: string,
  input: {
    sourceTerm: string;
    suggestedTranslation?: string | undefined;
    confirmedTranslation?: string | undefined;
    language: SupportedLanguageCode | "unknown" | "mixed" | "undetermined";
    context?: string | undefined;
  }
): Promise<{ entry: TerminologyEntry }> {
  return requestWithTranslationCode<{ entry: TerminologyEntry }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/terminology`,
    {
      method: "POST",
      body: JSON.stringify(input),
      idempotencyKey: idempotencyKey("terminology")
    }
  );
}

/**
 * Cross-research library.
 *
 * A copy keeps its origin and lands in the target research as its own source
 * with its own snapshot; nothing about the origin's human verification travels
 * with it. Unauthorized ids answer 404, so this client never has to guess
 * whether something exists.
 */
export type LibraryCopyOutcome = {
  sourceId: string;
  sessionId: string;
  mode: "copy" | "reference";
  copy: SourceCopyRecord;
};

export type LibraryDuplicateDetail = {
  sourceId: string;
  title: string;
  canonicalUrl: string | null;
  reason: "canonical_url" | "title";
};

export class LibraryFailedError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly duplicate?: LibraryDuplicateDetail
  ) {
    super(message);
    this.name = "LibraryFailedError";
  }
}

/** Same contract as the other typed failure helpers. */
async function requestWithLibraryCode<T>(
  path: string,
  init: RequestInit & { idempotencyKey?: string }
): Promise<T> {
  try {
    return await request<T>(path, init);
  } catch (error) {
    if (error instanceof ApiTransportError && error.kind === "http") {
      const payload = error.payload;
      throw new LibraryFailedError(
        error.message,
        typeof payload?.code === "string" ? payload.code : undefined,
        ...(payload?.duplicate
          ? [payload.duplicate as LibraryDuplicateDetail]
          : [])
      );
    }
    throw error;
  }
}

export type LibrarySearchQuery = {
  query?: string | undefined;
  publisher?: string | undefined;
  author?: string | undefined;
  domain?: string | undefined;
  publishedFrom?: string | undefined;
  publishedTo?: string | undefined;
  language?: string | undefined;
  sessionId?: string | undefined;
  targetSessionId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
};

function libraryQueryString(query: LibrarySearchQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && `${value}`.length > 0) {
      params.set(key, `${value}`);
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

/** Sessions the caller may browse: their own plus the ones shared with them. */
export function listLibrarySessions(): Promise<{
  sessions: LibrarySessionSummary[];
}> {
  return requestWithLibraryCode<{ sessions: LibrarySessionSummary[] }>(
    "/api/library/sessions",
    {}
  );
}

/** Authorized search across researches, with the filters the spec lists. */
export function searchLibrarySources(
  query: LibrarySearchQuery = {}
): Promise<LibrarySearchResult> {
  return requestWithLibraryCode<LibrarySearchResult>(
    `/api/library/sources${libraryQueryString(query)}`,
    {}
  );
}

/** The original source with its immutable version history. */
export function getLibrarySource(sourceId: string): Promise<LibrarySourceDetail> {
  return requestWithLibraryCode<LibrarySourceDetail>(
    `/api/library/sources/${encodeURIComponent(sourceId)}`,
    {}
  );
}

/** One capture's text, for reading what is about to be copied. */
export function readLibrarySnapshot(
  sourceId: string,
  snapshotId: string
): Promise<{ snapshotId: string; content: string; contentHash: string }> {
  return requestWithLibraryCode<{
    snapshotId: string;
    content: string;
    contentHash: string;
  }>(
    `/api/library/sources/${encodeURIComponent(sourceId)}/snapshots/${encodeURIComponent(snapshotId)}`,
    {}
  );
}

/** Grants a user or a role the right to browse one research's material. */
export function createShareGrant(
  draft: ShareGrantDraft
): Promise<ShareGrant> {
  return requestWithLibraryCode<ShareGrant>("/api/library/grants", {
    method: "POST",
    body: JSON.stringify(draft),
    idempotencyKey: idempotencyKey("share-grant")
  });
}

export function listShareGrants(
  sessionId: string
): Promise<{ grants: ShareGrant[] }> {
  return requestWithLibraryCode<{ grants: ShareGrant[] }>(
    `/api/library/grants?sessionId=${encodeURIComponent(sessionId)}`,
    {}
  );
}

/** Revokes a live grant; the row and the copies it produced both stay. */
export function revokeShareGrant(
  grantId: string,
  reason: string
): Promise<ShareGrant> {
  return requestWithLibraryCode<ShareGrant>(
    `/api/library/grants/${encodeURIComponent(grantId)}/revoke`,
    {
      method: "POST",
      body: JSON.stringify({ reason }),
      idempotencyKey: idempotencyKey("share-grant-revoke")
    }
  );
}

/** Copies a library source into this research as an independent source. */
export function copyLibrarySource(
  targetSessionId: string,
  command: {
    sourceSessionId: string;
    sourceId: string;
    mode?: "copy" | "reference";
  }
): Promise<LibraryCopyOutcome> {
  return requestWithLibraryCode<LibraryCopyOutcome>(
    `/api/sessions/${encodeURIComponent(targetSessionId)}/library/copies`,
    {
      method: "POST",
      body: JSON.stringify({ mode: "copy", ...command }),
      idempotencyKey: idempotencyKey("library-copy")
    }
  );
}

/** Copy lineage for one research's sources, with the live origin status. */
export function getCopyLineage(
  sessionId: string
): Promise<{ lineage: Record<string, SourceCopyRecord> }> {
  return requestWithLibraryCode<{ lineage: Record<string, SourceCopyRecord> }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/library/lineage`,
    {}
  );
}

/* ------------------------------------------------------------------ *
 * Team collaboration & human review workflow
 * ------------------------------------------------------------------ */

export type TeamMemberRole = "owner" | "editor" | "reviewer" | "viewer";
export type MembershipStatus =
  | "pending"
  | "active"
  | "declined"
  | "removed";
export type WorkItemStatus =
  | "open"
  | "in_progress"
  | "in_review"
  | "completed"
  | "cancelled";
export type CommentTargetType =
  | "claim"
  | "evidence"
  | "source"
  | "conflict"
  | "challenge"
  | "plan_item"
  | "revalidation_task"
  | "report_snapshot"
  | "work_item";
export type ReviewRequestType =
  | "claim_review"
  | "source_review"
  | "report_review"
  | "conflict_review";
export type ReviewRequestTargetType =
  | "claim"
  | "evidence"
  | "source"
  | "conflict"
  | "report_snapshot";
export type ReviewRequestStatus =
  | "open"
  | "in_review"
  | "completed"
  | "cancelled";
export type ReviewDecision = "approved" | "rejected";

export type TeamMember = {
  id: string;
  sessionId: string;
  userId: string;
  role: TeamMemberRole;
  status: MembershipStatus;
  invitedBy: string;
  invitedAt: string;
  joinedAt?: string;
  statusChangedAt: string;
  removedBy?: string;
  removeReason?: string;
  version: number;
  createdAt: string;
};

export type WorkItem = {
  id: string;
  sessionId: string;
  title: string;
  description?: string;
  status: WorkItemStatus;
  assigneeUserId?: string;
  targetType?: string;
  targetId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  dueAt?: string;
  version: number;
};

export type Comment = {
  id: string;
  sessionId: string;
  authorUserId: string;
  body: string;
  targetType: CommentTargetType;
  targetId: string;
  parentCommentId?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type ReviewRequest = {
  id: string;
  sessionId: string;
  requestType: ReviewRequestType;
  targetType: ReviewRequestTargetType;
  targetId: string;
  requestedBy: string;
  requestedReviewerUserId?: string;
  status: ReviewRequestStatus;
  assignedReviewerUserId?: string;
  decision?: ReviewDecision;
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type CollaborationActivity = {
  id: string;
  sessionId: string;
  sequence: number;
  correlationId: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
};

/**
 * Carries the HTTP status so the panel can tell "this session does not exist or
 * you are not a collaborator" (404) from "you may not do this" (403) from a
 * concurrent edit (409) — three different things to say to the reader, and a
 * plain `Error` would collapse them into one unhelpful message.
 */
export class CollaborationFailedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CollaborationFailedError";
  }
}

/**
 * Same contract as the other typed failure helpers: a body-less request must
 * not declare a JSON content-type, and a refused action carries the server's
 * own status so the panel can explain why instead of showing a bare failure.
 */
async function requestCollaboration<T>(
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {}
): Promise<T> {
  try {
    return await request<T>(path, init);
  } catch (error) {
    if (error instanceof ApiTransportError && error.kind === "http") {
      throw new CollaborationFailedError(error.message, error.status ?? 0);
    }
    throw error;
  }
}

/** Every member (any status) of the research, newest invite first. */
export function listCollaborationMembers(
  sessionId: string
): Promise<{ members: TeamMember[] }> {
  return requestCollaboration<{ members: TeamMember[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/members`
  );
}

/**
 * Invites a user. Ownership is never granted through this surface, so the
 * highest role offered is `editor`; asking for `owner` is refused by the
 * server. The invitation carries the inviter's identity (never the body), so a
 * member cannot be forged as someone else.
 */
export function inviteCollaborationMember(
  sessionId: string,
  input: { userId: string; role: Exclude<TeamMemberRole, "owner"> }
): Promise<TeamMember> {
  return requestCollaboration<TeamMember>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/members/invite`,
    {
      method: "POST",
      body: JSON.stringify(input),
      idempotencyKey: idempotencyKey("collab-invite")
    }
  );
}

/** The invitee accepts their own pending invitation. */
export function acceptCollaborationInvitation(
  sessionId: string,
  userId: string
): Promise<TeamMember> {
  return requestCollaboration<TeamMember>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/members/${encodeURIComponent(userId)}/accept`,
    { method: "POST", idempotencyKey: idempotencyKey("collab-accept") }
  );
}

/** The invitee declines their own pending invitation. */
export function declineCollaborationInvitation(
  sessionId: string,
  userId: string
): Promise<TeamMember> {
  return requestCollaboration<TeamMember>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/members/${encodeURIComponent(userId)}/decline`,
    { method: "POST", idempotencyKey: idempotencyKey("collab-decline") }
  );
}

/** Owner only: changes a live member's role (never to owner). */
export function changeCollaborationRole(
  sessionId: string,
  userId: string,
  role: Exclude<TeamMemberRole, "owner">
): Promise<TeamMember> {
  return requestCollaboration<TeamMember>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/members/${encodeURIComponent(userId)}/role`,
    {
      method: "PATCH",
      body: JSON.stringify({ role }),
      idempotencyKey: idempotencyKey("collab-role")
    }
  );
}

/** Owner only: removes a member, recording who and why. */
export function removeCollaborationMember(
  sessionId: string,
  userId: string,
  reason: string
): Promise<TeamMember> {
  return requestCollaboration<TeamMember>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/members/${encodeURIComponent(userId)}/remove`,
    {
      method: "POST",
      body: JSON.stringify({ reason }),
      idempotencyKey: idempotencyKey("collab-remove")
    }
  );
}

/** Every work item for the research, newest update first. */
export function listCollaborationWorkItems(
  sessionId: string
): Promise<{ workItems: WorkItem[] }> {
  return requestCollaboration<{ workItems: WorkItem[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/work-items`
  );
}

/**
 * Creates a work item. The assignee, if named, must be an active member — the
 * server refuses to assign work to someone who cannot see the research.
 */
export function createCollaborationWorkItem(
  sessionId: string,
  input: {
    title: string;
    description?: string;
    assigneeUserId?: string;
    targetType?: string;
    targetId?: string;
    dueAt?: string;
  }
): Promise<WorkItem> {
  return requestCollaboration<WorkItem>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/work-items`,
    {
      method: "POST",
      body: JSON.stringify(input),
      idempotencyKey: idempotencyKey("collab-work-item")
    }
  );
}

/**
 * Updates a work item. Optimistic-locked on `expectedVersion`; a stale edit is a
 * 409, never a silent overwrite.
 */
export function updateCollaborationWorkItem(
  sessionId: string,
  workItemId: string,
  input: {
    title?: string;
    description?: string;
    status?: WorkItemStatus;
    assigneeUserId?: string;
    dueAt?: string;
    expectedVersion: number;
  }
): Promise<WorkItem> {
  return requestCollaboration<WorkItem>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/work-items/${encodeURIComponent(workItemId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
      idempotencyKey: idempotencyKey("collab-work-item-update")
    }
  );
}

/** Every (non-deleted) comment on a target, newest first. */
export function listCollaborationComments(
  sessionId: string,
  targetType: string,
  targetId: string
): Promise<{ comments: Comment[] }> {
  const query = new URLSearchParams({ targetType, targetId });
  return requestCollaboration<{ comments: Comment[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/comments?${query.toString()}`
  );
}

/**
 * Creates a comment. The author is the server identity (never the body), so a
 * comment cannot be forged as another person.
 */
export function createCollaborationComment(
  sessionId: string,
  input: {
    body: string;
    targetType: string;
    targetId: string;
    parentCommentId?: string;
  }
): Promise<Comment> {
  return requestCollaboration<Comment>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/comments`,
    {
      method: "POST",
      body: JSON.stringify(input),
      idempotencyKey: idempotencyKey("collab-comment")
    }
  );
}

/** Soft-deletes a comment. Only the author may delete their own. */
export function deleteCollaborationComment(
  sessionId: string,
  commentId: string,
  expectedVersion: number
): Promise<Comment> {
  return requestCollaboration<Comment>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/comments/${encodeURIComponent(commentId)}?expectedVersion=${expectedVersion}`,
    { method: "DELETE" }
  );
}

/** Every review request for the research, newest first. */
export function listCollaborationReviewRequests(
  sessionId: string
): Promise<{ reviewRequests: ReviewRequest[] }> {
  return requestCollaboration<{ reviewRequests: ReviewRequest[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/review-requests`
  );
}

/**
 * Creates a review request. A request directed at a specific reviewer cannot
 * name the requester (no self-review), and the named reviewer must be a
 * collaborator.
 */
export function createCollaborationReviewRequest(
  sessionId: string,
  input: {
    requestType: ReviewRequestType;
    targetType: ReviewRequestTargetType;
    targetId: string;
    requestedReviewerUserId?: string;
  }
): Promise<ReviewRequest> {
  return requestCollaboration<ReviewRequest>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/review-requests`,
    {
      method: "POST",
      body: JSON.stringify(input),
      idempotencyKey: idempotencyKey("collab-review-request")
    }
  );
}

/** Claims an open review request. The requester may not claim their own. */
export function claimCollaborationReviewRequest(
  sessionId: string,
  reviewRequestId: string
): Promise<ReviewRequest> {
  return requestCollaboration<ReviewRequest>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/review-requests/${encodeURIComponent(reviewRequestId)}/claim`,
    { method: "POST", idempotencyKey: idempotencyKey("collab-claim") }
  );
}

/**
 * Decides a review request. Only the assigned reviewer may decide. The decision
 * is a human sign-off on the artifact — it does not write a claim verdict or a
 * verification status; formal verification still goes through the existing
 * evidence-verification API.
 */
export function decideCollaborationReviewRequest(
  sessionId: string,
  reviewRequestId: string,
  input: { decision: ReviewDecision; expectedVersion: number }
): Promise<ReviewRequest> {
  return requestCollaboration<ReviewRequest>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/review-requests/${encodeURIComponent(reviewRequestId)}/decide`,
    {
      method: "POST",
      body: JSON.stringify(input),
      idempotencyKey: idempotencyKey("collab-decide")
    }
  );
}

/** Cancels an open review request. The requester or an owner may cancel. */
export function cancelCollaborationReviewRequest(
  sessionId: string,
  reviewRequestId: string
): Promise<ReviewRequest> {
  return requestCollaboration<ReviewRequest>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/review-requests/${encodeURIComponent(reviewRequestId)}/cancel`,
    { method: "POST", idempotencyKey: idempotencyKey("collab-cancel") }
  );
}

/**
 * The activity feed, projected from the shared `executionEvents` table. One
 * audit trail for the whole research, so a collaboration action and a material
 * change are never two different histories.
 */
export function listCollaborationActivity(
  sessionId: string
): Promise<{ activity: CollaborationActivity[] }> {
  return requestCollaboration<{ activity: CollaborationActivity[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/activity`
  );
}
