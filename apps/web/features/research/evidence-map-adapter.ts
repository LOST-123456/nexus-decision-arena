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

const ROW_GAP = 200;
const COLUMN_GAP = 300;

/** Layer order follows the evidence chain: claim → excerpt → source → conflict → challenge. */
const TYPE_ORDER: readonly EvidenceMapNodeType[] = [
  "claim",
  "evidence",
  "source",
  "conflict",
  "challenge"
];

/**
 * Nodes per row inside one band.
 *
 * This exists because the previous layout put a band on a single row, so the
 * canvas width grew linearly with the material: 120 excerpts meant a 36,000 px
 * strip. `fitView` cannot out-zoom `minZoom`, so the whole map fell outside the
 * viewport and the surface became unusable long before it became slow. Wrapping
 * at six keeps any band at most 1,800 px wide (`6 × COLUMN_GAP`), which fits a
 * desktop viewport at a readable zoom, while height grows in row steps instead.
 *
 * Six is also the point where a wrapped band still reads as one horizontal
 * scan line: the node is 240 px wide with a 60 px gutter, so six of them plus
 * the frame land just under a 1,536 px artwork.
 */
export const MAX_NODES_PER_ROW = 6;

export type EvidenceMapLayout = {
  /** Deterministic position per node id. */
  positions: Map<string, { x: number; y: number }>;
  /** Width of the laid-out picture, in flow units. */
  width: number;
  /** Height of the laid-out picture, in flow units. */
  height: number;
};

/**
 * Lays the graph out as wrapped bands, top to bottom in evidence-chain order.
 *
 * Pure and deterministic: the same node set always produces the same picture,
 * and no Math.random / force simulation is involved. Band height is derived
 * from how many rows that band actually needs, so a band that wraps pushes the
 * next band down rather than overlapping it.
 */
export function layoutEvidenceMapNodes(nodes: EvidenceMapNode[]): EvidenceMapLayout {
  const positions = new Map<string, { x: number; y: number }>();
  let top = 0;
  let widest = 0;

  for (const type of TYPE_ORDER) {
    const band = nodes.filter((node) => node.type === type);
    if (band.length === 0) continue;

    band.forEach((node, index) => {
      positions.set(node.id, {
        x: (index % MAX_NODES_PER_ROW) * COLUMN_GAP,
        y: top + Math.floor(index / MAX_NODES_PER_ROW) * ROW_GAP
      });
    });

    const rows = Math.ceil(band.length / MAX_NODES_PER_ROW);
    const columns = Math.min(band.length, MAX_NODES_PER_ROW);
    widest = Math.max(widest, columns);
    top += rows * ROW_GAP;
  }

  return {
    positions,
    width: widest === 0 ? 0 : (widest - 1) * COLUMN_GAP,
    height: top === 0 ? 0 : top - ROW_GAP
  };
}

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
  return TYPE_ORDER
    .map((type) => [type, nodes.filter((node) => node.type === type)] as const)
    .filter((entry): entry is [EvidenceMapNodeType, EvidenceMapNode[]] =>
      entry[1].length > 0
    );
}

export function toEvidenceMapFlow(graph: EvidenceMapGraph): {
  nodes: EvidenceMapFlowNode[];
  edges: EvidenceMapFlowEdge[];
} {
  const layout = layoutEvidenceMapNodes(graph.nodes);
  const flowNodes: EvidenceMapFlowNode[] = [];
  for (const [type, typedNodes] of groupByType(graph.nodes)) {
    for (const node of typedNodes) {
      flowNodes.push({
        id: node.id,
        type: "evidence-map",
        // Every node in `graph.nodes` has a position; the fallback only exists
        // so the adapter cannot produce `undefined` coordinates if a future
        // type is added to the union without being added to `TYPE_ORDER`.
        position: layout.positions.get(node.id) ?? { x: 0, y: 0 },
        data: {
          node,
          kindLabel: evidenceMapNodeTypeLabel[type],
          statusLabel: evidenceMapNodeStatusLabel(node)
        }
      });
    }
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
