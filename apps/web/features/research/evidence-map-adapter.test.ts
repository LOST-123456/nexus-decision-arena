import { describe, expect, it } from "vitest";
import type { EvidenceMapGraph } from "@nexus/shared";
import {
  applyEvidenceMapFilter,
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
