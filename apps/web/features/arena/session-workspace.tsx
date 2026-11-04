"use client";

import type {
  ClaimInspectorDTO,
  ExecutionEvent,
  HumanDecision
} from "@nexus/shared";
import {
  DecisionReplay,
  isConclusionFinal,
  isConflictAwaitingHumanDecision,
  isPhaseWorking,
  sessionPhaseLabel,
  sessionPhaseStep
} from "@nexus/shared";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentPanel } from "../../components/agent-panel";
import { DecisionMap } from "../../components/decision-map";import { HumanCheckpoint } from "../../components/human-checkpoint";
import { Inspector } from "../../components/inspector";
import { RuntimeModeBadge } from "../../components/runtime-mode-badge";
import { DecisionInProgress } from "./decision-in-progress";
import { findChallengeProgress } from "./challenge-progress";
import { findSupplementFailure } from "./supplement-failure";
import { ActionLink, Button } from "../../components/ui/button";
import { FullPageNotice } from "../../components/ui/notice";
import {
  Timeline,
  type TimelineEvent
} from "../../components/timeline";
import {
  getInspector,
  getEvents,
  getSession,
  getCurrentUser,
  subscribeToEvents,
  startSession,
  submitHumanDecision,
  type EventStreamStatus,
  type HumanDecisionCommand
} from "./api-client";
import { SessionMaterials } from "./session-materials";
import { collectWebSources } from "./web-sources";
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
  /**
   * Which of the three actions is in flight.
   *
   * `pending` only says "something is happening", which is why the old panel
   * greyed out all three buttons with no text change: a reviewer who clicked
   * 要求补充分析 could not tell their click had landed, and the next two
   * clicks looked dead. Naming the action lets one button show progress and
   * the other two explain why they are closed.
   */
  const [pendingAction, setPendingAction] = useState<
    HumanDecision["action"] | null
  >(null);
  /** The last decision that actually went through, so the panel can prove it. */
  const [lastOutcome, setLastOutcome] = useState<{
    action: HumanDecision["action"];
    previousConclusion: string;
    conclusion: string;
  } | null>(null);
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
  /** Everything the reviewer still has to rule on, so "1 / 20" is honest. */
  const awaitingDecision = session.conflicts.filter(
    isConflictAwaitingHumanDecision
  );
  /** Round 1 is the first pass; every accepted supplement round adds one. */
  const reviewRound = (session.supplementRound ?? 0) + 1;
  /**
   * 外部检索查到的候选来源。
   *
   * 从事件流里读，而不是从某次请求的响应里拿：这样才能在刷新之后仍然在，
   * 也让"这条质询当时看了哪几条来源"有据可查。
   */
  const webSources = useMemo(() => collectWebSources(rawEvents), [rawEvents]);
  /**
   * 后台补充分析失败时唯一能落到页面的证据。
   *
   * 这一轮不再等 HTTP 响应，失败顺着响应回来的路已经没有了，只剩 core 写下的
   * AGENT_RUN_FAILED 事件。没有它，右栏会一直转计时器，用户只能干等。
   */
  const supplementFailure = useMemo(
    () => findSupplementFailure(rawEvents, session.phase),
    [rawEvents, session.phase]
  );
  /**
   * 这一轮质询跑到第几条。
   *
   * 只有计时器时，"在推进"和"卡住了"分不出来；质询进度把等待变成有形状的。
   */
  const challengeProgress = useMemo(
    () => findChallengeProgress(rawEvents),
    [rawEvents]
  );
  /** True while the backend is working on this session and nothing is clickable. */
  const working = !checkpointActive && isPhaseWorking(session.phase);
  /** 结论是否已经定稿——决定页头叫「当前结论」还是「初步倾向」。 */
  const conclusionFinal = isConclusionFinal(session.phase);
  /** 这一轮后台走到第几步，用于把「静止的十几秒」显示成有长度的等待。 */
  const runStep = sessionPhaseStep(session.phase);
  /**
   * 谁可以交材料。
   *
   * 三态而不是布尔：还没问出结果时先不渲染表单（否则会闪一下又消失），
   * 匿名（401）明确不给，问不出来（部署没有身份系统）按操作员放行——后端
   * 仍然会再拒一次，这里只决定"要不要把这个入口摆出来"。
   */
  const [materialWriter, setMaterialWriter] = useState<boolean | null>(null);

  /**
   * 这个评审还没开始跑的时候，页面上得有个能按的东西。
   *
   * 新建表单现在会立刻跳到本页、分析在后台起跑，所以这一页必须自己承担
   * 「还没起来」这一种状态：一句话说明 + 一个重试按钮 + 失败原因。否则从
   * 表单跳过来看到的是一个没有任何反应的 CREATED 页面，和"点了没反应"
   * 是同一种体验。
   */
  const [startPending, setStartPending] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

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
            toLoadFailure(
              error,
              "找不到这个评审（HTTP 404）。",
              "会话加载失败",
              "需要登录才能查看这个评审。"
            )
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

  /**
   * 事件流订阅：一条连接，看到最后。
   *
   * 之前这里把 `session.lastSequence` 放进了依赖，于是**每来一个事件就重建
   * 一次连接**——一轮补充分析三十多个事件，就是三十多次断开重连。重建要重新
   * 握手、重新 replay，而新旧连接交接的那一小段里事件是不在的，结果就是：
   * 后端 6 毫秒写好的事件，页面要一秒后才显示出来。
   *
   * 连接只需要知道"我从哪儿开始看"。起始序号在订阅那一刻定下来，之后不再
   * 变——新事件顺着同一条连接源源不断地来。真的断了，浏览器会自己带
   * `Last-Event-ID` 重连，核心也会从断点补齐。
   */
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
    // `session.lastSequence` 只在订阅开始那一刻读一次，之后不再作为依赖：
    // 把它放进来就等于每来一个事件重连一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, persisted, sessionId]);

  useEffect(() => {
    if (!persisted) return;
    let cancelled = false;
    getCurrentUser()
      .then((user) => {
        if (!cancelled) setMaterialWriter(user === null ? false : user.role !== "viewer");
      })
      /**
       * 问不出身份，多半是这个部署根本没有身份系统（操作员模式）：把它当成
       * "没有理由拦住"，而不是"默认拒绝"。真正的拒绝由后端做，并且会带着原因
       * 回到面板上。
       */
      .catch(() => {
        if (!cancelled) setMaterialWriter(true);
      });
    return () => {
      cancelled = true;
    };
  }, [persisted]);

  async function handleStart() {
    setStartError(null);
    setStartPending(true);
    try {
      await startSession(sessionId, window.crypto.randomUUID());
    } catch (error) {
      setStartError(
        error instanceof Error ? error.message : "启动失败，请稍后重试。"
      );
    } finally {
      setStartPending(false);
      // 起没起来都以数据库为准，重新读一次相位与事件。
      void loadSession(() => true);
    }
  }

  async function handleDecision(
    action: HumanDecision["action"],
    rationale: string,
    affectedAgentRoleIds: string[]
  ) {
    if (!primaryConflict) {
      setErrorMessage("当前没有可裁决的冲突，需要先有一轮 Agent 冲突产出。");
      return;
    }

    const conclusion = decisionConclusion(action);
    const previousConclusion = session.currentConclusion ?? "此前无结论";

    if (!persisted) {
      const decision: HumanDecision = {
        id: createPreviewId("human-decision"),
        sessionId,
        conflictId: primaryConflict.id,
        action,
        rationale,
        affectedClaimIds: primaryClaim ? [primaryClaim.id] : [],
        affectedAgentRoleIds,
        previousConclusion: session.currentConclusion ?? "此前无结论",
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
      setLastOutcome({ action, previousConclusion, conclusion });
      setErrorMessage(null);
      return;
    }

    setPending(true);
    setPendingAction(action);
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
      setLastOutcome({
        action,
        previousConclusion,
        conclusion: response.session.currentConclusion ?? conclusion
      });

      if (primaryClaim) {
        setLiveInspector(
          await getInspector(sessionId, primaryClaim.id)
        );
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "人工裁决失败"
      );
    } finally {
      setPending(false);
      setPendingAction(null);
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
    // Three different dead ends, three different ways out. A missing session is
    // a dead link, not a broken service: it gets its own panel and a way out
    // instead of a retry button that can only fail again. "You are not signed
    // in" is neither — telling that visitor to go and check the core process
    // would send them to inspect something that is running perfectly well.
    const notFound = loadFailure.kind === "not-found";
    const needsSignIn = loadFailure.kind === "sign-in";
    return (
      <FullPageNotice
        testId={
          notFound
            ? "session-not-found"
            : needsSignIn
              ? "session-sign-in-required"
              : "session-load-error"
        }
        role="alert"
        eyebrow={
          notFound
            ? "SESSION NOT FOUND"
            : needsSignIn
              ? "SIGN-IN REQUIRED"
              : "SESSION UNAVAILABLE"
        }
        title={
          notFound ? "会话不存在" : needsSignIn ? "需要登录" : "无法加载会话"
        }
        reason={loadFailure.message}
        hint={
          notFound
            ? "它可能已被删除，或者这个链接有误。"
            : needsSignIn
              ? "登录后即可查看这个评审。如果已经登录过，你的会话可能已过期。"
              : "请确认核心 API 正在运行（默认 4100 端口），然后重新加载。"
        }
        actions={
          notFound ? (
            <>
              <ActionLink href="/history">返回最近会话</ActionLink>
              <ActionLink href="/sessions/new">新建评审</ActionLink>
            </>
          ) : needsSignIn ? (
            <>
              <ActionLink href="/login">去登录</ActionLink>
              <ActionLink href="/history">返回最近会话</ActionLink>
            </>
          ) : (
            <Button onClick={() => void loadSession(() => true)}>
              重新加载
            </Button>
          )
        }
      />
    );
  }

  if (persisted && loading) {
    return (
      <FullPageNotice
        testId="session-loading"
        tone="loading"
        role="status"
        live="polite"
        eyebrow="LOADING"
        title="正在载入会话"
        hint="正在读取会话状态、执行事件与 Claim 详情。"
      />
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
          ) : streamStatus === "polling" ? (
            /*
             * 不是故障，是这个连接不支持实时推送：公网隧道会把事件流攒住，
             * 事件由轮询送来。说清楚"会慢一点但不会漏"，用户就不用反复刷新。
             */
            <span
              className="stream-offline-chip"
              role="status"
              data-testid="stream-polling"
              title="这个连接不支持实时推送（公网隧道会把事件流攒住）。进度改为每两秒刷新一次，不会漏事件。"
            >
              进度定时刷新
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
          {/*
           * 结论 vs 倾向。
           *
           * 页头原来一律写「当前结论」。实测第 3 秒显示「建议立项」，第 13 秒
           * 自己改成「暂缓规模化扩张」——AI 在质询结束前写下的只是倾向，把它
           * 叫结论等于让系统当场改口。DECIDED 之前一律降级为「初步倾向」并
           * 标注未定稿。
           */}
          <span className={conclusionFinal ? "" : "vital-provisional"}>
            <small>{conclusionFinal ? "当前结论" : "初步倾向 · 未定稿"}</small>
            <strong
              title={
                conclusionFinal
                  ? session.currentConclusion ?? "正在形成结论"
                  : "质询与人工裁决尚未完成，这只是 AI 目前的倾向，可能被推翻或改判。"
              }
            >
              {session.currentConclusion ?? "正在形成结论"}
            </strong>
          </span>
          <span>
            <small>{"\u8fd0\u884c\u9636\u6bb5"}</small>
            <strong
              title={
                runStep
                  ? `第 ${runStep.step} 步，共 ${runStep.total} 步：${runStep.label}`
                  : sessionPhaseLabel(session.phase)
              }
            >
              {sessionPhaseLabel(session.phase)}
              {runStep ? (
                <em className="vital-step">
                  {runStep.restarted ? "回到 " : ""}
                  {runStep.step}/{runStep.total}
                </em>
              ) : null}
            </strong>
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
              conflictType={primaryConflict.type}
              roles={session.agents}
              onDecision={handleDecision}
              pending={pending}
              pendingAction={pendingAction}
              round={reviewRound}
              queue={{
                position:
                  awaitingDecision.findIndex(
                    (conflict) => conflict.id === primaryConflict.id
                  ) + 1,
                total: awaitingDecision.length
              }}
              lastOutcome={lastOutcome}
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
          ) : session.phase === "CREATED" && persisted ? (
            /*
             * 还没开始跑。这一屏存在的理由：新建表单现在立刻跳过来，分析
             * 在后台起跑，所以「刚建好、还没动」是一个正常会停留几秒的
             * 状态——它必须说清"现在在等什么、能做什么"，而不是一片空白。
             */
            <section className="decision-complete decision-start">
              <p className="eyebrow">NOT STARTED</p>
              <h2>这次评审还没有开始</h2>
              <p>
                创建已经完成，五个角色的分析还没跑。通常是启动请求失败或刚跳过来
                还在等待；点下面的按钮即可重新启动，进度会显示在左侧时间线与阶段栏。
              </p>
              <Button onClick={handleStart} disabled={startPending}>
                {startPending ? "正在启动…" : "开始评审"}
              </Button>
              {startError ? (
                <p className="checkpoint-error" role="alert">
                  启动失败：{startError}
                </p>
              ) : null}
            </section>
          ) : working ? (
            <DecisionInProgress
              phase={session.phase}
              round={reviewRound}
              pendingAction={pendingAction}
              failureMessage={supplementFailure}
              progress={challengeProgress}
            />
          ) : null}
        </div>
      </div>

      {/*
        材料放在工作区下方而不是塞进右栏：右栏是"现在该做什么"的裁决区，
        材料是"下一轮之前要准备什么"，两者并列会让人以为现在就得交。
      */}
      {persisted && materialWriter !== null ? (
        <SessionMaterials
          sessionId={sessionId}
          canWrite={materialWriter}
          roundLabel={`第 ${reviewRound} 轮`}
          candidates={webSources}
        />
      ) : null}

      <Timeline
        events={events}
        selectedSequence={selectedSequence}
        onSelect={handleTimelineSelect}
      />
    </main>
  );
}
