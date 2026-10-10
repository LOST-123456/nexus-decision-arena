"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isEvidenceExpired,
  isEvidenceNotYetEffective,
  type ClaimReview,
  type EvidenceGap,
  type EvidenceGapAction
} from "@nexus/shared";
import { getEvents } from "./api";
import {
  createEvidence,
  createResearchClaim,
  createSource,
  getEvidenceContext,
  getResearchWorkspace,
  listClaimReviews,
  recordClaimReview,
  runCrossReview,
  setVerification,
  type CrossReviewResult,
  type EvidenceContext,
  type ResearchWorkspace
} from "./api";
import { getCurrentUser, type AuthUser } from "../arena/api-client";
import {
  CrossReviewPanel,
  EvidenceTable,
  ReviewCenter,
  SourceDetail,
  StatusPill,
  VerdictCard
} from "./components";
import { ClaimForm, EvidenceForm, SourceForm } from "./forms";
import {
  claimStatusLabel,
  pendingVerificationLabel,
  verificationLabel,
  verificationTone,
  verdictLabel,
  workflowLabel
} from "./labels";

type Panel = "claims" | "content" | "cross" | "review" | "detail";

/**
 * `claims` and `detail` are their own tabs only where the layout collapses: on
 * a wide screen the claim rail and the source detail are always on screen, so
 * offering a tab that changes nothing would be a dead control.
 */
const PANELS: Array<{ id: Panel; label: string; narrowOnly?: boolean }> = [
  { id: "claims", label: "主张", narrowOnly: true },
  { id: "content", label: "研究内容" },
  { id: "cross", label: "交叉审查" },
  { id: "review", label: "审核中心" },
  { id: "detail", label: "来源详情", narrowOnly: true }
];

const RESEARCH_MODE: Panel[] = ["claims", "content", "detail"];

function isResearchMode(panel: Panel): boolean {
  return RESEARCH_MODE.includes(panel);
}

export function ResearchWorkspace({
  sessionId,
  initialIntent
}: {
  sessionId: string;
  /**
   * A gap action carried over from the report. Applied once, after the
   * workspace has loaded, so the form the action names is the one that opens.
   */
  initialIntent?: {
    action: EvidenceGapAction;
    claimId: string;
    evidenceIds: string[];
  } | null;
}) {
  const [workspace, setWorkspace] = useState<ResearchWorkspace | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [context, setContext] = useState<EvidenceContext | null>(null);
  const [panel, setPanel] = useState<Panel>("content");
  const [openForm, setOpenForm] = useState<"none" | "claim" | "source" | "evidence">(
    "none"
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [intentApplied, setIntentApplied] = useState(false);

  // Cross-examination: real agent runs, so both progress and outcome are kept.
  const [crossRunning, setCrossRunning] = useState(false);
  const [crossError, setCrossError] = useState<string | null>(null);
  const [crossResult, setCrossResult] = useState<CrossReviewResult | null>(null);

  // Human rulings: append-only, re-read from the backend after every write.
  const [reviewHistory, setReviewHistory] = useState<ClaimReview[] | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const next = await getResearchWorkspace(sessionId);
    setWorkspace(next);
    return next;
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [next, currentUser, events] = await Promise.all([
          getResearchWorkspace(sessionId),
          getCurrentUser().catch(() => null),
          getEvents(sessionId).catch(() => [])
        ]);
        if (cancelled) return;
        setWorkspace(next);
        setUser(currentUser);
        setHistory(
          events
            .filter(
              (event) =>
                event.type === "EVIDENCE_RECORDED" ||
                event.type === "EVIDENCE_VERIFICATION_CHANGED" ||
                event.type === "CLAIM_CREATED" ||
                event.type === "CLAIM_REVIEW_RECORDED"
            )
            .slice(-8)
            .reverse()
            .map((event) => `#${event.sequence} ${event.type}`)
        );
      } catch (cause) {
        if (!cancelled) {
          setLoadError(
            cause instanceof Error ? cause.message : "Research workspace unavailable"
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!selectedEvidenceId) {
      setContext(null);
      return;
    }
    let cancelled = false;
    getEvidenceContext(sessionId, selectedEvidenceId)
      .then((next) => {
        if (!cancelled) setContext(next);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Failed to load detail");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, selectedEvidenceId]);

  // The review panel always shows the backend's own history for the claim, not
  // a locally guessed list, so a ruling recorded elsewhere still shows up.
  useEffect(() => {
    if (panel !== "review" || !selectedClaimId) return;
    let cancelled = false;
    setReviewError(null);
    listClaimReviews(sessionId, selectedClaimId)
      .then((next) => {
        if (!cancelled) setReviewHistory(next.reviews);
      })
      .catch((cause) => {
        if (!cancelled) {
          setReviewError(
            cause instanceof Error ? cause.message : "无法读取裁定历史"
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [panel, selectedClaimId, sessionId]);

  // A gap action carried over from the report is applied exactly once, after
  // the workspace data is loaded, so it opens a form that really exists for
  // that claim. An intent naming an unknown claim is ignored, not guessed at.
  useEffect(() => {
    if (intentApplied || !initialIntent || !workspace) return;
    if (!workspace.claims.some((claim) => claim.id === initialIntent.claimId)) {
      return;
    }
    setIntentApplied(true);
    applyGapAction(initialIntent.action, {
      claimId: initialIntent.claimId,
      evidenceIds: initialIntent.evidenceIds
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentApplied, initialIntent, workspace]);

  const claimsById = useMemo(
    () => new Map((workspace?.claims ?? []).map((claim) => [claim.id, claim])),
    [workspace]
  );
  const sourcesById = useMemo(
    () => new Map((workspace?.sources ?? []).map((source) => [source.id, source])),
    [workspace]
  );
  const verdictByClaimId = useMemo(
    () => new Map((workspace?.verdicts ?? []).map((verdict) => [verdict.claimId, verdict])),
    [workspace]
  );

  const visibleEvidence = useMemo(() => {
    const all = workspace?.evidence ?? [];
    if (!selectedClaimId) return all;
    return all.filter((item) => item.claimIds.includes(selectedClaimId));
  }, [workspace, selectedClaimId]);

  const canEdit = user === null || user.role !== "viewer";

  async function run(action: () => Promise<unknown>, failureHint: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : `${failureHint} failed`
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function startCrossReview(targetClaimId?: string) {
    const claimId = targetClaimId ?? selectedClaimId;
    if (!claimId) return;
    setCrossRunning(true);
    setCrossError(null);
    setCrossResult(null);
    try {
      const result = await runCrossReview(sessionId, claimId);
      setCrossResult(result);
      await reload();
    } catch (cause) {
      setCrossError(
        cause instanceof Error ? cause.message : "交叉审查请求失败"
      );
    } finally {
      setCrossRunning(false);
    }
  }

  async function submitReview(
    outcome: ClaimReview["outcome"],
    rationale: string
  ) {
    if (!selectedClaimId) return;
    // The ruling is written against the verdict that is on screen right now.
    // If the derived verdict has moved on since then, the server rejects it
    // instead of attaching the ruling to a conclusion nobody reviewed.
    const verdict = verdictByClaimId.get(selectedClaimId);
    if (!verdict) {
      setReviewError("该主张当前没有可复核的核查结论。");
      return;
    }
    setReviewBusy(true);
    setReviewError(null);
    try {
      await recordClaimReview(sessionId, selectedClaimId, {
        outcome,
        rationale,
        expectedVerdictStatus: verdict.status
      });
      const next = await listClaimReviews(sessionId, selectedClaimId);
      setReviewHistory(next.reviews);
      await reload();
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : "提交裁定失败");
    } finally {
      setReviewBusy(false);
    }
  }

  /**
   * A gap action opens the real surface that would close it. Nothing is
   * simulated: recording a source opens the source form, verifying opens the
   * excerpt's verification panel, and re-running cross-examination starts a
   * new agent run through the same backend path as the panel's own button.
   */
  function applyGapAction(
    action: EvidenceGapAction,
    target: { claimId: string; evidenceIds: readonly string[] }
  ) {
    switch (action) {
      case "record_source":
      case "add_primary_source":
        setSelectedClaimId(target.claimId);
        setPanel("content");
        setOpenForm("source");
        break;
      case "add_supporting_evidence":
      case "add_opposing_evidence":
        setSelectedClaimId(target.claimId);
        setPanel("content");
        setOpenForm("evidence");
        break;
      case "verify_evidence": {
        setSelectedClaimId(target.claimId);
        const evidence = target.evidenceIds[0];
        if (evidence) {
          setSelectedEvidenceId(evidence);
          setPanel("detail");
        } else {
          setPanel("content");
        }
        break;
      }
      case "run_cross_review":
        setSelectedClaimId(target.claimId);
        setPanel("cross");
        void startCrossReview(target.claimId);
        break;
      default:
        break;
    }
  }

  function handleGapAction(action: EvidenceGapAction, gap: EvidenceGap) {
    applyGapAction(action, {
      claimId: gap.claimId,
      evidenceIds: gap.evidenceIds
    });
  }

  if (loadError) {
    return (
      <div className="research-body">
        <div className="research-column">
          <section className="research-panel">
            <p className="research-error" role="alert">
              {loadError}
            </p>
            <p className="research-muted" style={{ marginTop: 8 }}>
              无法读取研究工作台。请确认后端已启动并完成 0005 迁移。
            </p>
          </section>
        </div>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="research-body">
        <div className="research-column">
          <div className="research-empty">正在载入研究工作台…</div>
        </div>
      </div>
    );
  }

  const selectedClaim = selectedClaimId ? claimsById.get(selectedClaimId) : undefined;
  const selectedVerdict = selectedClaimId
    ? verdictByClaimId.get(selectedClaimId)
    : undefined;

  const claimEvidence = selectedClaimId
    ? workspace.evidence.filter((item) => item.claimIds.includes(selectedClaimId))
    : [];
  const nonLive = claimEvidence.filter(
    (item) => isEvidenceExpired(item) || isEvidenceNotYetEffective(item)
  );
  const liveForClaim = claimEvidence.filter(
    (item) => !isEvidenceExpired(item) && !isEvidenceNotYetEffective(item)
  );
  const supporting = liveForClaim.filter((item) => item.direction === "supports");
  const opposing = liveForClaim.filter((item) => item.direction === "opposes");
  const background = liveForClaim.filter((item) => item.direction === "context");

  const claimChallenges = selectedClaimId
    ? workspace.challenges.filter(
        (challenge) => challenge.targetClaimId === selectedClaimId
      )
    : [];
  const claimRuns = selectedClaimId
    ? workspace.agentRuns.filter(
        (agentRun) =>
          agentRun.purpose === "cross_review" &&
          agentRun.targetClaimId === selectedClaimId
      )
    : [];
  const claimConflicts = selectedClaimId
    ? workspace.conflicts.filter((conflict) =>
        conflict.claimIds.includes(selectedClaimId)
      )
    : [];
  const reviewsForClaim =
    reviewHistory ?? (selectedClaimId
      ? workspace.reviews.filter((review) => review.claimId === selectedClaimId)
      : []);
  const gapsForClaim = selectedClaimId
    ? workspace.gaps.filter((gap) => gap.claimId === selectedClaimId)
    : [];

  const focusMode = !isResearchMode(panel);

  return (
    <>
      <div
        className="research-tabs"
        role="tablist"
        aria-label="研究面板"
        data-testid="research-tabs"
      >
        {PANELS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            className={`research-tab${item.narrowOnly ? " research-tab-narrow" : ""}`}
            aria-selected={panel === item.id}
            onClick={() => setPanel(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div
        className="research-body"
        data-testid="research-body"
        data-mode={focusMode ? "focus" : "research"}
      >
        {/* ---------- left: claims and flow (always on screen when wide) ---------- */}
        <div
          className="research-column"
          data-narrow-hidden={panel !== "claims"}
          data-testid="claim-rail"
          role="tabpanel"
          aria-label="主张导航"
        >
          <section className="research-panel">
            <div className="research-panel-head">
              <span className="research-panel-title">研究问题</span>
              <StatusPill tone="research-pill-neutral">
                {workflowLabel(workspace.session.phase)}
              </StatusPill>
            </div>
            <p className="research-question">
              {workspace.session.researchQuestion ?? "（未填写研究问题）"}
            </p>
            <p className="research-muted" style={{ marginTop: 6 }}>
              {pendingVerificationLabel(workspace.summary.unverified)} ·{" "}
              {workspace.summary.openVerdicts} 条主张仍有待处理材料
            </p>
            {workspace.summary.blockingGaps > 0 ||
            workspace.summary.needsMoreEvidence > 0 ? (
              <p
                className="research-muted"
                data-testid="blocking-gaps-summary"
                style={{ marginTop: 4 }}
              >
                阻断性证据缺口 {workspace.summary.blockingGaps} 项
                {workspace.summary.needsMoreEvidence > 0
                  ? ` · ${workspace.summary.needsMoreEvidence} 条主张被要求补充证据`
                  : ""}
              </p>
            ) : null}
          </section>

          <section className="research-panel">
            <div className="research-panel-head">
              <span className="research-panel-title">
                主张目录（{workspace.claims.length}）
              </span>
              <button
                type="button"
                className="research-button research-button-secondary"
                onClick={() => setOpenForm(openForm === "claim" ? "none" : "claim")}
              >
                {openForm === "claim" ? "收起" : "添加主张"}
              </button>
            </div>
            {openForm === "claim" ? (
              <ClaimForm
                busy={busy}
                error={error}
                onSubmit={async (command) => {
                  const ok = await run(
                    () => createResearchClaim(sessionId, command),
                    "Create claim"
                  );
                  if (ok) setOpenForm("none");
                }}
              />
            ) : null}
            {workspace.claims.length === 0 ? (
              <p className="research-muted">
                还没有主张。先写下一条可核查的原子主张，再为它收集证据。
              </p>
            ) : (
              <ul className="research-claim-list" data-testid="claim-list">
                <li className="research-claim-item">
                  <button
                    type="button"
                    className="research-claim-button"
                    aria-pressed={selectedClaimId === null}
                    onClick={() => setSelectedClaimId(null)}
                  >
                    <span className="research-claim-statement">全部主张</span>
                    <span className="research-claim-meta">
                      <span className="research-muted">
                        {workspace.evidence.length} 条材料
                      </span>
                    </span>
                  </button>
                </li>
                {workspace.claims.map((claim) => {
                  const verdict = verdictByClaimId.get(claim.id);
                  return (
                    <li key={claim.id} className="research-claim-item">
                      <button
                        type="button"
                        className="research-claim-button"
                        data-claim-id={claim.id}
                        aria-pressed={selectedClaimId === claim.id}
                        onClick={() => {
                          setSelectedClaimId(claim.id);
                          setCrossResult(null);
                          setCrossError(null);
                          setReviewHistory(null);
                          setReviewError(null);
                        }}
                      >
                        <span className="research-claim-statement">
                          {claim.statement}
                        </span>
                        <span className="research-claim-meta">
                          <StatusPill tone="research-pill-neutral">
                            {claimStatusLabel(claim.status)}
                          </StatusPill>
                          {verdict ? (
                            <StatusPill tone="research-pill-neutral">
                              {verdictLabel(verdict.effectiveStatus)}
                            </StatusPill>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="research-panel">
            <div className="research-panel-head">
              <span className="research-panel-title">核查产出</span>
            </div>
            <Link
              className="research-report-link"
              href={`/research/${sessionId}/report`}
              data-testid="fact-check-report-link"
            >
              打开 Fact Check Report →
            </Link>
            <p className="research-muted" style={{ marginTop: 6 }}>
              报告只从已持久化的材料、交叉审查与人工裁定生成，并记录材料指纹。
            </p>
          </section>
        </div>

        {/* ---------- main column: research content / cross-review / review ---------- */}
        <div className="research-column">
          <div data-hidden={focusMode}>
            {selectedClaim && selectedVerdict ? (
              <section className="research-panel" style={{ marginBottom: 12 }}>
                <div className="research-panel-head">
                  <span className="research-panel-title">当前主张的结论</span>
                </div>
                <p className="research-question">{selectedClaim.statement}</p>
                <div style={{ marginTop: 8 }}>
                  <VerdictCard
                    verdict={selectedVerdict}
                    claimStatus={claimStatusLabel(selectedClaim.status)}
                  />
                </div>
              </section>
            ) : null}

            <section className="research-panel">
              <div className="research-panel-head">
                <span className="research-panel-title">
                  证据材料（{visibleEvidence.length}）
                </span>
                <div className="research-actions">
                  <button
                    type="button"
                    className="research-button research-button-secondary"
                    onClick={() =>
                      setOpenForm(openForm === "source" ? "none" : "source")
                    }
                  >
                    {openForm === "source" ? "收起来源" : "添加来源"}
                  </button>
                  <button
                    type="button"
                    className="research-button"
                    onClick={() =>
                      setOpenForm(openForm === "evidence" ? "none" : "evidence")
                    }
                  >
                    {openForm === "evidence" ? "收起" : "录入证据"}
                  </button>
                </div>
              </div>

              {openForm === "source" ? (
                <SourceForm
                  busy={busy}
                  error={error}
                  onSubmit={async (command) => {
                    const ok = await run(
                      () => createSource(sessionId, command),
                      "Create source"
                    );
                    if (ok) setOpenForm("none");
                  }}
                />
              ) : null}

              {openForm === "evidence" ? (
                <EvidenceForm
                  claims={workspace.claims}
                  sources={workspace.sources}
                  defaultClaimId={selectedClaimId}
                  busy={busy}
                  error={error}
                  onSubmit={async (command) => {
                    const ok = await run(
                      () => createEvidence(sessionId, command),
                      "Create evidence"
                    );
                    if (ok) setOpenForm("none");
                  }}
                />
              ) : null}

              <EvidenceTable
                evidence={visibleEvidence}
                claimsById={claimsById}
                sourcesById={sourcesById}
                selectedId={selectedEvidenceId}
                onSelect={(evidenceId) => {
                  setSelectedEvidenceId(evidenceId);
                  setPanel("detail");
                }}
                emptyHint={
                  selectedClaimId
                    ? "该主张还没有任何证据材料。"
                    : "还没有证据材料。先添加来源，再录入原文摘录。"
                }
              />
            </section>

            <section className="research-panel" style={{ marginTop: 12 }}>
              <div className="research-panel-head">
                <span className="research-panel-title">最近操作</span>
                <Link className="research-muted" href={`/research/${sessionId}/evidence`}>
                  打开 Evidence Explorer →
                </Link>
              </div>
              {history.length === 0 ? (
                <p className="research-muted">暂无证据相关操作记录。</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {history.map((entry) => (
                    <li key={entry} className="research-muted">
                      {entry}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div data-hidden={panel !== "cross"} data-testid="cross-section">
            {selectedClaim && selectedVerdict ? (
              <CrossReviewPanel
                runs={claimRuns}
                challenges={claimChallenges}
                claimId={selectedClaim.id}
                canRun={canEdit}
                running={crossRunning}
                error={crossError}
                onRun={() => startCrossReview()}
              />
            ) : null}
            {crossResult ? (
              <div className="research-column" style={{ marginTop: 12 }}>
                <section className="research-panel" data-testid="cross-review-result">
                  <div className="research-panel-head">
                    <span className="research-panel-title">本次交叉审查结果</span>
                    <StatusPill
                      tone={
                        crossResult.status === "completed"
                          ? "research-pill-verified"
                          : crossResult.status === "partial"
                            ? "research-pill-unverified"
                            : "research-pill-rejected"
                      }
                    >
                      {crossResult.status === "completed"
                        ? "全部完成"
                        : crossResult.status === "partial"
                          ? "部分完成"
                          : "全部失败"}
                    </StatusPill>
                  </div>
                  <p className="research-muted">
                    {crossResult.runs.length} 次运行，产生{" "}
                    {crossResult.challenges.length} 项质询，
                    {crossResult.failures.length} 次失败。
                  </p>
                  {crossResult.failures.length > 0 ? (
                    <ul className="research-plain-list">
                      {crossResult.failures.map((failure) => (
                        <li key={failure.runId}>
                          角色 {failure.roleId.slice(0, 8)} 失败：{failure.reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              </div>
            ) : null}
            {!selectedClaim ? (
              <section className="research-panel">
                <p className="research-muted">
                  先在左侧选择一条主张，再发起面向该主张的交叉审查。
                </p>
              </section>
            ) : null}
          </div>

          <div data-hidden={panel !== "review"} data-testid="review-section">
            {selectedClaim && selectedVerdict ? (
              <ReviewCenter
                claim={selectedClaim}
                verdict={selectedVerdict}
                supporting={supporting}
                opposing={opposing}
                context={background}
                excluded={nonLive}
                gaps={gapsForClaim}
                conflicts={claimConflicts}
                runs={claimRuns}
                challenges={claimChallenges}
                reviews={reviewsForClaim}
                sourcesById={sourcesById}
                canReview={canEdit}
                busy={reviewBusy}
                error={reviewError}
                onSubmitReview={submitReview}
                onOpenCrossReview={() => setPanel("cross")}
                onGapAction={handleGapAction}
              />
            ) : (
              <section className="research-panel">
                <p className="research-muted">
                  先在左侧选择一条主张，再进入审核中心。
                </p>
              </section>
            )}
          </div>
        </div>

        {/* ---------- right: source detail (research modes only) ---------- */}
        <div
          data-hidden={focusMode}
          data-narrow-hidden={panel !== "detail"}
          role="tabpanel"
          aria-label="来源详情"
        >
          {context ? (
            <SourceDetail
              evidence={context.evidence}
              source={context.source}
              claims={context.claims}
              canEdit={canEdit}
              verifying={busy}
              error={error}
              onVerify={async (status, note) => {
                if (note.trim() === "") {
                  setError("请填写核实理由。");
                  return;
                }
                await run(
                  () =>
                    setVerification(sessionId, context.evidence.id, {
                      status,
                      verificationNote: note
                    }),
                  "Verification"
                );
              }}
            />
          ) : (
            <div className="research-column">
              <section className="research-panel">
                <p className="research-muted">
                  选择一条证据材料即可查看原文、来源元数据与核实记录。
                </p>
                <p className="research-muted" style={{ marginTop: 8 }}>
                  当前已核实 {workspace.summary.verified} 条，待核实{" "}
                  {workspace.summary.unverified} 条，已驳回{" "}
                  {workspace.summary.rejected} 条。
                </p>
              </section>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export function verificationSummary(status: string): string {
  return verificationLabel(
    status === "verified" || status === "rejected" ? status : "unverified"
  );
}

export function verificationPillTone(status: string): string {
  return verificationTone(
    status === "verified" || status === "rejected" ? status : "unverified"
  );
}
