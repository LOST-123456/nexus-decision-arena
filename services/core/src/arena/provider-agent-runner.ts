import {
  ChallengeSchema,
  ClaimSchema,
  EvidenceSchema,
  newId,
  type AgentRole,
  type Challenge,
  type Claim,
  type Evidence
} from "@nexus/shared";
import { generateStructured, type LlmProvider } from "@nexus/llm";
import { z } from "zod";
import type { AgentAnalysis, AgentRunner } from "./agent-runner";
import type { ChallengeDraft } from "./cross-examination";

const ProviderClaimSchema = z.object({
  statement: z.string().min(1),
  type: z.enum(["fact", "assumption", "prediction", "recommendation"]),
  stance: z.enum(["support", "oppose", "neutral"]),
  importance: z.number().int().min(1).max(5),
  confidence: z.number().min(0).max(1),
  evidenceTitles: z.array(z.string().min(1)).min(1)
});

const ProviderAnalysisSchema = z.object({
  claims: z.array(ProviderClaimSchema).min(1)
});

const ProviderResponseSchema = z.object({
  disposition: z.enum([
    "accept",
    "reject",
    "qualify",
    "insufficient_evidence"
  ]),
  statement: z.string().min(1),
  confidence: z.number().min(0).max(1).optional()
});

const ProviderEvaluationSchema = z.object({
  status: z.enum(["resolved", "unresolved"])
});

type AgentExecutionContext = {
  sessionId: string;
  agentRunId: string;
  projectInput: unknown;
};

function context(value: unknown): AgentExecutionContext {
  if (
    value === null ||
    typeof value !== "object" ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    !("agentRunId" in value) ||
    typeof value.agentRunId !== "string"
  ) {
    throw new Error("ProviderAgentRunner requires a session run context");
  }
  return value as AgentExecutionContext;
}

export class ProviderAgentRunner implements AgentRunner {
  constructor(private readonly provider: LlmProvider) {}

  async run(role: AgentRole, projectInput: unknown): Promise<AgentAnalysis> {
    const runContext = context(projectInput);
    const generated = await generateStructured(
      this.provider,
      {
        schemaName: "agent:analysis",
        system: [
          "You are one role in a decision challenge arena.",
          "Return JSON only. Do not invent citations.",
          `Role: ${role.name}. Goal: ${role.goal}.`
        ].join("\n"),
        user: JSON.stringify({ role, project: runContext.projectInput }),
        correlationId: runContext.agentRunId
      },
      ProviderAnalysisSchema,
      new AbortController().signal
    );
    const now = new Date().toISOString();
    const claims: Claim[] = [];
    const evidence: Evidence[] = [];

    for (const draft of generated.data.claims) {
      const claimId = newId();
      const claimEvidence = draft.evidenceTitles.map((title) => {
        const evidenceId = newId();
        return EvidenceSchema.parse({
          id: evidenceId,
          sessionId: runContext.sessionId,
          claimId,
          kind: "assumption",
          title,
          content: title,
          description: `Provider evidence for ${role.key}`,
          direction: draft.stance === "oppose" ? "opposes" : "supports",
          reliability: draft.confidence,
          verificationStatus: "unverified",
          retrievedAt: now,
          createdBy: "agent",
          agentRunId: runContext.agentRunId
        });
      });
      evidence.push(...claimEvidence);
      claims.push(
        ClaimSchema.parse({
          id: claimId,
          sessionId: runContext.sessionId,
          agentRunId: runContext.agentRunId,
          roleId: role.id,
          lens: role.lenses[0] ?? role.key,
          statement: draft.statement,
          type: draft.type,
          stance: draft.stance,
          importance: draft.importance,
          confidence: draft.confidence,
          evidenceIds: claimEvidence.map((item) => item.id),
          status: "proposed",
          rootClaimId: claimId,
          revision: 1,
          relations: [],
          createdAt: now,
          updatedAt: now
        })
      );
    }

    return { claims, evidence };
  }

  createChallengeDependencies(): {
    generateChallenge: (
      challenger: AgentRole,
      target: Claim
    ) => Promise<ChallengeDraft>;
    respondToChallenge: (
      challenge: Challenge,
      target: Claim
    ) => Promise<Claim>;
    evaluateResponse: (
      challenge: Challenge,
      responseClaim: Claim
    ) => Promise<"resolved" | "unresolved">;
  } {
    return {
      generateChallenge: async (challenger, target) => {
        const generated = await generateStructured(
          this.provider,
          {
            schemaName: "challenge:create",
            system: "Return one structured challenge as JSON.",
            user: JSON.stringify({ challenger, target }),
            correlationId: target.agentRunId
          },
          z.object({
            type: ChallengeSchema.shape.type,
            question: z.string().min(1),
            context: z.object({
              triggerClaimIds: z.array(z.string()).min(1),
              explanation: z.string().min(1)
            }),
            requiredEvidence: z.array(z.string().min(1)).min(1),
            severity: z.number().int().min(1).max(5),
            resolutionStrategy: ChallengeSchema.shape.resolutionStrategy
          }),
          new AbortController().signal
        );
        return generated.data;
      },
      respondToChallenge: async (challenge, target) => {
        const generated = await generateStructured(
          this.provider,
          {
            schemaName: "challenge:respond",
            system: "Answer the challenge as a revised Claim in JSON.",
            user: JSON.stringify({ challenge, target }),
            correlationId: challenge.correlationId
          },
          ProviderResponseSchema,
          new AbortController().signal
        );
        return ClaimSchema.parse({
          ...target,
          id: newId(),
          revision: target.revision + 1,
          revisionOfClaimId: target.id,
          respondsToChallengeId: challenge.id,
          disposition: generated.data.disposition,
          statement: generated.data.statement,
          confidence: generated.data.confidence ?? target.confidence,
          status: "contested",
          updatedAt: new Date().toISOString()
        });
      },
      evaluateResponse: async (challenge, responseClaim) => {
        const generated = await generateStructured(
          this.provider,
          {
            schemaName: "challenge:evaluate",
            system: "Return whether the response resolves the challenge.",
            user: JSON.stringify({ challenge, responseClaim }),
            correlationId: challenge.correlationId
          },
          ProviderEvaluationSchema,
          new AbortController().signal
        );
        return generated.data.status;
      }
    };
  }
}
