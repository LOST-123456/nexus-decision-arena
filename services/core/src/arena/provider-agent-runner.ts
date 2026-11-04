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
import { toSearchQuery, type SearchHit, type WebSearchProvider } from "./web-search";

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

/**
 * The signal used on paths that genuinely have nothing to cancel.
 *
 * A fresh `new AbortController().signal` per call looked like cancellation
 * support while being impossible to trigger — the object is real, the abort
 * never comes. This constant says the same thing out loud: on this path the
 * absence of cancellation is a design decision, not an oversight.
 */
const NO_CANCELLATION = new AbortController().signal;

/**
 * The challenge types the domain actually accepts, with the defect each one
 * names.
 *
 * Why this is spelled out: the prompt used to carry a single sample object and
 * never said what `type` was allowed to be. A temperature-0 model treats the
 * sample as the answer, so a whole session came back as twenty `evidence_gap`
 * rows asking "缺少什么证据？" — technically valid, useless to a reviewer. The
 * legal values and the defect behind each one are what let five challengers
 * with five different lenses produce five different objections.
 */
const CHALLENGE_TYPE_GUIDE = [
  "evidence_gap — the claim rests on a number or fact nobody can check yet; name the artefact that would settle it",
  "feasibility — the claim promises what the budget, timeline, team or tech cannot deliver",
  "contradiction — two claims, or a claim and the user's own input, cannot both be true",
  "logic_flaw — the conclusion does not follow from its premises (wrong baseline, missing denominator, survivorship, sunk cost)",
  "priority — the claim may hold, but the plan spends effort in the wrong order"
].join("\n");

const LEGAL_CHALLENGE_TYPES = [
  "evidence_gap",
  "feasibility",
  "contradiction",
  "logic_flaw",
  "priority"
] as const;

/** 材料进提示词时的样子：够用即可，不是全文搬运。 */
export type MaterialBrief = {
  title: string;
  /** 已截断的正文，只给到足以判断"这件事到底交没交"的长度。 */
  content: string;
  round: number;
};

/**
 * 材料在提示词里的上限。
 *
 * 无上限地拼接会让一个交了二十份材料的会话在每一轮质询上都付一次全量 token；
 * 而质询真正需要的只是"这件事有没有依据"，不是全文。取最近的若干份、每份截断，
 * 既够模型判断，又不会让成本随材料数量线性膨胀。
 */
const MATERIAL_BRIEF_LIMIT = 8;
const MATERIAL_BRIEF_CHARS = 240;

/**
 * 开工前确认这一次调用还没被叫停。
 *
 * 只在 `await` 之后用得上：信号在等待期间到达时，唯一正确的动作是不发请求，
 * 而不是发出去再指望 provider 立刻中止。
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Generation aborted", "AbortError");
  }
}

export function toMaterialBriefs(
  materials: readonly { title: string; content: string; round: number }[]
): MaterialBrief[] {
  return materials.slice(-MATERIAL_BRIEF_LIMIT).map((material) => ({
    title: material.title,
    content:
      material.content.length > MATERIAL_BRIEF_CHARS
        ? `${material.content.slice(0, MATERIAL_BRIEF_CHARS)}…`
        : material.content,
    round: material.round
  }));
}

/**
 * Builds the challenger prompt.
 *
 * `conflictPreference` on a role is a free-form label ("assumption" is not a
 * legal type), so it is offered as a bias, never as the answer: the model still
 * has to pick a type that exists.
 */
function challengeSystemPrompt(
  challenger: AgentRole,
  materialCount = 0,
  webSourceCount = 0
): string {
  const preferred = challenger.conflictPreference.filter((value) =>
    (LEGAL_CHALLENGE_TYPES as readonly string[]).includes(value)
  );
  return [
    "Return one JSON object and nothing else, shaped exactly like this (the values are placeholders, not content):",
    '{"type":"<type>","question":"<question>","context":{"triggerClaimIds":["<target.id>"],"explanation":"<explanation>"},"requiredEvidence":["<artefact>"],"severity":3,"resolutionStrategy":"<strategy>"}',
    "",
    `type — exactly one of: ${LEGAL_CHALLENGE_TYPES.join(" | ")}. No other value is accepted.`,
    CHALLENGE_TYPE_GUIDE,
    preferred.length > 0
      ? `This challenger's standing bias is ${preferred.join(", ")}. Use it when the claim really has that defect; otherwise name the defect it does have.`
      : "",
    "",
    materialCount > 0
      ? `The user message lists ${materialCount} material(s) the researcher supplied before this round. Do not ask for evidence those materials already contain — if they do weaken the claim, attack what the material fails to establish instead.`
      : "",
    /*
     * 检索结果是"去哪里看"，不是"已经证明"。
     *
     * 这一行必须写死在提示词里：只要模型把一条搜索结果当成 support，报告上的
     * 证据覆盖率就会开始说谎——而那个数字是这个产品唯一不敢含糊的东西。
     */
    webSourceCount > 0
      ? `The user message lists ${webSourceCount} machine-retrieved web source(s). They are candidates, NOT verified evidence: you may use them to say where to look ("公开报价页/招投标公告"), and you must still ask for human confirmation. Never describe a web source as proof that the claim holds.`
      : "",
    "question — attack something concrete: quote the figure, ratio, date or phrase you doubt, then say what would make it credible. 15-45 characters. A question that could be asked of any claim in any project is a wrong answer; never reuse the wording above. \"缺少什么证据？\" and \"证据是否充分？\" are not acceptable questions.",
    "requiredEvidence — one to three artefacts that can actually be produced today (a procurement record, a signed supplier quote, a cohort table, a prototype result), never \"more data\". Write it as what to DO, not what is missing: 「向 2 家供应商索取含运费的单笔报价单」beats 「需要成本数据」.",
    /*
     * 同一类失败也出现在质询侧：资料不全时模型会写"因信息不足，无法提出可
     * 质询的点"。质询的价值恰恰在于指出"这里缺什么、怎么补"，所以缺信息本身
     * 就是质询内容，而不是放弃质询的理由。
     */
    "Never answer with a meta-statement about your own limits (「因信息不足，无法形成质询」). A missing figure IS the challenge — name it and say what artefact would settle it.",
    "severity — 5 only when this claim alone carries the whole conclusion; 1 only when it is peripheral to it.",
    "resolutionStrategy — provide_evidence when the artefact can exist but is missing; revise_claim when the statement overreaches; withdraw_claim when it is unsupported and inessential; human_decision when only the operator can settle it.",
    "context.triggerClaimIds must contain the exact target.id from the user message, never a placeholder, an index or an example id."
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

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
  /**
   * @param readMaterials 读取某个会话已登记的人工材料。
   *
   * 材料从这里进来而不是顺着调用链一路传参，是因为质询的入口签名只有
   * `(challenger, target)` —— 而 `target` 自己带着 `sessionId`。质询者本来就
   * 该先看一眼"这个人已经交了什么"，否则每一轮都会重复追问同一件事。
   */
  constructor(
    private readonly provider: LlmProvider,
    private readonly readMaterials?: (
      sessionId: string
    ) => Promise<readonly MaterialBrief[]>,
    /**
     * 外部检索。缺席是常态：没配检索服务时这里是 null，提示词里连"来源"两个字
     * 都不会出现——宁可不说，也不能让用户以为查过了。
     */
    private readonly search?: WebSearchProvider | null
  ) {}

  /**
   * 用一条主张去检索，拿到候选来源。
   *
   * 查询词直接用主张原文截断，而不是让模型先写 query：多一次模型调用就多一次
   * 失败与延迟，而质询者要的本来就是"这句话凭什么成立"。检索失败返回空数组，
   * 这一轮照常进行。
   */
  private async searchFor(
    query: string,
    signal?: AbortSignal
  ): Promise<SearchHit[]> {
    if (!this.search) return [];
    const trimmed = toSearchQuery(query);
    if (trimmed === "") return [];
    return this.search.search(trimmed, signal);
  }

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
          /*
           * 主张必须是"关于这个项目的判断"，不是"关于分析过程的说明"。
           *
           * 真实跑出来的反例：模型在资料不全时写"由于信息不足，未能形成可验证
           * 的假设"——它把"我没法判断"当成了一条主张。这种输出对读者零价值：
           * 用户来这里就是要一个判断，哪怕这个判断是带假设的。
           */
          "Every claim must be a judgement ABOUT THIS PROJECT. Never write a claim about the analysis itself, about the information you were not given, or about what you could not determine. Statements like 「由于资料不足，未能形成可验证的假设」「信息不完整，无法判断」are not claims — never output them.",
          "When a number or fact is missing, do not stop: state the value you are assuming, say what it is based on, and set that claim's type to assumption. A stated assumption is what the review is for; silence is not.",
          "Never ask the reader a question and never defer the work back to the user. If the project needs a course of action, write the action: concrete steps someone can start this week, with rough quantities or ranges, ordered by what to do first.",
          `Role: ${role.name}. Goal: ${role.goal}.`
        ].join("\n"),
        user: JSON.stringify({ role, project: runContext.projectInput }),
        correlationId: runContext.agentRunId
      },
      ProviderAnalysisSchema,
      NO_CANCELLATION
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
          claimIds: [claimId],
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

  /**
   * 读材料失败不该让一整轮质询失败。
   *
   * 材料是补充信息：拿不到时质询照常进行，只是会像从前那样追问证据。把一次
   * 读库抖动升级成"这一轮没跑成"，是拿核心能力去陪一个附属功能。
   */
  private async materialsFor(sessionId: string): Promise<MaterialBrief[]> {
    if (!this.readMaterials) return [];
    try {
      return toMaterialBriefs(await this.readMaterials(sessionId));
    } catch {
      return [];
    }
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
      generateChallenge: async (challenger, target, signal) => {
        try {
          const materials = await this.materialsFor(target.sessionId);
          /**
           * 读材料这一步让"取消"有了一个空档：信号如果在这期间到达，而这里
           * 不做检查，接下来会照常发起一次请求——一次已经被叫停的调用。
           * 门在开工前关一次，比让 provider 自己发现要可靠。
           */
          throwIfAborted(signal);
          /*
           * 检索在质询者这一侧做，因为要回答的是"这句话凭什么成立"。
           * 拿不到就是空数组——没配检索服务时这里连一次网络请求都不会发。
           */
          const webSources = await this.searchFor(target.statement, signal);
          throwIfAborted(signal);
          const generated = await generateStructured(
            this.provider,
            {
              schemaName: "challenge:create",
              system: challengeSystemPrompt(
                challenger,
                materials.length,
                webSources.length
              ),
              user: JSON.stringify({
                challenger,
                target,
                ...(materials.length > 0 ? { materials } : {}),
                ...(webSources.length > 0 ? { webSources } : {})
              }),
              // A human-authored claim has no originating run, so the claim
              // itself becomes the correlation anchor.
              correlationId: target.agentRunId ?? target.id
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
            signal ?? NO_CANCELLATION
          );
          return {
            ...generated.data,
            // 候选来源随 draft 交回，由质询层落成事件。它不进 Challenge 本身。
            ...(webSources.length > 0
              ? { webSources, webQuery: toSearchQuery(target.statement) }
              : {})
          };
        } catch (error) {
          // An abort is the operator stopping the run, not the provider
          // failing. Falling back to a template here would keep the work going
          // after the stop was asked for — exactly the behaviour this path is
          // supposed to prevent.
          if (signal?.aborted) throw error;
          return fallbackChallenge(challenger, target);
        }
      },
      respondToChallenge: async (challenge, target, signal) => {
        try {
          const materials = await this.materialsFor(target.sessionId);
          throwIfAborted(signal);
          const webSources = await this.searchFor(challenge.question, signal);
          throwIfAborted(signal);
          const generated = await generateStructured(
            this.provider,
            {
              schemaName: "challenge:respond",
              system: [
                'Return JSON only: {"disposition":"qualify","statement":"修订后的断言","confidence":0.6}. disposition must be one of accept, reject, qualify, insufficient_evidence. Never use pipe-delimited values.',
                materials.length > 0
                  ? "The user message lists material(s) the researcher supplied. If they genuinely answer this challenge, revise the claim to say what the material establishes and raise confidence accordingly. If they do not, answer insufficient_evidence — never claim support a material does not give."
                  : "",
                /*
                 * 回应者最容易犯的错，是拿一条搜索结果去撑自己的主张。
                 * 候选来源只能改变"下一步去哪儿找"，不能改变"已被支持"。
                 */
                webSources.length > 0
                  ? "The user message lists machine-retrieved web source(s). They are unverified candidates: you may cite them as where to look, but they are never grounds for raising confidence or claiming the challenge is resolved. If they do not settle it, answer insufficient_evidence."
                  : ""
              ]
                .filter((line) => line.length > 0)
                .join("\n"),
              user: JSON.stringify({
                challenge,
                target,
                ...(materials.length > 0 ? { materials } : {}),
                ...(webSources.length > 0 ? { webSources } : {})
              }),
              correlationId: challenge.correlationId
            },
            ProviderResponseSchema,
            signal ?? NO_CANCELLATION
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
        } catch (error) {
          if (signal?.aborted) throw error;
          return fallbackResponse(challenge, target);
        }
      },
      evaluateResponse: async (challenge, responseClaim, signal) => {
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
            signal ?? NO_CANCELLATION
          );
          return generated.data.status;
        } catch (error) {
          if (signal?.aborted) throw error;
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
