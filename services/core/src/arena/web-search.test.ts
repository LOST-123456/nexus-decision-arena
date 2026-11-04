import { describe, expect, it, vi, afterEach } from "vitest";
import {
  createSearchProviderFromEnv,
  describeSearch,
  HttpSearchProvider,
  toSearchHits,
  toSearchQuery
} from "./web-search";

/**
 * 检索这一层只有两种状态：真的查了，或者根本没接。
 *
 * 没有第三种"看起来查过了"。这些用例钉的是这条边界——尤其是"没配服务
 * 必须返回 null"，因为一旦它退化成一个返回空数组的 provider，上层就会以为
 * "查了但没有结果"，也就会在提示词里写上"未检索到相关来源"。
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSearchProviderFromEnv", () => {
  it("没配检索地址时不造一个假 provider", () => {
    expect(createSearchProviderFromEnv({})).toBeNull();
    expect(createSearchProviderFromEnv({ SEARCH_API_URL: "   " })).toBeNull();
  });

  it("配了地址就有 provider，名字可以不配", () => {
    const provider = createSearchProviderFromEnv({
      SEARCH_API_URL: "https://search.example/api"
    });
    expect(provider?.name).toBe("http-search");
    expect(
      createSearchProviderFromEnv({
        SEARCH_API_URL: "https://search.example/api",
        SEARCH_API_PROVIDER: "tavily-proxy"
      })?.name
    ).toBe("tavily-proxy");
  });
});

describe("describeSearch", () => {
  it("没接时说的是没接，不是没找到", () => {
    const status = describeSearch(null);
    expect(status.enabled).toBe(false);
    expect(status.note).toContain("没有配置检索服务");
    expect(status.note).not.toContain("没有找到");
  });

  it("接了也要说清候选来源未经核实", () => {
    const status = describeSearch({ name: "x", search: async () => [] });
    expect(status.enabled).toBe(true);
    expect(status.note).toContain("未经核实");
  });
});

describe("toSearchHits", () => {
  it("认得 results / items / 裸数组三种形状", () => {
    const hit = { title: "报价页", url: "https://a.example", snippet: "单价 12 元" };
    expect(toSearchHits({ results: [hit] })).toHaveLength(1);
    expect(toSearchHits({ items: [hit] })).toHaveLength(1);
    expect(toSearchHits([hit])).toHaveLength(1);
  });

  it("没有链接的条目不算来源", () => {
    // 一句话不是来源。留着它，模型就会把它当成依据引用。
    expect(
      toSearchHits({ results: [{ title: "据说很便宜", snippet: "无出处" }] })
    ).toHaveLength(0);
  });

  it("最多三条，摘录截断", () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      title: `t${index}`,
      url: `https://e.example/${index}`,
      snippet: "字".repeat(400)
    }));
    const hits = toSearchHits({ results: many });
    expect(hits).toHaveLength(3);
    expect(hits[0]!.snippet.endsWith("…")).toBe(true);
  });
});

describe("HttpSearchProvider", () => {
  it("POST 出去、带 Bearer、把结果转成 hits", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: "招投标公告", url: "https://b.example/1", content: "单价" }]
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpSearchProvider({
      url: "https://search.example/api",
      apiKey: "k-1",
      name: "test"
    });
    const hits = await provider.search("校园二手教材 佣金");

    expect(hits[0]?.url).toBe("https://b.example/1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://search.example/api");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer k-1");
    expect(JSON.parse(init.body).query).toBe("校园二手教材 佣金");
  });

  it("搜索服务挂了不抛错——附属能力不该拖垮整轮评审", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const provider = new HttpSearchProvider({
      url: "https://search.example/api",
      apiKey: "",
      name: "test"
    });
    expect(await provider.search("q")).toEqual([]);
  });

  it("非 2xx 也返回空，不把错误页当结果", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    );
    const provider = new HttpSearchProvider({
      url: "https://search.example/api",
      apiKey: "",
      name: "test"
    });
    expect(await provider.search("q")).toEqual([]);
  });
});

describe("toSearchQuery", () => {
  it("洗掉标点与多余空白，长度收敛", () => {
    expect(toSearchQuery("校园二手教材循环平台是否值得规模化投入？")).toBe(
      "校园二手教材循环平台是否值得规模化投入"
    );
    expect(toSearchQuery("  a  b\n c ")).toBe("a b c");
    expect(toSearchQuery("x".repeat(200)).length).toBe(80);
  });

  it("全是标点时返回空串，调用方据此不发请求", () => {
    expect(toSearchQuery("？？？！！！")).toBe("");
  });
});
