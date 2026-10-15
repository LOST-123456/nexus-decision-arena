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
  /**
   * Who this research belongs to, taken from the server-side login identity
   * when the session was created. NULL marks a legacy workspace session
   * created before ownership existed: its access behaviour is unchanged, and
   * administering its library grants is restricted to the `owner` role rather
   * than guessing an owner after the fact.
   */
  ownerUserId: text("owner_user_id"),
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
  /** Coarse task type; the fine one is `input.kind`. Defaults to "unknown". */
  taskType: text("task_type").notNull().default("unknown"),
  /** Closed failure category, when the executor recorded one. */
  errorCode: text("error_code"),
  provider: text("provider"),
  model: text("model"),
  /** 1-based attempt; retries open a new row with a higher attempt. */
  attempt: integer("attempt").notNull().default(1),
  /** For retries: the run this one re-attempted. Self-reference, declared in
   *  migration 0016 as `REFERENCES agent_runs(id)`; left un-typed here so the
   *  Drizzle table definition does not self-reference and break type inference. */
  parentRunId: uuid("parent_run_id"),
  /** Real token accounting, or null when the executor did not report it. */
  tokenUsage: jsonb("token_usage"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  startedAt: timestampColumn("started_at").notNull().defaultNow(),
  completedAt: timestampColumn("completed_at"),
  /** Wall-clock duration in ms, filled only when the run finishes. */
  durationMs: integer("duration_ms")
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
    /**
     * Original language of the captured text. Nullable so snapshots written
     * before this migration (and any future capture that skips detection) stay
     * valid. Always the *original* language — never a translation target.
     */
    sourceLanguage: text("source_language"),
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

/**
 * A local research file that was uploaded into a session.
 *
 * This row is the *ledger entry* for an uploaded document: its identity
 * (sha256), what the bytes really are, and how the read settled. It never holds
 * the bytes (those live in managed storage) and it never holds the text (that
 * is a `source_snapshots` row once parsing succeeded). Keeping those three
 * apart is why a file can exist without being readable, and why readable text
 * can be cited without a second set of records.
 */
export const sourceFiles = pgTable(
  "source_files",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id),
    /** Set once text exists; stays null for `needs_ocr` and `failed`. */
    sourceId: uuid("source_id").references(() => sources.id, {
      onDelete: "set null"
    }),
    /** As the uploader named it. Display only. */
    fileName: text("file_name").notNull(),
    /** What the client claimed; kept for audit, never trusted. */
    declaredMimeType: text("declared_mime_type").notNull(),
    /** What the server established from the file signature. */
    detectedKind: text("detected_kind").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    parseStatus: text("parse_status").notNull(),
    parseError: text("parse_error"),
    parseStats: jsonb("parse_stats"),
    /** Opaque key into the managed file store — never a filesystem path. */
    storageKey: text("storage_key").notNull(),
    parserVersion: text("parser_version").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow()
  },
  (table) => ({
    sessionHash: uniqueIndex("source_files_session_hash_idx").on(
      table.sessionId,
      table.sha256
    ),
    session: index("source_files_session_idx").on(table.sessionId),
    source: index("source_files_source_idx").on(table.sourceId)
  })
);

/**
 * One monitoring check of a source.
 *
 * Append-only and never a verdict: it records what a check established about
 * the page itself — unchanged, changed, or unreadable — and never touches
 * `sources.retrieval_status` or `evidence.verification_status`. A `changed`
 * row must carry both hashes, so drift can only be recorded where there is a
 * before and an after to point at.
 */
export const sourceChecks = pgTable(
  "source_checks",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    reasonCode: text("reason_code"),
    message: text("message").notNull(),
    previousSnapshotId: uuid("previous_snapshot_id").references(
      () => sourceSnapshots.id,
      { onDelete: "set null" }
    ),
    currentSnapshotId: uuid("current_snapshot_id").references(
      () => sourceSnapshots.id,
      { onDelete: "set null" }
    ),
    previousContentHash: text("previous_content_hash"),
    currentContentHash: text("current_content_hash"),
    httpStatus: integer("http_status"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    newVersionStored: boolean("new_version_stored").notNull().default(false),
    checkedBy: text("checked_by").notNull(),
    checkedAt: timestampColumn("checked_at").notNull().defaultNow(),
    createdAt: timestampColumn("created_at").notNull().defaultNow()
  },
  (table) => ({
    sourceChecked: index("source_checks_source_checked_idx").on(
      table.sourceId,
      table.checkedAt
    ),
    sessionChecked: index("source_checks_session_checked_idx").on(
      table.sessionId,
      table.checkedAt
    )
  })
);

/**
 * A re-check a person owes because a source moved underneath a conclusion.
 *
 * One row per task: the id stays stable across transitions, and every status
 * change is appended to `revalidation_task_events` below, so who closed a task
 * and why is never lost. The unique index on (session, source, trigger hash)
 * is what makes repeated checks idempotent — checking the same version again
 * resolves to the row that is already open instead of opening a second
 * reminder.
 */
export const revalidationTasks = pgTable(
  "revalidation_tasks",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    sourceTitle: text("source_title").notNull(),
    /** Content hash of the version that opened this task. */
    triggerContentHash: text("trigger_content_hash").notNull(),
    previousSnapshotId: uuid("previous_snapshot_id").references(
      () => sourceSnapshots.id,
      { onDelete: "set null" }
    ),
    currentSnapshotId: uuid("current_snapshot_id").references(
      () => sourceSnapshots.id,
      { onDelete: "set null" }
    ),
    affectedEvidenceIds: jsonb("affected_evidence_ids").notNull().default([]),
    affectedClaimIds: jsonb("affected_claim_ids").notNull().default([]),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("open"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
    resolvedAt: timestampColumn("resolved_at"),
    resolvedBy: text("resolved_by"),
    resolutionNote: text("resolution_note")
  },
  (table) => ({
    // One task per version of a source: re-running the same check resolves to
    // the existing row instead of opening a second reminder. The task keeps
    // its id across transitions; the history lives in revalidation_task_events.
    current: uniqueIndex("revalidation_tasks_current_idx").on(
      table.sessionId,
      table.sourceId,
      table.triggerContentHash
    ),
    sessionStatus: index("revalidation_tasks_session_status_idx").on(
      table.sessionId,
      table.status
    ),
    source: index("revalidation_tasks_source_idx").on(table.sourceId)
  })
);

/**
 * Every status change of a re-check, appended.
 *
 * The task row above is updated in place, so this table is the only place the
 * history survives: "who moved this to resolved, and on what grounds" cannot
 * be edited away by a later transition.
 */
export const revalidationTaskEvents = pgTable(
  "revalidation_task_events",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => revalidationTasks.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id),
    /** Null on the event that opened the task. */
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    note: text("note"),
    actor: text("actor").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow()
  },
  (table) => ({
    task: index("revalidation_task_events_task_idx").on(
      table.taskId,
      table.createdAt.desc()
    ),
    session: index("revalidation_task_events_session_idx").on(
      table.sessionId,
      table.createdAt.desc()
    )
  })
);

/**
 * One saved version of the fact-check report.
 *
 * The row is written once and never updated: there is no edit path, and the
 * service exposes none. What makes an old version honest is that it carries
 * its own payload — reading version 2 renders version 2's stored report, not
 * a fresh build over today's rows. `materials_fingerprint` answers "was this
 * built from the same material as that one"; `snapshot_hash` answers "is
 * this the exact payload that was saved".
 *
 * The reference sets record the rows the payload was drawn from so the
 * history list and the diff can be answered without parsing the payload,
 * and so a reader can see which capture each conclusion cited. They are
 * references, not foreign keys: a capture may be cleaned up later, and the
 * reader is told it is gone rather than shown a dangling pointer.
 */
export const researchReportSnapshots = pgTable(
  "research_report_snapshots",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    /** From the server's own session; never from a request body. */
    createdBy: text("created_by").notNull(),
    researchQuestion: text("research_question"),
    /** The shape `reportPayload` was written in; see REPORT_SCHEMA_VERSION. */
    reportSchemaVersion: integer("report_schema_version")
      .notNull()
      .default(1),
    materialsFingerprint: text("materials_fingerprint").notNull(),
    /** sha256 over the canonical form of `reportPayload`. */
    snapshotHash: text("snapshot_hash").notNull(),
    /** The report as built at save time. Never regenerated on read. */
    reportPayload: jsonb("report_payload").notNull(),
    sourceReferences: jsonb("source_references").notNull().default([]),
    evidenceReferences: jsonb("evidence_references").notNull().default([]),
    claimReferences: jsonb("claim_references").notNull().default([]),
    reviewReferences: jsonb("review_references").notNull().default([]),
    monitoringReferences: jsonb("monitoring_references")
      .notNull()
      .default([]),
    /** Why this version was saved, in the saver's own words. */
    changeReason: text("change_reason"),
    /** The idempotency key the save arrived with, when it had one. */
    idempotencyKey: text("idempotency_key")
  },
  (table) => ({
    // One version number per session: a concurrent double-save collides here
    // instead of producing two rows that both claim to be version 3.
    sessionVersion: uniqueIndex(
      "research_report_snapshots_session_version_idx"
    ).on(table.sessionId, table.version),
    // One version per idempotency key: a re-submitted save resolves to the
    // version it already created.
    sessionIdempotency: uniqueIndex(
      "research_report_snapshots_session_idempotency_idx"
    )
      .on(table.sessionId, table.idempotencyKey)
      .where(sql`"idempotency_key" IS NOT NULL`),
    sessionCreated: index("research_report_snapshots_session_created_idx").on(
      table.sessionId,
      table.createdAt.desc()
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

/**
 * Source independence — a person's ruling about a PAIR of sources.
 *
 * Detection is computed on read, so only human assertions live here. The pair is
 * stored canonically (`fromSourceId < toSourceId`) and one current statement per
 * pair is enforced by a partial unique index, so "these two are the same" and
 * "these two are different" can never both be current. Rows are append-only:
 * a correction points back at what it replaced.
 *
 * Nothing in this table is a verdict or a verification.
 */
export const sourceRelations = pgTable(
  "source_relations",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    fromSourceId: uuid("from_source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    toSourceId: uuid("to_source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    basis: text("basis").notNull(),
    similarity: numeric("similarity", { precision: 4, scale: 3 }),
    reason: text("reason").notNull(),
    origin: text("origin").notNull(),
    actor: text("actor").notNull(),
    supersedesId: uuid("supersedes_id").references(
      (): AnyPgColumn => sourceRelations.id,
      { onDelete: "set null" }
    ),
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: timestampColumn("created_at").notNull().defaultNow()
  },
  (table) => ({
    /**
     * The unique index is over the UNORDERED pair (LEAST/GREATEST), so only one
     * current statement exists per pair while each row keeps its direction —
     * which is what makes a reprint or quote chain readable.
     */
    current: uniqueIndex("source_relations_current_idx")
      .on(
        sql`LEAST(${table.fromSourceId}, ${table.toSourceId})`,
        sql`GREATEST(${table.fromSourceId}, ${table.toSourceId})`
      )
      .where(sql`"is_current"`),
    session: index("source_relations_session_idx").on(
      table.sessionId,
      table.createdAt
    )
  })
);

/**
 * Source independence — a person's override of ONE source's provenance kind.
 *
 * Separate table from `source_relations` because the grain is different: this
 * says "this source is first-hand", which is a statement about one row, not
 * about a pair. Append-only with a single current row per source.
 */
export const sourceProfileOverrides = pgTable(
  "source_profile_overrides",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    provenanceKind: text("provenance_kind").notNull(),
    note: text("note").notNull(),
    origin: text("origin").notNull(),
    actor: text("actor").notNull(),
    supersedesId: uuid("supersedes_id").references(
      (): AnyPgColumn => sourceProfileOverrides.id,
      { onDelete: "set null" }
    ),
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: timestampColumn("created_at").notNull().defaultNow()
  },
  (table) => ({
    current: uniqueIndex("source_profile_overrides_current_idx")
      .on(table.sourceId)
      .where(sql`"is_current"`),
    session: index("source_profile_overrides_session_idx").on(
      table.sessionId,
      table.createdAt
    )
  })
);

/**
 * Research plan — what a person decided to do about a diagnosed gap.
 *
 * Gaps are derived on every read and need no table; this holds the part a
 * machine cannot derive: a decision, an owner, and whatever actually came
 * back. Append-only, with one current row per (session, gap) so a refresh
 * cannot duplicate an item a person already closed, and so closing one cannot
 * be undone by re-running the diagnosis.
 */
export const researchPlanItems = pgTable(
  "research_plan_items",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    gapId: text("gap_id").notNull(),
    gapKind: text("gap_kind").notNull(),
    severity: text("severity").notNull(),
    priority: integer("priority").notNull(),
    title: text("title").notNull(),
    question: text("question").notNull(),
    whyInsufficient: jsonb("why_insufficient")
      .notNull()
      .default(sql`'[]'::jsonb`),
    query: jsonb("query").notNull(),
    status: text("status").notNull().default("queued"),
    outcome: jsonb("outcome"),
    decisionReason: text("decision_reason"),
    decidedBy: text("decided_by"),
    failureReason: text("failure_reason"),
    supersedesId: uuid("supersedes_id").references(
      (): AnyPgColumn => researchPlanItems.id,
      { onDelete: "set null" }
    ),
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow()
  },
  (table) => ({
    /** One current item per gap: pressing "加入" twice cannot fork the task. */
    current: uniqueIndex("research_plan_items_current_idx")
      .on(table.sessionId, table.gapId)
      .where(sql`"is_current"`),
    sessionStatus: index("research_plan_items_session_status_idx").on(
      table.sessionId,
      table.status
    ),
    claim: index("research_plan_items_claim_idx").on(table.claimId)
  })
);

/**
 * A controlled search request.
 *
 * The task is a *request*, never a result: it starts 'queued' and the system
 * may only move it to 'searching' then 'completed'/'failed'. The leads it
 * surfaces are kept in `searchCandidates`; approval copies them into `sources`
 * but never into `evidence`. See migrations/0012_research_search_tasks.sql.
 */
export const researchSearchTasks = pgTable(
  "research_search_tasks",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    planItemId: uuid("plan_item_id")
      .notNull()
      .references(() => researchPlanItems.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    purpose: text("purpose").notNull(),
    keywords: jsonb("keywords").notNull().default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("queued"),
    failureReason: text("failure_reason"),
    rejectedAt: timestampColumn("rejected_at"),
    rejectedBy: text("rejected_by"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
    finishedAt: timestampColumn("finished_at")
  },
  (table) => ({
    session: index("research_search_tasks_session_idx").on(table.sessionId),
    planItem: index("research_search_tasks_plan_item_idx").on(
      table.sessionId,
      table.planItemId
    ),
    sessionStatus: index("research_search_tasks_session_status_idx").on(
      table.sessionId,
      table.status
    )
  })
);

/**
 * A lead surfaced by a controlled search.
 *
 * A candidate is NOT a source: it becomes one only when a person approves the
 * task, at which point `registeredSourceId` is stamped. The provenance it must
 * already carry (url, title, publisher, retrievedAt, sourceType) is what makes
 * that transfer pure rather than a silent metadata fabrication.
 */
export const searchCandidates = pgTable(
  "search_candidates",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => researchSearchTasks.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    title: text("title").notNull(),
    publisher: text("publisher").notNull(),
    retrievedAt: timestampColumn("retrieved_at").notNull(),
    sourceType: text("source_type").notNull(),
    note: text("note"),
    approvedAt: timestampColumn("approved_at"),
    registeredSourceId: uuid("registered_source_id").references(
      (): AnyPgColumn => sources.id,
      { onDelete: "set null" }
    ),
    createdAt: timestampColumn("created_at").notNull().defaultNow()
  },
  (table) => ({
    task: index("search_candidates_task_idx").on(table.taskId),
    session: index("search_candidates_session_idx").on(table.sessionId)
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

/**
 * A translation of a source snapshot into a target language.
 *
 * Translations are *derived* data keyed to a specific snapshot version: when a
 * source is re-captured, a new snapshot row is created and its translations are
 * distinct, so an old translation can never masquerade as the current version's.
 * A translation is an auxiliary reading aid only — it never alters the original
 * snapshot text and never verifies an Evidence row.
 */
export const translations = pgTable(
  "translations",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id),
    sourceSnapshotId: uuid("source_snapshot_id")
      .notNull()
      .references(() => sourceSnapshots.id, { onDelete: "cascade" }),
    sourceLanguage: text("source_language").notNull(),
    targetLanguage: text("target_language").notNull(),
    /** Hash of the source text that was translated — part of the dedup key. */
    textHash: text("text_hash").notNull(),
    translatedText: text("translated_text").notNull(),
    segmentMappings: jsonb("segment_mappings").notNull(),
    provider: text("provider").notNull(),
    /** Non-meaningful for the deterministic mock; defaulted to "n/a". */
    model: text("model").notNull().default("n/a"),
    status: text("status").notNull(),
    failureReason: text("failure_reason"),
    failureCode: text("failure_code"),
    createdBy: text("created_by").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow()
  },
  (table) => ({
    // Cache / dedup key per the budget rules: snapshot + languages + textHash +
    // provider + model. Re-translating identical input reuses the row.
    dedup: uniqueIndex("translations_dedup_idx").on(
      table.sourceSnapshotId,
      table.sourceLanguage,
      table.targetLanguage,
      table.textHash,
      table.provider,
      table.model
    ),
    session: index("translations_session_idx").on(table.sessionId)
  })
);

/**
 * An append-only log of human review actions on a translation. A review records
 * what a person decided; it never auto-applies to an Evidence verification
 * state, and it never rewrites the translated text it comments on.
 */
export const translationReviews = pgTable(
  "translation_reviews",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id),
    translationId: uuid("translation_id")
      .notNull()
      .references(() => translations.id, { onDelete: "cascade" }),
    reviewedBy: text("reviewed_by").notNull(),
    action: text("action").notNull(),
    reviewStatus: text("review_status").notNull(),
    correctionText: text("correction_text"),
    note: text("note"),
    createdAt: timestampColumn("created_at").notNull().defaultNow()
  },
  (table) => ({
    translation: index("translation_reviews_translation_idx").on(
      table.translationId
    )
  })
);

/**
 * A session-scoped terminology glossary. One term maps to a suggested and/or a
 * user-confirmed translation; different contexts may warrant different
 * translations, so we do not silently collapse similar terms into one concept.
 */
export const terminology = pgTable(
  "terminology",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id),
    sourceTerm: text("source_term").notNull(),
    suggestedTranslation: text("suggested_translation"),
    confirmedTranslation: text("confirmed_translation"),
    language: text("language").notNull(),
    context: text("context"),
    reviewedAt: timestampColumn("reviewed_at"),
    reviewedBy: text("reviewed_by"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow()
  },
  (table) => ({
    sessionTerm: uniqueIndex("terminology_session_term_idx").on(
      table.sessionId,
      table.sourceTerm
    )
  })
);

/**
 * An explicit authorization to browse another research's material.
 *
 * Material belongs to the session it was collected in; this row is the only
 * thing that makes it visible across the session boundary, and revoking it
 * keeps the row (with who revoked it and why) so the audit trail survives.
 * The partial unique index in migration 0018 allows one live grant per
 * (session, subject, scope).
 */
export const sourceShareGrants = pgTable(
  "source_share_grants",
  {
    id: uuid("id").primaryKey(),
    /** The session whose material is shared — the source side. */
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    /** `user` names one account; `role` names everyone holding that role. */
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    /** `read` and `copy` both permit browsing; recorded so audit can tell. */
    scope: text("scope").notNull(),
    grantedBy: text("granted_by").notNull(),
    grantedAt: timestampColumn("granted_at").notNull().defaultNow(),
    revokedAt: timestampColumn("revoked_at"),
    revokedBy: text("revoked_by"),
    revokeReason: text("revoke_reason")
  },
  (table) => ({
    live: uniqueIndex("source_share_grants_live_idx")
      .on(table.sessionId, table.subjectType, table.subjectId, table.scope)
      .where(sql`${table.revokedAt} IS NULL`),
    subject: index("source_share_grants_subject_idx")
      .on(table.subjectType, table.subjectId)
      .where(sql`${table.revokedAt} IS NULL`)
  })
);

/**
 * The lineage of a source that was copied into this research from another.
 *
 * One row per copied source. It records the origin session, the origin
 * source, the snapshot hash the copy was made from, who copied it and when,
 * and whether the copy has since forked (a recorded fact about the copy,
 * maintained by writes inside this session). The origin's own drift is
 * derived on read and deliberately not stored: a stored "current" would
 * silently become a lie the moment the origin changed.
 */
export const sourceCopies = pgTable(
  "source_copies",
  {
    id: uuid("id").primaryKey(),
    /** The target session and the source inside it. */
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    /**
     * Where the material came from. History, not a dependency: these are plain
     * columns on purpose, because a cascade would delete the target research's
     * audit trail when the origin is removed and a RESTRICT would let an old
     * research block its own deletion forever. See 0018_source_library.sql.
     */
    originSessionId: uuid("origin_session_id").notNull(),
    originSourceId: uuid("origin_source_id").notNull(),
    /** Null for a reference copy: metadata only, no captured text to point at. */
    originSnapshotId: uuid("origin_snapshot_id"),
    originSnapshotHash: text("origin_snapshot_hash"),
    copiedBy: text("copied_by").notNull(),
    copiedAt: timestampColumn("copied_at").notNull().defaultNow(),
    forkState: text("fork_state").notNull().default("synced"),
    forkedAt: timestampColumn("forked_at")
  },
  (table) => ({
    sessionSource: uniqueIndex("source_copies_session_source_idx").on(
      table.sessionId,
      table.sourceId
    ),
    origin: index("source_copies_origin_idx").on(
      table.originSessionId,
      table.originSourceId
    )
  })
);

/**
 * Who collaborates on a research session, and in what capacity.
 *
 * A session-scoped collaboration axis, distinct from the platform-wide
 * `owner`/`reviewer`/`viewer` roles: this is about *working together on one
 * research*, not about platform administration. Exactly one live membership
 * (status `pending` or `active`) exists per (session, user) — the partial
 * unique index below, mirroring migration 0019. Inviting is creating a
 * `pending` membership; accepting promotes it to `active`; the row survives
 * any status change as the audit trail of the relationship.
 *
 * The closed sets on `role` and `status` are enforced by CHECK constraints in
 * migration 0019; drizzle does not re-declare them so the two never drift.
 */
export const researchMemberships = pgTable(
  "research_memberships",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("pending"),
    invitedBy: text("invited_by").notNull(),
    invitedAt: timestampColumn("invited_at").notNull().defaultNow(),
    joinedAt: timestampColumn("joined_at"),
    statusChangedAt: timestampColumn("status_changed_at").notNull().defaultNow(),
    removedBy: text("removed_by"),
    removeReason: text("remove_reason"),
    version: integer("version").notNull().default(1),
    createdAt: timestampColumn("created_at").notNull().defaultNow()
  },
  (table) => ({
    live: uniqueIndex("research_memberships_live_idx")
      .on(table.sessionId, table.userId)
      .where(sql`${table.status} IN ('pending', 'active')`),
    sessionRole: index("research_memberships_session_role_idx")
      .on(table.sessionId, table.role)
      .where(sql`${table.status} = 'active'`),
    user: index("research_memberships_user_idx")
      .on(table.userId)
      .where(sql`${table.status} = 'active'`)
  })
);

/**
 * A piece of assigned work inside a research.
 *
 * The collaboration layer assigns and tracks work; it does not re-model the
 * work itself. A work item is either free-form (`title`/`description`) or a
 * pointer at an existing artifact via `targetType`/`targetId` (a plan item, a
 * revalidation task, an evidence gap, a source monitoring task, or an agent
 * run). The status is a single lifecycle owned by this table, advanced with
 * optimistic locking through `version`.
 */
export const researchWorkItems = pgTable(
  "research_work_items",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("open"),
    assigneeUserId: text("assignee_user_id"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    createdBy: text("created_by").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
    completedAt: timestampColumn("completed_at"),
    dueAt: timestampColumn("due_at"),
    version: integer("version").notNull().default(1)
  },
  (table) => ({
    sessionStatus: index("research_work_items_session_status_idx").on(
      table.sessionId,
      table.status
    ),
    assignee: index("research_work_items_assignee_idx")
      .on(table.assigneeUserId)
      .where(sql`${table.assigneeUserId} IS NOT NULL`)
  })
);

/**
 * A threaded comment on a research artifact.
 *
 * `authorUserId` is written by the service from the caller identity and never
 * from the request body, so a comment cannot be forged as another author. The
 * body length and the `targetType` closed set are enforced by CHECKs in
 * migration 0019; the rendering layer (React) escapes the body, so a comment
 * is never executed as markup. Deletion is soft: `deletedAt` keeps the
 * conversation intact and the audit trail honest.
 */
export const researchComments = pgTable(
  "research_comments",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").notNull(),
    body: text("body").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    parentCommentId: text("parent_comment_id"),
    deletedAt: timestampColumn("deleted_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
    version: integer("version").notNull().default(1)
  },
  (table) => ({
    target: index("research_comments_target_idx")
      .on(table.sessionId, table.targetType, table.targetId)
      .where(sql`${table.deletedAt} IS NULL`),
    parent: index("research_comments_parent_idx")
      .on(table.parentCommentId)
      .where(sql`${table.parentCommentId} IS NOT NULL`)
  })
);

/**
 * A request that a person review an artifact, and its outcome.
 *
 * This is the human-review coordination surface: it records *who asked*,
 * *what* is to be reviewed, and *what the reviewer decided*. It deliberately
 * does not write a claim verdict or a verification status — an `approved`
 * here is a human sign-off on the artifact, not a verdict, and any formal
 * verification still has to go through the existing evidence-verification
 * API. The `assignedReviewerUserId`/`status`/`decision` invariants are
 * enforced by CHECKs in migration 0019 so the three can never disagree.
 */
export const researchReviewRequests = pgTable(
  "research_review_requests",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    requestType: text("request_type").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedReviewerUserId: text("requested_reviewer_user_id"),
    status: text("status").notNull().default("open"),
    assignedReviewerUserId: text("assigned_reviewer_user_id"),
    decision: text("decision"),
    decidedBy: text("decided_by"),
    decidedAt: timestampColumn("decided_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
    version: integer("version").notNull().default(1)
  },
  (table) => ({
    sessionStatus: index("research_review_requests_session_status_idx").on(
      table.sessionId,
      table.status
    ),
    requestedReviewer: index("research_review_requests_requested_reviewer_idx")
      .on(table.requestedReviewerUserId)
      .where(sql`${table.requestedReviewerUserId} IS NOT NULL`),
    assigned: index("research_review_requests_assigned_idx")
      .on(table.assignedReviewerUserId)
      .where(sql`${table.assignedReviewerUserId} IS NOT NULL`)
  })
);
