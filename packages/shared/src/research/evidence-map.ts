import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";
import { ClaimStatusSchema } from "../domain/claim";
import {
  EvidenceDirectionSchema,
  EvidenceObjectSchema
} from "../domain/evidence";
import { ConflictStatusSchema } from "../domain/conflict";
import { ChallengeSchema } from "../domain/challenge";
import {
  SourceKindSchema,
  SourceRetrievalStatusSchema
} from "../domain/source";
import { ClaimVerdictStatusSchema } from "../verification/claim-verdict";

/*
 * Evidence Map — the graph projection of research material.
 *
 * One rule governs this whole module: the graph describes RELATIONSHIPS, it
 * never asserts FACTS. An edge from Evidence to a Claim means "this excerpt
 * bears on that claim in this direction" — it does NOT mean "the claim is
 * proven". What can responsibly be concluded remains the business of
 * evidence.verificationStatus, the derived ClaimVerdict and human review,
 * none of which this projection writes or overrides.
 *
 * The projection is derived on every read from rows that already exist
 * (claims, evidence, sources, conflicts, challenges, claim_reviews). It adds
 * no table, no write path and no verdict logic of its own — see
 * services/core/src/research/evidence-map-projection.ts.
 */

export const EvidenceMapNodeTypeSchema = z.enum([
  "claim",
  "evidence",
  "source",
  "conflict",
  "challenge"
]);

export type EvidenceMapNodeType = z.infer<typeof EvidenceMapNodeTypeSchema>;

/**
 * Relationship vocabulary. `supports` / `opposes` / `context` are the recorded
 * `evidence.direction` values (the brief calls the second one "contradicts";
 * the projection keeps the domain word rather than renaming a recorded value).
 * The other four are structural links that already exist between rows.
 */
export const EvidenceMapRelationSchema = z.enum([
  "supports",
  "opposes",
  "context",
  "provided_by",
  "involved_in",
  "questions",
  "generated_by"
]);

export type EvidenceMapRelation = z.infer<typeof EvidenceMapRelationSchema>;

/** Reused verbatim from the domain — the map never invents a status value. */
const EvidenceVerificationStatusSchema =
  EvidenceObjectSchema.shape.verificationStatus;
const ChallengeStatusSchema = ChallengeSchema.shape.status;

const EvidenceMapNodeBase = {
  /** Graph-internal id (`type:entityId`), not a row id. */
  id: z.string().min(1),
  sessionId: IdSchema,
  /** The underlying row's id. */
  entityId: IdSchema,
  label: z.string().min(1)
};

export const EvidenceMapClaimNodeSchema = z.object({
  ...EvidenceMapNodeBase,
  type: z.literal("claim"),
  status: ClaimStatusSchema,
  statement: z.string().min(1),
  /** Derived verdict (read-only reuse of deriveClaimVerdicts), never stored. */
  verdict: ClaimVerdictStatusSchema
});

export const EvidenceMapEvidenceNodeSchema = z.object({
  ...EvidenceMapNodeBase,
  type: z.literal("evidence"),
  status: EvidenceVerificationStatusSchema,
  excerpt: z.string().min(1),
  verificationStatus: EvidenceVerificationStatusSchema,
  direction: EvidenceDirectionSchema
});

export const EvidenceMapSourceNodeSchema = z.object({
  ...EvidenceMapNodeBase,
  type: z.literal("source"),
  status: SourceRetrievalStatusSchema,
  title: z.string().min(1),
  publisher: z.string().nullable(),
  sourceType: SourceKindSchema,
  /**
   * Mean of the RECORDED reliability values of excerpts drawn from this
   * source, or null when none exist. This is a projection of recorded
   * per-excerpt facts — not a trust score for the source, and never a
   * substitute for human judgement about it.
   */
  reliability: z.number().min(0).max(1).nullable()
});

export const EvidenceMapConflictNodeSchema = z.object({
  ...EvidenceMapNodeBase,
  type: z.literal("conflict"),
  status: ConflictStatusSchema,
  severity: z.number().int().min(1).max(5)
});

export const EvidenceMapChallengeNodeSchema = z.object({
  ...EvidenceMapNodeBase,
  type: z.literal("challenge"),
  status: ChallengeStatusSchema,
  question: z.string().min(1),
  /** Projected from recorded status/responseClaimId; null = still open. */
  resolution: z.string().nullable()
});

export const EvidenceMapNodeSchema = z.discriminatedUnion("type", [
  EvidenceMapClaimNodeSchema,
  EvidenceMapEvidenceNodeSchema,
  EvidenceMapSourceNodeSchema,
  EvidenceMapConflictNodeSchema,
  EvidenceMapChallengeNodeSchema
]);

export type EvidenceMapNode = z.infer<typeof EvidenceMapNodeSchema>;
export type EvidenceMapClaimNode = z.infer<typeof EvidenceMapClaimNodeSchema>;
export type EvidenceMapEvidenceNode = z.infer<
  typeof EvidenceMapEvidenceNodeSchema
>;
export type EvidenceMapSourceNode = z.infer<typeof EvidenceMapSourceNodeSchema>;
export type EvidenceMapConflictNode = z.infer<
  typeof EvidenceMapConflictNodeSchema
>;
export type EvidenceMapChallengeNode = z.infer<
  typeof EvidenceMapChallengeNodeSchema
>;

export const EvidenceMapEdgeSchema = z.object({
  /** Graph-internal deterministic id (`relation:from:to`), not a row id. */
  id: z.string().min(1),
  sessionId: IdSchema,
  /** Node ids (`type:entityId`), not raw entity ids. */
  from: z.string().min(1),
  to: z.string().min(1),
  relation: EvidenceMapRelationSchema,
  /**
   * Only the Evidence→Claim edges carry one: the recorded excerpt
   * reliability. Structural links have no recorded confidence and stay null
   * rather than inheriting a fake one.
   */
  confidence: z.number().min(0).max(1).nullable()
});

export type EvidenceMapEdge = z.infer<typeof EvidenceMapEdgeSchema>;

/**
 * Per-claim evidence coverage. A DISPLAY METRIC ONLY: it never feeds
 * `deriveClaimVerdicts`, never changes `claims.status`, and never stands in
 * for human review.
 *
 * coverage = (verifiedCount / evidenceCount) × meanReliability, 0 when there
 * is no related evidence. Every component is shown alongside the number so
 * the single percentage can never be mistaken for a conclusion.
 */
export const EvidenceCoverageSchema = z.object({
  claimId: IdSchema,
  evidenceCount: z.number().int().min(0),
  verifiedCount: z.number().int().min(0),
  supportingCount: z.number().int().min(0),
  contradictingCount: z.number().int().min(0),
  sourceCount: z.number().int().min(0),
  meanReliability: z.number().min(0).max(1).nullable(),
  coverage: z.number().min(0).max(1)
});

export type EvidenceCoverage = z.infer<typeof EvidenceCoverageSchema>;

export const EvidenceMapGraphSchema = z.object({
  sessionId: IdSchema,
  generatedAt: TimestampSchema,
  nodes: z.array(EvidenceMapNodeSchema),
  edges: z.array(EvidenceMapEdgeSchema),
  coverage: z.array(EvidenceCoverageSchema)
});

export type EvidenceMapGraph = z.infer<typeof EvidenceMapGraphSchema>;
