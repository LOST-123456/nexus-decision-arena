import {
  AgentRoleSchema,
  ChallengeSchema,
  ClaimSchema,
  ConflictSchema,
  EvidenceSchema,
  HumanDecisionSchema,
  type AgentRole,
  type Challenge,
  type Claim,
  type Conflict,
  type Evidence,
  type HumanDecision
} from "@nexus/shared";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a database row object");
  }
  return value as Record<string, unknown>;
}

function iso(value: unknown): string {
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
      return { ...value, retrievedAt: iso(value.retrievedAt) };
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
