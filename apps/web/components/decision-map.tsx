"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  type NodeProps,
  type ReactFlowInstance
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { isConflictAwaitingHumanDecision, isConclusionFinal } from "@nexus/shared";
import type { ReplayableSession } from "../features/arena/event-reducer";
import {
  DECISION_MAP_EDGE_LEGEND,
  toDecisionMap,
  type DecisionMapNode,
  type DecisionMapNodeData,
  type DecisionMapStatus
} from "../features/arena/map-adapter";
import {
  DECISION_MAP_MIN_READABLE_ZOOM,
  getDecisionMapSizingPolicy
} from "../features/arena/map-layout";

const statusLabels: Record<DecisionMapStatus, string> = {
  idle: "待命",
  proposed: "已提出",
  running: "执行中",
  supported: "已支持",
  completed: "已完成",
  challenged: "被质询",
  paused: "已暂停",
  conflict: "冲突待裁",
  rejected: "已否决",
  failed: "失败"
};

const nodeTypes = {
  agent: DecisionNode,
  claim: DecisionNode,
  challenge: DecisionNode,
  conflict: DecisionNode,
  conclusion: DecisionNode
};

function DecisionNode({ data }: NodeProps<DecisionMapNode>) {
  return (
    <article
      className={`decision-node decision-node-${data.kind} status-${data.status} ${
        data.checkpoint ? "decision-node-checkpoint" : ""
      }`}
      data-status={data.status}
      data-kind={data.kind}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="decision-handle"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="decision-handle"
      />
      <header>
        <span className="node-kind">{data.meta ?? data.kind.toUpperCase()}</span>
        <span className="node-status">
          <span aria-hidden="true" />
          {statusLabels[data.status]}
        </span>
      </header>
      <h3 title={data.label}>{data.label}</h3>
      <p title={data.detail}>{data.detail}</p>
    </article>
  );
}

/**
 * 连线语义。
 *
 * 默认收起来：它原来是一张常驻画布右上角的浮层，5 个节点的图里有 2 个被它
 * 压住一半——图例把要解释的东西盖住了。收成「连线语义」四个字，需要的人
 * 点开看，不需要的人不丢画布。
 */
function EdgeLegend() {
  return (
    <details className="edge-legend-shell">
      <summary>连线语义</summary>
      <div className="edge-legend" aria-label="连线语义">
        {DECISION_MAP_EDGE_LEGEND.map((entry) => (
          <span
            key={entry.semantic}
            className="edge-legend-item"
            data-semantic={entry.semantic}
          >
            <svg
              className="edge-legend-line"
              width="28"
              height="10"
              viewBox="0 0 28 10"
              aria-hidden="true"
            >
              <line
                x1="1"
                y1="5"
                x2="27"
                y2="5"
                stroke={entry.color}
                strokeWidth={entry.strokeWidth}
                {...(entry.dashArray === "none"
                  ? {}
                  : { strokeDasharray: entry.dashArray })}
              />
            </svg>
            <span>{entry.label}</span>
            <small className="edge-legend-marker">{entry.legendMarker}</small>
          </span>
        ))}
      </div>
    </details>
  );
}
export function DecisionMap({
  session,
  compact = false
}: {
  session: ReplayableSession;
  compact?: boolean;
}) {
  const [viewportWidth, setViewportWidth] = useState(1440);
  /**
   * 当前缩放，以及"有没有节点落在视野外"。
   *
   * 这两件事必须一起看。此前的做法是让 fitView 硬把图缩到能装下（下限 0.85），
   * 装不下也照装：右侧整列冲突卡被画布边缘切掉，没有任何提示，看起来像"图缺
   * 了一块"。改成允许缩到 30% 又会走向另一个极端——26 个节点的图缩到 30%，
   * 满屏都是看不清的小方块，主界面直接废掉。
   *
   * 所以：默认保持可读尺度（fitView 的可读下限 0.85），只要有节点跑到视野外，
   * 就在工具栏下面明说「还有节点在视野外」，并给一个「全览」按钮真的缩到装得
   * 下。默认可读、全貌一键可达、而且从不悄悄裁切。
   */
  const [zoom, setZoom] = useState(1);
  const [clipped, setClipped] = useState(false);
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const graph = useMemo(() => toDecisionMap(session), [session]);
  const sizing = useMemo(
    () => getDecisionMapSizingPolicy(viewportWidth),
    [viewportWidth]
  );
  const humanCheckpoint =
    session.phase === "HUMAN_REVIEW" ||
    session.conflicts.some(isConflictAwaitingHumanDecision);
  const hasClaims = session.claims.length > 0;

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    updateViewportWidth();
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  /*
   * 用节点的真实位置判断"有没有出界"，而不是靠算：卡片高度随文字变化，
   * 估算出来的边界迟早会错。缩放和平移都会触发重新量，rAF 合并掉抖动。
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const box = canvas.getBoundingClientRect();
      const nodes = canvas.querySelectorAll(".decision-node");
      if (nodes.length === 0) {
        setClipped(false);
        return;
      }
      let outside = false;
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (
          rect.right > box.right + 2 ||
          rect.bottom > box.bottom + 2 ||
          rect.left < box.left - 2 ||
          rect.top < box.top - 2
        ) {
          outside = true;
          break;
        }
      }
      setClipped(outside);
    });
    return () => cancelAnimationFrame(frame);
  }, [zoom, graph]);

  return (
    <section
      className={`decision-map ${compact ? "decision-map-compact" : ""}`}
      aria-label="Decision Map"
      data-human-checkpoint={humanCheckpoint ? "true" : "false"}
    >
      <div className="map-toolbar">
        <div>
          <p className="eyebrow">DECISION MAP</p>
          <h2>
            {session.currentConclusion ?? "结论正在形成"}
            {session.currentConclusion !== null &&
            !isConclusionFinal(session.phase) ? (
              /* 和页头同一个口径：还没裁决完，这就只是倾向。 */
              <small className="map-conclusion-tag">初步 · 未定稿</small>
            ) : null}
          </h2>
        </div>
        <div className="map-runtime">
          <span className={`status-marker status-${session.operationalStatus.toLowerCase()}`} />
          <span>{session.phase.replaceAll("_", " ")}</span>
          <span className="sequence">SEQ {session.lastSequence}</span>
          {/*
           * 图例放在工具栏里，不放画布上。
           *
           * 它原来是画布右上角的常驻浮层：展开时压住节点，收起时盖住卡片
           * 左上角——图例挡住了它要解释的东西。挪进工具栏后，无论开合都
           * 不可能与节点重叠。
           */}
          <EdgeLegend />
        </div>
      </div>

      {clipped ? (
        <div className="map-zoom-hint" data-testid="map-zoom-hint">
          <span>
            图比这一栏大，还有节点在视野外（当前 {Math.round(zoom * 100)}%）。
            拖动可平移，或
          </span>
          <button
            type="button"
            className="map-fit-button"
            onClick={() =>
              flow?.fitView({
                padding: 0.06,
                minZoom: sizing.minZoom,
                maxZoom: sizing.fitViewMaxZoom
              })
            }
          >
            全览一次看全（会缩小）
          </button>
          <span>，再用右下角 + 放大阅读。</span>
        </div>
      ) : zoom < DECISION_MAP_MIN_READABLE_ZOOM - 0.001 ? (
        <p className="map-zoom-hint" data-testid="map-zoom-hint">
          现在是 {Math.round(zoom * 100)}% 全览：结构都在，字偏小。点右下角 + 放大，
          或拖动平移；节点上的标题和说明也能悬停看全文。
        </p>
      ) : null}

      {humanCheckpoint ? (
        <div
          className="human-checkpoint-banner"
          role="alert"
          data-testid="human-checkpoint"
        >
          <span className="checkpoint-icon" aria-hidden="true">
            !
          </span>
          <span>
            <strong>HUMAN CHECKPOINT</strong>
            <small>执行已暂停，等待人工裁决后继续</small>
          </span>
          <span className="checkpoint-state">PAUSED</span>
        </div>
      ) : null}

      <div className="map-canvas" ref={canvasRef}>
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{
            padding: sizing.fitViewPadding,
            minZoom: sizing.fitViewMinZoom,
            maxZoom: sizing.fitViewMaxZoom
          }}
          minZoom={sizing.minZoom}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnScroll={sizing.panOnScroll}
          onMove={(_event, viewport) => setZoom(viewport.zoom)}
          onInit={setFlow}
          proOptions={{ hideAttribution: true }}
        >
          {/* Colour comes from the `--xy-*` tokens bound in globals.css, so the
              canvas follows the active theme without subscribing to it here. */}
          <Background gap={24} size={1} variant={BackgroundVariant.Dots} />
          <Controls
            showInteractive={false}
            aria-label="Decision Map controls"
          />
          {!hasClaims ? (
            <Panel position="bottom-center">
              <div className="map-empty">等待 Agent 提交首批 Claim</div>
            </Panel>
          ) : null}
        </ReactFlow>
      </div>
    </section>
  );
}
