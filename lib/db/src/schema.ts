import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
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
  nextEventSequence: integer("next_event_sequence").notNull().default(1),
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
  agentRunId: uuid("agent_run_id")
    .notNull()
    .references(() => agentRuns.id),
  roleId: uuid("role_id")
    .notNull()
    .references(() => agentRoles.id),
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

export const evidence = pgTable("evidence", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => decisionSessions.id),
  claimId: uuid("claim_id")
    .notNull()
    .references(() => claims.id),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  description: text("description").notNull(),
  sourceRef: text("source_ref"),
  direction: text("direction").notNull(),
  reliability: doublePrecision("reliability").notNull(),
  verificationStatus: text("verification_status").notNull(),
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

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  requestHash: text("request_hash").notNull(),
  status: text("status").notNull().default("completed"),
  response: jsonb("response"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow()
});
