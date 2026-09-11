import {
  ConflictSchema,
  newId,
  type Challenge,
  type Claim,
  type Conflict
} from "@nexus/shared";

type ConflictInput = {
  sessionId: string;
  claims: Claim[];
  challenges: Challenge[];
};

export function detectConflicts(input: ConflictInput): Conflict[] {
  const conflicts: Conflict[] = [];
  const claimById = new Map(input.claims.map((claim) => [claim.id, claim]));

  for (const claim of input.claims) {
    for (const relation of claim.relations) {
      const target = claimById.get(relation.targetClaimId);
      if (relation.type !== "contradicts" || !target) {
        continue;
      }

      const id = newId();
      conflicts.push(
        ConflictSchema.parse({
          id,
          sessionId: input.sessionId,
          claimIds: [claim.id, target.id],
          challengeIds: [],
          type: "logic",
          summary: `${claim.statement} conflicts with ${target.statement}`,
          severity: 4,
          status: "detected",
          humanDecisionRequired: true,
          resolutionSuggestion: "Review both claims and request evidence.",
          impactScope: {
            analysisAreas: ["market", "finance"],
            stakeholders: ["Project team"]
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })
      );
    }
  }

  for (const challenge of input.challenges) {
    if (challenge.status !== "unresolved" || challenge.severity < 4) {
      continue;
    }
    const target = claimById.get(challenge.targetClaimId);
    if (!target) {
      continue;
    }
    const id = newId();
    conflicts.push(
      ConflictSchema.parse({
        id,
        sessionId: input.sessionId,
        claimIds: [target.id],
        challengeIds: [challenge.id],
        type: "evidence",
        summary: challenge.question,
        severity: challenge.severity,
        status: "detected",
        humanDecisionRequired: true,
        resolutionSuggestion: `Provide: ${challenge.requiredEvidence.join(", ")}`,
        impactScope: {
          analysisAreas: ["market"],
          stakeholders: ["Project team"]
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
    );
  }

  return conflicts;
}
