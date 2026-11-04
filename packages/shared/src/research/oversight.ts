import { z } from "zod";

/**
 * 「人有没有真的在把关」——一个部署里可以数出来的事实。
 *
 * 这里刻意只有计数，没有评分。研究材料的六维质量分在
 * `research/research-quality` 里，那是「这批材料可不可信」；这里回答的是另一个
 * 问题：「AI 给出的结论，最后有没有人真的拍过板」。两个问题共用「质量」这个词
 * 就会互相顶替，所以这一层叫 oversight。
 *
 * 三条规矩：
 *
 *  1. **一条记录都不新存。** 每个数字都是既有行的一次 GROUP BY。分歧、裁决和
 *     运行本来就为了自己的理由存在，这个面板只是又一种看法。存一份副本意味着
 *     它会在被撤销、被重试、被删除之后继续宣称。
 *  2. **分母为零时不给比率。** 零次裁决里的「采纳率」不是 0%，是没有。返回
 *     `null`，由界面说「还没有数据」，而不是画一根到底的柱。
 *  3. **统计范围就是可读范围。** 传进来的会话集合由鉴权守卫算出，与列表页、
 *     消息中心同一个来源。跨账号的聚合数字是泄露。
 */
export const OversightCountsSchema = z.object({
  /** 被统计的研究数量，让「N 项研究里」这句话有据可依。 */
  sessionCount: z.number().int().nonnegative(),
  conflicts: z.object({
    /** 全部已检出分歧。 */
    total: z.number().int().nonnegative(),
    /** 其中被标记为必须人工裁决的。 */
    requiringHuman: z.number().int().nonnegative(),
    /** 必须人工、且还没落定 —— 这些是真正挂着的。 */
    awaitingHuman: z.number().int().nonnegative(),
    /** 已落定。 */
    resolved: z.number().int().nonnegative()
  }),
  decisions: z.object({
    total: z.number().int().nonnegative(),
    /** 采纳质询：人认为质询成立，主张被推翻。 */
    acceptChallenge: z.number().int().nonnegative(),
    /** 维持主张：人认为质询不成立。 */
    upholdClaim: z.number().int().nonnegative(),
    /** 要求补充分析：人拒绝在现有材料上拍板。 */
    requestMoreAnalysis: z.number().int().nonnegative()
  }),
  runs: z.object({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    timedOut: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    /**
     * 由重试产生的行（`attempt > 1`），不是「失败了几次」。
     * 两者一起看才有意义：失败多但重试少，说明没人管；失败少但重试多，
     * 说明第一次几乎从不成功。
     */
    retried: z.number().int().nonnegative()
  })
});

export type OversightCounts = z.infer<typeof OversightCountsSchema>;

export const EMPTY_OVERSIGHT_COUNTS: OversightCounts = {
  sessionCount: 0,
  conflicts: { total: 0, requiringHuman: 0, awaitingHuman: 0, resolved: 0 },
  decisions: { total: 0, acceptChallenge: 0, upholdClaim: 0, requestMoreAnalysis: 0 },
  runs: { total: 0, completed: 0, failed: 0, timedOut: 0, cancelled: 0, retried: 0 }
};

/**
 * 质询被采纳的比例，即「人没有顺着主张走」的频率。
 *
 * `null` 而不是 0：分母为零时这个比率不存在。把它画成 0% 会让一个从没被裁决过
 * 的工作区看起来像「AI 从不被推翻」，那是相反的结论。
 */
export function challengeAcceptedRate(counts: OversightCounts): number | null {
  if (counts.decisions.total === 0) return null;
  return counts.decisions.acceptChallenge / counts.decisions.total;
}

/**
 * 跑完的运行占比。
 *
 * 分子是 `completed`，不是「没失败」——取消和超时都不算跑完，把它们算进成功
 * 会让「取消了也算好」这种话出现在界面上。
 */
export function completedRunRate(counts: OversightCounts): number | null {
  if (counts.runs.total === 0) return null;
  return counts.runs.completed / counts.runs.total;
}

/** 百分比文案，`null` 时明确说没有数据，而不是印 `0%`。 */
export function formatRate(rate: number | null): string {
  if (rate === null) return "暂无数据";
  return `${Math.round(rate * 100)}%`;
}
