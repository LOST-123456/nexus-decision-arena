import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const HumanDecisionSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  conflictId: IdSchema,
  action: z.enum([
    "accept_challenge",
    "uphold_claim",
    "request_more_analysis"
  ]),
  rationale: z.string().min(1),
  affectedClaimIds: z.array(IdSchema),
  affectedAgentRoleIds: z.array(IdSchema),
  previousConclusion: z.string().min(1),
  newConclusion: z.string().min(1),
  operatorId: z.string().min(1),
  createdAt: TimestampSchema
});

export type HumanDecision = z.infer<typeof HumanDecisionSchema>;

/**
 * 人工裁决动作的中文说法。枚举名（accept_challenge 等）只用于机器，
 * 面向用户的文案统一放在这里，避免下游各自拼英文。
 */
export const HUMAN_ACTION_LABELS: Record<HumanDecision["action"], string> = {
  accept_challenge: "采纳关键质询",
  uphold_claim: "维持原判断",
  request_more_analysis: "要求补充一轮分析"
};

export function humanActionLabel(action: string): string {
  return action in HUMAN_ACTION_LABELS
    ? HUMAN_ACTION_LABELS[action as HumanDecision["action"]]
    : action;
}

/**
 * 按钮与状态条上的短说法。
 *
 * 同一个动作有两种长度：裁决面板按钮只有三格宽，只能放短说法；
 * 历史、报告与审计需要完整说法（"采纳关键质询"）。两套都由这里定义，
 * 这样按钮点下去之后的状态条不会把动作叫成另一个名字。
 */
export const HUMAN_ACTION_SHORT_LABELS: Record<HumanDecision["action"], string> =
  {
    accept_challenge: "采纳质询",
    uphold_claim: "维持判断",
    request_more_analysis: "要求补充分析"
  };

export function humanActionShortLabel(action: string): string {
  return action in HUMAN_ACTION_SHORT_LABELS
    ? HUMAN_ACTION_SHORT_LABELS[action as HumanDecision["action"]]
    : action;
}
