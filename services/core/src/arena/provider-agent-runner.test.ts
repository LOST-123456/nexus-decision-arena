import { describe, expect, it } from "vitest";
import { ClaimSchema, newId, type Claim } from "@nexus/shared";
import type { LlmProvider, LlmRequest } from "@nexus/llm";
import { DEFAULT_AGENT_ROLES } from "./default-roles";
import { ProviderAgentRunner, toMaterialBriefs } from "./provider-agent-runner";
import type { SearchHit, WebSearchProvider } from "./web-search";

/**
 * The provider path is where cancellation actually has to reach: a signal that
 * stops at the service layer leaves the HTTP request and the tokens flowing.
 * These tests hold that link in place.
 */

const ROLE = DEFAULT_AGENT_ROLES[0]!;
const CLAIM_ID = newId();
const SESSION_ID = newId();
const RUN_ID = newId();

const CLAIM: Claim = ClaimSchema.parse({
  id: CLAIM_ID,
  sessionId: SESSION_ID,
  lens: "research",
  statement: "Shipments grew 12% last quarter.",
  type: "fact",
  stance: "support",
  importance: 4,
  confidence: 0.5,
  evidenceIds: [],
  status: "proposed",
  rootClaimId: CLAIM_ID,
  revision: 1,
  relations: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
});

/** A provider that hangs until its signal is aborted, then rejects. */
function hangingProvider(): LlmProvider {
  return {
    generate: (_request: LlmRequest, signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Generation aborted", "AbortError")),
          { once: true }
        );
      })
  };
}

describe("ProviderAgentRunner · challenge prompt", () => {
  /**
   * The prompt used to be one sample object. Five challengers, five lenses, and
   * twenty identical `evidence_gap` rows asking the same question is what that
   * produced. These assertions hold the fix in place: the legal type domain is
   * stated, the sample is labelled as a shape, and the generic question is
   * explicitly wrong.
   */
  async function capturedSystem(role = ROLE): Promise<string> {
    let system = "";
    const provider: LlmProvider = {
      generate: (request) => {
        system = request.system;
        return Promise.resolve(
          JSON.stringify({
            type: "feasibility",
            question: "12% 的增速来自哪个渠道？缺少分渠道口径无法验证。",
            context: {
              triggerClaimIds: [CLAIM.id],
              explanation: "增速决定结论，但没有分渠道数据就无法核验"
            },
            requiredEvidence: ["上季度分渠道出货台账"],
            severity: 4,
            resolutionStrategy: "provide_evidence"
          })
        );
      }
    };
    await new ProviderAgentRunner(provider)
      .createChallengeDependencies()
      .generateChallenge(role, CLAIM);
    return system;
  }

  it("names every legal challenge type, so none of them is discovered by luck", async () => {
    const system = await capturedSystem();
    for (const type of [
      "evidence_gap",
      "feasibility",
      "contradiction",
      "logic_flaw",
      "priority"
    ]) {
      expect(system).toContain(type);
    }
  });

  it("says out loud that the sample is a shape and the generic question is wrong", async () => {
    const system = await capturedSystem();
    expect(system).toContain("缺少什么证据？");
    expect(system).toContain("never reuse the wording");
    // The sample must be marked as placeholders rather than content.
    expect(system).toContain("placeholders, not content");
  });

  /**
   * 「因信息不足，未形成可提出的质询」不是质询。
   *
   * 真实跑出来的反例：资料不全时模型会写一句关于自己局限的说明书。这句话
   * 对读者零价值，而缺的那张表本身就是质询的内容。提示词现在把这条禁掉。
   */
  it("禁止把「我也没办法」写成质询", async () => {
    const system = await capturedSystem();
    expect(system).toContain("meta-statement about your own limits");
    expect(system).toContain("A missing figure IS the challenge");
  });

  /**
   * requiredEvidence 要写成动作，不是写成"缺什么"。
   *
   * 报告页的执行计划直接由这一栏生成：写「需要成本数据」，用户看完还是不知道
   * 下一步做什么；写「向 2 家供应商索取含运费的单笔报价单」，它就能照着做。
   */
  it("要求把待补材料写成可照做的动作", async () => {
    const system = await capturedSystem();
    expect(system).toContain("Write it as what to DO");
  });

  it("offers a role's bias only when it is a legal type", async () => {
    const market = await capturedSystem(DEFAULT_AGENT_ROLES[0]!);
    expect(market).toContain("standing bias is evidence_gap");

    // The finance role is labelled "assumption", which is not a challenge type.
    const finance = DEFAULT_AGENT_ROLES.find(
      (role) => role.conflictPreference.includes("assumption")
    )!;
    const system = await capturedSystem(finance);
    expect(system).not.toContain("standing bias is assumption");
    expect(system).toContain("exactly one of: evidence_gap");
  });
});

/**
 * 角色分析这一步的产出纪律。
 *
 * 用户看到的「因资料不足，未形成可要求的假设」不是我们写的文案，是模型自己
 * 写进主张里的一句话。它把"我没法判断"当成了一条判断——而这种输出对一个
 * 想拿主意的用户毫无价值。所以纪律写在提示词里，并且钉在测试里。
 */
describe("ProviderAgentRunner · 分析提示词的产出纪律", () => {
  async function capturedAnalysisSystem(): Promise<string> {
    let system = "";
    const provider: LlmProvider = {
      generate: (request) => {
        system = request.system;
        return Promise.resolve(
          JSON.stringify({
            claims: [
              {
                statement: "单校年流通量约 2000 册，按 15% 抽成测算单校年收入约 6 万元",
                type: "assumption",
                stance: "support",
                importance: 4,
                confidence: 0.5,
                evidenceTitles: ["按同类校园平台公开招投标数据推算"]
              }
            ]
          })
        );
      }
    };
    await new ProviderAgentRunner(provider).run(ROLE, {
      sessionId: SESSION_ID,
      agentRunId: RUN_ID,
      projectInput: { name: "校园二手教材循环平台" }
    });
    return system;
  }

  it("禁止把「我判断不了」写成一条主张", async () => {
    const system = await capturedAnalysisSystem();
    expect(system).toContain("judgement ABOUT THIS PROJECT");
    expect(system).toContain("never output them");
  });

  it("缺数字时要求给出假设，而不是停在那里", async () => {
    const system = await capturedAnalysisSystem();
    expect(system).toContain("set that claim's type to assumption");
    expect(system).toContain("A stated assumption is what the review is for");
  });

  it("不许把问题抛回给用户，该给做法就给做法", async () => {
    const system = await capturedAnalysisSystem();
    expect(system).toContain("Never ask the reader a question");
    expect(system).toContain("concrete steps someone can start this week");
  });
});

/**
 * 检索结果只能改变「去哪儿找」，不能改变「是否已核实」。
 *
 * 这是这套东西里最容易被做坏的一处：一旦模型把一条搜索结果当成 support，
 * 报告上的证据覆盖率就会开始说谎。所以两件事都要钉住——检索结果确实进了
 * 提示词（否则等于没查），并且提示词明确禁止把它当成证据。
 */
describe("ProviderAgentRunner · 外部检索的注入与边界", () => {
  const HIT: SearchHit = {
    title: "某高校后勤集团 2025 年教材采购公告",
    url: "https://example.edu/procurement/2025",
    snippet: "预算 120 万元，服务期 2 年"
  };

  function fakeSearch(
    hits: SearchHit[] | (() => Promise<SearchHit[]>)
  ): WebSearchProvider & { calls: string[] } {
    const calls: string[] = [];
    return {
      name: "fake-search",
      calls,
      search: async (query: string) => {
        calls.push(query);
        return typeof hits === "function" ? hits() : hits;
      }
    };
  }

  async function captured(search?: WebSearchProvider) {
    let system = "";
    let user = "";
    const provider: LlmProvider = {
      generate: (request) => {
        system = request.system;
        user = request.user;
        return Promise.resolve(
          JSON.stringify({
            type: "evidence_gap",
            question: "公告里的 120 万预算对应多少册教材？没有单价无法测算。",
            context: {
              triggerClaimIds: [CLAIM.id],
              explanation: "预算总额不能证明单位经济成立"
            },
            requiredEvidence: ["该校采购公告原件与分项报价"],
            severity: 4,
            resolutionStrategy: "provide_evidence"
          })
        );
      }
    };
    await new ProviderAgentRunner(provider, undefined, search)
      .createChallengeDependencies()
      .generateChallenge(ROLE, CLAIM);
    return { system, user };
  }

  it("有检索服务时，候选来源真的进了提示词", async () => {
    const search = fakeSearch([HIT]);
    const { system, user } = await captured(search);
    const payload = JSON.parse(user) as { webSources?: SearchHit[] };

    expect(payload.webSources?.[0]?.url).toBe(HIT.url);
    expect(system).toContain("candidates, NOT verified evidence");
    expect(system).toContain("Never describe a web source as proof");
  });

  it("没检索服务时，连“来源”这个词都不出现", async () => {
    // 一个没接检索的部署，不能让模型（或用户）以为它查过。
    const { system, user } = await captured();
    expect(user).not.toContain("webSources");
    expect(system).not.toContain("machine-retrieved");
  });

  it("用被质疑的主张原文去查，但先把标点洗掉", async () => {
    // 带着问号/句号去搜，搜索引擎会把它当短语的一部分，命中率明显下降。
    const search = fakeSearch([HIT]);
    await captured(search);
    expect(search.calls[0]).toContain("Shipments grew 12");
    expect(search.calls[0]).not.toContain(".");
    expect(search.calls[0]).not.toContain("%");
  });

  it("检索失败时这一轮照常出质询", async () => {
    const search = fakeSearch(async () => {
      throw new Error("search down");
    });
    await expect(captured(search)).resolves.toBeTruthy();
  });
});

describe("ProviderAgentRunner · cancellation", () => {
  it("rejects instead of falling back when the run is aborted", async () => {
    const runner = new ProviderAgentRunner(hangingProvider());
    const dependencies = runner.createChallengeDependencies();
    const controller = new AbortController();

    const pending = dependencies.generateChallenge(ROLE, CLAIM, controller.signal);
    controller.abort();

    // The fallback draft is a legitimate answer to a provider *failure*. It is
    // the wrong answer to "stop": it would keep the work going after the
    // operator asked for it to end.
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("passes the caller's signal down to the provider, not a private one", async () => {
    let seen: AbortSignal | null = null;
    const provider: LlmProvider = {
      generate: (_request, signal) => {
        seen = signal;
        return Promise.reject(new Error("provider down"));
      }
    };
    const runner = new ProviderAgentRunner(provider);
    const controller = new AbortController();

    await runner
      .createChallengeDependencies()
      .generateChallenge(ROLE, CLAIM, controller.signal);

    expect(seen).not.toBeNull();
    expect(seen).toBe(controller.signal);
  });

  it("still falls back when the provider fails and nothing was cancelled", async () => {
    const provider: LlmProvider = {
      generate: () => Promise.reject(new Error("provider down"))
    };
    const runner = new ProviderAgentRunner(provider);

    const draft = await runner
      .createChallengeDependencies()
      .generateChallenge(ROLE, CLAIM);

    expect(draft.type).toBe("evidence_gap");
    expect(draft.requiredEvidence.length).toBeGreaterThan(0);
  });

  it("gives the analysis path a signal too, so no call is un-cancellable by accident", async () => {
    let seen: AbortSignal | null = null;
    const provider: LlmProvider = {
      generate: (_request, signal) => {
        seen = signal;
        return Promise.resolve(
          JSON.stringify({
            claims: [
              {
                statement: "需求证据不足",
                type: "assumption",
                stance: "oppose",
                importance: 5,
                confidence: 0.6,
                evidenceTitles: ["缺少采购记录"]
              }
            ]
          })
        );
      }
    };
    const runner = new ProviderAgentRunner(provider);

    await runner.run(ROLE, {
      sessionId: SESSION_ID,
      agentRunId: RUN_ID,
      projectInput: {}
    });

    expect(seen).not.toBeNull();
    // The analysis path has no per-run cancellation by design; what matters is
    // that it is a real signal object rather than an omitted argument.
    expect((seen as unknown as AbortSignal).aborted).toBe(false);
  });
});

/**
 * 材料要真的进到提示词里，否则「补充材料」就只是给页面加了一个输入框。
 */
describe("ProviderAgentRunner · materials", () => {
  const CHALLENGE_JSON = JSON.stringify({
    type: "feasibility",
    question: "三校意向书没有约定结算周期，6% 抽佣怎么落地？",
    context: {
      triggerClaimIds: [CLAIM.id],
      explanation: "结算周期决定现金流，意向书未覆盖"
    },
    requiredEvidence: ["三校意向书中的结算条款"],
    severity: 4,
    resolutionStrategy: "provide_evidence"
  });

  it("把已登记的材料交给质询者，并说明不必重复追问", async () => {
    let user = "";
    let system = "";
    const provider: LlmProvider = {
      generate: (request) => {
        user = request.user;
        system = request.system;
        return Promise.resolve(CHALLENGE_JSON);
      }
    };
    const runner = new ProviderAgentRunner(provider, async () => [
      { title: "三校合作意向书", content: "已签 3 校，覆盖 2.1 万人", round: 1 }
    ]);

    await runner.createChallengeDependencies().generateChallenge(ROLE, CLAIM);

    expect(user).toContain("三校合作意向书");
    expect(system).toContain("Do not ask for evidence those materials already contain");
  });

  it("没有材料时提示词里不出现材料段落", async () => {
    let system = "";
    const provider: LlmProvider = {
      generate: (request) => {
        system = request.system;
        return Promise.resolve(CHALLENGE_JSON);
      }
    };

    await new ProviderAgentRunner(provider, async () => [])
      .createChallengeDependencies()
      .generateChallenge(ROLE, CLAIM);

    expect(system).not.toContain("Do not ask for evidence those materials already contain");
  });

  it("读材料失败时质询照常进行", async () => {
    const provider: LlmProvider = {
      generate: () => Promise.resolve(CHALLENGE_JSON)
    };
    const runner = new ProviderAgentRunner(provider, () =>
      Promise.reject(new Error("event store down"))
    );

    const draft = await runner
      .createChallengeDependencies()
      .generateChallenge(ROLE, CLAIM);

    expect(draft.type).toBe("feasibility");
  });

  it("材料多且长时只带最近几份、每份截断，避免每轮都付全量 token", () => {
    const long = "字".repeat(1000);
    const briefs = toMaterialBriefs(
      Array.from({ length: 20 }, (_value, index) => ({
        title: `材料 ${index}`,
        content: long,
        round: 1
      }))
    );

    expect(briefs).toHaveLength(8);
    expect(briefs[0]?.title).toBe("材料 12");
    expect(briefs[0]!.content.length).toBeLessThan(300);
  });
});
