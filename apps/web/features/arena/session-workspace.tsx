"use client";

import type {
  ClaimInspectorDTO,
  ExecutionEvent,
  HumanDecision
} from "@nexus/shared";
import { DecisionReplay, isConflictAwaitingHumanDecision } from "@nexus/shared";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentPanel } from "../../components/agent-panel";
import { DecisionMap } from "../../components/decision-map";
import { HumanCheckpoint } from "../../components/human-checkpoint";
import { Inspector } from "../../components/inspector";
import { RuntimeModeBadge } from "../../components/runtime-mode-badge";
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
  type EventStreamStatus,
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
import { toLoadFailure, type LoadFailure } from "../../lib/load-failure";

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
  /**
   * Why this is separate from `errorMessage`: `errorMessage` is an action
   * refusal ("this decision was rejected"), which leaves the workspace on
   * screen. This one means the session itself never loaded, so the workspace
   * has nothing true to show — rendering the empty shell instead would make a
   * dead core look like a brand-new, empty session.
   */
  const [loadFailure, setLoadFailure] = useState<LoadFailure | null>(null);
  const [streamStatus, setStreamStatus] = useState<EventStreamStatus | null>(
    null
  );

  const primaryConflict = session.conflicts.find(
    isConflictAwaitingHumanDecision
  );
  const primaryClaim = session.claims[0];
  const previewInspector = persisted
    ? null
    : toPreviewInspectorDTO(session);
  const inspectorData = persisted ? liveInspector : previewInspector;
  const checkpointActive =
    session.phase === "HUMAN_REVIEW" && primaryConflict !== undefined;

  /**
   * Loads the session, its event log and the inspector for its first claim.
   *
   * `isActive` is how a superseded attempt (fast navigation, unmount) is told
   * to drop its results instead of writing them over a newer load.
   */
  const loadSession = useCallback(
    async (isActive: () => boolean) => {
      setLoading(true);
      setLoadFailure(null);
      try {
        const [loaded, persistedEvents] = await Promise.all([
          getSession(sessionId),
          getEvents(sessionId)
        ]);
        if (!isActive()) return;
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
        if (!isActive()) return;
        setLiveInspector(inspector);
      } catch (error) {
        if (isActive()) {
          setLoadFailure(
            toLoadFailure(error, "找不到这个评审（HTTP 404）。", "会话加载失败")
          );
        }
      } finally {
        if (isActive()) {
          setLoading(false);
        }
      }
    },
    [sessionId]
  );

  useEffect(() => {
    if (!persisted) {
      return;
    }

    let cancelled = false;
    void loadSession(() => !cancelled);

    return () => {
      cancelled = true;
    };
  }, [persisted, loadSession]);

  useEffect(() => {
    if (!persisted || loading) {
      return;
    }

    return subscribeToEvents(
      sessionId,
      session.lastSequence,
      (event) => {
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
      },
      setStreamStatus
    );
  }, [loading, persisted, session.lastSequence, sessionId]);

  async function handleDecision(
    action: HumanDecision["action"],
    rationale: string,
    affectedAgentRoleIds: string[]
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
        affectedAgentRoleIds,
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
      affectedAgentRoleIds,
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

  if (persisted && loadFailure) {
    // A missing session is a dead link, not a broken service: it gets its own
    // panel and a way out instead of a retry button that can only fail again.
    const notFound = loadFailure.status === 404;
    return (
      <main
        id="main"
        tabIndex={-1}
        className="workspace-fallback"
        data-testid={notFound ? "session-not-found" : "session-load-error"}
      >
        <section className="workspace-notice" role="alert">
          <p className="eyebrow">
            {notFound ? "SESSION NOT FOUND" : "SESSION UNAVAILABLE"}
          </p>
          <h2>{notFound ? "会话不存在" : "无法加载会话"}</h2>
          <p className="workspace-notice-reason">{loadFailure.message}</p>
          {notFound ? (
            <p className="workspace-notice-hint">
              它可能已被删除，或者这个链接有误。
            </p>
          ) : (
            <p className="workspace-notice-hint">
              请确认核心 API 正在运行（默认 4100 端口），然后重新加载。
            </p>
          )}
          {notFound ? (
            <div className="workspace-notice-actions">
              <Link className="workspace-retry" href="/history">
                返回最近会话
              </Link>
              <Link className="workspace-retry" href="/sessions/new">
                新建评审
              </Link>
            </div>
          ) : (
            <button
              type="button"
              className="workspace-retry"
              onClick={() => void loadSession(() => true)}
            >
              重新加载
            </button>
          )}
        </section>
      </main>
    );
  }

  if (persisted && loading) {
    return (
      <main
        id="main"
        tabIndex={-1}
        className="workspace-fallback"
        data-testid="session-loading"
      >
        <section className="workspace-notice" data-tone="loading">
          <p className="eyebrow">LOADING</p>
          <h2>正在载入会话</h2>
          <p className="workspace-notice-hint">
            正在读取会话状态、执行事件与 Claim 详情。
          </p>
        </section>
      </main>
    );
  }

  return (
    <main
      id="main"
      tabIndex={-1}
      className="workspace-shell"
      data-session-source={persisted ? "live" : "preview-fixture"}
    >
      <header className="workspace-header">
        <span className="correlation-chip" title={sessionId}>
          会话 {sessionId.slice(0, 8)}
        </span>

        <div className="workspace-runtime-cluster">
          <RuntimeModeBadge />
          {streamStatus === "error" ? (
            <span
              className="stream-offline-chip"
              role="status"
              data-testid="stream-offline"
            >
              实时连接中断 · 自动重连中
            </span>
          ) : null}
          {rawEvents.at(-1)?.correlationId ? (
            <span
              className="correlation-chip"
              title={rawEvents.at(-1)?.correlationId}
            >
              CORR {rawEvents.at(-1)?.correlationId.slice(0, 8)}
            </span>
          ) : null}
        </div>
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
                  ? "\u6b63\u5728\u52a0\u8f7d Claim \u8be6\u60c5"
                  : "\u5f53\u524d\u6ca1\u6709\u53ef\u67e5\u770b\u7684 Claim \u8be6\u60c5"}
              </p>
            </section>
          )}

          {checkpointActive ? (
            <HumanCheckpoint
              conflictSummary={primaryConflict.summary}
              roles={session.agents}
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
