"use client";

import type {
  ClaimInspectorDTO,
  ExecutionEvent,
  HumanDecision
} from "@nexus/shared";
import { DecisionReplay } from "@nexus/shared";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AgentPanel } from "../../components/agent-panel";
import { DecisionMap } from "../../components/decision-map";
import { HumanCheckpoint } from "../../components/human-checkpoint";
import { Inspector } from "../../components/inspector";
import {
  Timeline,
  type TimelineEvent
} from "../../components/timeline";
import {
  getInspector,
  getEvents,
  getSession,
  subscribeToEvents,
  submitHumanDecision,
  type HumanDecisionCommand
} from "./api-client";
import type { ReplayableSession } from "./event-reducer";
import { reduceSessionEvent } from "./event-reducer";
import { applyHumanDecisionResponse } from "./human-decision-sync";
import { toPreviewInspectorDTO } from "./preview-inspector";
import {
  previewSession,
  previewTimeline,
  type PreviewSession
} from "./preview-session";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPersistedSessionId(sessionId: string): boolean {
  return uuidPattern.test(sessionId);
}

function createPreviewId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}`;
}

export function isReportAvailable(
  phase: ReplayableSession["phase"]
): boolean {
  return phase === "DECIDED" || phase === "REPORT_READY";
}

function createEmptySession(sessionId: string): ReplayableSession {
  return {
    sessionId,
    phase: "CREATED",
    operationalStatus: "ACTIVE",
    agents: [],
    claims: [],
    evidence: [],
    challenges: [],
    conflicts: [],
    humanDecisions: [],
    currentConclusion: null,
    lastSequence: 0
  };
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

function decisionConclusion(action: HumanDecision["action"]): string {
  if (action === "accept_challenge") {
    return "\u6709\u9650\u7acb\u9879";
  }
  if (action === "uphold_claim") {
    return "\u7ef4\u6301\u5efa\u8bae\u7acb\u9879";
  }
  return "\u91cd\u65b0\u8bc4\u4f30\u91c7\u8d2d\u8bc1\u636e";
}

export function SessionWorkspace({ sessionId }: { sessionId: string }) {
  const persisted = isPersistedSessionId(sessionId);
  const initialSession = useMemo(
    () =>
      persisted
        ? createEmptySession(sessionId)
        : previewSnapshotAt(42, sessionId),
    [persisted, sessionId]
  );
  const [session, setSession] = useState<ReplayableSession>(initialSession);
  const [selectedSequence, setSelectedSequence] = useState(
    persisted ? 0 : 42
  );
  const [events, setEvents] = useState<TimelineEvent[]>(
    persisted ? [] : previewTimeline.map((event) => ({ ...event }))
  );
  const [rawEvents, setRawEvents] = useState<ExecutionEvent[]>([]);
  const [liveInspector, setLiveInspector] =
    useState<ClaimInspectorDTO | null>(null);
  const [loading, setLoading] = useState(persisted);
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const primaryConflict = session.conflicts.find(
    (conflict) => conflict.humanDecisionRequired
  );
  const primaryClaim = session.claims[0];
  const previewInspector = persisted
    ? null
    : toPreviewInspectorDTO(session);
  const inspectorData = persisted ? liveInspector : previewInspector;
  const checkpointActive =
    session.phase === "HUMAN_REVIEW" && primaryConflict !== undefined;

  useEffect(() => {
    if (!persisted) {
      return;
    }

    let cancelled = false;
    setLoading(true);
    Promise.all([getSession(sessionId), getEvents(sessionId)])
      .then(async ([loaded, persistedEvents]) => {
        if (cancelled) {
          return;
        }
        setSession(loaded);
        setRawEvents(persistedEvents);
        setEvents(
          persistedEvents.map((event) => ({
            id: event.id,
            sequence: event.sequence,
            type: event.type
          }))
        );
        setSelectedSequence(loaded.lastSequence);
        const claim = loaded.claims[0];
        if (!claim) {
          setLiveInspector(null);
          return;
        }
        const inspector = await getInspector(sessionId, claim.id);
        if (!cancelled) {
          setLiveInspector(inspector);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setErrorMessage(
            error instanceof Error ? error.message : "Session load failed"
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [persisted, sessionId]);

  useEffect(() => {
    if (!persisted || loading) {
      return;
    }

    return subscribeToEvents(sessionId, session.lastSequence, (event) => {
      setRawEvents((current) =>
        current.some((item) => item.id === event.id)
          ? current
          : [...current, event].sort(
              (left, right) => left.sequence - right.sequence
            )
      );
      setEvents((current) =>
        current.some((item) => item.id === event.id)
          ? current
          : [
              ...current,
              {
                id: event.id,
                sequence: event.sequence,
                type: event.type
              }
            ].sort((left, right) => left.sequence - right.sequence)
      );
      setSession((current) => reduceSessionEvent(current, event));
      setSelectedSequence(event.sequence);
    });
  }, [loading, persisted, session.lastSequence, sessionId]);

  async function handleDecision(
    action: HumanDecision["action"],
    rationale: string
  ) {
    if (!primaryConflict) {
      setErrorMessage("No eligible conflict is available for review.");
      return;
    }

    const conclusion = decisionConclusion(action);

    if (!persisted) {
      const decision: HumanDecision = {
        id: createPreviewId("human-decision"),
        sessionId,
        conflictId: primaryConflict.id,
        action,
        rationale,
        affectedClaimIds: primaryClaim ? [primaryClaim.id] : [],
        affectedAgentRoleIds: [],
        previousConclusion: session.currentConclusion ?? "No prior conclusion",
        newConclusion: conclusion,
        operatorId: "preview-operator",
        createdAt: new Date().toISOString()
      };
      setSession((current) => ({
        ...current,
        phase: action === "request_more_analysis" ? "REASSESSING" : "DECIDED",
        operationalStatus:
          action === "request_more_analysis" ? "ACTIVE" : "COMPLETED",
        currentConclusion: conclusion,
        humanDecisions: [...current.humanDecisions, decision]
      }));
      setErrorMessage(null);
      return;
    }

    setPending(true);
    setErrorMessage(null);
    const command: HumanDecisionCommand = {
      conflictId: primaryConflict.id,
      action,
      rationale,
      affectedClaimIds: primaryClaim ? [primaryClaim.id] : [],
      affectedAgentRoleIds: [],
      newConclusion: conclusion,
      operatorId: "operator-1"
    };

    try {
      const response = await submitHumanDecision(
        sessionId,
        command,
        `human-decision-${createPreviewId("request")}`
      );
      setSession((current) =>
        applyHumanDecisionResponse(current, response)
      );
      setEvents((current) =>
        current.some((event) => event.id === response.event.id)
          ? current
          : [
              ...current,
              {
                id: response.event.id,
                sequence: response.event.sequence,
                type: response.event.type
              }
            ].sort((left, right) => left.sequence - right.sequence)
      );
      setRawEvents((current) =>
        current.some((event) => event.id === response.event.id)
          ? current
          : [...current, response.event].sort(
              (left, right) => left.sequence - right.sequence
            )
      );
      setSelectedSequence(response.event.sequence);

      if (primaryClaim) {
        setLiveInspector(
          await getInspector(sessionId, primaryClaim.id)
        );
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Human decision failed"
      );
    } finally {
      setPending(false);
    }
  }

  function handleTimelineSelect(sequence: number) {
    setSelectedSequence(sequence);
    if (!persisted) {
      setSession(previewSnapshotAt(sequence, sessionId));
      return;
    }

    const snapshot = new DecisionReplay(rawEvents).snapshotAt(sequence);
    setSession((current) => ({
      ...current,
      ...snapshot,
      agents: current.agents,
      evidence: current.evidence
    }));
  }

  return (
    <main
      className="workspace-shell"
      data-session-source={persisted ? "live" : "preview-fixture"}
    >
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
          {inspectorData ? (
            <Inspector data={inspectorData} />
          ) : (
            <section className="inspector-panel" aria-label="Claim Inspector">
              <p className="eyebrow">INSPECTOR</p>
              <p className="empty-copy">
                {loading
                  ? "Loading Inspector data"
                  : "No Claim inspector data is available."}
              </p>
            </section>
          )}

          {checkpointActive ? (
            <HumanCheckpoint
              conflictSummary={primaryConflict.summary}
              onDecision={handleDecision}
              pending={pending}
              previewOnly={!persisted}
              {...(errorMessage ? { errorMessage } : {})}
            />
          ) : isReportAvailable(session.phase) ? (
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
          ) : null}
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
