import { describe, expect, it } from "vitest";
import { collectWebSources } from "./web-sources";

/**
 * 候选来源只做一件事：把事件流里记下的检索结果还原成一行行可点的来源。
 *
 * 它必须容忍"没有这条事件"——绝大多数部署没接检索，事件流里永远不会有它。
 */
function event(payload: unknown, type = "WEB_SOURCES_FOUND") {
  return { type, payload } as never;
}

describe("collectWebSources", () => {
  it("没有检索事件时就是空数组，不是 undefined", () => {
    expect(collectWebSources([])).toEqual([]);
    expect(
      collectWebSources([event({ challenge: {} }, "CHALLENGE_CREATED")])
    ).toEqual([]);
  });

  it("把来源连同质询 id 和检索词一起还原", () => {
    const result = collectWebSources([
      event({
        challengeId: "c-1",
        query: "采购管道",
        sources: [
          { title: "采购公告", url: "https://e.example/1", snippet: "120 万" }
        ]
      })
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.challengeId).toBe("c-1");
    expect(result[0]?.query).toBe("采购管道");
    expect(result[0]?.url).toBe("https://e.example/1");
  });

  it("同一个地址只出现一次——重复登记会把材料列表灌满", () => {
    const one = {
      challengeId: "c-1",
      query: "q",
      sources: [{ title: "A", url: "https://e.example/1", snippet: "" }]
    };
    const result = collectWebSources([
      event(one),
      event({
        ...one,
        challengeId: "c-2",
        sources: [{ title: "A again", url: "https://e.example/1", snippet: "" }]
      })
    ]);
    expect(result).toHaveLength(1);
  });

  it("没有 url 的条目直接丢掉——一句话不是来源", () => {
    const result = collectWebSources([
      event({
        challengeId: "c-1",
        query: "q",
        sources: [{ title: "据说很便宜", snippet: "无出处" }]
      })
    ]);
    expect(result).toEqual([]);
  });

  it("坏数据不炸：payload 不是对象、sources 不是数组", () => {
    expect(collectWebSources([event(null)])).toEqual([]);
    expect(collectWebSources([event({ sources: "nope" })])).toEqual([]);
    expect(collectWebSources([event({ sources: [null, 3] })])).toEqual([]);
  });
});
