import { eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { agentRuns, claims, promptVersions } from "../schema";

type InspectorViewRow = {
  claim: unknown;
  evidence: unknown[];
  challenges: unknown[];
  conflicts: unknown[];
};

export class InspectorRepository {
  constructor(private readonly database: Database) {}

  async getInspector(sessionId: string, claimId: string) {
    const [claim] = await this.database
      .select()
      .from(claims)
      .where(eq(claims.id, claimId))
      .limit(1);

    if (!claim || claim.sessionId !== sessionId) {
      return null;
    }

    const viewRows = (await this.database.execute(
      sql`SELECT * FROM claim_inspector_view WHERE claim_id = ${claimId}`
    )) as unknown as InspectorViewRow[];
    const [view] = viewRows;

    const [agentRun] = await this.database
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, claim.agentRunId))
      .limit(1);

    const [promptVersion] = agentRun
      ? await this.database
          .select()
          .from(promptVersions)
          .where(eq(promptVersions.id, agentRun.promptVersionId))
          .limit(1)
      : [];

    return {
      claim,
      evidence: view?.evidence ?? [],
      challenges: view?.challenges ?? [],
      conflicts: view?.conflicts ?? [],
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
