import { describe, expect, it } from "vitest";
import { newId } from "../ids";
import { materialsFromEvents } from "./session-material";

const SESSION_ID = newId();

function materialEvent(overrides: {
  id?: string;
  title?: string;
  round?: number;
  type?: string;
  payload?: unknown;
}) {
  return {
    id: overrides.id ?? newId(),
    sessionId: SESSION_ID,
    sequence: 1,
    correlationId: newId(),
    type: overrides.type ?? "MATERIAL_ADDED",
    payload:
      overrides.payload ??
      {
        id: overrides.id ?? newId(),
        sessionId: SESSION_ID,
        title: overrides.title ?? "三校合作意向",
        content: "2026-03 与 A/B/C 三校后勤处签意向书。",
        addedBy: "owner-1",
        round: overrides.round ?? 1,
        createdAt: "2026-03-01T00:00:00.000Z"
      },
    occurredAt: "2026-03-01T00:00:00.000Z"
  };
}

describe("materialsFromEvents", () => {
  it("只挑材料事件，不动别的", () => {
    const events = [
      materialEvent({ title: "第一份" }),
      { ...materialEvent({}), type: "CONFLICT_DETECTED" },
      materialEvent({ title: "第二份", round: 2 })
    ];

    const materials = materialsFromEvents(events);

    expect(materials.map((item) => item.title)).toEqual(["第一份", "第二份"]);
    expect(materials[1]?.round).toBe(2);
  });

  it("跳过读不出来的那一条，而不是让整页报错", () => {
    // 材料是补充信息：一条早期格式的材料不该让会话渲染失败。
    const events = [
      materialEvent({ title: "好的" }),
      materialEvent({ payload: { title: "缺字段" } })
    ];

    expect(materialsFromEvents(events)).toHaveLength(1);
  });

  it("空事件流就是没有材料", () => {
    expect(materialsFromEvents([])).toEqual([]);
  });
});
