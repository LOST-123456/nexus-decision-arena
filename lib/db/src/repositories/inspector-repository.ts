import type {
  Challenge,
  Claim,
  ClaimInspectorDTO,
  Conflict,
  Evidence
} from "@nexus/shared";
export type { ClaimInspectorDTO } from "@nexus/shared";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  agentRuns,
  claims,
  humanDecisions,
  promptVersions
} from "../schema";

type JsonObject = Record<string, unknown>;

type InspectorViewRow = {
  claim: JsonObject;
  evidence: JsonObject[];
  challenges: Array<{
    challenge: JsonObject;
    responseClaim?: JsonObject | null;
  }>;
  conflicts: JsonObject[];
};

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase()
  );
}

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(camelize);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) =>
        child === null ? [] : [[snakeToCamel(key), camelize(child)]]
      )
    );
  }

  return value;
}

export class InspectorRepository {
  constructor(private readonly database: Database) {}

  async getInspector(
    sessionId: string,
    claimId: string
  ): Promise<ClaimInspectorDTO | null> {
    const [claimRecord] = await this.database
      .select()
      .from(claims)
      .where(eq(claims.id, claimId))
      .limit(1);

    if (!claimRecord || claimRecord.sessionId !== sessionId) {
      return null;
    }

    const viewRows = (await this.database.execute(
      sql`SELECT * FROM claim_inspector_view WHERE claim_id = ${claimId}`
    )) as unknown as InspectorViewRow[];
    const [view] = viewRows;

    const [agentRun] = await this.database
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, claimRecord.agentRunId))
      .limit(1);

    const [promptVersion] = agentRun
      ? await this.database
          .select()
          .from(promptVersions)
          .where(eq(promptVersions.id, agentRun.promptVersionId))
          .limit(1)
      : [];

    const claim = camelize(view?.claim ?? claimRecord) as Claim;
    const evidence = camelize(view?.evidence ?? []) as Evidence[];
    const challenges = camelize(view?.challenges ?? []) as Array<{
      challenge: Challenge;
      responseClaim?: Claim;
    }>;
    const conflicts = camelize(view?.conflicts ?? []) as Conflict[];
    const decisions = await this.database
      .select()
      .from(humanDecisions)
      .where(eq(humanDecisions.sessionId, sessionId));
    const linkedDecision = [...decisions]
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
      )
      .find(
        (decision) =>
          (Array.isArray(decision.affectedClaimIds)
            ? decision.affectedClaimIds
            : []
          ).includes(claim.id) ||
          conflicts.some(
            (conflict) =>
              conflict.id === decision.conflictId &&
              conflict.claimIds.includes(claim.id)
          )
      );
    const decisiveChallengeIds = [
      ...new Set(
        conflicts
          .filter((conflict) => conflict.claimIds.includes(claim.id))
          .flatMap((conflict) => conflict.challengeIds)
      )
    ];

    return {
      claim,
      evidence,
      challenges,
      conflicts,
      provenance: { agentRun, promptVersion },
      decisionRationale: {
        outcome:
          claim.status === "accepted"
            ? "accepted"
            : claim.status === "rejected"
              ? "rejected"
              : claim.status === "contested"
                ? "contested"
                : "needs_human",
        summary:
          claim.status === "accepted"
            ? "\u8be5 Claim \u5df2\u901a\u8fc7\u8bc1\u636e\u4e0e\u8d28\u8be2\u5ba1\u67e5\u3002"
            : "\u8be5 Claim \u4ecd\u9700\u8865\u5145\u8bc1\u636e\u6216\u7531\u4eba\u5de5\u590d\u6838\u3002",
        decisiveChallengeIds,
        evidenceIds: claim.evidenceIds,
        ...(linkedDecision
          ? { humanDecisionId: linkedDecision.id }
          : {})
      }
    };
  }
}
