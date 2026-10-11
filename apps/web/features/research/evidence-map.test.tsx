import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Component tests for the Evidence Map surface. The data access is faked;
 * what is pinned down is the honesty contract of the UI:
 *  - the graph renders with node labels and a disclaimer that edges are
 *    relationships, not proof;
 *  - clicking a node opens the detail panel with the spec'd fields;
 *  - the filter chips switch views;
 *  - the empty state says there is nothing to draw yet.
 */

const getEvidenceMap = vi.fn();

vi.mock("./api", () => ({
  getEvidenceMap: (...args: unknown[]) => getEvidenceMap(...args)
}));

const { EvidenceMapPanel } = await import("./evidence-map");

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
