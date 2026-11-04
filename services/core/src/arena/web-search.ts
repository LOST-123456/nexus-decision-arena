/**
 * 外部检索：把"它自己上网找"做成一个可以缺席的部件。
 *
 * 为什么先做接口再谈实现：这个产品最不能出的错，是让人以为材料被核实过。
 * 检索也一样——如果没配检索服务却在界面上暗示"已联网查证"，那比不查更糟。
 * 所以这里只有两种状态，没有第三种：
 *
 *   - 配了 `SEARCH_API_URL`：真的发请求，拿回 title/url/snippet；
 *   - 没配：返回 `null`，调用方据此**什么都不说**，而不是说"没找到"。
 *
 * 检索结果永远只是「候选来源」，`verificationStatus` 仍是 unverified。它能让
 * 追问落到具体地方（"去这家供应商的公开报价页找"），但不能让一句话变成已核实
 * 的结论。
 */

export type SearchHit = {
  title: string;
  url: string;
  snippet: string;
};

export interface WebSearchProvider {
  readonly name: string;
  /** 失败一律返回空数组：检索是附属能力，不该把一整轮评审拖垮。 */
  search(query: string, signal?: AbortSignal): Promise<SearchHit[]>;
}

/**
 * 把一句主张洗成可以用去检索的查询词。
 *
 * 洗标点不是洁癖：带着问号/句号去搜，搜索引擎会把它当成短语的一部分，命中率
 * 明显下降。抽成纯函数是为了让"实际发出去的词"和"记进事件的词"是同一个——
 * 否则审计包里的 query 和真实请求对不上，等于没记。
 */
export function toSearchQuery(raw: string): string {
  return raw
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export type SearchStatus = {
  enabled: boolean;
  provider: string;
  /** 给界面/接口用的一句实话，别让"没接"看起来像"没找到"。 */
  note: string;
};

/** 一轮质询最多看几条：多了会把 claim 本身挤出上下文。 */
const RESULT_LIMIT = 3;
const SNIPPET_CHARS = 300;
const DEFAULT_TIMEOUT_MS = 8000;

type SearchResponseShape = {
  results?: unknown;
  items?: unknown;
  data?: unknown;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 兼容三种常见的返回形状，而不是要求用户去改造他的搜索服务。
 *
 * 真实部署里 `SEARCH_API_URL` 后面可能是 Tavily、Serper、Bing 的代理，也可能
 * 是团队自己包的一层。只认一种形状，等于把这个功能限定在一种服务上。
 */
export function toSearchHits(payload: unknown): SearchHit[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? ((payload as SearchResponseShape).results ??
        (payload as SearchResponseShape).items ??
        (payload as SearchResponseShape).data)
      : null;
  if (!Array.isArray(list)) return [];

  const hits: SearchHit[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const url = asString(item.url) || asString(item.link);
    // 没有链接的条目不是来源，只是一句话。丢掉它，免得被当成依据。
    if (url === "") continue;
    const snippet =
      asString(item.snippet) ||
      asString(item.content) ||
      asString(item.description);
    hits.push({
      title: asString(item.title) || url,
      url,
      snippet:
        snippet.length > SNIPPET_CHARS
          ? `${snippet.slice(0, SNIPPET_CHARS)}…`
          : snippet
    });
    if (hits.length >= RESULT_LIMIT) break;
  }
  return hits;
}

export class HttpSearchProvider implements WebSearchProvider {
  constructor(
    private readonly config: {
      url: string;
      apiKey: string;
      name: string;
      timeoutMs?: number;
    }
  ) {}

  get name(): string {
    return this.config.name;
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
    const timeout = AbortSignal.timeout(
      this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    // 调用方的取消信号也要生效：一轮被叫停的评审不该还在等搜索结果。
    const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(this.config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey
            ? { authorization: `Bearer ${this.config.apiKey}` }
            : {})
        },
        body: JSON.stringify({ query, limit: RESULT_LIMIT }),
        signal: composite
      });
      if (!response.ok) return [];
      return toSearchHits(await response.json());
    } catch {
      return [];
    }
  }
}

export function createSearchProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env
): WebSearchProvider | null {
  const url = (env.SEARCH_API_URL ?? "").trim();
  if (url === "") return null;
  return new HttpSearchProvider({
    url,
    apiKey: (env.SEARCH_API_KEY ?? "").trim(),
    name: (env.SEARCH_API_PROVIDER ?? "").trim() || "http-search"
  });
}

export function describeSearch(
  provider: WebSearchProvider | null
): SearchStatus {
  if (!provider) {
    return {
      enabled: false,
      provider: "未接入",
      note: "没有配置检索服务，本轮结论只基于模型知识与项目资料。"
    };
  }
  return {
    enabled: true,
    provider: provider.name,
    note: "检索到的条目是候选来源，未经核实，不能当作已核实证据。"
  };
}
