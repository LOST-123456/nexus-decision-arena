import type { Edge, Node } from "@xyflow/react";
import type {
  EvidenceMapGraph,
  EvidenceMapNode,
  EvidenceMapNodeType,
  EvidenceMapRelation
} from "@nexus/shared";
import {
  evidenceMapNodeStatusLabel,
  evidenceMapNodeTypeLabel,
  evidenceMapRelationLabel
} from "./labels";

/*
 * Evidence Map adapter — turns the server's graph projection into React Flow
 * nodes and edges. Pure functions only: no fetching, no state, no verdict
 * logic. The layout is deterministic (layered rows), so the same graph always
 * draws the same picture.
 *
 * Layer order follows the evidence chain, not a workflow: the claims under
 * examination sit on top, the excerpts that bear on them in the middle, the
 * sources the excerpts came from underneath, and the conflicts / challenges
 * the material raised at the bottom.
 */

export type EvidenceMapFilter =
  | "all"
  | "claims"
  | "evidence"
  | "conflicts"
  | "unverified";

export const EVIDENCE_MAP_FILTERS: ReadonlyArray<{
  id: EvidenceMapFilter;
  label: string;
}> = [
  { id: "all", label: "全部" },
  { id: "claims", label: "只看主张" },
  { id: "evidence", label: "只看证据" },
  { id: "conflicts", label: "只看冲突" },
  { id: "unverified", label: "只看未核实证据" }
];

export type EvidenceMapNodeData = {
  node: EvidenceMapNode;
  kindLabel: string;
  statusLabel: string;
};

export type EvidenceMapFlowNode = Node<EvidenceMapNodeData, "evidence-map">;
export type EvidenceMapFlowEdge = Edge;

const ROW_Y: Record<EvidenceMapNodeType, number> = {
  claim: 0,
  evidence: 200,
  source: 400,
  conflict: 600,
  challenge: 800
};

const COLUMN_GAP = 300;

/**
 * Relation visuals reuse the decision map's CSS variables so both graphs read
 * with the same visual grammar: green = support, red = opposition, warning =
 * conflict, neutral = structural.
 */
const RELATION_VISUALS: Record<
  EvidenceMapRelation,
  { color: string; dashArray: string; markerEnd?: "arrowclosed" }
> = {
  supports: { color: "var(--supports)", dashArray: "none", markerEnd: "arrowclosed" },
  opposes: { color: "var(--opposes)", dashArray: "10 4", markerEnd: "arrowclosed" },
  context: { color: "var(--line-strong)", dashArray: "2 6" },
  provided_by: { color: "var(--line-strong)", dashArray: "1 5" },
  involved_in: {
    color: "var(--warning)",
    dashArray: "8 3 2 3",
    markerEnd: "arrowclosed"
  },
  questions: {
    color: "var(--danger)",
    dashArray: "4 4",
    markerEnd: "arrowclosed"
  },
  generated_by: {
    color: "var(--warning)",
    dashArray: "10 3",
    markerEnd: "arrowclosed"
  }
};

/** Groups nodes by type in stable layer order. */
function groupByType(
  nodes: EvidenceMapNode[]
): Array<[EvidenceMapNodeType, EvidenceMapNode[]]> {
  const order: EvidenceMapNodeType[] = [
    "claim",
    "evidence",
    "source",
    "conflict",
    "challenge"
  ];
  return order
    .map((type) => [type, nodes.filter((node) => node.type === type)] as const)
    .filter((entry): entry is [EvidenceMapNodeType, EvidenceMapNode[]] =>
      entry[1].length > 0
    );
}

export function toEvidenceMapFlow(graph: EvidenceMapGraph): {
  nodes: EvidenceMapFlowNode[];
  edges: EvidenceMapFlowEdge[];
} {
  const flowNodes: EvidenceMapFlowNode[] = [];
  for (const [type, typedNodes] of groupByType(graph.nodes)) {
    typedNodes.forEach((node, column) => {
      flowNodes.push({
        id: node.id,
        type: "evidence-map",
        position: { x: column * COLUMN_GAP, y: ROW_Y[type] },
        data: {
          node,
          kindLabel: evidenceMapNodeTypeLabel[node.type],
          statusLabel: evidenceMapNodeStatusLabel(node)
        }
      });
    });
  }

  const flowEdges: EvidenceMapFlowEdge[] = graph.edges.map((edge) => {
    const visual = RELATION_VISUALS[edge.relation];
    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: "smoothstep",
      label: evidenceMapRelationLabel[edge.relation],
      ariaLabel: evidenceMapRelationLabel[edge.relation],
      className: `evidence-map-edge evidence-map-edge-${edge.relation}`,
      ...(visual.markerEnd ? { markerEnd: visual.markerEnd } : {}),
      style: {
        stroke: visual.color,
        strokeWidth: 1.8,
        strokeDasharray: visual.dashArray
      }
    };
  });

  return { nodes: flowNodes, edges: flowEdges };
}

/**
 * Node ids visible under a filter. The "unverified" filter is the one that
 * expands beyond its literal type: it also keeps the claims those excerpts
 * bear on and the sources they came from, so the picture still explains
 * itself instead of showing floating nodes.
 */
export function visibleNodeIdsForFilter(
  graph: EvidenceMapGraph,
  filter: EvidenceMapFilter
): Set<string> {
  if (filter === "all") {
    return new Set(graph.nodes.map((node) => node.id));
  }
  if (filter === "claims" || filter === "evidence" || filter === "conflicts") {
    const type: EvidenceMapNodeType =
      filter === "claims" ? "claim" : filter === "evidence" ? "evidence" : "conflict";
    return new Set(
      graph.nodes.filter((node) => node.type === type).map((node) => node.id)
    );
  }

  const visible = new Set<string>();
  for (const node of graph.nodes) {
    if (
      node.type === "evidence" &&
      node.verificationStatus === "unverified"
    ) {
      visible.add(node.id);
    }
  }
  for (const edge of graph.edges) {
    if (
      visible.has(edge.from) &&
      (edge.relation === "supports" ||
        edge.relation === "opposes" ||
        edge.relation === "context")
    ) {
      visible.add(edge.to);
    }
    if (visible.has(edge.to) && edge.relation === "provided_by") {
      visible.add(edge.from);
    }
  }
  return visible;
}

/** The graph restricted to a filter: nodes kept, edges only when both ends stay. */
export function applyEvidenceMapFilter(
  graph: EvidenceMapGraph,
  filter: EvidenceMapFilter
): EvidenceMapGraph {
  const visible = visibleNodeIdsForFilter(graph, filter);
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => visible.has(node.id)),
    edges: graph.edges.filter(
      (edge) => visible.has(edge.from) && visible.has(edge.to)
    ),
    coverage: graph.coverage.filter((entry) =>
      visible.has(`claim:${entry.claimId}`)
    )
  };
}
