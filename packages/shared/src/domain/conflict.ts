import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const ConflictStatusSchema = z.enum([
  "detected",
  "human_review",
  "resolved"
]);

export const ConflictSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  claimIds: z.array(IdSchema).min(1),
  challengeIds: z.array(IdSchema),
  type: z.enum(["evidence", "logic", "assumption", "priority"]),
  summary: z.string().min(1),
  severity: z.number().int().min(1).max(5),
  status: ConflictStatusSchema,
  humanDecisionRequired: z.boolean(),
  resolutionSuggestion: z.string().min(1),
  impactScope: z.object({
    analysisAreas: z.array(
      z.enum(["market", "technology", "finance", "risk", "operations"])
    ),
    stakeholders: z.array(z.string())
  }),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});

export type Conflict = z.infer<typeof ConflictSchema>;
export type ConflictStatus = z.infer<typeof ConflictStatusSchema>;

/**
 * 冲突类型的中文说法。冲突面板要把"这是哪一类分歧"讲清楚——只给
 * `evidence` 这样的枚举名，用户无法判断该补材料还是该改判断。
 */
export const CONFLICT_TYPE_LABELS: Record<Conflict["type"], string> = {
  evidence: "证据缺口",
  logic: "推理瑕疵",
  assumption: "未验证假设",
  priority: "优先级分歧"
};

export function conflictTypeLabel(value: string): string {
  return value in CONFLICT_TYPE_LABELS
    ? CONFLICT_TYPE_LABELS[value as Conflict["type"]]
    : value;
}
