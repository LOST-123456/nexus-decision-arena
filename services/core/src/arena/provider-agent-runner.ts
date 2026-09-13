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
import type {
  ChallengeDraft,
  CrossExaminationPlan
} from "./cross-examination";
import { selectClaims } from "../workflow/claim-selector";
import { assignChallengers } from "../workflow/challenger-assigner";

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
          'Example: {"claims":[{"statement":"需求证据不足","type":"assumption","stance":"oppose","importance":5,"confidence":0.6,"evidenceTitles":["缺少采购记录"]}]}.',
          "type must be exactly one of: fact, assumption, prediction, recommendation. Never output a pipe-delimited list.",
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
    const fallbackChallenge = (
      challenger: AgentRole,
      target: Claim
    ): ChallengeDraft => ({
      type:
        target.evidenceIds.length === 0
          ? "evidence_gap"
          : target.type === "assumption"
            ? "feasibility"
            : "logic_flaw",
      question: `${challenger.name}质疑“${target.statement}”的证据是否充分，请提供可核验依据。`,
      context: {
        triggerClaimIds: [target.id],
        explanation: "该断言直接影响当前结论，但现有证据仍需核验。"
      },
      requiredEvidence: ["可核验来源、计算过程或原型结果"],
      severity: Math.max(4, target.importance),
      resolutionStrategy:
        target.evidenceIds.length === 0
          ? "provide_evidence"
          : "human_decision"
    });

    const fallbackResponse = (challenge: Challenge, target: Claim): Claim =>
      ClaimSchema.parse({
        ...target,
        id: newId(),
        revision: target.revision + 1,
        revisionOfClaimId: target.id,
        respondsToChallengeId: challenge.id,
        disposition: "insufficient_evidence",
        statement: `在补充证据前，将“${target.statement}”限定为待验证假设。`,
        confidence: Math.max(0, target.confidence - 0.1),
        status: "contested",
        updatedAt: new Date().toISOString()
      });

    return {
      generateChallenge: async (challenger, target) => {
        try {
          const generated = await generateStructured(
            this.provider,
            {
              schemaName: "challenge:create",
              system: 'Return JSON only: {"type":"evidence_gap","question":"缺少什么证据？","context":{"triggerClaimIds":[target.id],"explanation":"为什么该证据影响结论"},"requiredEvidence":["采购记录"],"severity":4,"resolutionStrategy":"provide_evidence"}. context.triggerClaimIds must contain the exact target.id from the user message and must never use placeholders. resolutionStrategy must be exactly one of provide_evidence, revise_claim, withdraw_claim, human_decision.',
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
        } catch {
          return fallbackChallenge(challenger, target);
        }
      },
      respondToChallenge: async (challenge, target) => {
        try {
          const generated = await generateStructured(
            this.provider,
            {
              schemaName: "challenge:respond",
              system: 'Return JSON only: {"disposition":"qualify","statement":"修订后的断言","confidence":0.6}. disposition must be one of accept, reject, qualify, insufficient_evidence. Never use pipe-delimited values.',
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
        } catch {
          return fallbackResponse(challenge, target);
        }
      },
      evaluateResponse: async (challenge, responseClaim) => {
        if (challenge.severity >= 4) {
          return "unresolved";
        }
        try {
          const generated = await generateStructured(
            this.provider,
            {
              schemaName: "challenge:evaluate",
              system: 'Return JSON only: {"status":"unresolved"}. status must be exactly resolved or unresolved. Never use pipe-delimited values.',
              user: JSON.stringify({ challenge, responseClaim }),
              correlationId: challenge.correlationId
            },
            ProviderEvaluationSchema,
            new AbortController().signal
          );
          return generated.data.status;
        } catch {
          return responseClaim.status === "supported" ? "resolved" : "unresolved";
        }
      }
    };
  }

  createChallengePlans(
    roles: AgentRole[],
    claims: Claim[],
    runIdByRoleId: ReadonlyMap<string, string>
  ): CrossExaminationPlan[] {
    const configuredMaxClaims = Number(
      process.env.CROSS_EXAMINATION_MAX_CLAIMS ?? 5
    );
    const configuredMaxChallengers = Number(
      process.env.CROSS_EXAMINATION_MAX_CHALLENGERS ?? 2
    );
    const maxClaims =
      Number.isFinite(configuredMaxClaims) && configuredMaxClaims > 0
        ? configuredMaxClaims
        : 5;
    const maxChallengers =
      Number.isFinite(configuredMaxChallengers) &&
      configuredMaxChallengers > 0
        ? configuredMaxChallengers
        : 2;
    return selectClaims(claims, maxClaims).flatMap((target) =>
      assignChallengers(target, roles, maxChallengers).flatMap((challenger) => {
        const challengerRunId = runIdByRoleId.get(challenger.id);
        return challengerRunId
          ? [
              {
                targetClaimId: target.id,
                challengerRoleId: challenger.id,
                challengerRunId
              }
            ]
          : [];
      })
    );
  }
}
