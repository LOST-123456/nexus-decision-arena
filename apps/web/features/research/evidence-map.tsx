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

  const filtered = useMemo(
    () => (graph ? applyEvidenceMapFilter(graph, filter) : null),
    [graph, filter]
  );
  const flow = useMemo(
    () => (filtered ? toEvidenceMapFlow(filtered) : { nodes: [], edges: [] }),
    [filtered]
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
            <Background
              color="rgba(145, 163, 174, 0.16)"
              gap={24}
              size={1}
              variant={BackgroundVariant.Dots}
            />
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
