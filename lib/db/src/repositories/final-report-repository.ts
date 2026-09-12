import { asc, desc, eq } from "drizzle-orm";
import {
  FinalReportSchema,
  newId,
  type FinalReport,
  type HumanDecision
} from "@nexus/shared";
import type { Database } from "../client";
import {
  challenges,
  claims,
  conflicts,
  decisionSessions,
  evidence,
  executionEvents,
  finalReports,
  humanDecisions,
  projects
} from "../schema";
import {
  parseChallenges,
  parseClaims,
  parseConflicts,
  parseEvidence,
  parseHumanDecisions
} from "./domain-mapper";

export class ReportNotReadyError extends Error {
  constructor() {
    super("Final report is not ready until a human decision is recorded");
    this.name = "ReportNotReadyError";
  }
}

function conclusionFromEvent(payload: unknown): string | null {
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "currentConclusion" in payload &&
    typeof payload.currentConclusion === "string"
  ) {
    return payload.currentConclusion;
  }
  return null;
}

function humanActionLabel(action: HumanDecision["action"]): string {
  switch (action) {
    case "accept_challenge":
      return "Adopt the decisive challenge";
    case "uphold_claim":
      return "Uphold the original claim";
    case "request_more_analysis":
      return "Request one supplement round";
  }
}

function toFinalReport(
  row: typeof finalReports.$inferSelect
): FinalReport {
  return FinalReportSchema.parse({
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    humanDecisionId: row.humanDecisionId ?? undefined
  });
}

export class FinalReportRepository {
  constructor(private readonly database: Database) {}

  async getBySessionId(sessionId: string): Promise<FinalReport | null> {
    const [row] = await this.database
      .select()
      .from(finalReports)
      .where(eq(finalReports.sessionId, sessionId))
      .limit(1);
    return row ? toFinalReport(row) : null;
  }

  async generateAndPersist(sessionId: string): Promise<FinalReport> {
    const [session] = await this.database
      .select()
      .from(decisionSessions)
      .where(eq(decisionSessions.id, sessionId))
      .limit(1);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const [project] = await this.database
      .select()
      .from(projects)
      .where(eq(projects.id, session.projectId))
      .limit(1);
    const sessionClaims = parseClaims(
      await this.database
        .select()
        .from(claims)
        .where(eq(claims.sessionId, sessionId))
    );
    const sessionEvidence = parseEvidence(
      await this.database
        .select()
        .from(evidence)
        .where(eq(evidence.sessionId, sessionId))
    );
    const sessionConflicts = parseConflicts(
      await this.database
        .select()
        .from(conflicts)
        .where(eq(conflicts.sessionId, sessionId))
    );
    const sessionChallenges = parseChallenges(
      await this.database
        .select()
        .from(challenges)
        .where(eq(challenges.sessionId, sessionId))
    );
    const [latestDecisionRow] = await this.database
      .select()
      .from(humanDecisions)
      .where(eq(humanDecisions.sessionId, sessionId))
      .orderBy(desc(humanDecisions.createdAt))
      .limit(1);
    const sessionEvents = await this.database
      .select()
      .from(executionEvents)
      .where(eq(executionEvents.sessionId, sessionId))
      .orderBy(asc(executionEvents.sequence));

    if (!latestDecisionRow) {
      throw new ReportNotReadyError();
    }
    const latestDecision = parseHumanDecisions([latestDecisionRow])[0];
    if (!latestDecision) {
      throw new ReportNotReadyError();
    }

    const decisiveConflicts = sessionConflicts.filter((conflict) =>
      conflict.claimIds.some((claimId) =>
        latestDecision.affectedClaimIds.includes(claimId)
      )
    );
    const relevantConflicts =
      decisiveConflicts.length > 0 ? decisiveConflicts : sessionConflicts;
    const decisiveChallengeIds = [
      ...new Set(relevantConflicts.flatMap((conflict) => conflict.challengeIds))
    ];
    const decisiveChallenges = sessionChallenges.filter((challenge) =>
      decisiveChallengeIds.includes(challenge.id)
    );
    const relevantClaimIds = new Set([
      ...latestDecision.affectedClaimIds,
      ...decisiveChallenges.map((challenge) => challenge.targetClaimId)
    ]);
    const relevantEvidence =
      relevantClaimIds.size === 0
        ? sessionEvidence
        : sessionEvidence.filter(
            (item) =>
              relevantClaimIds.has(item.claimId) ||
              sessionClaims.some(
                (claim) =>
                  claim.id === item.claimId && relevantClaimIds.has(claim.id)
              )
          );
    const requiredNextActions = [
      ...new Set(
        decisiveChallenges.flatMap((challenge) => challenge.requiredEvidence)
      )
    ];
    const firstConclusion =
      sessionEvents
        .map((event) => conclusionFromEvent(event.payload))
        .find((conclusion): conclusion is string => Boolean(conclusion)) ??
      latestDecision.previousConclusion;
    const now = new Date().toISOString();
    const report = FinalReportSchema.parse({
      id: newId(),
      sessionId,
      projectName: project?.name ?? "Decision session",
      executiveSummary: `${firstConclusion} -> ${latestDecision.previousConclusion}; ${humanActionLabel(latestDecision.action)}; final: ${session.currentConclusion ?? latestDecision.newConclusion}.`,
      initialConclusion: firstConclusion,
      postChallengeConclusion: latestDecision.previousConclusion,
      humanAction: humanActionLabel(latestDecision.action),
      finalConclusion: session.currentConclusion ?? latestDecision.newConclusion,
      decisionExplanation: [
        latestDecision.rationale,
        ...relevantConflicts.map(
          (conflict) => conflict.resolutionSuggestion
        )
      ].join(" "),
      requiredNextActions,
      decisiveChallengeIds,
      evidenceIds: relevantEvidence.map((item) => item.id),
      humanDecisionId: latestDecision.id,
      createdAt: now,
      updatedAt: now
    });

    const [persisted] = await this.database
      .insert(finalReports)
      .values({
        id: report.id,
        sessionId: report.sessionId,
        projectName: report.projectName,
        executiveSummary: report.executiveSummary,
        initialConclusion: report.initialConclusion,
        postChallengeConclusion: report.postChallengeConclusion,
        humanAction: report.humanAction,
        finalConclusion: report.finalConclusion,
        decisionExplanation: report.decisionExplanation,
        requiredNextActions: report.requiredNextActions,
        decisiveChallengeIds: report.decisiveChallengeIds,
        evidenceIds: report.evidenceIds,
        humanDecisionId: report.humanDecisionId,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt
      })
      .onConflictDoUpdate({
        target: finalReports.sessionId,
        set: {
          projectName: report.projectName,
          executiveSummary: report.executiveSummary,
          initialConclusion: report.initialConclusion,
          postChallengeConclusion: report.postChallengeConclusion,
          humanAction: report.humanAction,
          finalConclusion: report.finalConclusion,
          decisionExplanation: report.decisionExplanation,
          requiredNextActions: report.requiredNextActions,
          decisiveChallengeIds: report.decisiveChallengeIds,
          evidenceIds: report.evidenceIds,
          humanDecisionId: report.humanDecisionId,
          updatedAt: report.updatedAt
        }
      })
      .returning();

    if (!persisted) {
      throw new Error("Final report persistence failed");
    }
    return toFinalReport(persisted);
  }
}
