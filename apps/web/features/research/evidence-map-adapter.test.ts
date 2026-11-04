import { describe, expect, it } from "vitest";
import type { EvidenceMapGraph } from "@nexus/shared";
import {
  applyEvidenceMapFilter,
  layoutEvidenceMapNodes,
  MAX_NODES_PER_ROW,
  toEvidenceMapFlow,
  visibleNodeIdsForFilter
} from "./evidence-map-adapter";

/*
 * Pure-adapter tests: layout determinism, relation labelling, and the filter
 * semantics — especially that the "unverified" filter keeps the claims and
 * sources that give the unverified excerpts context, and that a filter never
 * leaves an edge with a missing endpoint.
 */

const SESSION_ID = "session-1";

const graph: EvidenceMapGraph = {
  sessionId: SESSION_ID,
  generatedAt: "2026-10-11T06:00:00.000Z",
  nodes: [
    {
      id: "claim:c1",
      sessionId: SESSION_ID,
      entityId: "c1",
      type: "claim",
      label: "主张A",
      status: "proposed",
      statement: "主张A",
      verdict: "insufficient_evidence"
    },
    {
      id: "evidence:e1",
      sessionId: SESSION_ID,
      entityId: "e1",
      type: "evidence",
      label: "摘录1",
      status: "unverified",
      excerpt: "原文",
      verificationStatus: "unverified",
      direction: "supports"
    },
    {
      id: "source:s1",
      sessionId: SESSION_ID,
      entityId: "s1",
      type: "source",
      label: "来源1",
      status: "fetched",
      title: "来源1",
      publisher: "P",
      sourceType: "url",
      reliability: null
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
      verifiedCount: 0,
      supportingCount: 1,
      contradictingCount: 0,
      sourceCount: 1,
      meanReliability: 0.8,
      coverage: 0
    }
  ]
};

describe("toEvidenceMapFlow", () => {
  it("lays each type out in its own layer, left-to-right within a layer", () => {
    const flow = toEvidenceMapFlow(graph);
    const byId = new Map(flow.nodes.map((node) => [node.id, node]));

    expect(byId.get("claim:c1")?.position.y).toBe(0);
    expect(byId.get("evidence:e1")?.position.y).toBe(200);
    expect(byId.get("source:s1")?.position.y).toBe(400);
  });

  it("labels every edge with the relation's Chinese label", () => {
    const flow = toEvidenceMapFlow(graph);
    const labels = flow.edges.map((edge) => edge.label);
    expect(labels).toContain("支持");
    expect(labels).toContain("出自来源");
  });
});

describe("filtering", () => {
  it("keeps only the selected type for a type filter, with no dangling edges", () => {
    const filtered = applyEvidenceMapFilter(graph, "claims");
    expect(filtered.nodes.map((node) => node.id)).toEqual(["claim:c1"]);
    expect(filtered.edges).toEqual([]);
  });

  it("expands 只看未核实证据 to include the claims and sources that give context", () => {
    const visible = visibleNodeIdsForFilter(graph, "unverified");
    expect(visible.has("evidence:e1")).toBe(true);
    // The claim the excerpt bears on and the source it came from stay visible.
    expect(visible.has("claim:c1")).toBe(true);
    expect(visible.has("source:s1")).toBe(true);

    const filtered = applyEvidenceMapFilter(graph, "unverified");
    expect(filtered.nodes).toHaveLength(3);
    expect(filtered.edges).toHaveLength(2);
  });

  it("keeps coverage only for claims that remain visible", () => {
    const filtered = applyEvidenceMapFilter(graph, "evidence");
    expect(filtered.coverage).toEqual([]);
    const all = applyEvidenceMapFilter(graph, "all");
    expect(all.coverage).toHaveLength(1);
  });
});

/*
 * Layout bounds: the layout is the thing that decides whether a large research
 * session is readable at all. Placing a whole band on one row made the canvas
 * width linear in the material (120 excerpts -> 36,000 px), which no `fitView`
 * can bring into view because `minZoom` clamps first. These tests pin the
 * bound, not a pixel-perfect picture.
 */
describe("layout bounds", () => {
  const evidence = (index: number): EvidenceMapGraph["nodes"][number] => ({
    id: `evidence:e${index}`,
    sessionId: SESSION_ID,
    entityId: `e${index}`,
    type: "evidence",
    label: `摘录${index}`,
    status: "unverified",
    excerpt: "原文",
    verificationStatus: "unverified",
    direction: "supports"
  });

  const claim = (index: number): EvidenceMapGraph["nodes"][number] => ({
    id: `claim:c${index}`,
    sessionId: SESSION_ID,
    entityId: `c${index}`,
    type: "claim",
    label: `主张${index}`,
    status: "proposed",
    statement: `主张${index}`,
    verdict: "insufficient_evidence"
  });

  it("wraps a crowded band instead of stretching the canvas with it", () => {
    const layout = layoutEvidenceMapNodes(
      Array.from({ length: 120 }, (_, index) => evidence(index + 1))
    );

    // 120 nodes = 20 rows of 6; the width is set by the row cap, not by 120.
    expect(layout.width).toBeLessThan(MAX_NODES_PER_ROW * 300);
    expect(layout.height).toBeGreaterThan(layout.width);
  });

  it("never leaves two nodes on the same coordinate and never overlaps a band", () => {
    const layout = layoutEvidenceMapNodes([
      ...Array.from({ length: 10 }, (_, index) => claim(index + 1)),
      evidence(1)
    ]);

    const occupied = new Set<string>();
    for (const position of layout.positions.values()) {
      const key = `${position.x}:${position.y}`;
      expect(occupied.has(key)).toBe(false);
      occupied.add(key);
    }

    // The claim band needs two rows, so the evidence band starts below both.
    expect(layout.positions.get("claim:c1")).toEqual({ x: 0, y: 0 });
    expect(layout.positions.get("claim:c7")).toEqual({ x: 0, y: 200 });
    expect(layout.positions.get("evidence:e1")).toEqual({ x: 0, y: 400 });
  });

  it("draws the same picture for the same material", () => {
    const nodes = Array.from({ length: 9 }, (_, index) => evidence(index + 1));
    const first = layoutEvidenceMapNodes(nodes).positions;
    const second = layoutEvidenceMapNodes(nodes).positions;

    expect([...first.entries()]).toEqual([...second.entries()]);
  });
});
