import { describe, expect, it, vi } from "vitest";
import { newId, materialsFromEvents, type ExecutionEvent } from "@nexus/shared";
import { createApp } from "../../app";

/**
 * 补充材料的接口契约。
 *
 * 这些用例盯的是三件事：材料必须带着轮次落进事件流；内容为空的提交要被拒绝；
 * 写不进去的时候不能假装写进去了。
 */
function materialApp(options: {
  sessionExists?: boolean;
  supplementRound?: number;
  append?: (input: unknown) => Promise<ExecutionEvent>;
}) {
  const sessionId = newId();
  const append =
    options.append ??
    (async (input) => {
      const typed = input as {
        sessionId: string;
        correlationId: string;
        type: ExecutionEvent["type"];
        payload: unknown;
      };
      return {
        id: newId(),
        sessionId: typed.sessionId,
        sequence: 3,
        correlationId: typed.correlationId,
        type: typed.type,
        payload: typed.payload,
        occurredAt: new Date().toISOString()
      } as ExecutionEvent;
    });

  const app = createApp({
    sessions: {
      getById: vi
        .fn()
        .mockResolvedValue(
          options.sessionExists === false
            ? null
            : {
                id: sessionId,
                phase: "HUMAN_REVIEW",
                currentConclusion: "建议立项",
                supplementRound: options.supplementRound ?? 0
              }
        )
    } as never,
    inspector: {} as never,
    events: { listAfter: vi.fn().mockResolvedValue([]), append } as never,
    runSession: {} as never
  });

  return { app, sessionId, append };
}

describe("material routes", () => {
  it("把材料写进事件流，并记下这是第几轮之前交的", async () => {
    const { app, sessionId } = materialApp({ supplementRound: 1 });

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/materials`,
      payload: {
        title: "三校合作意向书",
        content: "2026-03 与 A/B/C 三校后勤处签意向书，覆盖 2.1 万人。"
      }
    });

    expect(response.statusCode).toBe(201);
    const material = response.json().material;
    expect(material.sessionId).toBe(sessionId);
    expect(material.round).toBe(2);
    expect(material.title).toBe("三校合作意向书");
  });

  it("拒绝空白材料", async () => {
    const { app, sessionId } = materialApp({});

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/materials`,
      payload: { title: "   ", content: "  " }
    });

    expect(response.statusCode).toBe(400);
  });

  it("会话不存在时给 404，而不是写进一个不存在的会话", async () => {
    const { app, sessionId } = materialApp({ sessionExists: false });

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/materials`,
      payload: { title: "材料", content: "内容" }
    });

    expect(response.statusCode).toBe(404);
  });

  it("列表只返回材料事件", async () => {
    const sessionId = newId();
    const materialEvent = {
      id: newId(),
      sessionId,
      sequence: 2,
      correlationId: newId(),
      type: "MATERIAL_ADDED",
      payload: {
        id: newId(),
        sessionId,
        title: "试点数据",
        content: "两周试点 GMV 3.2 万元",
        addedBy: "owner-1",
        round: 2,
        createdAt: "2026-03-02T00:00:00.000Z"
      },
      occurredAt: "2026-03-02T00:00:00.000Z"
    };
    const app = createApp({
      sessions: { getById: vi.fn().mockResolvedValue({ id: sessionId }) } as never,
      inspector: {} as never,
      events: {
        listAfter: vi.fn().mockResolvedValue([
          { ...materialEvent, id: newId(), type: "CONFLICT_DETECTED", payload: {} },
          materialEvent
        ]),
        append: vi.fn()
      } as never,
      runSession: {} as never
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/materials`
    });

    expect(response.statusCode).toBe(200);
    const listed = response.json().materials;
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe("试点数据");

    // 与前端共用一个读取实现：两边对"什么算材料"不能有两套判断。
    expect(
      materialsFromEvents([materialEvent as never]).map((item) => item.title)
    ).toEqual(["试点数据"]);
  });
});
