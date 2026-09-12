"use client";

import { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Panel,
  ReactFlow,
  type NodeProps
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ReplayableSession } from "../features/arena/event-reducer";
import {
  toDecisionMap,
  type DecisionMapNode,
  type DecisionMapNodeData,
  type DecisionMapStatus
} from "../features/arena/map-adapter";

const statusLabels: Record<DecisionMapStatus, string> = {
  idle: "待命",
  running: "执行中",
  completed: "已完成",
  challenged: "被质询",
  paused: "已暂停",
  conflict: "冲突待裁",
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
      <header>
        <span className="node-kind">{data.meta ?? data.kind.toUpperCase()}</span>
        <span className="node-status">
          <span aria-hidden="true" />
          {statusLabels[data.status]}
        </span>
      </header>
      <h3>{data.label}</h3>
      <p>{data.detail}</p>
    </article>
  );
}

function EdgeLegend() {
  return (
    <div className="edge-legend" aria-label="连线语义">
      <span>
        <i className="edge-dot edge-dot-running" />
        执行流
      </span>
      <span>
        <i className="edge-dot edge-dot-challenged" />
        未解质询
      </span>
      <span>
        <i className="edge-dot edge-dot-conflict" />
        冲突
      </span>
      <span>
        <i className="edge-dot edge-dot-resolved" />
        已接受
      </span>
    </div>
  );
}

export function DecisionMap({
  session,
  compact = false
}: {
  session: ReplayableSession;
  compact?: boolean;
}) {
  const graph = useMemo(() => toDecisionMap(session), [session]);
  const humanCheckpoint =
    session.phase === "HUMAN_REVIEW" ||
    session.conflicts.some(
      (conflict) =>
        conflict.humanDecisionRequired || conflict.status === "human_review"
    );
  const hasClaims = session.claims.length > 0;

  return (
    <section
      className={`decision-map ${compact ? "decision-map-compact" : ""}`}
      aria-label="Decision Map"
      data-human-checkpoint={humanCheckpoint ? "true" : "false"}
    >
      <div className="map-toolbar">
        <div>
          <p className="eyebrow">DECISION MAP</p>
          <h2>{session.currentConclusion ?? "结论正在形成"}</h2>
        </div>
        <div className="map-runtime">
          <span className={`status-marker status-${session.operationalStatus.toLowerCase()}`} />
          <span>{session.phase.replaceAll("_", " ")}</span>
          <span className="sequence">SEQ {session.lastSequence}</span>
        </div>
      </div>

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

      <div className="map-canvas">
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.18, minZoom: 0.2, maxZoom: 1 }}
          minZoom={0.18}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnScroll
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
        >
          <Background
            color="rgba(145, 163, 174, 0.16)"
            gap={24}
            size={1}
            variant={BackgroundVariant.Dots}
          />
          <Controls
            showInteractive={false}
            aria-label="Decision Map controls"
          />
          <Panel position="top-right">
            <EdgeLegend />
          </Panel>
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
