import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";
import { SourceKindSchema } from "../domain/source";

/*
 * Controlled research search.
 *
 * This is the *only* place a search result may live before a human inspects it.
 * The contract is deliberately narrow and the opposite of "auto-ingest":
 *
 *   - A search task produces *candidates*, never evidence. A candidate is a lead
 *     someone can inspect and choose to register as a Source.
 *   - Approving a task creates Sources — provenance records — never Evidence.
 *     Evidence is a separate, human-driven step that cites an already-registered
 *     source. Automating that step would silently manufacture proof, which is
 *     exactly what this build refuses to do.
 *   - Every candidate must already carry the provenance a Source needs
 *     (url, title, publisher, retrievedAt, sourceType), so approval is a pure
 *     transfer rather than a data-enrichment step the system performs silently.
 *
 * The "search" itself is controlled and deterministic in this build: there is no
 * live web crawl. Keywords are derived from the plan item, and candidates are
 * produced from a seeded, inspectable set. That is by design — a paragraph of
 * model prose about "what might be out there" is not a search result and must
 * never be displayed as one.
 */

/* ------------------------------------------------------------------ *
 * Status vocabulary
 * ------------------------------------------------------------------ */

export const ResearchSearchTaskStatusSchema = z.enum([
  /** Created, not yet run. */
  "queued",
  /** A controlled search is in flight. */
  "searching",
  /** Candidates were produced. */
  "completed",
  /** The search ran and did not succeed. */
  "failed",
  /** A person cancelled it before it produced anything usable. */
  "cancelled"
]);

export type ResearchSearchTaskStatus = z.infer<
  typeof ResearchSearchTaskStatusSchema
>;

/** Statuses that prove something actually ran. `queued` deliberately is not one. */
export const RESEARCH_SEARCH_EXECUTED_STATUSES: readonly ResearchSearchTaskStatus[] =
  ["searching", "completed", "failed"];

/* ------------------------------------------------------------------ *
 * Persisted shape
 * ------------------------------------------------------------------ */

export const ResearchSearchTaskSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  /** The research-plan item this task answers. */
  planItemId: IdSchema,
  /** What the gap is — the question being searched. */
  query: z.string().min(1).max(600),
  /** Why this search is being run — the research target. */
  purpose: z.string().min(1).max(1000),
  /** Keywords the controlled search used. */
  keywords: z.array(z.string().min(1).max(200)).max(24).default([]),
  status: ResearchSearchTaskStatusSchema,
  /** Why a search failed, when it did. */
  failureReason: z.string().min(1).max(2000).nullable(),
  /** When a person rejected the candidates, and who did. */
  rejectedAt: TimestampSchema.nullable().optional(),
  rejectedBy: z.string().max(160).nullable().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** When the search settled (completed/failed/cancelled), else null. */
  finishedAt: TimestampSchema.nullable()
});

export type ResearchSearchTask = z.infer<typeof ResearchSearchTaskSchema>;

/**
 * A lead surfaced by a controlled search.
 *
 * Every candidate is required to carry the provenance a Source needs — url,
 * title, publisher, retrievedAt and sourceType — so that approving it is a pure
 * transfer and the system never silently fabricates metadata. A candidate is
 * NOT evidence; it only becomes a Source after a person approves the task.
 */
export const SearchCandidateSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  sessionId: IdSchema,
  /** Canonical locator. Required — a candidate without a url is useless. */
  url: z.string().url(),
  /** Human-readable name of the page or document. */
  title: z.string().min(1).max(240),
  /** Publishing organisation or responsible body. */
  publisher: z.string().min(1).max(240),
  /** When the lead was surfaced by the controlled search. */
  retrievedAt: TimestampSchema,
  /** The kind of source this lead represents, mapped onto Source.kind. */
  sourceType: SourceKindSchema,
  /** Why this candidate matched, or limits on its usefulness. */
  note: z.string().max(2000).nullable().default(null),
  /** Set when a person approved this candidate and it became a Source. */
  approvedAt: TimestampSchema.nullable(),
  /** The source this candidate became, once approved. */
  registeredSourceId: IdSchema.nullable(),
  createdAt: TimestampSchema
});

export type SearchCandidate = z.infer<typeof SearchCandidateSchema>;

/* ------------------------------------------------------------------ *
 * Drafts accepted from the API
 * ------------------------------------------------------------------ */

/** Creating a search task. Keywords may be supplied or derived by the service. */
export const ResearchSearchTaskDraftSchema = z.object({
  planItemId: IdSchema,
  query: z.string().trim().min(1).max(600),
  purpose: z.string().trim().min(1).max(1000),
  keywords: z.array(z.string().trim().min(1).max(200)).max(24).default([])
});

export type ResearchSearchTaskDraft = z.infer<
  typeof ResearchSearchTaskDraftSchema
>;

/* ------------------------------------------------------------------ *
 * Failure vocabulary
 * ------------------------------------------------------------------ */

/**
 * Why a search action could not be carried out. Named so the UI can say what to
 * do next, and so the honest "this did not find anything real" path is distinct
 * from an unexpected internal failure.
 */
export const ResearchSearchFailureCodeSchema = z.enum([
  "search_task_not_found",
  "plan_item_not_found",
  "invalid_request",
  "invalid_transition",
  "search_failed",
  "storage_unavailable"
]);

export type ResearchSearchFailureCode = z.infer<
  typeof ResearchSearchFailureCodeSchema
>;
