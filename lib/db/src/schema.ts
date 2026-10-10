import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

const timestampColumn = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    content: text("content").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow()
  },
  (table) => ({
    nameVersion: uniqueIndex("prompt_versions_name_version_idx").on(
      table.name,
      table.version
    )
  })
);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  input: jsonb("input").notNull(),
  locale: text("locale").notNull().default("zh-CN"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow()
});

export const decisionSessions = pgTable("decision_sessions", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  locale: text("locale").notNull(),
  phase: text("phase").notNull(),
  operationalStatus: text("operational_status").notNull(),
  currentConclusion: text("current_conclusion"),
  /** The question under investigation, distinct from the workflow phase. */
  researchQuestion: text("research_question"),
  nextEventSequence: integer("next_event_sequence").notNull().default(1),
  supplementRound: integer("supplement_round").notNull().default(0),
  pauseReason: text("pause_reason"),
  resumePhase: text("resume_phase"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow()
});

export const agentRoles = pgTable("agent_roles", {
  id: uuid("id").primaryKey(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  goal: text("goal").notNull(),
  perspective: text("perspective").notNull(),
  evaluationCriteria: jsonb("evaluation_criteria").notNull(),
  evidenceRequired: jsonb("evidence_required").notNull(),
  conflictPreference: jsonb("conflict_preference").notNull(),
  lenses: jsonb("lenses").notNull(),
  promptVersionId: uuid("prompt_version_id")
    .notNull()
    .references(() => promptVersions.id)
});

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => decisionSessions.id),
  roleId: uuid("role_id")
    .notNull()
    .references(() => agentRoles.id),
  promptVersionId: uuid("prompt_version_id")
    .notNull()
    .references(() => promptVersions.id),
  status: text("status").notNull(),
  correlationId: uuid("correlation_id"),
  traceId: text("trace_id"),
  input: jsonb("input"),
  output: jsonb("output"),
  error: text("error"),
  startedAt: timestampColumn("started_at").notNull().defaultNow(),
  completedAt: timestampColumn("completed_at")
});

export const claims = pgTable("claims", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => decisionSessions.id),
  // Nullable for human-authored research claims: provenance is either an agent
  // run or nothing, and a claim typed in by a researcher has no agent run.
  agentRunId: uuid("agent_run_id").references(() => agentRuns.id),
  roleId: uuid("role_id").references(() => agentRoles.id),
  lens: text("lens").notNull(),
  statement: text("statement").notNull(),
  type: text("type").notNull(),
  stance: text("stance").notNull(),
  importance: integer("importance").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  evidenceIds: jsonb("evidence_ids").notNull(),
  status: text("status").notNull(),
  rootClaimId: uuid("root_claim_id")
    .notNull()
    .references((): AnyPgColumn => claims.id),
  revisionOfClaimId: uuid("revision_of_claim_id").references(
    (): AnyPgColumn => claims.id
  ),
  revision: integer("revision").notNull(),
  relations: jsonb("relations").notNull(),
  respondsToChallengeId: uuid("responds_to_challenge_id").references(
    (): AnyPgColumn => challenges.id
  ),
  disposition: text("disposition"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow()
});

/** Citable provenance record; one source can back many evidence excerpts. */
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    url: text("url"),
    publisher: text("publisher"),
    author: text("author"),
    publishedAt: timestampColumn("published_at"),
    note: text("note"),
    /**
     * Retrieval axis, deliberately separate from evidence verification: it
     * records whether the page itself could be read, not whether anyone has
     * stood behind an excerpt from it.
     */
    canonicalUrl: text("canonical_url"),
    retrievalStatus: text("retrieval_status").notNull().default("not_requested"),
    retrievalAttempts: integer("retrieval_attempts").notNull().default(0),
    retrievedAt: timestampColumn("retrieved_at"),
    retrievalError: text("retrieval_error"),
    contentType: text("content_type"),
    contentHash: text("content_hash"),
    contentBytes: integer("content_bytes"),
    createdBy: text("created_by").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow()
  },
  (table) => ({
    sessionTitle: uniqueIndex("sources_session_title_idx").on(
      table.sessionId,
      table.title
    ),
    // Manual sources carry no canonical url and are exempt, so the index is
    // partial rather than a per-session uniqueness rule over a nullable column.
    sessionCanonicalUrl: uniqueIndex("sources_session_canonical_url_idx")
      .on(table.sessionId, table.canonicalUrl)
      .where(sql`${table.canonicalUrl} IS NOT NULL`)
  })
);

/**
 * An immutable capture of a page at one point in time.
 *
 * Rows are appended, never rewritten: when a page changes, the new capture is
 * added so an excerpt confirmed against the older text can still be re-located,
 * and so a later drift can be attributed to the version it actually matched.
 */
export const sourceSnapshots = pgTable(
  "source_snapshots",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    canonicalUrl: text("canonical_url").notNull(),
    contentHash: text("content_hash").notNull(),
    title: text("title"),
    author: text("author"),
    publisher: text("publisher"),
    publishedAt: timestampColumn("published_at"),
    contentType: text("content_type").notNull(),
    content: text("content").notNull(),
    contentBytes: integer("content_bytes").notNull(),
    charCount: integer("char_count").notNull(),
    retrievedAt: timestampColumn("retrieved_at").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow()
  },
  (table) => ({
    version: uniqueIndex("source_snapshots_version_idx").on(
      table.sourceId,
      table.contentHash
    ),
    sourceRetrieved: index("source_snapshots_source_retrieved_idx").on(
      table.sourceId,
      table.retrievedAt
    )
  })
);

export const evidence = pgTable("evidence", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => decisionSessions.id),
  /** Claims this evidence bears on; one excerpt can bear on several. */
  claimIds: jsonb("claim_ids").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  description: text("description").notNull(),
  sourceId: uuid("source_id").references(() => sources.id),
  sourceRef: text("source_ref"),
  locator: text("locator"),
  /**
   * Where the excerpt sits in the source, and whether it can still be found
   * there. This is a third state axis: a quote can be locatable but unverified,
   * or verified but no longer present in the page it was taken from.
   */
  locatorKind: text("locator_kind"),
  locatorStatus: text("locator_status").notNull().default("unanchored"),
  /** The exact text used to re-find the excerpt inside the source content. */
  anchorText: text("anchor_text"),
  /** Hash of the snapshot this excerpt was confirmed against, for drift. */
  sourceContentHash: text("source_content_hash"),
  direction: text("direction").notNull(),
  reliability: doublePrecision("reliability").notNull(),
  verificationStatus: text("verification_status").notNull(),
  verifiedBy: text("verified_by"),
  verifiedAt: timestampColumn("verified_at"),
  verificationNote: text("verification_note"),
  validityPeriod: jsonb("validity_period"),
  retrievedAt: timestampColumn("retrieved_at").notNull(),
  createdBy: text("created_by").notNull(),
  agentRunId: uuid("agent_run_id").references(() => agentRuns.id)
});

export const challenges = pgTable("challenges", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => decisionSessions.id),
  targetClaimId: uuid("target_claim_id")
    .notNull()
    .references(() => claims.id),
  challengerRunId: uuid("challenger_run_id")
    .notNull()
    .references(() => agentRuns.id),
  challengerRoleId: uuid("challenger_role_id")
    .notNull()
    .references(() => agentRoles.id),
  type: text("type").notNull(),
  question: text("question").notNull(),
  context: jsonb("context").notNull(),
  requiredEvidence: jsonb("required_evidence").notNull(),
  severity: integer("severity").notNull(),
  resolutionStrategy: text("resolution_strategy").notNull(),
  status: text("status").notNull(),
  responseClaimId: uuid("response_claim_id").references(
    (): AnyPgColumn => claims.id
  ),
  correlationId: uuid("correlation_id").notNull(),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow()
});

/** Human fact-check ruling on a single claim. Append-only. */
export const claimReviews = pgTable(
  "claim_reviews",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id),
    outcome: text("outcome").notNull(),
    rationale: text("rationale").notNull(),
    reviewer: text("reviewer").notNull(),
    evidenceIds: jsonb("evidence_ids").notNull(),
    sourceIds: jsonb("source_ids").notNull(),
    verdictStatusAtReview: text("verdict_status_at_review").notNull(),
    verdictConfidenceAtReview: doublePrecision(
      "verdict_confidence_at_review"
    ).notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow()
  },
  (table) => ({
    claim: index("claim_reviews_claim_idx").on(table.claimId, table.createdAt),
    session: index("claim_reviews_session_idx").on(
      table.sessionId,
      table.createdAt
    )
  })
);

export const conflicts = pgTable("conflicts", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => decisionSessions.id),
  claimIds: jsonb("claim_ids").notNull(),
  challengeIds: jsonb("challenge_ids").notNull(),
  type: text("type").notNull(),
  summary: text("summary").notNull(),
  severity: integer("severity").notNull(),
  status: text("status").notNull(),
  humanDecisionRequired: boolean("human_decision_required").notNull(),
  resolutionSuggestion: text("resolution_suggestion").notNull(),
  impactScope: jsonb("impact_scope").notNull(),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow()
});

export const humanDecisions = pgTable("human_decisions", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => decisionSessions.id),
  conflictId: uuid("conflict_id")
    .notNull()
    .references(() => conflicts.id),
  action: text("action").notNull(),
  rationale: text("rationale").notNull(),
  affectedClaimIds: jsonb("affected_claim_ids").notNull(),
  affectedAgentRoleIds: jsonb("affected_agent_role_ids").notNull(),
  previousConclusion: text("previous_conclusion").notNull(),
  newConclusion: text("new_conclusion").notNull(),
  operatorId: text("operator_id").notNull(),
  createdAt: timestampColumn("created_at").notNull().defaultNow()
});

export const finalReports = pgTable(
  "final_reports",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id),
    projectName: text("project_name").notNull(),
    executiveSummary: text("executive_summary").notNull(),
    initialConclusion: text("initial_conclusion").notNull(),
    postChallengeConclusion: text("post_challenge_conclusion").notNull(),
    humanAction: text("human_action").notNull(),
    finalConclusion: text("final_conclusion").notNull(),
    decisionExplanation: text("decision_explanation").notNull(),
    requiredNextActions: jsonb("required_next_actions").notNull(),
    decisiveChallengeIds: jsonb("decisive_challenge_ids").notNull(),
    evidenceIds: jsonb("evidence_ids").notNull(),
    humanDecisionId: uuid("human_decision_id").references(
      () => humanDecisions.id
    ),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow()
  },
  (table) => ({
    session: uniqueIndex("final_reports_session_id_idx").on(table.sessionId)
  })
);

export const executionEvents = pgTable(
  "execution_events",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id),
    sequence: integer("sequence").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    traceId: text("trace_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    promptVersionId: uuid("prompt_version_id").references(
      () => promptVersions.id
    ),
    occurredAt: timestampColumn("occurred_at").notNull()
  },
  (table) => ({
    sessionSequence: uniqueIndex("execution_events_session_sequence_idx").on(
      table.sessionId,
      table.sequence
    )
  })
);

/**
 * Model-proposed material awaiting a human ruling.
 *
 * These tables are deliberately outside the domain: nothing that derives a
 * verdict reads them, so a suggestion cannot change what the research
 * currently concludes. `createdClaimId` / `createdEvidenceId` point *at* the
 * real rows an acceptance produced — they never stand in for them.
 */
export const claimExtractionRuns = pgTable(
  "claim_extraction_runs",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => sourceSnapshots.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputHash: text("input_hash").notNull(),
    promptVersion: text("prompt_version").notNull(),
    segmentationVersion: text("segmentation_version").notNull(),
    charCount: integer("char_count").notNull().default(0),
    segmentCount: integer("segment_count").notNull().default(0),
    candidateClaimCount: integer("candidate_claim_count").notNull().default(0),
    candidateEvidenceCount: integer("candidate_evidence_count")
      .notNull()
      .default(0),
    anchorMatched: integer("anchor_matched").notNull().default(0),
    anchorMissing: integer("anchor_missing").notNull().default(0),
    attempt: integer("attempt").notNull().default(1),
    correlationId: uuid("correlation_id").notNull(),
    createdBy: text("created_by").notNull(),
    startedAt: timestampColumn("started_at").notNull(),
    completedAt: timestampColumn("completed_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow()
  },
  (table) => ({
    input: uniqueIndex("claim_extraction_runs_input_idx").on(
      table.sessionId,
      table.sourceId,
      table.snapshotId,
      table.inputHash
    ),
    source: index("claim_extraction_runs_source_idx").on(
      table.sessionId,
      table.sourceId,
      table.createdAt
    )
  })
);

export const claimCandidates = pgTable(
  "claim_candidates",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => claimExtractionRuns.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => sourceSnapshots.id, { onDelete: "cascade" }),
    segmentIndex: integer("segment_index").notNull(),
    statement: text("statement").notNull(),
    type: text("type").notNull(),
    context: text("context"),
    qualifiers: jsonb("qualifiers").notNull(),
    uncertainty: jsonb("uncertainty").notNull(),
    rationale: text("rationale").notNull(),
    suggestedImportance: integer("suggested_importance").notNull(),
    status: text("status").notNull().default("proposed"),
    createdClaimId: uuid("created_claim_id").references((): AnyPgColumn => claims.id),
    rejectReason: text("reject_reason"),
    decidedBy: text("decided_by"),
    decidedAt: timestampColumn("decided_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow()
  },
  (table) => ({
    run: index("claim_candidates_run_idx").on(table.runId, table.segmentIndex),
    source: index("claim_candidates_source_idx").on(
      table.sessionId,
      table.sourceId,
      table.status
    )
  })
);

export const evidenceCandidates = pgTable(
  "evidence_candidates",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => claimExtractionRuns.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => sourceSnapshots.id, { onDelete: "cascade" }),
    segmentIndex: integer("segment_index").notNull(),
    claimCandidateId: uuid("claim_candidate_id")
      .notNull()
      .references(() => claimCandidates.id, { onDelete: "cascade" }),
    excerpt: text("excerpt").notNull(),
    title: text("title").notNull(),
    direction: text("direction").notNull(),
    locatorKind: text("locator_kind").notNull(),
    /** Decided against the stored capture, never taken from model output. */
    locatorStatus: text("locator_status").notNull(),
    locator: text("locator"),
    anchorText: text("anchor_text"),
    sourceContentHash: text("source_content_hash"),
    suggestedReliability: doublePrecision("suggested_reliability").notNull(),
    rationale: text("rationale").notNull(),
    uncertainty: jsonb("uncertainty").notNull(),
    status: text("status").notNull().default("proposed"),
    createdEvidenceId: uuid("created_evidence_id").references(
      () => evidence.id
    ),
    rejectReason: text("reject_reason"),
    decidedBy: text("decided_by"),
    decidedAt: timestampColumn("decided_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow()
  },
  (table) => ({
    claimCandidate: index("evidence_candidates_claim_candidate_idx").on(
      table.claimCandidateId
    ),
    run: index("evidence_candidates_run_idx").on(
      table.runId,
      table.segmentIndex
    )
  })
);

/**
 * A. Citation integrity — one row per check of one excerpt.
 *
 * The grain is the excerpt, not the claim: whether a quote can still be found
 * in the capture it was taken from is one fact, no matter how many claims it
 * is attached to. Corrections are new rows, so an earlier result is never
 * edited out from under the person who recorded it.
 */
export const citationIntegrityChecks = pgTable(
  "citation_integrity_checks",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => evidence.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => sources.id, {
      onDelete: "set null"
    }),
    snapshotId: uuid("snapshot_id").references(() => sourceSnapshots.id, {
      onDelete: "set null"
    }),
    status: text("status").notNull(),
    matchKind: text("match_kind"),
    anchorText: text("anchor_text"),
    /** Version the excerpt was anchored against, when one was recorded. */
    expectedContentHash: text("expected_content_hash"),
    /** Version of the capture that was actually searched. */
    snapshotContentHash: text("snapshot_content_hash"),
    matchedText: text("matched_text"),
    contextText: text("context_text"),
    reason: text("reason").notNull(),
    origin: text("origin").notNull(),
    actor: text("actor").notNull(),
    supersedesId: uuid("supersedes_id").references(
      (): AnyPgColumn => citationIntegrityChecks.id,
      { onDelete: "set null" }
    ),
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: timestampColumn("created_at").notNull().defaultNow()
  },
  (table) => ({
    current: uniqueIndex("citation_integrity_checks_current_idx")
      .on(table.evidenceId)
      .where(sql`"is_current"`),
    session: index("citation_integrity_checks_session_idx").on(
      table.sessionId,
      table.createdAt
    )
  })
);

/**
 * B. Claim–evidence support — one row per (claim, excerpt) reading.
 *
 * This is advice about how an excerpt bears on a claim, not a verdict and not
 * a verification: nothing writes `evidence.verification_status` from here, and
 * `deriveClaimVerdicts()` cannot see this table.
 */
export const claimSupportAssessments = pgTable(
  "claim_support_assessments",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => evidence.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    rationale: text("rationale").notNull(),
    matchedExcerpt: text("matched_excerpt"),
    /** Server-side: was `matchedExcerpt` actually found in the source text? */
    matchedExcerptLocated: boolean("matched_excerpt_located")
      .notNull()
      .default(false),
    signals: jsonb("signals").notNull().default([]),
    provider: text("provider"),
    model: text("model"),
    promptVersion: text("prompt_version").notNull(),
    origin: text("origin").notNull(),
    actor: text("actor").notNull(),
    supersedesId: uuid("supersedes_id").references(
      (): AnyPgColumn => claimSupportAssessments.id,
      { onDelete: "set null" }
    ),
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: timestampColumn("created_at").notNull().defaultNow()
  },
  (table) => ({
    current: uniqueIndex("claim_support_assessments_current_idx")
      .on(table.claimId, table.evidenceId)
      .where(sql`"is_current"`),
    claim: index("claim_support_assessments_claim_idx").on(
      table.sessionId,
      table.claimId,
      table.createdAt
    ),
    evidence: index("claim_support_assessments_evidence_idx").on(
      table.sessionId,
      table.evidenceId,
      table.createdAt
    )
  })
);

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  requestHash: text("request_hash").notNull(),
  status: text("status").notNull().default("completed"),
  response: jsonb("response"),
  leaseToken: text("lease_token"),
  leaseExpiresAt: timestampColumn("lease_expires_at"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow()
});
