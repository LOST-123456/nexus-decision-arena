import {
  CreateSessionMaterialSchema,
  materialsFromEvents,
  newId,
  type SessionMaterial
} from "@nexus/shared";
import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../../app";
import type { EventBus } from "../../execution/event-bus";

/**
 * 人工补充材料。
 *
 * 一个项目很少一次评审就能定论。第一轮质询问出来的通常是"你拿不出证据"，
 * 而补上证据本身就是一个动作——所以这里给的是"交材料"这个动词，不是"编辑项目
 * 描述"。项目描述是评审的起点，改动它会让此前所有轮次的结论失去参照；材料是
 * 追加的，带着时间戳和轮次，谁在什么时候补了什么一清二楚。
 *
 * 材料写进事件流（`MATERIAL_ADDED`），因此不可改写、不可删除、天然按序。
 */
export function registerMaterialRoutes(
  app: FastifyInstance,
  dependencies: Pick<AppDependencies, "sessions" | "events" | "auth">,
  eventBus: EventBus
): void {
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/materials",
    async (request, reply) => {
      const events = await dependencies.events.listAfter(request.params.id, 0);
      return reply.code(200).send({ materials: materialsFromEvents(events) });
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/materials",
    async (request, reply) => {
      const user = dependencies.auth?.userFromRequest(request) ?? null;
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      // 只读账户可以看材料，但不能替项目提供事实依据。
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }

      const parsed = CreateSessionMaterialSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid material",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const session = await dependencies.sessions.getById(sessionId);
      if (!session) {
        return reply
          .code(404)
          .send({ error: "Session not found", code: "session_not_found" });
      }

      const material: SessionMaterial = {
        id: newId(),
        sessionId,
        title: parsed.data.title,
        content: parsed.data.content,
        // 用账号名而不是内部 id：这条记录是给人看的审计线索，一串 uuid
        // 既认不出人，也无从追问。
        addedBy: user?.username ?? user?.id ?? "operator",
        // 记下交材料时会话已经完成了几轮补充分析：下一轮质询据此判断
        // "这份材料是在这批问题之前还是之后到的"。
        round: (session.supplementRound ?? 0) + 1,
        createdAt: new Date().toISOString()
      };

      await eventBus.publishAfterCommit({
        append: () =>
          dependencies.events.append({
            sessionId,
            correlationId: material.id,
            type: "MATERIAL_ADDED",
            payload: material
          })
      });

      return reply.code(201).send({ material });
    }
  );
}
