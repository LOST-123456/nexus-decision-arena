import {
  ChallengeSchema,
  ClaimSchema,
  newId,
  type AgentRole,
  type Challenge,
  type Claim,
  type Conflict,
  type ExecutionEvent
} from "@nexus/shared";
import { selectClaims } from "../workflow/claim-selector";
import { assignChallengers } from "../workflow/challenger-assigner";
import { detectConflicts } from "../workflow/conflict-detector";

export type CrossExaminationInput = {
  sessionId: string;
  claims: Claim[];
  roles: AgentRole[];
  plans?: CrossExaminationPlan[];
  /**
   * Persistence callbacks may answer `false`, meaning "this run may no longer
   * write" — the caller's row-locked guard refused the write because the run
   * was cancelled. The engine then stops that run's remaining work instead of
   * pretending it produced something.
   */
  persistChallenge?: (challenge: Challenge) => Promise<void | boolean>;
  persistResponseClaim?: (claim: Claim) => Promise<void | boolean>;
  persistChallengeUpdate?: (challenge: Challenge) => Promise<void | boolean>;
  persistConflict?: (conflict: Conflict) => Promise<void | boolean>;
  /**
   * The cancellation signal for one challenger run. Supplied by the caller that
   * owns the runs; the engine passes it to the provider on every call so an
   * abort actually interrupts the request instead of being observed too late.
   */
  signalFor?: (challengerRunId: string) => AbortSignal | undefined;
  emit: (
    event: Partial<ExecutionEvent> & { type: ExecutionEvent["type"] }
  ) => Promise<void> | void;
};

/**
 * Raised when a run's write was refused because that run is no longer running.
 * It is not a failure of the work — it is the work being stopped on purpose.
 */
export class CrossExaminationHaltedError extends Error {
  constructor(readonly challengerRunId: string) {
    super(`Cross-examination halted: run ${challengerRunId} is no longer running.`);
    this.name = "CrossExaminationHaltedError";
  }
}

export type CrossExaminationPlan = {
  targetClaimId: string;
  challengerRoleId: string;
  challengerRunId: string;
};

export type ChallengeDraft = Pick<
  Challenge,
  | "type"
  | "question"
  | "context"
  | "requiredEvidence"
  | "severity"
  | "resolutionStrategy"
> & {
  /**
   * 这次质询用到过的外部检索结果。
   *
   * 它不属于 `Challenge`（schema 里没有这个字段，也不该有）：候选来源不是
   * 质询的一部分，是"为什么问出这句话"的旁证。所以它随事件落库，不随质询
   * 持久化。
   */
  webQuery?: string;
  webSources?: readonly { title: string; url: string; snippet: string }[];
};

export type CrossExaminationResult = {
  challenges: Challenge[];
  responseClaims: Claim[];
  conflicts: Conflict[];
};

type CrossExaminationDependencies = {
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
};

/**
 * 同时跑多少条质询。
 *
 * 一条质询要三次模型调用（提问、应答、判定），十条就是三十次请求，而这些
 * 请求互相之间没有依赖——针对不同主张、不同质询者。真正决定这一轮快慢的
 * 是并发路数，不是代码本身。
 *
 * 实测（DeepSeek `deepseek-chat`，单次调用约 1.6 秒往返）：四路并发时整轮
 * 12 秒；路数提到与条数相同时，每一路只做一条质询，三次调用串行也就是三轮，
 * 4~5 秒。再往上加没有意义——一轮最多 10 条（5 条主张 × 2 个质询者）。
 *
 * 默认 6：比原来的 4 快一截，又不至于把模型服务的并发额度顶满。部署可以按
 * 自己的额度用 `CHALLENGE_CONCURRENCY` 覆盖，上限 12。
 */
function resolveChallengeConcurrency(): number {
  const raw = Number(process.env.CHALLENGE_CONCURRENCY ?? 6);
  if (!Number.isFinite(raw) || raw <= 0) return 6;
  return Math.min(12, Math.floor(raw));
}

/**
 * 限流并发映射，结果按输入顺序返回。
 *
 * 顺序必须保持：冲突检测与最终报告读的是质询的先后，"谁先跑完"不该决定
 * 谁排在前面。
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await run(items[index]!, index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function validateResponseRevision(
  response: Claim,
  target: Claim,
  challenge: Challenge
): Claim {
  const parsed = ClaimSchema.parse(response);

  if (
    parsed.id === target.id ||
    parsed.revisionOfClaimId !== target.id ||
    parsed.revision <= target.revision
  ) {
    throw new Error(
      `Challenge ${challenge.id} must produce a newer Claim revision of ${target.id}`
    );
  }

  if (parsed.respondsToChallengeId !== challenge.id) {
    throw new Error(
      `Response Claim ${parsed.id} does not answer Challenge ${challenge.id}`
    );
  }

  if (parsed.sessionId !== target.sessionId) {
    throw new Error(
      `Response Claim ${parsed.id} belongs to a different session`
    );
  }

  return parsed;
}

export class CrossExaminationService {
  constructor(private readonly dependencies: CrossExaminationDependencies) {}

  async run(input: CrossExaminationInput): Promise<CrossExaminationResult> {
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
    const challenges: Challenge[] = [];
    const responseClaims: Claim[] = [];
    const claimById = new Map(input.claims.map((claim) => [claim.id, claim]));
    const roleById = new Map(input.roles.map((role) => [role.id, role]));
    const work = input.plans
      ? input.plans.flatMap((plan) => {
          const target = claimById.get(plan.targetClaimId);
          const challenger = roleById.get(plan.challengerRoleId);
          return target && challenger
            ? [{ target, challenger, challengerRunId: plan.challengerRunId }]
            : [];
        })
      : selectClaims(input.claims, maxClaims).flatMap((target) =>
          assignChallengers(target, input.roles, maxChallengers).map((challenger) => ({
            target,
            challenger,
            challengerRunId: newId()
          }))
        );

    /**
     * 先说出这一轮一共要做多少条质询。
     *
     * 页面光看一个越走越大的计时器，分不清"在推进"和"卡住了"。有 total
     * 之后，已产生的质询数除以它就是进度。
     */
    if (work.length > 0) {
      await input.emit({
        type: "CHALLENGE_BATCH_STARTED",
        payload: { total: work.length },
        correlationId: newId()
      });
    }

    /**
     * 逐条质询，但并发跑。
     *
     * 之前是一个 for 循环 await 到底：每条质询要三次模型调用（提问、应答、
     * 判定），十条就是三十次串行请求，整轮的时间全花在等模型上。各条质询
     * 彼此独立——针对不同主张、不同质询者——所以改成限流并发。
     *
     * 结果按输入顺序收集，不按完成顺序：冲突检测与最终报告读的是顺序，
     * 不能因为谁先跑完谁就排到前面。
     */
    const outcomes = await mapWithConcurrency(
      work,
      resolveChallengeConcurrency(),
      async ({ target, challenger, challengerRunId }) => {
        const correlationId = newId();
        const signal = input.signalFor?.(challengerRunId);
        /*
         * 质询一旦创建成功就存在了，哪怕它的应答后来失败。
         *
         * 这一点不能因为并发改造丢掉：那条质询已经落库、已经发了事件，报告与
         * 审计包必须看得到它——"问出来了但没答上来"本身就是事实。失败时把它
         * 按 open 状态带回去，和串行时一模一样。
         */
        let created: Challenge | null = null;

        try {
          const draft = await this.dependencies.generateChallenge(
            challenger,
            structuredClone(target),
            signal
          );
          const now = new Date().toISOString();
          const challenge = ChallengeSchema.parse({
            id: newId(),
            sessionId: input.sessionId,
            targetClaimId: target.id,
            challengerRunId,
            challengerRoleId: challenger.id,
            ...draft,
            status: "open",
            correlationId,
            createdAt: now,
            updatedAt: now
          });
          created = challenge;
          // Push only after the write is accepted: a refused write must not
          // leave the engine believing this run produced a challenge.
          const challengeStored = await input.persistChallenge?.(
            structuredClone(challenge)
          );
          if (challengeStored === false) {
            throw new CrossExaminationHaltedError(challengerRunId);
          }
          await input.emit({
            type: "CHALLENGE_CREATED",
            payload: structuredClone(challenge),
            correlationId: challenge.correlationId
          });
          /*
           * 候选来源单独落一条事件。
           *
           * 不塞进 CHALLENGE_CREATED 的 payload：那条事件的形状已经被页面、
           * 导出和审计包读着，往里面加字段会让"质询长什么样"取决于有没有配
           * 检索服务。单独一条事件，读不到就是没有，读得到也明确是候选。
           */
          if (draft.webSources && draft.webSources.length > 0) {
            await input.emit({
              type: "WEB_SOURCES_FOUND",
              payload: {
                challengeId: challenge.id,
                targetClaimId: target.id,
                query: draft.webQuery ?? "",
                sources: draft.webSources
              },
              correlationId: challenge.correlationId
            });
          }

          const response = validateResponseRevision(
            await this.dependencies.respondToChallenge(
              challenge,
              structuredClone(target),
              signal
            ),
            target,
            challenge
          );
          const responseStored = await input.persistResponseClaim?.(
            structuredClone(response)
          );
          if (responseStored === false) {
            throw new CrossExaminationHaltedError(challengerRunId);
          }
          challenge.status = "answered";
          challenge.responseClaimId = response.id;
          challenge.status = await this.dependencies.evaluateResponse(
            challenge,
            response,
            signal
          );
          challenge.updatedAt = new Date().toISOString();
          const updateStored = await input.persistChallengeUpdate?.(
            structuredClone(challenge)
          );
          if (updateStored === false) {
            throw new CrossExaminationHaltedError(challengerRunId);
          }
          await input.emit({
            type: "CHALLENGE_RESOLVED",
            payload: challenge,
            correlationId: challenge.correlationId
          });
          return { challenge, response };
        } catch (error) {
          if (
            error instanceof CrossExaminationHaltedError ||
            signal?.aborted === true
          ) {
            // A cancelled run did not fail — it was stopped on purpose.
            // Emitting CHALLENGE_FAILED here would put a failure badge on an
            // operator's deliberate action. An abort also counts even without
            // the sentinel error: a provider that honoured the signal rejects
            // with its own AbortError, and that is the same event.
            return { challenge: created, response: null };
          }
          await input.emit({
            type: "CHALLENGE_FAILED",
            payload: {
              targetClaimId: target.id,
              challengerRoleId: challenger.id,
              message:
                error instanceof Error
                  ? error.message
                  : "Unknown challenge failure"
            },
            correlationId
          });
          return { challenge: created, response: null };
        }
      }
    );

    for (const outcome of outcomes) {
      if (outcome.challenge !== null) challenges.push(outcome.challenge);
      if (outcome.response !== null) responseClaims.push(outcome.response);
    }

    const conflicts = detectConflicts({
      sessionId: input.sessionId,
      claims: [...input.claims, ...responseClaims],
      challenges
    });

    for (const conflict of conflicts) {
      const stored = await input.persistConflict?.(structuredClone(conflict));
      if (stored === false) {
        // The run behind this conflict was cancelled before the write landed.
        // Nothing was persisted, so nothing may be announced.
        continue;
      }
      await input.emit({
        type: "CONFLICT_DETECTED",
        payload: conflict,
        correlationId: newId()
      });
    }

    return { challenges, responseClaims, conflicts };
  }
}
