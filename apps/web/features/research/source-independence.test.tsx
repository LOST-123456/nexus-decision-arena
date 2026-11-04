import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rules of the source-independence surface, checked against the real
 * component.
 *
 * Only the data access is faked. What these tests pin down is the part that
 * would be easy to get wrong and hard to notice: that a reprint is not counted
 * as a second source, that mere similarity is shown as a suspicion rather than
 * a fact, that "来源类型未知" is presented as an answer instead of a blank, and
 * that a person's ruling is sent as a new record.
 */

const getSourceAnalysis = vi.fn();
const declareSourceRelation = vi.fn();
const overrideSourceProfile = vi.fn();

class SourceIndependenceFailedError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "SourceIndependenceFailedError";
  }
}

vi.mock("./api", () => ({
  SourceIndependenceFailedError,
  getSourceAnalysis: (...args: unknown[]) => getSourceAnalysis(...args),
  declareSourceRelation: (...args: unknown[]) => declareSourceRelation(...args),
  overrideSourceProfile: (...args: unknown[]) => overrideSourceProfile(...args)
}));

const { SourceIndependencePanel } = await import("./source-independence");

const SESSION_ID = "0199e6d0-0000-7000-8000-000000000001";
const SOURCE_A = "0199e6d0-0000-7000-8000-000000000002";
const SOURCE_B = "0199e6d0-0000-7000-8000-000000000003";

type Profile = {
  sourceId: string;
  title: string;
  canonicalUrl: string | null;
  provenanceKind: string;
  provenanceOrigin: string;
  provenanceReasons: string[];
  facts: {
    publisher: string | null;
    author: string | null;
    publishedAt: string | null;
    retrievedAt: string | null;
    contentVersion: string | null;
    contentType: string | null;
    charCount: number | null;
    retrievalStatus: string;
  };
  referencesSourceIds: string[];
  referencedBySourceIds: string[];
  qualityLabels: string[];
  limitations: string[];
};

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    sourceId: SOURCE_A,
    title: "原始报道",
    canonicalUrl: "https://origin.test/a",
    provenanceKind: "unknown",
    provenanceOrigin: "system",
    provenanceReasons: ["没有任何已记录的证据可以判定来源类型。"],
    facts: {
      publisher: null,
      author: null,
      publishedAt: null,
      retrievedAt: "2026-10-02T00:00:00.000Z",
      contentVersion: "hash-aaaaaaaaaa",
      contentType: "text/plain",
      charCount: 120,
      retrievalStatus: "fetched"
    },
    referencesSourceIds: [],
    referencedBySourceIds: [],
    qualityLabels: ["已保存正文版本"],
    limitations: ["未登记发布机构，无法判断发布主体。"],
    ...overrides
  };
}

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    algorithm: "source-independence-v1",
    generatedAt: "2026-10-10T00:00:00.000Z",
    summary: {
      sessionId: SESSION_ID,
      pages: 5,
      confirmedIndependentSources: 1,
      suspectedIndependentSources: 1,
      clusters: [
        {
          clusterId: "cluster-1",
          representativeSourceId: SOURCE_A,
          sourceIds: [SOURCE_A, SOURCE_B],
          pageCount: 5,
          confirmedKinds: ["duplicate"],
          notes: ["5 个页面属于同一份独立信息源。"]
        }
      ],
      confirmedLinks: [],
      suspectedLinks: [],
      unlinkedSourceIds: [],
      notes: []
    },
    links: [],
    profiles: [
      profile(),
      profile({
        sourceId: SOURCE_B,
        title: "转载页",
        canonicalUrl: "https://mirror.test/b",
        provenanceKind: "secondary",
        provenanceReasons: ["正文/登记信息显式引用了本会话内其他来源（1 个），判为二手转述。"],
        referencesSourceIds: [SOURCE_A]
      })
    ],
    humanRelations: [],
    ...overrides
  };
}

beforeEach(() => {
  getSourceAnalysis.mockReset();
  declareSourceRelation.mockReset();
  overrideSourceProfile.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("SourceIndependencePanel", () => {
  it("reads five reprints as a single independent source", async () => {
    getSourceAnalysis.mockResolvedValue(analysis());
    render(
      <SourceIndependencePanel sessionId={SESSION_ID} canEdit />
    );
    await waitFor(() =>
      expect(screen.getByTestId("independence-headline")).toBeTruthy()
    );
    expect(screen.getByTestId("independence-headline").textContent).toContain(
      "5 个页面、1 条独立信息源"
    );
    expect(screen.getByTestId("cluster-list").textContent).toContain(
      "5 个页面"
    );
  });

  it("lays the independence summary out as label/value pairs, not bundled grid cells", async () => {
    // independence-summary had the same bundled-div-in-a-two-track-grid
    // problem as the claim card; it now uses the deflist pattern, so the
    // label column sizes to its content instead of a fixed 96px.
    getSourceAnalysis.mockResolvedValue(analysis());
    render(<SourceIndependencePanel sessionId={SESSION_ID} canEdit />);
    await waitFor(() =>
      expect(screen.getByTestId("independence-headline")).toBeTruthy()
    );
    const summary = screen.getByTestId("independence-summary");
    expect(summary.tagName).toBe("DL");
    expect(summary.className).toContain("research-deflist");
    expect(summary.querySelectorAll("dt").length).toBe(3);
    expect(summary.querySelectorAll("dd").length).toBe(3);
  });

  it("shows mere similarity as a suspicion, not as a merged fact", async () => {
    getSourceAnalysis.mockResolvedValue(
      analysis({
        summary: {
          sessionId: SESSION_ID,
          pages: 2,
          confirmedIndependentSources: 2,
          suspectedIndependentSources: 1,
          clusters: [
            {
              clusterId: SOURCE_A,
              representativeSourceId: SOURCE_A,
              sourceIds: [SOURCE_A],
              pageCount: 1,
              confirmedKinds: [],
              notes: []
            },
            {
              clusterId: SOURCE_B,
              representativeSourceId: SOURCE_B,
              sourceIds: [SOURCE_B],
              pageCount: 1,
              confirmedKinds: [],
              notes: []
            }
          ],
          confirmedLinks: [],
          suspectedLinks: [
            {
              fromSourceId: SOURCE_A,
              toSourceId: SOURCE_B,
              kind: "near_duplicate",
              basis: "text_similarity",
              confidence: "suspected",
              similarity: 0.95,
              reason: "两份正文的近似指纹相似度 95.0%，疑似重复，需人工确认是否同源。",
              origin: "system"
            }
          ],
          unlinkedSourceIds: [],
          notes: ["另有 1 组文本相近的疑似重复待人工确认，未计入独立性合并。"]
        }
      })
    );
    render(<SourceIndependencePanel sessionId={SESSION_ID} canEdit />);
    await waitFor(() => expect(screen.getByTestId("suspected-list")).toBeTruthy());
    expect(screen.getByTestId("independence-headline").textContent).toContain(
      "1–2 条独立信息源"
    );
    expect(screen.getByTestId("suspected-list").textContent).toContain("疑似，待确认");
  });

  it("presents an unknown provenance kind as a real answer", async () => {
    getSourceAnalysis.mockResolvedValue(analysis());
    render(<SourceIndependencePanel sessionId={SESSION_ID} canEdit />);
    await waitFor(() =>
      expect(screen.getByTestId(`provenance-pill-${SOURCE_A}`)).toBeTruthy()
    );
    expect(screen.getByTestId(`provenance-pill-${SOURCE_A}`).textContent).toContain(
      "来源类型未知"
    );
    // The reason and the missing facts are named, not hidden behind a score.
    expect(screen.getByTestId(`limitations-${SOURCE_A}`).textContent).toContain(
      "未登记发布机构"
    );
  });

  it("says independence does not verify anything or change the gate", async () => {
    getSourceAnalysis.mockResolvedValue(analysis());
    render(<SourceIndependencePanel sessionId={SESSION_ID} canEdit />);
    await waitFor(() =>
      expect(screen.getByTestId("independence-disclaimer")).toBeTruthy()
    );
    expect(
      screen.getByTestId("independence-disclaimer").textContent
    ).toContain("不会自动核实");
  });

  it("sends a provenance override as a new record with a reason", async () => {
    getSourceAnalysis.mockResolvedValue(analysis());
    overrideSourceProfile.mockResolvedValue({
      override: {},
      event: {}
    });
    render(<SourceIndependencePanel sessionId={SESSION_ID} canEdit />);
    await waitFor(() =>
      expect(screen.getByTestId(`override-kind-${SOURCE_A}`)).toBeTruthy()
    );
    fireEvent.click(screen.getByTestId(`override-kind-${SOURCE_A}`));
    fireEvent.change(screen.getByTestId("override-kind-select"), {
      target: { value: "primary" }
    });
    fireEvent.change(screen.getByTestId("override-note"), {
      target: { value: "确认这是统计局原始发布页面。" }
    });
    fireEvent.click(screen.getByTestId("override-submit"));
    await waitFor(() => expect(overrideSourceProfile).toHaveBeenCalledTimes(1));
    expect(overrideSourceProfile).toHaveBeenCalledWith(SESSION_ID, {
      sourceId: SOURCE_A,
      provenanceKind: "primary",
      note: "确认这是统计局原始发布页面。"
    });
  });

  it("sends a relation with its direction, kind and reason", async () => {
    getSourceAnalysis.mockResolvedValue(analysis());
    declareSourceRelation.mockResolvedValue({ relation: {}, event: {} });
    render(<SourceIndependencePanel sessionId={SESSION_ID} canEdit />);
    await waitFor(() =>
      expect(screen.getByTestId(`add-relation-${SOURCE_A}`)).toBeTruthy()
    );
    fireEvent.click(screen.getByTestId(`add-relation-${SOURCE_A}`));
    fireEvent.change(screen.getByTestId("relation-kind"), {
      target: { value: "reprint" }
    });
    fireEvent.change(screen.getByTestId("relation-reason"), {
      target: { value: "编辑核对后确认这是转载页面。" }
    });
    fireEvent.click(screen.getByTestId("relation-submit"));
    await waitFor(() => expect(declareSourceRelation).toHaveBeenCalledTimes(1));
    expect(declareSourceRelation).toHaveBeenCalledWith(SESSION_ID, {
      fromSourceId: SOURCE_A,
      toSourceId: SOURCE_B,
      kind: "reprint",
      reason: "编辑核对后确认这是转载页面。"
    });
  });

  it("refuses to submit a reason that is too short", async () => {
    getSourceAnalysis.mockResolvedValue(analysis());
    render(<SourceIndependencePanel sessionId={SESSION_ID} canEdit />);
    await waitFor(() =>
      expect(screen.getByTestId(`add-relation-${SOURCE_A}`)).toBeTruthy()
    );
    fireEvent.click(screen.getByTestId(`add-relation-${SOURCE_A}`));
    fireEvent.change(screen.getByTestId("relation-reason"), {
      target: { value: "短" }
    });
    fireEvent.click(screen.getByTestId("relation-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("analysis-notice")).toBeTruthy()
    );
    expect(declareSourceRelation).not.toHaveBeenCalled();
  });

  it("offers no write controls to a viewer", async () => {
    getSourceAnalysis.mockResolvedValue(analysis());
    render(<SourceIndependencePanel sessionId={SESSION_ID} canEdit={false} />);
    await waitFor(() =>
      expect(screen.getByTestId(`profile-${SOURCE_A}`)).toBeTruthy()
    );
    expect(screen.queryByTestId(`override-kind-${SOURCE_A}`)).toBeNull();
    expect(screen.queryByTestId(`add-relation-${SOURCE_A}`)).toBeNull();
  });

  it("surfaces a failed analysis with a retry instead of an empty success", async () => {
    getSourceAnalysis.mockRejectedValueOnce(
      new SourceIndependenceFailedError("boom", "storage_unavailable")
    );
    render(<SourceIndependencePanel sessionId={SESSION_ID} canEdit />);
    await waitFor(() =>
      expect(screen.getByTestId("source-analysis-error")).toBeTruthy()
    );
    expect(screen.getByTestId("source-analysis-error").textContent).toContain(
      "来源分析暂不可用"
    );
    expect(screen.getByTestId("retry-analysis")).toBeTruthy();
  });

  /**
   * A quality card is about one source, and this panel lists every source in
   * the research. Arriving with `initialSourceId` has to say *which* entry the
   * card meant, or the reader is left scanning the list for it.
   */
  it("marks the source a quality card sent the reader to", async () => {
    getSourceAnalysis.mockResolvedValue(analysis());
    render(
      <SourceIndependencePanel
        sessionId={SESSION_ID}
        canEdit
        initialSourceId={SOURCE_B}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId(`profile-${SOURCE_B}`)).toBeTruthy()
    );

    expect(screen.getByTestId(`profile-${SOURCE_B}`).dataset.located).toBe(
      "true"
    );
    expect(screen.queryAllByTestId("located-source-marker")).toHaveLength(1);
    expect(
      screen.getByTestId(`profile-${SOURCE_A}`).dataset.located
    ).toBeUndefined();
  });

  it("marks nothing when it was opened without one", async () => {
    getSourceAnalysis.mockResolvedValue(analysis());
    render(<SourceIndependencePanel sessionId={SESSION_ID} canEdit />);
    await waitFor(() =>
      expect(screen.getByTestId(`profile-${SOURCE_A}`)).toBeTruthy()
    );

    expect(screen.queryAllByTestId("located-source-marker")).toHaveLength(0);
  });
});
