import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Component tests for the Evidence Map surface. The data access is faked;
 * what is pinned down is the honesty contract of the UI:
 *  - the graph renders with node labels and a disclaimer that edges are
 *    relationships, not proof;
 *  - clicking a node opens the detail panel with the spec'd fields;
 *  - the filter chips switch views;
 *  - the empty state says there is nothing to draw yet;
 *  - the readiness signal is two separate states and never claims more than
 *    the React Flow store can actually show.
 *
 * The last group exists because of a real defect: the panel used to publish
 * `useNodesInitialized()`, which for a controlled `<ReactFlow nodes>` with no
 * `onNodesChange` is permanently false — the measurement happens, but the
 * write-back the hook also requires never does. The graph drew itself fine and
 * the page said "not ready" for twenty seconds. jsdom is where that could be
 * pinned down cheaply, because the ResizeObserver stub below never fires and
 * therefore never measures anything: a signal that still turns true here would
 * be lying.
 */

const getEvidenceMap = vi.fn();

vi.mock("./api", () => ({
  getEvidenceMap: (...args: unknown[]) => getEvidenceMap(...args)
}));

const { EvidenceMapPanel, allNodesMeasured } = await import("./evidence-map");

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const SESSION_ID = "session-1";

const graph = {
  sessionId: SESSION_ID,
  generatedAt: "2026-10-11T06:00:00.000Z",
  nodes: [
    {
      id: "claim:c1",
      sessionId: SESSION_ID,
      entityId: "c1",
      type: "claim",
      label: "企业市场增长预测",
      status: "proposed",
      statement: "企业市场增长预测",
      verdict: "insufficient_evidence"
    },
    {
      id: "evidence:e1",
      sessionId: SESSION_ID,
      entityId: "e1",
      type: "evidence",
      label: "市场报告摘录",
      status: "verified",
      excerpt: "报告第 12 页原文。",
      verificationStatus: "verified",
      direction: "supports"
    },
    {
      id: "source:s1",
      sessionId: SESSION_ID,
      entityId: "s1",
      type: "source",
      label: "Gartner 报告",
      status: "fetched",
      title: "Gartner 报告",
      publisher: "Gartner",
      sourceType: "url",
      reliability: 0.8
    }
  ],
  edges: [
    {
      id: "edge-1",
      sessionId: SESSION_ID,
      from: "evidence:e1",
      to: "claim:c1",
      relation: "supports",
      confidence: 0.8
    },
    {
      id: "edge-2",
      sessionId: SESSION_ID,
      from: "source:s1",
      to: "evidence:e1",
      relation: "provided_by",
      confidence: null
    }
  ],
  coverage: [
    {
      claimId: "c1",
      evidenceCount: 1,
      verifiedCount: 1,
      supportingCount: 1,
      contradictingCount: 0,
      sourceCount: 1,
      meanReliability: 0.8,
      coverage: 0.8
    }
  ]
} as never;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("EvidenceMapPanel", () => {
  it("renders node labels and the not-proof disclaimer", async () => {
    getEvidenceMap.mockResolvedValue(graph);
    render(<EvidenceMapPanel sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(screen.getByText("企业市场增长预测")).toBeTruthy();
    });
    expect(screen.getByText("市场报告摘录")).toBeTruthy();
    expect(screen.getByText(/不代表已证实/)).toBeTruthy();
  });

  it("opens the detail panel when a claim node is clicked", async () => {
    getEvidenceMap.mockResolvedValue(graph);
    render(<EvidenceMapPanel sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(screen.getByText("企业市场增长预测")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("企业市场增长预测"));

    const detail = await screen.findByTestId("evidence-map-detail");
    expect(detail).toBeTruthy();
    expect(screen.getByText("Verdict")).toBeTruthy();
    expect(screen.getByText(/80%/)).toBeTruthy();
    expect(screen.getByText(/不改变判定/)).toBeTruthy();
  });

  it("shows the evidence detail with verification and source", async () => {
    getEvidenceMap.mockResolvedValue(graph);
    render(<EvidenceMapPanel sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(screen.getByText("市场报告摘录")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("市场报告摘录"));

    await screen.findByTestId("evidence-map-detail");
    expect(screen.getByText("核实状态")).toBeTruthy();
    expect(screen.getByText("出自来源")).toBeTruthy();
  });

  it("switches views with the filter chips", async () => {
    getEvidenceMap.mockResolvedValue(graph);
    render(<EvidenceMapPanel sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(screen.getByText("企业市场增长预测")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "只看主张" }));

    await waitFor(() => {
      expect(screen.queryByText("市场报告摘录")).toBeNull();
    });
    expect(screen.getByText("企业市场增长预测")).toBeTruthy();
  });

  it("shows an empty-state hint for a session without material", async () => {
    getEvidenceMap.mockResolvedValue({
      sessionId: SESSION_ID,
      generatedAt: "2026-10-11T06:00:00.000Z",
      nodes: [],
      edges: [],
      coverage: []
    });
    render(<EvidenceMapPanel sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(screen.getByText(/尚无可视化材料/)).toBeTruthy();
    });
  });

  it("surfaces a retryable error when the request fails", async () => {
    getEvidenceMap.mockRejectedValue(new Error("网络失败"));
    render(<EvidenceMapPanel sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });
});

/**
 * The readiness predicate, driven directly. These are the cases the browser
 * tests can only reach by timing, and the ones that decide whether the page is
 * allowed to say the graph is laid out.
 */
describe("allNodesMeasured", () => {
  const measured = (id: string) => ({
    id,
    internals: { handleBounds: { source: [], target: [] } }
  });
  const unmeasured = (id: string) => ({ id, internals: { handleBounds: undefined } });

  it("treats an empty graph as nothing to wait for", () => {
    expect(allNodesMeasured([], new Set())).toBe(true);
  });

  it("is false while the store is still empty", () => {
    expect(allNodesMeasured([], new Set(["claim:c1"]))).toBe(false);
  });

  it("is true when every expected node has been measured", () => {
    const store = [measured("claim:c1"), measured("evidence:e1")];
    expect(allNodesMeasured(store, new Set(["claim:c1", "evidence:e1"]))).toBe(true);
  });

  it("is false when one expected node has not been measured yet", () => {
    const store = [measured("claim:c1"), unmeasured("evidence:e1")];
    expect(allNodesMeasured(store, new Set(["claim:c1", "evidence:e1"]))).toBe(false);
  });

  it("is false when the store still holds a node this view no longer shows", () => {
    // One render after a filter change the store still describes the old set.
    // A count would coincide here and claim readiness a frame early.
    const store = [
      measured("claim:c1"),
      measured("evidence:e1"),
      measured("source:s1")
    ];
    expect(allNodesMeasured(store, new Set(["claim:c1", "evidence:e1"]))).toBe(false);
  });

  it("is false when an expected node is missing from the store", () => {
    const store = [measured("claim:c1")];
    expect(allNodesMeasured(store, new Set(["claim:c1", "evidence:e1"]))).toBe(false);
  });

  it("ignores nodes the view never asked about when the sets already match", () => {
    const store = [measured("claim:c1")];
    expect(allNodesMeasured(store, new Set(["claim:c1"]))).toBe(true);
  });

  it("counts a node with no handles as measured, since it was laid out", () => {
    // getHandleBounds returns null — not undefined — once a node has been
    // through updateNodeInternals but carries no Handle at all.
    const store = [{ id: "claim:c1", internals: { handleBounds: null } }];
    expect(allNodesMeasured(store, new Set(["claim:c1"]))).toBe(true);
  });

  it("does not wait for a hidden node, and does not let one widen the answer", () => {
    // A hidden node renders nothing, so there is nothing to measure for it.
    const withHidden = [
      measured("claim:c1"),
      { id: "evidence:e1", hidden: true, internals: { handleBounds: undefined } }
    ];
    expect(allNodesMeasured(withHidden, new Set(["claim:c1"]))).toBe(true);

    // A *visible* node the view did not ask for does block readiness.
    const withVisible = [measured("claim:c1"), measured("evidence:e1")];
    expect(allNodesMeasured(withVisible, new Set(["claim:c1"]))).toBe(false);
  });
});

/**
 * The two states as the page publishes them. `data-graph-loaded` answers "did
 * the data arrive"; `data-nodes-ready` answers "is the graph laid out". The
 * second one must stay false here: this ResizeObserver stub never fires, so
 * React Flow never measures anything, and a signal that turned true anyway
 * would be exactly the defect this round removes.
 */
describe("EvidenceMapPanel readiness states", () => {
  const canvas = () => screen.getByTestId("evidence-map-canvas");

  /**
   * The readiness value travels a real React chain before it lands on the DOM:
   * store subscription effect -> parent state -> attribute. Asserting on the
   * very next tick would pass for the wrong reason (the chain simply has not
   * run yet), so a "stays false" claim must first give that chain every chance
   * to produce true. jsdom needs a few macrotask turns for the effects to
   * cascade; if the panel were lying, one of these turns would expose it.
   */
  async function settleReadiness(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }
  }

  it("separates graph-loaded from nodes-measured while loading", async () => {
    let release: (value: unknown) => void = () => {};
    getEvidenceMap.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    render(<EvidenceMapPanel sessionId={SESSION_ID} />);

    // Still fetching: no canvas at all, so neither state is published.
    expect(screen.queryByTestId("evidence-map-canvas")).toBeNull();
    expect(screen.getByText(/正在加载证据地图/)).toBeTruthy();

    release(graph);
    await waitFor(() => {
      expect(canvas()).toBeTruthy();
    });
    expect(canvas().getAttribute("data-graph-loaded")).toBe("true");
    await settleReadiness();
    // Nothing has been measured, so the layout state must not be claimed.
    expect(canvas().getAttribute("data-nodes-ready")).toBe("false");
  });

  it("keeps nodes-ready false when nothing is ever measured", async () => {
    getEvidenceMap.mockResolvedValue(graph);
    render(<EvidenceMapPanel sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(canvas()).toBeTruthy();
    });
    // The nodes are on screen — the graph is readable — but no measurement has
    // been reported, and the panel refuses to say otherwise.
    expect(screen.getByText("企业市场增长预测")).toBeTruthy();
    await settleReadiness();
    expect(canvas().getAttribute("data-nodes-ready")).toBe("false");
  });

  it("publishes an empty graph as loaded and ready, with its empty state", async () => {
    getEvidenceMap.mockResolvedValue({
      sessionId: SESSION_ID,
      generatedAt: "2026-10-11T06:00:00.000Z",
      nodes: [],
      edges: [],
      coverage: []
    });
    render(<EvidenceMapPanel sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(canvas()).toBeTruthy();
    });
    expect(canvas().getAttribute("data-graph-loaded")).toBe("true");
    // An empty graph has no nodes to measure, so readiness is allowed to arrive
    // asynchronously (the store subscription fires after the first paint) —
    // wait for it rather than assuming the chain has already run.
    await waitFor(() => {
      expect(canvas().getAttribute("data-nodes-ready")).toBe("true");
    });
    expect(screen.getByText(/尚无可视化材料/)).toBeTruthy();
  });

  it("publishes no readiness at all when the graph fails to load", async () => {
    getEvidenceMap.mockRejectedValue(new Error("网络失败"));
    render(<EvidenceMapPanel sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    // A failed load must not read as "loaded but not laid out".
    expect(screen.queryByTestId("evidence-map-canvas")).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });
});
