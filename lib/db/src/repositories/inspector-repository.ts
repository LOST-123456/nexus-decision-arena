import type {
  Challenge,
  Claim,
  Conflict,
  Evidence
} from "@nexus/shared";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { agentRuns, claims, promptVersions } from "../schema";

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

type AgentRunRow = typeof agentRuns.$inferSelect;
type PromptVersionRow = typeof promptVersions.$inferSelect;

export type ClaimInspectorDTO = {
  claim: Claim;
  evidence: Evidence[];
  challenges: Array<{
    challenge: Challenge;
    responseClaim?: Claim;
  }>;
  conflicts: Conflict[];
  provenance: {
    agentRun: AgentRunRow | undefined;
    promptVersion: PromptVersionRow | undefined;
  };
  decisionRationale: {
    outcome: "accepted" | "rejected" | "contested" | "needs_human";
    summary: string;
    decisiveChallengeIds: string[];
    evidenceIds: string[];
  };
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
            ? "该 Claim 已通过证据与质询审查。"
            : "该 Claim 仍需补充证据或由人工复核。",
        decisiveChallengeIds: [],
        evidenceIds: claim.evidenceIds
      }
    };
  }
}