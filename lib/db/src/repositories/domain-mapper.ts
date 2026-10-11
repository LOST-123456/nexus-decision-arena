import {
  AgentRoleSchema,
  ChallengeSchema,
  ClaimCandidateSchema,
  ClaimExtractionRunSchema,
  ClaimReviewSchema,
  ClaimSchema,
  ClaimSupportAssessmentSchema,
  CitationIntegrityCheckSchema,
  ConflictSchema,
  EvidenceCandidateSchema,
  EvidenceSchema,
  HumanDecisionSchema,
  SourceSchema,
  SourceProfileOverrideSchema,
  SourceRelationSchema,
  SourceSnapshotSchema,
  type AgentRole,
  type Challenge,
  type Claim,
  type ClaimCandidate,
  type ClaimExtractionRun,
  type ClaimReview,
  type ClaimSupportAssessment,
  type CitationIntegrityCheck,
  type Conflict,
  type Evidence,
  type EvidenceCandidate,
  type HumanDecision,
  type Source,
  type SourceProfileOverride,
  type SourceRelation,
  type SourceSnapshot
} from "@nexus/shared";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a database row object");
  }
  return value as Record<string, unknown>;
}

/** Postgres `timestamptz` rows come back as non-ISO text; normalize before zod parses. */
export function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid persisted timestamp: ${String(value)}`);
  }
  return date.toISOString();
}

export function parseAgentRoles(rows: readonly unknown[]): AgentRole[] {
  return AgentRoleSchema.array().parse(rows);
}

export function parseClaims(rows: readonly unknown[]): Claim[] {
  return ClaimSchema.array().parse(
    rows.map((row) => {
      const value = record(row);
      return {
        ...value,
        createdAt: iso(value.createdAt),
        updatedAt: iso(value.updatedAt)
      };
    })
  );
}

export function parseEvidence(rows: readonly unknown[]): Evidence[] {
  return EvidenceSchema.array().parse(
    rows.map((row) => {
      const value = record(row);
      return {
        ...value,
        retrievedAt: iso(value.retrievedAt),
        ...(value.verifiedAt ? { verifiedAt: iso(value.verifiedAt) } : {})
      };
    })
  );
}

export function parseSources(rows: readonly unknown[]): Source[] {
  return SourceSchema.array().parse(
    rows.map((row) => {
      const value = record(row);
      return {
        ...value,
        ...(value.publishedAt ? { publishedAt: iso(value.publishedAt) } : {}),
        ...(value.retrievedAt ? { retrievedAt: iso(value.retrievedAt) } : {}),
        createdAt: iso(value.createdAt),
        updatedAt: iso(value.updatedAt)
      };
    })
  );
}

export function parseSourceSnapshots(
  rows: readonly unknown[]
): SourceSnapshot[] {
  return SourceSnapshotSchema.array().parse(
    rows.map((row) => {
      const value = record(row);
      return {
        ...value,
        ...(value.publishedAt ? { publishedAt: iso(value.publishedAt) } : {}),
        retrievedAt: iso(value.retrievedAt),
        createdAt: iso(value.createdAt)
      };
    })
  );
}

export function parseChallenges(rows: readonly unknown[]): Challenge[] {
  return ChallengeSchema.array().parse(
    rows.map((row) => {
      const value = record(row);
      return {
        ...value,
        createdAt: iso(value.createdAt),
        updatedAt: iso(value.updatedAt)
      };
    })
  );
}

export function parseConflicts(rows: readonly unknown[]): Conflict[] {
  return ConflictSchema.array().parse(
    rows.map((row) => {
      const value = record(row);
      return {
        ...value,
        createdAt: iso(value.createdAt),
        updatedAt: iso(value.updatedAt)
      };
    })
  );
}

export function parseHumanDecisions(
  rows: readonly unknown[]
): HumanDecision[] {
  return HumanDecisionSchema.array().parse(
    rows.map((row) => {
      const value = record(row);
      return { ...value, createdAt: iso(value.createdAt) };
    })
  );
}

export function parseClaimReviews(rows: readonly unknown[]): ClaimReview[] {
  return ClaimReviewSchema.array().parse(
    rows.map((row) => {
      const value = record(row);
      return { ...value, createdAt: iso(value.createdAt) };
    })
  );
}

/**
 * PostgreSQL answers with `null` for "absent"; TypeScript answers with
 * `undefined`. Rows from the candidate tables carry a lot of optional columns,
 * so instead of repeating a null check on every field these three parsers drop
 * the nulls once, here, and let `optional()` mean absent.
 */
function absent(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null)
  );
}

function withRunDates(value: Record<string, unknown>) {
  return {
    ...absent(value),
    startedAt: iso(value.startedAt),
    ...(value.completedAt ? { completedAt: iso(value.completedAt) } : {}),
    createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt)
  };
}

function withCandidateDates(value: Record<string, unknown>) {
  return {
    ...absent(value),
    ...(value.decidedAt ? { decidedAt: iso(value.decidedAt) } : {}),
    createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt)
  };
}

export function parseClaimExtractionRuns(
  rows: readonly unknown[]
): ClaimExtractionRun[] {
  return ClaimExtractionRunSchema.array().parse(
    rows.map((row) => withRunDates(record(row)))
  );
}

export function parseClaimCandidates(rows: readonly unknown[]): ClaimCandidate[] {
  return ClaimCandidateSchema.array().parse(
    rows.map((row) => withCandidateDates(record(row)))
  );
}

export function parseEvidenceCandidates(
  rows: readonly unknown[]
): EvidenceCandidate[] {
  return EvidenceCandidateSchema.array().parse(
    rows.map((row) => withCandidateDates(record(row)))
  );
}

/**
 * `numeric` columns come back from PostgreSQL as strings, so the confidence is
 * converted here rather than loosening the domain schema to accept both.
 */
/**
 * Citation rows keep their nulls.
 *
 * Unlike the candidate tables, almost every optional column here is part of the
 * answer rather than an absent value: `supersedesId: null` means "this is the
 * original conclusion, nothing was overridden", and `expectedContentHash: null`
 * means "no version was ever recorded". Dropping them would turn those
 * statements into "unknown", so they are passed through and the domain schema
 * declares them `.nullable()` on purpose.
 */
function withCitationDates(value: Record<string, unknown>) {
  const confidence = value.confidence;
  return {
    ...value,
    ...(confidence === null || confidence === undefined
      ? {}
      : { confidence: Number(confidence) }),
    isCurrent: value.isCurrent === true,
    createdAt: iso(value.createdAt)
  };
}

export function parseCitationIntegrityChecks(
  rows: readonly unknown[]
): CitationIntegrityCheck[] {
  return CitationIntegrityCheckSchema.array().parse(
    rows.map((row) => withCitationDates(record(row)))
  );
}

export function parseClaimSupportAssessments(
  rows: readonly unknown[]
): ClaimSupportAssessment[] {
  return ClaimSupportAssessmentSchema.array().parse(
    rows.map((row) => withCitationDates(record(row)))
  );
}

/**
 * Source assertion rows keep their nulls for the same reason the citation rows
 * do: `supersedesId: null` means "this is the original statement", and
 * `similarity: null` means "this link was not made on a similarity score".
 * `numeric` arrives as a string, so it is converted here.
 */
function withSourceAssertionDates(value: Record<string, unknown>) {
  const similarity = value.similarity;
  return {
    ...value,
    ...(similarity === null || similarity === undefined
      ? {}
      : { similarity: Number(similarity) }),
    isCurrent: value.isCurrent === true,
    createdAt: iso(value.createdAt)
  };
}

export function parseSourceRelations(
  rows: readonly unknown[]
): SourceRelation[] {
  return SourceRelationSchema.array().parse(
    rows.map((row) => withSourceAssertionDates(record(row)))
  );
}

export function parseSourceProfileOverrides(
  rows: readonly unknown[]
): SourceProfileOverride[] {
  return SourceProfileOverrideSchema.array().parse(
    rows.map((row) => withSourceAssertionDates(record(row)))
  );
}
