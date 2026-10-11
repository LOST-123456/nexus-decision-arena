import type { SourceKind } from "@nexus/shared";

/**
 * A lead surfaced by a controlled search, before it is stamped with an id, task
 * and retrieval time. The service turns these into `SearchCandidate` rows.
 */
export interface SearchLead {
  url: string;
  title: string;
  publisher: string;
  sourceType: SourceKind;
  note: string | null;
}

/**
 * Anything that can turn a query into candidate leads.
 *
 * Implementations must be honest: a lead is a suggestion for a person to
 * inspect, never a fetched, trusted page. They must also be able to fail
 * loudly — a search that cannot run reports why, rather than inventing results.
 */
export interface SearchProvider {
  readonly name: string;
  search(input: {
    query: string;
    purpose: string;
    keywords: string[];
    sessionId: string;
    taskId: string;
    now: Date;
  }): Promise<SearchLead[]>;
}

export class SearchProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchProviderError";
  }
}

function slugify(text: string): string {
  const ascii = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii.slice(0, 48);
}

/**
 * A controlled, network-free search.
 *
 * This build has no live web crawl, so "searching" means applying a fixed,
 * inspectable recipe to the query and returning a small set of *illustrative*
 * leads. Every lead is explicitly a candidate for a person to inspect and
 * verify — never a fetched, trusted page. The URLs use the example.org domain
 * on purpose: they are placeholders a human must replace with real, verified
 * sources before any of them could back an evidence claim.
 */
export class DeterministicSearchProvider implements SearchProvider {
  readonly name = "deterministic-controlled-search";

  async search(input: {
    query: string;
    purpose: string;
    keywords: string[];
    sessionId: string;
    taskId: string;
    now: Date;
  }): Promise<SearchLead[]> {
    const slug = slugify(input.query) || "topic";
    const keywords = input.keywords.length > 0 ? input.keywords : [input.query];
    const primary = keywords[0] ?? input.query;
    return [
      {
        url: `https://example.org/research/${slug}`,
        title: `${input.query.slice(0, 80)} — 一手资料建议`,
        publisher: "示例发布方（待人工核实）",
        sourceType: "url",
        note: `确定性候选项：受控检索依据关键词「${primary.slice(
          0,
          40
        )}」生成，上线前须替换为真实可核对的来源。`
      },
      {
        url: `https://example.org/datasets/${slug}`,
        title: `${input.query.slice(0, 80)} 相关数据集`,
        publisher: "示例数据提供方（待人工核实）",
        sourceType: "dataset",
        note: "确定性候选项：建议核对原始数据集与口径，再决定是否登记为证据来源。"
      }
    ];
  }
}
