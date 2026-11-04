import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRoleKeySchema,
  ChallengeSchema,
  ClaimSchema,
  EvidenceSchema,
  newId,
  type AgentRole,
  type Challenge,
  type Claim,
  type Evidence
} from "@nexus/shared";
import {
  MockLlmProvider,
  generateStructured,
  type LlmProvider
} from "@nexus/llm";
import { z } from "zod";
import type { AgentAnalysis, AgentRunner } from "./agent-runner";
import type {
  ChallengeDraft,
  CrossExaminationPlan
} from "./cross-examination";

const FixtureClaimSchema = z.object({
  statement: z.string().min(1),
  type: z.enum(["fact", "assumption", "prediction", "recommendation"]),
  stance: z.enum(["support", "oppose", "neutral"]),
  importance: z.number().int().min(1).max(5),
  confidence: z.number().min(0).max(1),
  evidenceTitles: z.array(z.string().min(1)).min(1)
});

const FixtureRoleAnalysisSchema = z.object({
  role: AgentRoleKeySchema,
  claims: z.array(FixtureClaimSchema).min(1)
});

const FixtureChallengeSchema = z.object({
  targetIndex: z.number().int().nonnegative(),
  challengerRole: AgentRoleKeySchema,
  type: ChallengeSchema.shape.type,
  question: z.string().min(1),
  context: z.object({ explanation: z.string().min(1) }),
  requiredEvidence: z.array(z.string().min(1)).min(1),
  severity: z.number().int().min(1).max(5),
  resolutionStrategy: ChallengeSchema.shape.resolutionStrategy,
  expectedStatus: z.enum(["resolved", "unresolved"])
});

const FixtureRoleAnalysisArraySchema = z.array(FixtureRoleAnalysisSchema);
const FixtureChallengeArraySchema = z.array(FixtureChallengeSchema);

export type DeterministicFixtures = {
  analysis: z.infer<typeof FixtureRoleAnalysisArraySchema>;
  challenges: z.infer<typeof FixtureChallengeArraySchema>;
};

type AgentExecutionContext = {
  sessionId: string;
  agentRunId: string;
  projectInput: unknown;
};

function findRepositoryRoot(): string {
  const candidates = [
    process.cwd(),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
  ];
  const root = candidates.find((candidate) =>
    existsSync(resolve(candidate, "fixtures", "mock-analysis.json"))
  );
  if (!root) {
    throw new Error("Could not locate deterministic decision arena fixtures");
  }
  return root;
}

export async function loadDeterministicFixtures(
  repositoryRoot = findRepositoryRoot()
): Promise<DeterministicFixtures> {
  const fixtureDirectory = resolve(repositoryRoot, "fixtures");
  const [analysisRaw, challengesRaw] = await Promise.all([
    readFile(resolve(fixtureDirectory, "mock-analysis.json"), "utf8"),
    readFile(resolve(fixtureDirectory, "mock-challenges.json"), "utf8")
  ]);
  return {
    analysis: FixtureRoleAnalysisArraySchema.parse(JSON.parse(analysisRaw)),
    challenges: FixtureChallengeArraySchema.parse(
      JSON.parse(challengesRaw)
    )
  };
}

function asExecutionContext(value: unknown): AgentExecutionContext {
  if (
    value === null ||
    typeof value !== "object" ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    !("agentRunId" in value) ||
    typeof value.agentRunId !== "string"
  ) {
    throw new Error("Deterministic AgentRunner requires a session run context");
  }
  return value as AgentExecutionContext;
}

export class DeterministicAgentRunner implements AgentRunner {
  /**
   * 目标主张在 claims 数组里的下标。
   *
   * fixture 是按"第几条主张"写的，而质询是按主张对象来的，两者之间要有
   * 一张对照表。`createChallengePlans` 每次都会用当轮真实的 claims 重建它，
   * 所以补充轮换了主张集合也不会指错。
   */
  #targetIndexByClaimId = new Map<string, number>();

  constructor(private readonly fixtures: DeterministicFixtures) {}

  async run(role: AgentRole, projectInput: unknown): Promise<AgentAnalysis> {
    const context = asExecutionContext(projectInput);
    const roleFixture = this.fixtures.analysis.find(
      (entry) => entry.role === role.key
    );
    if (!roleFixture) {
      throw new Error(`No deterministic fixture for role ${role.key}`);
    }

    const provider = new MockLlmProvider({
      "agent:analysis": () => JSON.stringify(roleFixture)
    });
    const generated = await generateStructured(
      provider,
      {
        schemaName: "agent:analysis",
        system: "Return the fixed role analysis fixture as JSON.",
        user: JSON.stringify(context.projectInput),
        correlationId: context.agentRunId
      },
      FixtureRoleAnalysisSchema,
      new AbortController().signal
    );

    const now = new Date().toISOString();
    const claims: Claim[] = [];
    const evidence: Evidence[] = [];
    for (const claimFixture of generated.data.claims) {
      const claimId = newId();
      const claimEvidence = claimFixture.evidenceTitles.map((title) => {
        const evidenceId = newId();
        return EvidenceSchema.parse({
          id: evidenceId,
          sessionId: context.sessionId,
          claimIds: [claimId],
          kind: "assumption",
          title,
          content: title,
          description: `Deterministic evidence fixture for ${role.key}`,
          direction:
            claimFixture.stance === "oppose" ? "opposes" : "supports",
          reliability: claimFixture.confidence,
          verificationStatus: "unverified",
          retrievedAt: now,
          createdBy: "agent",
          agentRunId: context.agentRunId
        });
      });
      evidence.push(...claimEvidence);
      claims.push(
        ClaimSchema.parse({
          id: claimId,
          sessionId: context.sessionId,
          agentRunId: context.agentRunId,
          roleId: role.id,
          lens: role.lenses[0] ?? role.key,
          statement: claimFixture.statement,
          type: claimFixture.type,
          stance: claimFixture.stance,
          importance: claimFixture.importance,
          confidence: claimFixture.confidence,
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

  createChallengePlans(
    roles: AgentRole[],
    claims: Claim[],
    runIdByRoleId: ReadonlyMap<string, string>
  ): CrossExaminationPlan[] {
    // 当轮的主张集合先记下来：后面的质询要靠它把"这条主张"换算回
    // fixture 里用的第几条。
    this.#targetIndexByClaimId = new Map(
      claims.map((claim, index) => [claim.id, index])
    );
    return this.fixtures.challenges.flatMap((fixture) => {
      const target = claims[fixture.targetIndex];
      const challenger = roles.find(
        (role) => role.key === fixture.challengerRole
      );
      const challengerRunId = challenger
        ? runIdByRoleId.get(challenger.id)
        : undefined;
      return target && challenger && challengerRunId
        ? [
            {
              targetClaimId: target.id,
              challengerRoleId: challenger.id,
              challengerRunId
            }
          ]
        : [];
    });
  }

  createChallengeDependencies(): {
    generateChallenge: (
      challenger: AgentRole,
      target: Claim,
      signal?: AbortSignal
    ) => Promise<ChallengeDraft>;
    respondToChallenge: (
      challenge: Challenge,
      target: Claim,
      signal?: AbortSignal
    ) => Promise<Claim>;
    evaluateResponse: (
      challenge: Challenge,
      responseClaim: Claim,
      signal?: AbortSignal
    ) => Promise<"resolved" | "unresolved">;
  } {
    /**
     * 这一轮每条质询该有的判定，按"质询者 + 目标主张"记下来。
     *
     * 之前这里是一个共享的 `expectedStatus` 变量，靠"提问 → 应答 → 判定"
     * 三步紧挨着执行来保证它没被换掉。质询改成并发之后就不成立了：下一条
     * 质询一提问就把这个变量改了，上一条的应答读到的就成了别人的判定——
     * 质询与它的应答对不上，冲突检测自然一条都出不来。
     *
     * 改成按这一条质询自己的身份去取，谁都不会串。键是"质询者 + 目标
     * 主张"，在 fixture 里唯一。
     */
    const expectedStatusByPair = new Map<
      string,
      "resolved" | "unresolved"
    >();
    const pairKey = (challengerRoleId: string, targetClaimId: string): string =>
      `${challengerRoleId}::${targetClaimId}`;
    /**
     * The deterministic runner is fast, so it never blocks long enough for an
     * abort to arrive mid-call. It still honours the signal at every step: a
     * cancelled run must stop producing fixture output, or a test could not
     * tell a real cancellation from a lucky one.
     */
    const stopIfCancelled = (signal?: AbortSignal): void => {
      if (signal?.aborted) {
        throw new DOMException("The run was cancelled.", "AbortError");
      }
    };
    return {
      generateChallenge: async (challenger, target, signal) => {
        stopIfCancelled(signal);
        /*
         * 按"谁问的、问的是哪条主张"找 fixture，而不是按调用顺序往下取。
         *
         * 顺序取法在并发下会错位：谁先跑到这一行，谁就拿到哪一条 fixture，
         * 提问的问题和目标主张就对不上了。认准身份才不会错。
         */
        const targetIndex = this.#targetIndexByClaimId.get(target.id);
        const fixture = this.fixtures.challenges.find(
          (candidate) =>
            candidate.challengerRole === challenger.key &&
            (targetIndex === undefined ||
              candidate.targetIndex === targetIndex)
        );
        if (!fixture) {
          throw new Error(
            `No deterministic challenge fixture for ${challenger.key} against claim ${target.id}`
          );
        }
        expectedStatusByPair.set(
          pairKey(challenger.id, target.id),
          fixture.expectedStatus
        );
        return {
          type: fixture.type,
          question: fixture.question,
          context: {
            triggerClaimIds: [target.id],
            explanation: fixture.context.explanation
          },
          requiredEvidence: fixture.requiredEvidence,
          severity: fixture.severity,
          resolutionStrategy: fixture.resolutionStrategy
        };
      },
      respondToChallenge: async (challenge, target, signal) => {
        stopIfCancelled(signal);
        const expectedStatus =
          expectedStatusByPair.get(
            pairKey(challenge.challengerRoleId, challenge.targetClaimId)
          ) ?? "unresolved";
        const status =
          expectedStatus === "resolved" ? "supported" : "contested";
        return ClaimSchema.parse({
          ...target,
          id: newId(),
          revision: target.revision + 1,
          revisionOfClaimId: target.id,
          respondsToChallengeId: challenge.id,
          disposition:
            expectedStatus === "resolved"
              ? "accept"
              : "insufficient_evidence",
          status,
          confidence:
            expectedStatus === "resolved"
              ? Math.min(1, target.confidence + 0.1)
              : Math.max(0, target.confidence - 0.1),
          updatedAt: new Date().toISOString()
        });
      },
      evaluateResponse: async (challenge, _responseClaim, signal) => {
        stopIfCancelled(signal);
        return (
          expectedStatusByPair.get(
            pairKey(challenge.challengerRoleId, challenge.targetClaimId)
          ) ?? "unresolved"
        );
      }
    };
  }
}

export function createMockProvider(
  fixtures: DeterministicFixtures
): LlmProvider {
  return new MockLlmProvider({
    "agent:analysis": (request) => {
      const context = JSON.parse(request.user) as { role?: string };
      const fixture = fixtures.analysis.find(
        (entry) => entry.role === context.role
      );
      if (!fixture) {
        throw new Error("No deterministic role fixture");
      }
      return JSON.stringify(fixture);
    }
  });
}
