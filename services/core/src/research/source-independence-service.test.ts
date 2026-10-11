import { describe, expect, it } from "vitest";
import {
  newId,
  type ExecutionEvent,
  type Source,
  type SourceProfileOverride,
  type SourceRelation,
  type SourceSnapshot
} from "@nexus/shared";
import {
  SourceIndependenceError,
  SourceIndependenceService
} from "./source-independence-service";

/**
 * Behaviour of the independence analysis with the database faked.
 *
 * The boundary under test: five reprints of one story must read as ONE
 * independent source, similarity alone must never merge two pages, and nothing
 * this service does may touch a source, an excerpt or a verdict.
 */

const SESSION_ID = newId();

const ORIGINAL_TEXT =
  "The bureau reported that retail sales rose five percent in the first half. " +
  "Analysts had expected a smaller increase and said the figure was encouraging.";

let counter = 0;

function source(overrides: Partial<Source> = {}): Source {
  counter += 1;
  return {
    id: newId(),
    sessionId: SESSION_ID,
    title: `Source ${counter}`,
    kind: "url",
    createdBy: "human",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

function snapshot(input: {
  sourceId: string;
  content: string;
  hash: string;
}): SourceSnapshot {
  return {
    id: newId(),
    sessionId: SESSION_ID,
    sourceId: input.sourceId,
    canonicalUrl: `https://example.test/${input.sourceId}`,
    contentHash: input.hash,
    contentType: "text/plain",
    content: input.content,
    contentBytes: input.content.length,
    charCount: input.content.length,
    retrievedAt: "2026-10-02T00:00:00.000Z",
    createdAt: "2026-10-02T00:00:00.000Z"
  };
}

type Recorded = {
  relations: SourceRelation[];
  overrides: SourceProfileOverride[];
};

function fakeEvent(
  sequence: number,
  input: { correlationId: string; type: string; payload?: unknown }
): ExecutionEvent {
  return {
    id: newId(),
    sessionId: SESSION_ID,
    sequence,
    correlationId: input.correlationId,
    type: input.type,
    payload: input.payload,
    occurredAt: new Date().toISOString()
  } as ExecutionEvent;
}

function buildService(input: {
  sources: Source[];
  snapshots?: SourceSnapshot[];
  relations?: SourceRelation[];
  overrides?: SourceProfileOverride[];
  recorded?: Recorded;
}) {
  const recorded: Recorded = input.recorded ?? { relations: [], overrides: [] };
  let sequence = 0;

  const service = new SourceIndependenceService({
    sources: {
      listSources: async () => input.sources,
      listLatestSnapshots: async () => input.snapshots ?? [],
      getSource: async (_sessionId: string, sourceId: string) =>
        input.sources.find((item) => item.id === sourceId) ?? null
    },
    assertions: {
      recordRelation: async (payload: {
        sessionId: string;
        relation: Omit<SourceRelation, "supersedesId" | "isCurrent" | "createdAt">;
        event: { correlationId: string; type: string; payload?: unknown };
      }) => {
        const relation: SourceRelation = {
          ...payload.relation,
          supersedesId: null,
          isCurrent: true,
          createdAt: new Date().toISOString()
        };
        recorded.relations.push(relation);
        sequence += 1;
        return {
          relation,
          event: fakeEvent(sequence, payload.event)
        };
      },
      listCurrentRelations: async () => input.relations ?? [],
      listRelationsForSource: async () => input.relations ?? [],
      listRelationHistory: async () => input.relations ?? [],
      recordProfileOverride: async (payload: {
        sessionId: string;
        override: Omit<
          SourceProfileOverride,
          "supersedesId" | "isCurrent" | "createdAt"
        >;
        event: { correlationId: string; type: string; payload?: unknown };
      }) => {
        const override: SourceProfileOverride = {
          ...payload.override,
          supersedesId: null,
          isCurrent: true,
          createdAt: new Date().toISOString()
        };
        recorded.overrides.push(override);
        sequence += 1;
        return { override, event: fakeEvent(sequence, payload.event) };
      },
      listCurrentProfileOverrides: async () => input.overrides ?? [],
      listProfileOverrideHistory: async () => input.overrides ?? []
    },
    now: () => new Date("2026-10-10T00:00:00.000Z")
  });

  return { service, recorded };
}

describe("SourceIndependenceService.analyze", () => {
  it("reads five reprints of one story as a single independent source", async () => {
    const sources = Array.from({ length: 5 }, () => source());
    const snapshots = sources.map((item) =>
      snapshot({ sourceId: item.id, content: ORIGINAL_TEXT, hash: "same-hash" })
    );
    const { service } = buildService({ sources, snapshots });

    const result = await service.analyze(SESSION_ID);
    expect(result.summary.pages).toBe(5);
    expect(result.summary.confirmedIndependentSources).toBe(1);
    expect(result.summary.clusters[0]?.pageCount).toBe(5);
  });

  it("returns a valid empty reading rather than an error", async () => {
    const { service } = buildService({ sources: [] });
    const result = await service.analyze(SESSION_ID);
    expect(result.summary.pages).toBe(0);
    expect(result.summary.notes.join()).toContain("还没有登记来源");
  });

  it("keeps two similar-but-different pages separate until confirmed", async () => {
    const first = source();
    const second = source();
    const { service } = buildService({
      sources: [first, second],
      snapshots: [
        snapshot({ sourceId: first.id, content: ORIGINAL_TEXT, hash: "h1" }),
        snapshot({
          sourceId: second.id,
          content: `${ORIGINAL_TEXT} 记者补充报道。`,
          hash: "h2"
        })
      ]
    });

    const result = await service.analyze(SESSION_ID);
    expect(result.summary.confirmedIndependentSources).toBe(2);
    expect(result.summary.suspectedIndependentSources).toBe(1);
    expect(result.summary.suspectedLinks).toHaveLength(1);
    expect(result.summary.suspectedLinks[0]?.confidence).toBe("suspected");
  });

  it("merges a human 'unrelated' ruling back out of the count", async () => {
    const first = source({ contentHash: "same" });
    const second = source({ contentHash: "same" });
    const { service } = buildService({
      sources: [first, second],
      relations: [
        {
          id: newId(),
          sessionId: SESSION_ID,
          fromSourceId: first.id,
          toSourceId: second.id,
          kind: "unrelated",
          basis: "human_assertion",
          similarity: null,
          reason: "编辑确认这是两篇不同报道，只是正文偶合。",
          origin: "human",
          actor: "Researcher (researcher)",
          supersedesId: null,
          isCurrent: true,
          createdAt: "2026-10-03T00:00:00.000Z"
        }
      ]
    });

    const result = await service.analyze(SESSION_ID);
    // Detection would have merged them on the identical hash; the person's
    // ruling overrides it.
    expect(result.summary.confirmedIndependentSources).toBe(2);
  });

  it("reports which source a page explicitly links to", async () => {
    const mirror = source({ canonicalUrl: "https://mirror.test/copy" });
    const origin = source({ canonicalUrl: "https://origin.test/a" });
    const { service } = buildService({
      sources: [mirror, origin],
      snapshots: [
        snapshot({
          sourceId: mirror.id,
          content: `转载自 https://origin.test/a 。${ORIGINAL_TEXT}`,
          hash: "m1"
        }),
        snapshot({ sourceId: origin.id, content: ORIGINAL_TEXT, hash: "o1" })
      ]
    });

    const result = await service.analyze(SESSION_ID);
    const mirrorProfile = result.profiles.find((p) => p.sourceId === mirror.id)!;
    expect(mirrorProfile.referencesSourceIds).toContain(origin.id);
    // A page that cites an upstream is a secondary account, not the original.
    expect(mirrorProfile.provenanceKind).toBe("secondary");
  });

  it("never invents a provenance kind when nothing supports one", async () => {
    const lonely = source();
    const { service } = buildService({ sources: [lonely] });
    const result = await service.analyze(SESSION_ID);
    expect(result.profiles[0]?.provenanceKind).toBe("unknown");
    expect(result.profiles[0]?.limitations.length).toBeGreaterThan(0);
  });
});

describe("SourceIndependenceService.declareRelation", () => {
  it("stores a human relation with its reason and author", async () => {
    const first = source();
    const second = source();
    const recorded: Recorded = { relations: [], overrides: [] };
    const { service } = buildService({
      sources: [first, second],
      recorded
    });

    const result = await service.declareRelation({
      sessionId: SESSION_ID,
      relationId: newId(),
      actor: "Reviewer Two (reviewer)",
      draft: {
        fromSourceId: second.id,
        toSourceId: first.id,
        kind: "reprint",
        reason: "编辑核对后确认第二篇是第一篇的转载。"
      }
    });

    expect(result.relation.kind).toBe("reprint");
    expect(result.relation.origin).toBe("human");
    expect(result.event.type).toBe("SOURCE_RELATION_RECORDED");
    expect(recorded.relations).toHaveLength(1);
  });

  it("refuses a kind outside the assertable vocabulary", async () => {
    const first = source();
    const second = source();
    const { service } = buildService({ sources: [first, second] });

    await expect(
      service.declareRelation({
        sessionId: SESSION_ID,
        relationId: newId(),
        actor: "Reviewer (reviewer)",
        draft: {
          fromSourceId: first.id,
          toSourceId: second.id,
          kind: "plagiarised" as never,
          reason: "some reason that is long enough"
        }
      })
    ).rejects.toBeInstanceOf(SourceIndependenceError);
  });

  it("refuses a source from another research task", async () => {
    const first = source();
    const { service } = buildService({ sources: [first] });

    await expect(
      service.declareRelation({
        sessionId: SESSION_ID,
        relationId: newId(),
        actor: "Reviewer (reviewer)",
        draft: {
          fromSourceId: first.id,
          toSourceId: newId(),
          kind: "reprint",
          reason: "claims to relate to a source that is not here"
        }
      })
    ).rejects.toMatchObject({ code: "source_not_found", httpStatus: 404 });
  });
});

describe("SourceIndependenceService.overrideProfile", () => {
  it("records a human override that the next analysis reads back", async () => {
    const only = source();
    const recorded: Recorded = { relations: [], overrides: [] };
    const { service } = buildService({ sources: [only], recorded });

    const result = await service.overrideProfile({
      sessionId: SESSION_ID,
      overrideId: newId(),
      actor: "Researcher (researcher)",
      draft: {
        sourceId: only.id,
        provenanceKind: "primary",
        note: "确认这是统计局原始发布页面。"
      }
    });

    expect(result.override.provenanceKind).toBe("primary");
    expect(result.event.type).toBe("SOURCE_PROFILE_OVERRIDDEN");
    expect(recorded.overrides).toHaveLength(1);
  });
});
