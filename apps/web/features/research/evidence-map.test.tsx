import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceMapGraph } from "@nexus/shared";
import type { EvidenceMapFilter } from "./evidence-map-adapter";

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

const {
  EvidenceMapPanel,
  allNodesMeasured,
  evidenceMapFlowContentKey,
  useEvidenceMapFlow
} = await import("./evidence-map");

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

/* --- flow identity fixtures ---------------------------------------
 * A re-fetch answers with the same content as brand-new objects; these
 * helpers produce exactly that, plus single-field changes of any node or
 * edge kind without fighting the discriminated union. */

/** A re-fetch's answer: same content, brand-new object identities. */
function refetchedGraph(): EvidenceMapGraph {
  return JSON.parse(JSON.stringify(graph)) as EvidenceMapGraph;
}

/** A copy of the fixture graph with one node patched. */
function withNode(
  index: number,
  patch: Record<string, unknown>
): EvidenceMapGraph {
  const next = refetchedGraph();
  const node = next.nodes[index];
  if (!node) throw new Error(`fixture graph has no node at ${index}`);
  Object.assign(node as unknown as Record<string, unknown>, patch);
  return next;
}

/** A copy of the fixture graph with one edge patched. */
function withEdge(
  index: number,
  patch: Record<string, unknown>
): EvidenceMapGraph {
  const next = refetchedGraph();
  const edge = next.edges[index];
  if (!edge) throw new Error(`fixture graph has no edge at ${index}`);
  Object.assign(edge as unknown as Record<string, unknown>, patch);
  return next;
}

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

/**
 * Flow identity — the stability half of the readiness contract.
 *
 * React Flow adopts the `nodes` prop by reference and resets every node's
 * `internals.handleBounds` when the prop arrives as new objects, which drops
 * `nodesMeasured` until the ResizeObserver reports again. Under `next dev`,
 * Strict Mode runs the load effect twice, so the second fetch's answer — an
 * equal graph as a new object — used to look exactly like a layout change.
 *
 * These pin down the two sides of the fix: equal content must keep the flow
 * (and its node objects) identical, and every field that changes what is
 * drawn must rebuild it. The predicate itself is unchanged and stays strict.
 */
describe("evidenceMapFlowContentKey", () => {
  const emptyGraph: EvidenceMapGraph = {
    sessionId: SESSION_ID,
    generatedAt: "2026-10-11T06:00:00.000Z",
    nodes: [],
    edges: [],
    coverage: []
  };

  it("keys equal content the same across object identities", () => {
    expect(evidenceMapFlowContentKey(refetchedGraph(), "all")).toBe(
      evidenceMapFlowContentKey(graph, "all")
    );
  });

  it("keys differently when a node label changes", () => {
    expect(evidenceMapFlowContentKey(withNode(0, { label: "换了一个说法的主张" }), "all")).not.toBe(
      evidenceMapFlowContentKey(graph, "all")
    );
  });

  it("keys differently when a node status changes", () => {
    expect(evidenceMapFlowContentKey(withNode(0, { status: "supported" }), "all")).not.toBe(
      evidenceMapFlowContentKey(graph, "all")
    );
    expect(evidenceMapFlowContentKey(withNode(1, { verificationStatus: "rejected" }), "all")).not.toBe(
      evidenceMapFlowContentKey(graph, "all")
    );
  });

  it("keys differently when an edge relation changes", () => {
    expect(evidenceMapFlowContentKey(withEdge(0, { relation: "opposes" }), "all")).not.toBe(
      evidenceMapFlowContentKey(graph, "all")
    );
  });

  it("keys differently when the filter changes", () => {
    expect(evidenceMapFlowContentKey(graph, "claims")).not.toBe(
      evidenceMapFlowContentKey(graph, "all")
    );
  });

  it("keys an empty graph stably, and apart from a non-empty one", () => {
    const emptyAgain = JSON.parse(
      JSON.stringify(emptyGraph)
    ) as EvidenceMapGraph;
    expect(evidenceMapFlowContentKey(emptyAgain, "all")).toBe(
      evidenceMapFlowContentKey(emptyGraph, "all")
    );
    expect(evidenceMapFlowContentKey(emptyGraph, "all")).not.toBe(
      evidenceMapFlowContentKey(graph, "all")
    );
  });

  it("keys another session's graph differently", () => {
    const otherSession = refetchedGraph();
    otherSession.sessionId = "session-2";
    expect(evidenceMapFlowContentKey(otherSession, "all")).not.toBe(
      evidenceMapFlowContentKey(graph, "all")
    );
  });

  it("ignores generatedAt: a refresh timestamp alone must not rebuild", () => {
    const refreshed = refetchedGraph();
    refreshed.generatedAt = "2026-10-18T06:00:00.000Z";
    expect(evidenceMapFlowContentKey(refreshed, "all")).toBe(
      evidenceMapFlowContentKey(graph, "all")
    );
  });

  it("ignores coverage: the flow never reads it", () => {
    // The detail panel reads the live graph object, not the flow, so a
    // coverage-only change must not churn the nodes React Flow holds.
    const reCovered = refetchedGraph();
    reCovered.coverage = [
      {
        claimId: "c1",
        evidenceCount: 9,
        verifiedCount: 9,
        supportingCount: 9,
        contradictingCount: 0,
        sourceCount: 3,
        meanReliability: 0.9,
        coverage: 0.9
      }
    ];
    expect(evidenceMapFlowContentKey(reCovered, "all")).toBe(
      evidenceMapFlowContentKey(graph, "all")
    );
  });
});

/**
 * Collision defences — the reason the key is a tagged join and not a plain
 * concatenation.
 *
 * A flat `field=value` join with control-character separators looks safe until
 * you try to break it: a label carrying a raw `\u0000` can forge the field
 * boundary that follows it, and `5` and `"5"` stringify identically. Both
 * produced real collisions before this round (verified against the shipped
 * implementation); each case below pins the fix so the equal-key/different-
 * content failure — the exact failure the content key exists to prevent —
 * cannot come back through a refactor.
 *
 * Inputs marked "defence" are shapes the schema does not produce today; the
 * key is a pure function, so it must stay injective anyway, and a schema
 * widening must not silently turn a field-type flip into a swallowed edit.
 */
describe("evidenceMapFlowContentKey collision defences", () => {
  const k = (g: EvidenceMapGraph) => evidenceMapFlowContentKey(g, "all");

  /** A record-level graph, for defence cases the schema would reject. */
  function looseGraph(
    nodes: unknown[],
    edges: unknown[] = []
  ): EvidenceMapGraph {
    return {
      sessionId: SESSION_ID,
      generatedAt: "2026-10-11T06:00:00.000Z",
      nodes,
      edges,
      coverage: []
    } as never;
  }

  it("keeps a label carrying the field separator from forging the next field", () => {
    // A paste can carry a raw NUL into a label (schema: any non-empty string).
    // Under the old join these two nodes produced the SAME key, so the second
    // render kept the first node's label — a real change swallowed as none.
    const plain = withNode(2, {
      label: "Gartner 报告",
      title: "Gartner 报告"
    });
    const smuggled = withNode(2, {
      label: "Gartner 报告\u0000title=Gartner 报告",
      title: "Gartner 报告"
    });
    expect(k(smuggled)).not.toBe(k(plain));
  });

  it("keeps an edge endpoint carrying the field separator from forging its pair", () => {
    const plain = withEdge(0, { from: "evidence:e1", to: "claim:c1" });
    const smuggled = withEdge(0, {
      from: "evidence:e1\u0000to=claim:c1",
      to: "claim:c1"
    });
    expect(k(smuggled)).not.toBe(k(plain));
  });

  it("separates records even when a value carries the record separator", () => {
    const two = looseGraph([{ id: "n1" }, { id: "n2" }]);
    const smuggler = looseGraph([{ id: "n1\u001en2" }]);
    expect(k(smuggler)).not.toBe(k(two));
  });

  it("keeps a session id carrying the section separator from merging sections", () => {
    // Defence: IdSchema is a UUID today, so this cannot arrive from the API,
    // but the key must not depend on that staying true.
    const merged = looseGraph([{ id: "n1" }]);
    merged.sessionId = "s\u001fn1\u001fall\u001f";
    const normal = looseGraph([{ id: "n1" }]);
    normal.sessionId = "s";
    expect(k(merged)).not.toBe(k(normal));
  });

  it("distinguishes null, undefined and empty string in the same field", () => {
    // publisher is `string | null`; "" is a legal value that renders
    // differently from null ("未记录"), so all three must key apart.
    const withNull = withNode(2, { publisher: null });
    const withUndefined = withNode(2, { publisher: undefined });
    const withEmpty = withNode(2, { publisher: "" });
    const keys = new Set([k(withNull), k(withUndefined), k(withEmpty)]);
    expect(keys.size).toBe(3);
  });

  it("keys a number differently from its string form (defence)", () => {
    const numeric = looseGraph([{ id: "n1", type: "conflict", severity: 5 }]);
    const stringy = looseGraph([{ id: "n1", type: "conflict", severity: "5" }]);
    expect(k(stringy)).not.toBe(k(numeric));
  });

  it("keys a boolean differently from its string form (defence)", () => {
    const flagged = looseGraph([{ id: "n1", flag: true }]);
    const stringy = looseGraph([{ id: "n1", flag: "true" }]);
    expect(k(stringy)).not.toBe(k(flagged));
  });

  it("keys differently when the node order changes", () => {
    const reordered = refetchedGraph();
    const first = reordered.nodes[0];
    const second = reordered.nodes[1];
    if (!first || !second) throw new Error("fixture graph is missing nodes");
    reordered.nodes = [second, first, ...reordered.nodes.slice(2)];
    expect(k(reordered)).not.toBe(k(graph));
  });

  it("keys differently when the edge order changes", () => {
    const reordered = refetchedGraph();
    const first = reordered.edges[0];
    const second = reordered.edges[1];
    if (!first || !second) throw new Error("fixture graph is missing edges");
    reordered.edges = [second, first, ...reordered.edges.slice(2)];
    expect(k(reordered)).not.toBe(k(graph));
  });

  it("keeps an equals sign inside a value from reading as a field separator", () => {
    // Sanity: `=` is NOT a separator, so a value containing it is unambiguous.
    // The fix's quoting keeps this property structural rather than lucky.
    const withEquals = withNode(1, { label: "supports=claim" });
    expect(k(withEquals)).not.toBe(k(graph));
    const otherShape = looseGraph([
      { id: "n1", label: "supports=claim" },
      { id: "n2" }
    ]);
    const singleField = looseGraph([{ id: "n1", label: "supports=claim" }]);
    expect(k(otherShape)).not.toBe(k(singleField));
  });

  it("keeps equal numeric values keyed alike across identities", () => {
    // 1 and 1.0 are the same number; the key must not split them.
    const a = looseGraph([{ id: "n1", confidence: 1 }]);
    const b = looseGraph([{ id: "n1", confidence: 1.0 }]);
    expect(k(a)).toBe(k(b));
  });
});

/**
 * The hook the panel derives its flow from. What is verified here is exactly
 * what jsdom can observe: object identity across equal re-fetches, and
 * correct rebuilds on real changes. That a rebuilt flow also re-measures and
 * reaches ready again is browser behaviour — the ResizeObserver stub in this
 * file never fires — and is covered by the E2E readiness spec instead.
 */
describe("useEvidenceMapFlow", () => {
  function setup(
    initialGraph: EvidenceMapGraph | null,
    initialFilter: EvidenceMapFilter = "all"
  ) {
    return renderHook(
      ({
        g,
        f
      }: {
        g: EvidenceMapGraph | null;
        f: EvidenceMapFilter;
      }) => useEvidenceMapFlow(g, f),
      { initialProps: { g: initialGraph, f: initialFilter } }
    );
  }

  it("keeps the flow and its node objects when a re-fetch returns equal content", () => {
    const { result, rerender } = setup(graph);
    const first = result.current;

    rerender({ g: refetchedGraph(), f: "all" });

    expect(result.current).toBe(first);
    expect(result.current.nodes[0]).toBe(first.nodes[0]);
    expect(result.current.edges).toBe(first.edges);
  });

  it("rebuilds the flow when a node label changes", () => {
    const { result, rerender } = setup(graph);
    const first = result.current;

    rerender({ g: withNode(0, { label: "换了一个说法的主张" }), f: "all" });

    expect(result.current).not.toBe(first);
    expect(result.current.nodes[0]?.data.node.label).toBe("换了一个说法的主张");
  });

  it("rebuilds the flow when the filter changes", () => {
    const { result, rerender } = setup(graph);
    const first = result.current;

    rerender({ g: graph, f: "claims" });

    expect(result.current).not.toBe(first);
    expect(result.current.nodes.map((node) => node.id)).toEqual(["claim:c1"]);
  });

  it("keeps the empty flow identity across equal empty re-fetches", () => {
    const emptyGraph: EvidenceMapGraph = {
      sessionId: SESSION_ID,
      generatedAt: "2026-10-11T06:00:00.000Z",
      nodes: [],
      edges: [],
      coverage: []
    };
    const { result, rerender } = setup(emptyGraph);
    const first = result.current;

    rerender({
      g: JSON.parse(JSON.stringify(emptyGraph)) as EvidenceMapGraph,
      f: "all"
    });

    expect(result.current).toBe(first);
    expect(result.current.nodes).toHaveLength(0);
  });

  it("does not reuse a previous session's flow", () => {
    const { result, rerender } = setup(graph);
    const first = result.current;

    // Another session's graph: same shape, every record stamped with the
    // other session. The flow must be rebuilt from it, never borrowed.
    const otherSession = refetchedGraph();
    otherSession.sessionId = "session-2";
    otherSession.nodes = otherSession.nodes.map((node) => ({
      ...node,
      sessionId: "session-2"
    }));
    rerender({ g: otherSession, f: "all" });

    expect(result.current).not.toBe(first);
    expect(result.current.nodes[0]?.data.node.sessionId).toBe("session-2");
    expect(result.current.nodes[0]?.data.node.label).toBe(
      first.nodes[0]?.data.node.label
    );
  });

  it("returns the shared empty flow for a null graph, and a real one after", () => {
    const { result, rerender } = setup(graph);
    expect(result.current.nodes).toHaveLength(3);

    rerender({ g: null, f: "all" });
    expect(result.current.nodes).toHaveLength(0);
    expect(result.current.edges).toHaveLength(0);

    rerender({ g: graph, f: "all" });
    expect(result.current.nodes).toHaveLength(3);
  });

  it("rebuilds the flow for a label that smuggles a field boundary", () => {
    // The end-to-end form of the collision case: a legal label value that
    // used to produce the same content key as the plain node, so the flow —
    // and the label on screen — stayed stale. The rebuild must land the new
    // text, not just differ in identity.
    const { result, rerender } = setup(graph);
    const first = result.current;

    rerender({
      g: withNode(0, { label: "企业市场增长预测\u0000type=claim" }),
      f: "all"
    });

    expect(result.current).not.toBe(first);
    expect(result.current.nodes[0]?.data.node.label).toBe(
      "企业市场增长预测\u0000type=claim"
    );
  });

  it("keeps the flow identity when only a node's field order in the key changes", () => {
    // Same content, same key: a re-fetch that returns the identical graph in
    // a fresh object must not churn the flow even though the underlying
    // records are new instances.
    const { result, rerender } = setup(graph);
    const first = result.current;

    rerender({ g: refetchedGraph(), f: "all" });

    expect(result.current).toBe(first);
  });
});
