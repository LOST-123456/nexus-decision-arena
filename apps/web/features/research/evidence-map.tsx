"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  useStoreApi,
  type NodeProps
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { EvidenceMapGraph } from "@nexus/shared";
import { getEvidenceMap } from "./api";
import {
  applyEvidenceMapFilter,
  EVIDENCE_MAP_FILTERS,
  toEvidenceMapFlow,
  type EvidenceMapFilter,
  type EvidenceMapFlowEdge,
  type EvidenceMapFlowNode
} from "./evidence-map-adapter";
import {
  directionLabel,
  evidenceMapNodeStatusLabel,
  evidenceMapNodeTypeLabel,
  sourceKindLabel,
  verdictLabel
} from "./labels";

/*
 * 证据地图 — the research material drawn as a relationship graph.
 *
 * What this surface refuses to do is as important as what it shows: an edge
 * between evidence and a claim is rendered as a DIRECTION ("支持"/"反对"/
 * "背景"), never as a proof badge. The verdict line on a claim node comes
 * from the derived ClaimVerdict, and the coverage number is presented as a
 * metric only — the panel says so, in text, next to the number.
 */

const nodeTypes = {
  "evidence-map": EvidenceMapGraphNode
};

/* ------------------------------------------------------------------ *
 * Flow identity
 *
 * React Flow adopts the `nodes` prop by reference: a new array of new node
 * objects makes `StoreUpdater` call `setNodes`, and `adoptUserNodes` then
 * rebuilds every internal node whose user object it has not seen before —
 * resetting `internals.handleBounds` for all of them, because the flow nodes
 * this panel passes never carry a `measured` field. `nodesMeasured` drops
 * back to false until the ResizeObserver reports the unchanged sizes again.
 *
 * Under `next dev`, React Strict Mode runs the panel's load effect twice, so
 * a re-fetch returns an equal graph as a new object and the flow derived from
 * it churns for no visible reason. A stable flow identity is what keeps the
 * readiness signal honest AND still: equal content must not look like a
 * layout change.
 * ------------------------------------------------------------------ */

/** Shared empty flow: an empty graph has no nodes to give identity to. */
const EMPTY_EVIDENCE_MAP_FLOW: {
  nodes: EvidenceMapFlowNode[];
  edges: EvidenceMapFlowEdge[];
} = { nodes: [], edges: [] };

/* Control characters as separators: real field values (ids, labels, status
 * words) never contain them, so no two different structures can collide into
 * the same key by accident. */
const FIELD_SEP = "\u0000";
const RECORD_SEP = "\u001e";
const SECTION_SEP = "\u001f";

/**
 * One field of a node or edge record as a key fragment.
 *
 * Two defences are load-bearing here, and each closes a collision a plain
 * `String(value)` leaves open:
 *
 *  1. A type tag. `5` and `"5"` stringify identically, as do `true` and
 *     `"true"`; without the tag a record whose field flipped between a number
 *     and its string form would keep the old key and the old picture.
 *
 *  2. `JSON.stringify` for strings. It escapes every control character, so a
 *     label carrying a raw `\u0000` can no longer extend past its own field
 *     and forge the separator of the next one — the equal-key/different-
 *     content case this whole key exists to prevent. `=` inside a value was
 *     never ambiguous (field names are a fixed, known set), but quoting keeps
 *     that property obvious rather than incidental.
 */
function primitiveKeyPart(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return `s${JSON.stringify(value)}`;
    case "number":
      return `n${value}`;
    case "boolean":
      return `b${value}`;
    case "undefined":
      return "u";
    default:
      /* Every current node/edge field is a primitive. If one ever stops
       * being one, fall back to a structural serialization so two different
       * values can never share a key — an equal-looking key must never be
       * produced by different content. */
      return `o${JSON.stringify(value)}`;
  }
}

/**
 * A content key for everything the flow derives from a graph.
 *
 * It covers every field of every node and edge record — ids, types, labels,
 * statuses, positions' inputs, relations, confidences — plus the filter, in
 * graph order. Two graphs with the same key draw exactly the same picture.
 *
 * It deliberately excludes `generatedAt` and `coverage`: neither reaches the
 * flow (the node detail panel reads the live `graph` object, not the flow),
 * and keying on a refresh timestamp would rebuild the flow on every re-fetch
 * even when nothing on screen would change — the very churn this exists to
 * stop. Node and edge records are flat primitive objects, so the key is a
 * join, not a serialization of the whole graph.
 */
export function evidenceMapFlowContentKey(
  graph: EvidenceMapGraph,
  filter: EvidenceMapFilter
): string {
  const recordKey = (record: Record<string, unknown>): string =>
    Object.keys(record)
      .map((field) => `${field}=${primitiveKeyPart(record[field])}`)
      .join(FIELD_SEP);

  const nodeKeys = graph.nodes.map((node) =>
    recordKey(node as unknown as Record<string, unknown>)
  );
  const edgeKeys = graph.edges.map((edge) =>
    recordKey(edge as unknown as Record<string, unknown>)
  );

  return [
    graph.sessionId,
    filter,
    nodeKeys.join(RECORD_SEP),
    edgeKeys.join(RECORD_SEP)
  ].join(SECTION_SEP);
}

/**
 * The flow for the current graph and filter, with a stable identity across
 * re-fetches that return equal content.
 *
 * The memo is keyed on the content key rather than the graph object: when a
 * second fetch (Strict Mode's double effect, a retry, a future refresh)
 * returns an equal graph, the previously built flow is reused — same node
 * objects, so React Flow sees an unchanged `nodes` prop, never re-adopts the
 * nodes, and never resets the measurement the readiness signal reads. When
 * the content really differs — a label, a status, an edge, the filter, the
 * session — the key differs and the flow is rebuilt from the live graph.
 *
 * The hook is component-local by construction: nothing is cached across
 * panels, so two research sessions can never borrow each other's flow.
 */
export function useEvidenceMapFlow(
  graph: EvidenceMapGraph | null,
  filter: EvidenceMapFilter
): { nodes: EvidenceMapFlowNode[]; edges: EvidenceMapFlowEdge[] } {
  const contentKey = useMemo(
    () => (graph ? evidenceMapFlowContentKey(graph, filter) : null),
    [graph, filter]
  );

  return useMemo(() => {
    if (graph === null || contentKey === null) return EMPTY_EVIDENCE_MAP_FLOW;
    return toEvidenceMapFlow(applyEvidenceMapFilter(graph, filter));
    // `graph` and `filter` are captured; `contentKey` encodes every field the
    // flow derives from them, so this rebuilds exactly when the drawn picture
    // would change — and never when only the object identity changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentKey]);
}

/**
 * The slice of React Flow's internal node record this panel needs in order to
 * say "this node has been measured". Declared structurally so the predicate
 * below stays a pure function that unit tests can drive without a browser.
 */
export type MeasurableNodeRecord = {
  id: string;
  hidden?: boolean;
  internals: { handleBounds?: unknown };
};

/**
 * True when the store holds exactly the expected node set and every one of
 * them has been measured.
 *
 * "Measured" means React Flow's own `updateNodeInternals` has run for that
 * node: it is the only place that writes `internals.handleBounds`, and it only
 * gets there after `getDimensions` returned a non-zero width and height. A node
 * whose handle bounds are still `undefined` has not been laid out yet, so its
 * edges have no real endpoints to attach to.
 *
 * The store is compared as a *set*, not a count. React Flow adopts a new `nodes`
 * prop in an effect, so for one render after a filter change the store still
 * describes the previous node set; a count alone can coincide with the new one
 * and claim readiness a frame early. Comparing ids makes that impossible.
 *
 * `hidden` nodes render nothing, so they are neither waited for nor allowed to
 * widen the answer. This panel never hides a node — the adapter sets no such
 * flag — so the branch exists only to stay faithful to how React Flow itself
 * counts.
 */
export function allNodesMeasured(
  nodes: Iterable<MeasurableNodeRecord>,
  expectedIds: ReadonlySet<string>
): boolean {
  if (expectedIds.size === 0) {
    // An empty graph has nothing to wait for; its empty state is the answer.
    return true;
  }
  let visible = 0;
  let measured = 0;
  for (const node of nodes) {
    if (node.hidden) {
      continue;
    }
    visible += 1;
    if (!expectedIds.has(node.id)) {
      // The store still holds a node this view no longer shows.
      return false;
    }
    if (node.internals.handleBounds !== undefined) {
      measured += 1;
    }
  }
  return visible === expectedIds.size && measured === visible;
}

/**
 * Reads "has every node been measured" out of the React Flow store.
 *
 * Why not `useNodesInitialized()`: that hook additionally requires
 * `measured` on the **user** node object, and React Flow only writes that back
 * through `applyNodeChanges`, which `triggerNodeChanges` calls solely in
 * uncontrolled (`defaultNodes`) mode. This panel drives `<ReactFlow>` with a
 * controlled `nodes` prop and no `onNodesChange`, so the measurement genuinely
 * happens — the store's internal nodes carry `measured` and
 * `internals.handleBounds`, and the edges are drawn from them — but the user
 * node is never updated and the hook stays `false` forever. Reading the store
 * field the hook checks first is the correct handling for this dependency
 * version; it is the same record the library itself uses to decide a node is
 * initialized.
 *
 * Must be rendered inside `<ReactFlow>`, which is where the store context
 * lives — hence the reporter component below rather than a hook in the panel.
 */
function useEvidenceMapNodesMeasured(expectedIds: ReadonlySet<string>): boolean {
  const store = useStoreApi();
  const [measured, setMeasured] = useState(false);

  useEffect(() => {
    const read = () => {
      setMeasured(
        allNodesMeasured(store.getState().nodeLookup.values(), expectedIds)
      );
    };
    read();
    // The store mutates on pan, zoom and drag too; setMeasured bails out when
    // the answer has not changed, so those updates cost nothing.
    return store.subscribe(read);
  }, [store, expectedIds]);

  return measured;
}

/**
 * Bridges the store-derived measurement answer up to the panel, which owns the
 * element the page (and the tests) read.
 *
 * The bridge reports *both* directions, so the panel's state mirrors the store
 * instead of latching: when a filter swaps the node set, the new nodes have no
 * handle bounds yet and the panel drops back to "not measured" on its own,
 * with no separate reset effect to keep in sync.
 */
function NodesMeasuredReporter({
  expectedIds,
  onChange
}: {
  expectedIds: ReadonlySet<string>;
  onChange: (measured: boolean) => void;
}) {
  const measured = useEvidenceMapNodesMeasured(expectedIds);
  useEffect(() => {
    onChange(measured);
  }, [measured, onChange]);
  return null;
}

function EvidenceMapGraphNode({
  data
}: NodeProps<EvidenceMapFlowNode>) {
  const { node, kindLabel, statusLabel } = data;
  return (
    <article
      className={`evidence-map-node evidence-map-node-${node.type}`}
      data-node-type={node.type}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="evidence-map-handle"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="evidence-map-handle"
      />
      <header>
        <span className="evidence-map-node-kind">{kindLabel}</span>
        <span className="evidence-map-node-status">{statusLabel}</span>
      </header>
      <p className="evidence-map-node-label">{node.label}</p>
    </article>
  );
}

function coveragePercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="evidence-map-detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function NodeDetail({
  graph,
  nodeId,
  onClose
}: {
  graph: EvidenceMapGraph;
  nodeId: string;
  onClose: () => void;
}) {
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node) return null;

  return (
    <aside
      className="evidence-map-detail"
      aria-label="节点详情"
      data-testid="evidence-map-detail"
    >
      <header>
        <span className="evidence-map-detail-kind">
          {evidenceMapNodeTypeLabel[node.type]}
        </span>
        <button
          type="button"
          className="evidence-map-detail-close"
          onClick={onClose}
          aria-label="关闭详情"
        >
          ×
        </button>
      </header>

      {node.type === "claim" ? (
        <>
          <dl>
            <DetailRow label="主张">{node.statement}</DetailRow>
            <DetailRow label="Verdict">{verdictLabel(node.verdict)}</DetailRow>
          </dl>
          {(() => {
            const coverage = graph.coverage.find(
              (entry) => entry.claimId === node.entityId
            );
            if (!coverage) return null;
            return (
              <dl>
                <DetailRow label="支持证据">
                  {coverage.supportingCount}
                </DetailRow>
                <DetailRow label="反对证据">
                  {coverage.contradictingCount}
                </DetailRow>
                <DetailRow label="关联来源">
                  {coverage.sourceCount}
                </DetailRow>
                <DetailRow label="证据覆盖率">
                  {coveragePercent(coverage.coverage)}
                  <small className="evidence-map-metric-note">
                    （指标仅用于呈现，不改变判定）
                  </small>
                </DetailRow>
              </dl>
            );
          })()}
        </>
      ) : null}

      {node.type === "evidence" ? (
        <dl>
          <DetailRow label="摘录">{node.excerpt}</DetailRow>
          <DetailRow label="核实状态">{statusText(graph, node.id)}</DetailRow>
          <DetailRow label="方向">{directionLabel(node.direction)}</DetailRow>
          <DetailRow label="出自来源">{sourceTitleOf(graph, node.id)}</DetailRow>
        </dl>
      ) : null}

      {node.type === "source" ? (
        <dl>
          <DetailRow label="来源">{node.title}</DetailRow>
          <DetailRow label="发布者">{node.publisher ?? "未记录"}</DetailRow>
          <DetailRow label="来源类型">{sourceKindLabel(node.sourceType)}</DetailRow>
          <DetailRow label="摘录可靠度均值">
            {node.reliability === null
              ? "无关联摘录"
              : coveragePercent(node.reliability)}
            <small className="evidence-map-metric-note">
              （记录值投影，不是来源可信度评分）
            </small>
          </DetailRow>
        </dl>
      ) : null}

      {node.type === "conflict" ? (
        <dl>
          <DetailRow label="冲突">{node.label}</DetailRow>
          <DetailRow label="严重度">{node.severity} / 5</DetailRow>
          <DetailRow label="状态">{statusText(graph, node.id)}</DetailRow>
        </dl>
      ) : null}

      {node.type === "challenge" ? (
        <dl>
          <DetailRow label="质询">{node.question}</DetailRow>
          <DetailRow label="解决情况">
            {node.resolution ?? "未解决"}
          </DetailRow>
        </dl>
      ) : null}
    </aside>
  );
}

/** Status text of any node, using the shared per-type label functions. */
function statusText(graph: EvidenceMapGraph, nodeId: string): string {
  const node = graph.nodes.find((item) => item.id === nodeId);
  return node ? evidenceMapNodeStatusLabel(node) : "";
}

function sourceTitleOf(graph: EvidenceMapGraph, evidenceNodeId: string): string {
  const edge = graph.edges.find(
    (item) => item.to === evidenceNodeId && item.relation === "provided_by"
  );
  if (!edge) return "未关联来源";
  const source = graph.nodes.find((item) => item.id === edge.from);
  return source?.label ?? "未关联来源";
}

export function EvidenceMapPanel({ sessionId }: { sessionId: string }) {
  const [graph, setGraph] = useState<EvidenceMapGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<EvidenceMapFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /**
   * Two separate readiness states, deliberately not one flag:
   *
   *  - `graphLoaded`  — the graph request finished and produced data. It says
   *                     nothing about layout.
   *  - `nodesMeasured`— React Flow has measured every node currently in the
   *                     flow. It is mirrored from the store by the reporter
   *                     inside `<ReactFlow>`, so it drops back to false by
   *                     itself when a filter changes the node set.
   *
   * Collapsing them into one boolean is what made the old signal unfalsifiable:
   * the page could not tell "still fetching" from "fetched but never laid out",
   * so a measurement bug looked like a slow network.
   */
  const graphLoaded = !loading && !error && graph !== null;
  const [nodesMeasured, setNodesMeasured] = useState(false);
  const handleNodesMeasured = useCallback(
    (measured: boolean) => setNodesMeasured(measured),
    []
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setGraph(await getEvidenceMap(sessionId));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "加载证据地图失败，请重试。"
      );
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The flow holds its identity across re-fetches that return equal content
  // (see useEvidenceMapFlow): React Flow sees an unchanged `nodes` prop, does
  // not re-adopt the nodes, and does not reset the measurement the readiness
  // signal reads. A real content change — label, status, edge, filter,
  // session — still rebuilds it from the live graph.
  const flow = useEvidenceMapFlow(graph, filter);
  // Identity-stable, because the reporter subscribes to it.
  const flowNodeIds = useMemo(
    () => new Set(flow.nodes.map((node) => node.id)),
    [flow]
  );

  const header = (
    <header className="research-panel-header">
      <div>
        <h2>证据地图</h2>
        <p className="research-muted">
          连线表示关联方向（支持 / 反对 / 背景 / 出自来源），不代表已证实；结论以
          Verdict 与人工审核为准。
        </p>
      </div>
    </header>
  );

  if (loading) {
    return (
      <section className="research-panel" aria-label="证据地图">
        {header}
        <p className="research-muted">正在加载证据地图……</p>
      </section>
    );
  }

  if (error || !graph) {
    return (
      <section className="research-panel" aria-label="证据地图">
        {header}
        <p className="research-error" role="alert">
          {error ?? "加载证据地图失败，请重试。"}
        </p>
        <button type="button" onClick={() => void load()}>
          重试
        </button>
      </section>
    );
  }

  return (
    <section className="research-panel" aria-label="证据地图">
      {header}

      <div
        className="evidence-map-filters"
        role="group"
        aria-label="筛选视图"
        data-testid="evidence-map-filters"
      >
        {EVIDENCE_MAP_FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`research-chip${
              filter === item.id ? " research-chip-active" : ""
            }`}
            aria-pressed={filter === item.id}
            onClick={() => {
              setFilter(item.id);
              setSelectedId(null);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="evidence-map-layout">
      <div
        className="evidence-map-canvas"
        data-testid="evidence-map-canvas"
        data-graph-loaded={graphLoaded ? "true" : "false"}
        data-nodes-ready={graphLoaded && nodesMeasured ? "true" : "false"}
      >
        <ReactFlow
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(null)}
          fitView
          minZoom={0.2}
          maxZoom={1.5}
          nodesDraggable={true}
          nodesConnectable={false}
          elementsSelectable={true}
          proOptions={{ hideAttribution: true }}
        >
          <NodesMeasuredReporter
            expectedIds={flowNodeIds}
            onChange={handleNodesMeasured}
          />
            {/* Colour comes from the `--xy-*` tokens bound in globals.css, so the
                canvas follows the active theme without subscribing to it here. */}
            <Background gap={24} size={1} variant={BackgroundVariant.Dots} />
            <Controls
              showInteractive={false}
              aria-label="证据地图缩放控制"
            />
            {flow.nodes.length === 0 ? (
              <Panel position="bottom-center">
                <div className="evidence-map-empty">
                  {filter === "all"
                    ? "尚无可视化材料：先录入主张与证据。"
                    : "当前筛选下没有节点。"}
                </div>
              </Panel>
            ) : null}
          </ReactFlow>
        </div>

        {selectedId ? (
          <NodeDetail
            graph={graph}
            nodeId={selectedId}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
      </div>
    </section>
  );
}
