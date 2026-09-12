"use client";

import type { HumanDecision } from "@nexus/shared";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AgentPanel } from "../../components/agent-panel";
import { DecisionMap } from "../../components/decision-map";
import { HumanCheckpoint } from "../../components/human-checkpoint";
import { Inspector } from "../../components/inspector";
import {
  Timeline,
  type TimelineEvent
} from "../../components/timeline";
import {
  previewSession,
  previewTimeline,
  type PreviewSession
} from "./preview-session";

const decisionSequence = 43;

function createPreviewId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}`;
}

export function previewSnapshotAt(
  sequence: number,
  sessionId: string
): PreviewSession {
  const phase =
    sequence < 8
      ? "PLANNING"
      : sequence < 24
        ? "ANALYZING"
        : sequence < 33
          ? "CHALLENGING"
          : sequence < 42
            ? "CONFLICT_DETECTED"
            : "HUMAN_REVIEW";
  const operationalStatus =
    sequence < 42 ? "ACTIVE" : previewSession.operationalStatus;
  const agents = previewSession.agents.map((agent) => ({
    ...agent,
    status:
      sequence < 8
        ? "idle"
        : sequence < 16
          ? "running"
          : sequence < 42
            ? "completed"
            : agent.status
  })) as PreviewSession["agents"];
  const claims = sequence < 16 ? [] : previewSession.claims;
  const evidence = sequence < 16 ? [] : previewSession.evidence;
  const challenges = sequence < 24 ? [] : previewSession.challenges;
  const conflicts =
    sequence < 33
      ? []
      : sequence < 42
        ? previewSession.conflicts.slice(0, 1)
        : previewSession.conflicts;

  return {
    ...previewSession,
    sessionId,
    phase,
    operationalStatus,
    agents,
    claims,
    evidence,
    challenges,
    conflicts,
    currentConclusion:
      sequence < 33
        ? "\u5efa\u8bae\u7acb\u9879"
        : sequence < 42
          ? "\u6682\u7f13\u89c4\u6a21\u5316\u6269\u5f20"
          : previewSession.currentConclusion,
    lastSequence: sequence
  };
}

function decisionSummary(
  action: HumanDecision["action"],
  session: PreviewSession
): string {
  if (action === "request_more_analysis") {
    return "\u8865\u5145\u91c7\u8d2d\u4e0e\u6210\u672c\u8bc1\u636e\u540e\u91cd\u65b0\u8bc4\u4f30\u3002";
  }
  if (action === "uphold_claim") {
    return "\u7ef4\u6301\u539f\u5224\u65ad\u3002";
  }
  if (session.phase === "DECIDED") {
    return "\u91c7\u8d2d\u3001\u6280\u672f\u548c\u8d22\u52a1\u8d28\u8be2\u5df2\u88ab\u91c7\u7eb3\uff0c\u7ed3\u8bba\u8c03\u6574\u4e3a\u6709\u9650\u7acb\u9879\u3002";
  }
  return "\u91c7\u8d2d\u7ba1\u9053\u8bc1\u636e\u4e0d\u8db3\uff0c\u9700\u8981\u4eba\u5de5\u88c1\u51b3\u3002";
}

export function SessionWorkspace({ sessionId }: { sessionId: string }) {
  const initialSession = useMemo(
    () => previewSnapshotAt(42, sessionId),
    [sessionId]
  );
  const [session, setSession] = useState(initialSession);
  const [selectedSequence, setSelectedSequence] = useState(42);
  const [decisionSnapshot, setDecisionSnapshot] =
    useState<PreviewSession | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>(
    previewTimeline.map((event) => ({ ...event }))
  );

  const checkpointActive = session.phase === "HUMAN_REVIEW";
  const primaryConflict = session.conflicts[0];
  const primaryClaim = session.claims[0];

  function handleDecision(
    action: HumanDecision["action"],
    rationale: string
  ) {
    const accepted = action === "accept_challenge";
    const uphold = action === "uphold_claim";
    const requestingMore = action === "request_more_analysis";
    const conclusion = accepted
      ? "\u6709\u9650\u7acb\u9879"
      : uphold
        ? "\u7ef4\u6301\u5efa\u8bae\u7acb\u9879"
        : "\u91cd\u65b0\u8bc4\u4f30\u91c7\u8d2d\u8bc1\u636e";
    const nextSequence =
      (events.at(-1)?.sequence ?? previewSession.lastSequence) + 1;
    const decision: HumanDecision = {
      id: createPreviewId("human-decision"),
      sessionId,
      conflictId: primaryConflict?.id ?? "preview-conflict",
      action,
      rationale,
      affectedClaimIds: primaryClaim ? [primaryClaim.id] : [],
      affectedAgentRoleIds: primaryConflict
        ? []
        : previewSession.agents.map((agent) => agent.id),
      previousConclusion: session.currentConclusion ?? "\u6682\u65e0\u7ed3\u8bba",
      newConclusion: conclusion,
      operatorId: "local-operator",
      createdAt: new Date().toISOString()
    };
    const nextSession: PreviewSession = {
      ...session,
      phase: requestingMore ? "REASSESSING" : "DECIDED",
      operationalStatus: requestingMore ? "ACTIVE" : "COMPLETED",
      currentConclusion: conclusion,
      humanDecisions: [...session.humanDecisions, decision],
      lastSequence: nextSequence
    };

    setSession(nextSession);
    setDecisionSnapshot(nextSession);
    setSelectedSequence(nextSequence);
    setEvents((currentEvents) => [
      ...currentEvents,
      {
        id: decision.id,
        sequence: nextSequence,
        type: "SESSION_STATE_CHANGED",
        label: requestingMore
          ? "\u8981\u6c42\u8865\u5145\u5206\u6790"
          : "\u4eba\u5de5\u88c1\u5b9a"
      }
    ]);
  }

  function handleTimelineSelect(sequence: number) {
    setSelectedSequence(sequence);
    if (decisionSnapshot && sequence >= decisionSequence) {
      setSession(decisionSnapshot);
      return;
    }
    setSession(previewSnapshotAt(sequence, sessionId));
  }

  const inspectorData = {
    claim: {
      id: primaryClaim?.id ?? "preview-claim",
      statement:
        primaryClaim?.statement ??
        "\u7b49\u5f85 Claim \u8fdb\u5165\u51b3\u7b56\u5730\u56fe",
      status: primaryClaim?.status ?? "proposed"
    },
    evidence: session.evidence,
    challenges: session.challenges,
    conflicts: session.conflicts,
    decisionRationale: {
      outcome:
        session.phase === "DECIDED"
          ? "accepted"
          : checkpointActive
            ? "needs_human"
            : "contested",
      summary: decisionSummary(
        session.humanDecisions.at(-1)?.action ?? "accept_challenge",
        session
      ),
      decisiveChallengeIds: session.challenges
        .filter((challenge) => challenge.severity >= 4)
        .map((challenge) => challenge.id),
      evidenceIds: primaryClaim?.evidenceIds ?? []
    }
  };

  return (
    <main className="workspace-shell" data-session-source="preview">
      <header className="workspace-header">
        <Link className="brand-lockup brand-lockup-compact" href="/">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <span>
            <strong>Nexus Decision Arena</strong>
            <small>SESSION / {sessionId}</small>
          </span>
        </Link>

        <div className="workspace-vitals">
          <span>
            <small>{"\u5f53\u524d\u7ed3\u8bba"}</small>
            <strong>
              {session.currentConclusion ??
                "\u6b63\u5728\u5f62\u6210\u7ed3\u8bba"}
            </strong>
          </span>
          <span>
            <small>{"\u8fd0\u884c\u9636\u6bb5"}</small>
            <strong>{session.phase.replaceAll("_", " ")}</strong>
          </span>
          <span className={checkpointActive ? "vital-alert" : ""}>
            <small>{"\u4eba\u5de5\u4ecb\u5165"}</small>
            <strong>{checkpointActive ? "REQUIRED" : "COMPLETE"}</strong>
          </span>
        </div>
      </header>

      <div className="workspace-main">
        <AgentPanel roles={session.agents} />

        <section className="decision-column" aria-label="Decision workspace">
          <DecisionMap session={session} />
        </section>

        <div className="inspector-column">
          <Inspector data={inspectorData} />
          {checkpointActive ? (
            <HumanCheckpoint
              conflictSummary={
                primaryConflict?.summary ?? "\u7b49\u5f85\u4eba\u5de5\u88c1\u51b3"
              }
              onDecision={handleDecision}
            />
          ) : (
            <section className="decision-complete">
              <p className="eyebrow">DECISION COMPLETE</p>
              <h2>{session.currentConclusion}</h2>
              <Link
                className="primary-link"
                href={`/sessions/${sessionId}/report`}
              >
                {"\u67e5\u770b\u51b3\u7b56\u62a5\u544a"}
                <span aria-hidden="true">{"\u2192"}</span>
              </Link>
            </section>
          )}
        </div>
      </div>

      <Timeline
        events={events}
        selectedSequence={selectedSequence}
        onSelect={handleTimelineSelect}
      />
    </main>
  );
}