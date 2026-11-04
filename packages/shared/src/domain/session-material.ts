import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

/**
 * 人工补充的一份材料。
 *
 * 一个项目很少一次评审就能定论：第一轮问出来的往往是"你没有证据"，而补上
 * 证据本身就是一个动作。材料把这一步变成可追溯的事实——谁在第几轮之前交了
 * 什么——下一轮质询才有东西可读，报告也才说得清"结论是在哪些材料之后形成的"。
 *
 * 存储上材料是 `MATERIAL_ADDED` 事件（见 `event.ts` 的说明），所以这里的
 * schema 同时是事件 payload 的形状。
 */
export const SessionMaterialSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  title: z.string().min(1).max(120),
  content: z.string().min(1).max(4000),
  addedBy: z.string().min(1),
  /** 交这份材料时，会话已经完成了几轮补充分析。 */
  round: z.number().int().min(1),
  createdAt: TimestampSchema
});

export type SessionMaterial = z.infer<typeof SessionMaterialSchema>;

/** 新建材料时客户端只需要给这两项；其余由服务端补。 */
export const CreateSessionMaterialSchema = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(4000)
});

export type CreateSessionMaterial = z.infer<typeof CreateSessionMaterialSchema>;

/**
 * 从事件流里读出材料。
 *
 * 入参只要求 `type` 和 `payload`：仓库层读出来的行把 `type` 标成宽泛的
 * `string`（数据库列就是 text），如果这里坚持要 `ExecutionEvent`，每个调用点都
 * 得先做一次没有意义的断言。
 *
 * 宁可少读也不抛错：一条格式不对的旧材料不应该让整页会话渲染失败——材料是
 * 补充信息，不是会话成立的前提。读不出来的那一条会消失在列表里，但它仍在
 * 时间线上，仍然可以被审计。
 */
export function materialsFromEvents(
  events: readonly { type: string; payload: unknown }[]
): SessionMaterial[] {
  const materials: SessionMaterial[] = [];
  for (const event of events) {
    if (event.type !== "MATERIAL_ADDED") continue;
    const parsed = SessionMaterialSchema.safeParse(event.payload);
    if (parsed.success) {
      materials.push(parsed.data);
    }
  }
  return materials;
}
