"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isEvidenceExpired,
  isEvidenceNotYetEffective,
  type ClaimReview,
  type EvidenceGap,
  type EvidenceGapAction,
  type SourceCopyRecord
} from "@nexus/shared";
import { getEvents } from "./api";
import {
  createEvidence,
  createResearchClaim,
  createSource,
  getCopyLineage,
  getEvidenceContext,
  getResearchWorkspace,
  importSource,
  listClaimReviews,
  recordClaimReview,
  runCrossReview,
  setVerification,
  type CrossReviewResult,
  type EvidenceContext,
  type ImportSourceCommand,
  type ImportSourceResult,
  type ResearchWorkspace
} from "./api";
import { getCurrentUser, type AuthUser } from "../arena/api-client";
import { toLoadFailure, type LoadFailure } from "../../lib/load-failure";
import {
  CrossReviewPanel,
  EvidenceTable,
  ReviewCenter,
  SourceDetail,
  StatusPill,
  VerdictCard
} from "./components";
import { ClaimForm, EvidenceForm, ImportSourceForm, SourceForm } from "./forms";
import { ClaimCandidatesPanel } from "./claim-candidates";
import { CitationReviewPanel } from "./citation-review";
import { SourceIndependencePanel } from "./source-independence";
import { ResearchPlanPanel } from "./research-plan";
import { ResearchQualityPanel } from "./research-quality";
import { EvidenceMapPanel } from "./evidence-map";
import { FileImportPanel } from "./file-import";
import { SourceLibraryPanel } from "./source-library";
import { AgentOpsPanel } from "./agent-ops";
import { CollaborationPanel } from "./collaboration";
import { FileReader } from "./file-reader";
import { SourceReader } from "./source-reader";
import {
  claimStatusLabel,
  formatDate,
  pendingVerificationLabel,
  sourceImportStateLabel,
  sourceImportStateTone,
  sourceRetrievalLabel,
  sourceRetrievalTone,
  verificationLabel,
  verificationTone,
  verdictLabel,
  workflowLabel
} from "./labels";

type Panel =
  | "claims"
  | "content"
  | "cross"
  | "review"
  | "detail"
  | "reader"
  | "analyze"
  | "citations"
  | "independence"
  | "plan"
  | "quality"
  | "map"
  | "files"
  | "filereader"
  | "agentops"
  | "library"
  | "collaboration";

/**
 * `claims` and `detail` are their own tabs only where the layout collapses: on
 * a wide screen the claim rail and the source detail are always on screen, so
 * offering a tab that changes nothing would be a dead control.
 *
 * `reader` is the exception — it is a real destination on every width, because
 * reading a stored page replaces the whole workspace rather than sitting in a
 * column beside it.
 */
const PANELS: Array<{ id: Panel; label: string; narrowOnly?: boolean }> = [
  { id: "claims", label: "主张", narrowOnly: true },
  { id: "content", label: "研究内容" },
  { id: "cross", label: "交叉审查" },
  { id: "review", label: "审核中心" },
  { id: "detail", label: "来源详情", narrowOnly: true },
  { id: "reader", label: "原文阅读" },
  { id: "analyze", label: "AI 拆解" },
  { id: "citations", label: "引用核查" },
  { id: "independence", label: "来源关系" },
  { id: "plan", label: "研究计划" },
  { id: "quality", label: "研究质量" },
  { id: "map", label: "证据地图" },
  { id: "files", label: "文件导入" },
  { id: "agentops", label: "运行中心" },
  { id: "library", label: "资料库" },
  { id: "collaboration", label: "团队协作" }
];

/**
 * One address inside a multi-url import. The state is the workspace's own
 * progress, kept separate from the stored retrieval status of the source that
 * comes back: "we finished trying" and "the text was extracted" are different
 * facts, and a refused url is still a finished attempt.
 */
type ImportRow = {
  url: string;
  state: "pending" | "running" | "done" | "failed";
  result?: ImportSourceResult;
  message?: string;
};

/** Event types that belong in the workspace's own activity trail. */
const HISTORY_EVENT_TYPES = new Set([
  "EVIDENCE_RECORDED",
  "EVIDENCE_VERIFICATION_CHANGED",
  "CLAIM_CREATED",
  "CLAIM_REVIEW_RECORDED",
  "SOURCE_REGISTERED",
  "SOURCE_RETRIEVED",
  "SOURCE_RETRIEVAL_FAILED",
  "SOURCE_EXCERPTS_RECHECKED",
  "CLAIM_EXTRACTION_STARTED",
  "CLAIM_EXTRACTION_COMPLETED",
  "CLAIM_EXTRACTION_FAILED",
  "CLAIM_CANDIDATES_DECIDED",
  "CITATION_INTEGRITY_CHECKED",
  "SUPPORT_ASSESSMENT_RECORDED",
  "CITATION_CORRECTION_RECORDED",
  "SOURCE_RELATION_RECORDED",
  "SOURCE_PROFILE_OVERRIDDEN",
  "RESEARCH_PLAN_ITEM_ADDED",
  "RESEARCH_PLAN_QUERY_EDITED",
  "RESEARCH_PLAN_SEARCH_STARTED",
  "RESEARCH_PLAN_SEARCH_FAILED",
  "RESEARCH_PLAN_OUTCOME_RECORDED",
  "RESEARCH_PLAN_ITEM_CLOSED",
  "SEARCH_TASK_CREATED",
  "SEARCH_COMPLETED",
  "SEARCH_FAILED",
  "SOURCE_CANDIDATE_FOUND",
  // 跨研究复用：授权、撤销与"复制进本研究"都是本研究自己的活动，
  // 所以它们出现在活动轨迹里；复制事件记的是"这次复制发生在本研究"，
  // 不是"本研究已经核实了这条材料"。
  "SOURCE_LIBRARY_GRANTED",
  "SOURCE_LIBRARY_REVOKED",
  "SOURCE_COPIED_TO_RESEARCH"
]);

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
  const [openForm, setOpenForm] = useState<
    "none" | "claim" | "source" | "evidence" | "import"
  >("none");
  /**
   * Which source the reader is showing. Kept apart from `selectedEvidenceId`
   * so closing the reader returns to whatever excerpt the user came from.
   */
  const [readerSourceId, setReaderSourceId] = useState<string | null>(null);
  /** Which imported file the file reader is showing, if any. */
  const [readerFileId, setReaderFileId] = useState<string | null>(null);
  /** Which source the AI candidate review is working on. */
  const [analyzeSourceId, setAnalyzeSourceId] = useState<string | null>(null);
  const [importRows, setImportRows] = useState<ImportRow[] | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Why the research never arrived, with its status kept.
   *
   * A 404 means the research is gone and the reader should go back to the
   * list; anything else means the service did not answer and is worth
   * retrying. Collapsing both into a message string made a deleted research
   * look like a server outage, and a server outage look like a deleted
   * research — the same failure this product already fixed on the arena side.
   */
  const [loadFailure, setLoadFailure] = useState<LoadFailure | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  /**
   * Which sources in this research are copies, keyed by the local source id.
   * Read back from the backend rather than inferred: the origin status is
   * derived live against the origin research, so a revoked share shows up here
   * without anyone writing to this research.
   */
  const [copyLineage, setCopyLineage] = useState<Record<string, SourceCopyRecord>>({});
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

  /**
   * The activity trail is read back from the event log, never assembled from
   * what this component happens to have done — otherwise a write made in
   * another tab, or a refused fetch whose attempt was still recorded, would be
   * invisible here.
   */
  const refreshHistory = useCallback(async () => {
    const events = await getEvents(sessionId).catch(() => []);
    setHistory(
      events
        .filter((event) => HISTORY_EVENT_TYPES.has(event.type))
        .slice(-8)
        .reverse()
        .map((event) => `#${event.sequence} ${event.type}`)
    );
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [next, currentUser] = await Promise.all([
          getResearchWorkspace(sessionId),
          getCurrentUser().catch(() => null)
        ]);
        if (cancelled) return;
        setWorkspace(next);
        setUser(currentUser);
        await refreshHistory();
      } catch (cause) {
        if (!cancelled) {
          setLoadFailure(
            toLoadFailure(
              cause,
              "找不到这项研究（HTTP 404）。",
              "Research workspace unavailable"
            )
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshHistory]);

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

  /**
   * The copy lineage is read when the detail panel is opened, not once at
   * mount, so a copy just made in 资料库 is already reflected. A lineage this
   * account may not read is not worth an error banner — the detail panel then
   * simply shows no copy badge, which is the safe direction to fail in.
   */
  useEffect(() => {
    if (panel !== "detail") return;
    let cancelled = false;
    getCopyLineage(sessionId)
      .then((response) => {
        if (!cancelled) setCopyLineage(response.lineage);
      })
      .catch(() => {
        if (!cancelled) setCopyLineage({});
      });
    return () => {
      cancelled = true;
    };
  }, [panel, sessionId]);

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

  /**
   * Asks the server to read each url and store its text, one at a time.
   *
   * A refusal is not a no-op: the attempt is recorded against the source even
   * when the fetch fails, so the workspace is reloaded at the end regardless and
   * every row reports its own outcome. Reading them sequentially keeps the load
   * on one page's server bounded and makes the per-url progress truthful.
   */
  async function submitImport(commands: ImportSourceCommand[]) {
    if (commands.length === 0) return;
    setImportBusy(true);
    setImportError(null);
    setOpenForm((current) => (current === "import" ? "none" : current));
    setImportRows(commands.map((command) => ({ url: command.url, state: "pending" })));

    for (const [index, command] of commands.entries()) {
      setImportRows((current) =>
        (current ?? []).map((row, position) =>
          position === index ? { ...row, state: "running" } : row
        )
      );
      try {
        const result = await importSource(sessionId, command);
        setImportRows((current) =>
          (current ?? []).map((row, position) =>
            position === index ? { url: row.url, state: "done", result } : row
          )
        );
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "导入该地址失败";
        setImportRows((current) =>
          (current ?? []).map((row, position) =>
            position === index ? { url: row.url, state: "failed", message } : row
          )
        );
      }
    }

    try {
      await reload();
      await refreshHistory();
    } catch (cause) {
      setImportError(
        cause instanceof Error ? cause.message : "导入后刷新工作台失败"
      );
    } finally {
      setImportBusy(false);
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

  if (loadFailure) {
    const notFound = loadFailure.status === 404;
    return (
      <div className="research-body">
        <div className="research-column">
          <section
            className="research-panel"
            data-testid={notFound ? "research-not-found" : "research-load-error"}
          >
            <p className="research-error" role="alert">
              {loadFailure.message}
            </p>
            <p className="research-muted" style={{ marginTop: 8 }}>
              {notFound
                ? "它可能已被删除，或者这个链接有误。"
                : "无法读取研究工作台。请确认后端已启动并完成 0005 迁移。"}
            </p>
            <p style={{ marginTop: 12 }}>
              <Link
                className="research-button research-button-secondary"
                href="/research"
              >
                返回研究列表
              </Link>
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

  /**
   * The copy lineage entry for whatever source the detail column is showing.
   * A source that was created here has no entry, and the detail panel then
   * shows no copy block at all — absence is the honest answer for a source
   * that was not copied.
   */
  const detailCopy = context?.source ? copyLineage[context.source.id] : undefined;

  const tabs = (
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
  );

  // Reading a stored page is a surface of its own, not a column: it gets the
  // full width so long text is not squeezed, and it keeps the tab bar so the
  // way back is always visible.
  if (panel === "reader") {
    return (
      <>
        {tabs}
        <div className="research-body" data-testid="research-body" data-mode="reader">
          {readerSourceId ? (
            <SourceReader
              sessionId={sessionId}
              sourceId={readerSourceId}
              claims={workspace.claims}
              defaultClaimId={selectedClaimId}
              canEdit={canEdit}
              onClose={() => setPanel(selectedEvidenceId ? "detail" : "content")}
              onChanged={async () => {
                await reload();
                await refreshHistory();
              }}
              onOpenEvidence={(evidenceId) => {
                setSelectedEvidenceId(evidenceId);
                setPanel("detail");
              }}
            />
          ) : (
            <div className="research-column">
              <section className="research-panel">
                <p className="research-muted">
                  还没有选择要阅读的来源。可以先在「研究内容」里导入网页，或从某条证据的
                  「来源详情」中点「阅读保存的原文」。
                </p>
              </section>
            </div>
          )}
        </div>
      </>
    );
  }

  // Candidate review gets its own full-width surface for the same reason the
  // reader does: comparing a candidate against the page text it came from is
  // not something to do in a narrow column.
  if (panel === "analyze") {
    return (
      <>
        {tabs}
        <div
          className="research-body"
          data-testid="research-body"
          data-mode="analyze"
        >
          {analyzeSourceId ? (
            <ClaimCandidatesPanel
              sessionId={sessionId}
              sourceId={analyzeSourceId}
              sourceTitle={
                workspace.sources.find((source) => source.id === analyzeSourceId)
                  ?.title ?? ""
              }
              claims={workspace.claims.map((claim) => ({
                id: claim.id,
                statement: claim.statement
              }))}
              canEdit={canEdit}
              onClose={() => setPanel("content")}
              onChanged={async () => {
                await reload();
                await refreshHistory();
              }}
            />
          ) : (
            <div className="research-column">
              <section className="research-panel">
                <p className="research-muted">
                  还没有选择要分析的来源。先在「研究内容」里导入网页，再从导入结果中点
                  「AI 拆解候选主张」。
                </p>
              </section>
            </div>
          )}
        </div>
      </>
    );
  }

  // Citation review also gets the full width: each row carries the quote, the
  // source context, and two independent states, which is too much for a column.
  if (panel === "citations") {
    return (
      <>
        {tabs}
        <div
          className="research-body"
          data-testid="research-body"
          data-mode="analyze"
        >
          <div className="research-column">
            <CitationReviewPanel
              sessionId={sessionId}
              evidence={workspace.evidence}
              claims={workspace.claims.map((claim) => ({
                id: claim.id,
                statement: claim.statement
              }))}
              sourcesById={new Map(
                workspace.sources.map((source) => [
                  source.id,
                  { id: source.id, title: source.title }
                ])
              )}
              canEdit={canEdit}
              onChanged={async () => {
                await reload();
                await refreshHistory();
              }}
            />
          </div>
        </div>
      </>
    );
  }

  // Source independence also gets the full width: each source carries a
  // profile, its relations and the counts, which needs room to read.
  if (panel === "independence") {
    return (
      <>
        {tabs}
        <div
          className="research-body"
          data-testid="research-body"
          data-mode="analyze"
        >
          <div className="research-column">
            <SourceIndependencePanel
              sessionId={sessionId}
              canEdit={canEdit}
              onChanged={async () => {
                await reload();
                await refreshHistory();
              }}
            />
          </div>
        </div>
      </>
    );
  }

  // 研究计划 also gets the full width: each item carries its query, its
  // lifecycle and its reason, which needs room to read.
  if (panel === "plan") {
    return (
      <>
        {tabs}
        <div
          className="research-body"
          data-testid="research-body"
          data-mode="analyze"
        >
          <div className="research-column">
            <ResearchPlanPanel
              sessionId={sessionId}
              canEdit={canEdit}
              onChanged={async () => {
                await reload();
                await refreshHistory();
              }}
            />
          </div>
        </div>
      </>
    );
  }

  /**
   * 研究质量 also gets the full width: the overview, the six dimensions and
   * the findings list are read top-down, and a column would force a reader to
   * scroll past the claim rail to follow one sentence.
   */
  if (panel === "quality") {
    return (
      <>
        {tabs}
        <div
          className="research-body"
          data-testid="research-body"
          data-mode="analyze"
        >
          <div className="research-column">
            <ResearchQualityPanel
              sessionId={sessionId}
              navigation={{
                onOpenClaim: (claimId) => {
                  setSelectedClaimId(claimId);
                  setPanel("review");
                },
                onOpenEvidence: (evidenceId) => {
                  setSelectedEvidenceId(evidenceId);
                  setPanel("detail");
                },
                onOpenSource: () => setPanel("independence"),
                onOpenReader: (sourceId) => {
                  setReaderSourceId(sourceId);
                  setPanel("reader");
                },
                onOpenPlan: () => setPanel("plan")
              }}
            />
          </div>
        </div>
      </>
    );
  }

  /**
   * Local files get the full width too: importing several documents and reading
   * their outcome side by side does not work in a column, and a table needs the
   * room even more than prose does.
   */
  if (panel === "files") {
    return (
      <>
        {tabs}
        <div
          className="research-body"
          data-testid="research-body"
          data-mode="analyze"
        >
          <FileImportPanel
            sessionId={sessionId}
            canEdit={canEdit}
            onOpenFile={(file) => {
              setReaderFileId(file.id);
              setPanel("filereader");
            }}
            onChanged={async () => {
              await reload();
              await refreshHistory();
            }}
          />
        </div>
      </>
    );
  }

  if (panel === "filereader") {
    return (
      <>
        {tabs}
        <div
          className="research-body"
          data-testid="research-body"
          data-mode="reader"
        >
          {readerFileId ? (
            <FileReader
              sessionId={sessionId}
              fileId={readerFileId}
              claims={workspace.claims}
              defaultClaimId={selectedClaimId}
              canEdit={canEdit}
              onClose={() => setPanel("files")}
              onChanged={async () => {
                await reload();
                await refreshHistory();
              }}
            />
          ) : (
            <div className="research-column">
              <section className="research-panel">
                <p className="research-muted">
                  还没有选择要阅读的文件。先在「文件导入」里上传，再点该文件的「打开阅读」。
                </p>
              </section>
            </div>
          )}
        </div>
      </>
    );
  }

  // 证据地图 gets the full width for the same reason: a graph needs room to
  // be read, and the detail panel sits beside it on wide screens.
  if (panel === "map") {
    return (
      <>
        {tabs}
        <div
          className="research-body"
          data-testid="research-body"
          data-mode="analyze"
        >
          <div className="research-column">
            <EvidenceMapPanel sessionId={sessionId} />
          </div>
        </div>
      </>
    );
  }

  // The Agent Operations Center gets the full width: the run list and the
  // run detail sit in a responsive grid that collapses to one column on mobile.
  if (panel === "agentops") {
    return (
      <>
        {tabs}
        <div
          className="research-body"
          data-testid="research-body"
          data-mode="analyze"
        >
          <div className="research-column">
            <AgentOpsPanel sessionId={sessionId} canEdit={canEdit} />
          </div>
        </div>
      </>
    );
  }

  /**
   * 资料库 gets the full width: it is a search-and-browse surface with its own
   * two columns (filters and visible researches on the left, results and the
   * sharing table on the right), so it cannot live in the claim rail's column.
   */
  if (panel === "library") {
    return (
      <>
        {tabs}
        <div
          className="research-body"
          data-testid="research-body"
          data-mode="analyze"
        >
          <SourceLibraryPanel
            currentSessionId={sessionId}
            canEdit={canEdit}
            onChanged={async () => {
              await reload();
              await refreshHistory();
            }}
          />
        </div>
      </>
    );
  }

  // The team collaboration surface gets the full width: it carries its own
  // member/work/comment/review/activity tabs, so it cannot sit in the claim
  // rail's column.
  if (panel === "collaboration") {
    return (
      <>
        {tabs}
        <div
          className="research-body"
          data-testid="research-body"
          data-mode="analyze"
        >
          <CollaborationPanel
            sessionId={sessionId}
            canEdit={canEdit}
            onChanged={async () => {
              await reload();
              await refreshHistory();
            }}
          />
        </div>
      </>
    );
  }

  return (
    <>
      {tabs}

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
                    // 只关闭「发起提交的那个表单」：提交是异步的（含一次 reload），
                    // 期间用户可能已打开另一个表单；无条件 setOpenForm("none") 会把后者一并关掉。
                    if (ok) setOpenForm((current) => (current === "claim" ? "none" : current));
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
                      setOpenForm(openForm === "import" ? "none" : "import")
                    }
                  >
                    {openForm === "import" ? "收起导入" : "导入网页"}
                  </button>
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

              {openForm === "import" ? (
                <ImportSourceForm
                  busy={importBusy}
                  error={importError}
                  onSubmit={(commands) => void submitImport(commands)}
                />
              ) : null}

              {importRows ? (
                <div
                  className="research-panel"
                  data-testid="import-source-result"
                  style={{ marginTop: 8, marginBottom: 8 }}
                >
                  <div className="research-panel-head">
                    <span className="research-panel-title">导入结果</span>
                    <div className="research-actions">
                      <span className="research-muted">
                        {importRows.filter((row) => row.state === "done").length} 个成功 ·{" "}
                        {importRows.filter((row) => row.state === "failed").length} 个失败
                      </span>
                      <button
                        type="button"
                        className="research-button research-button-secondary"
                        onClick={() => setImportRows(null)}
                      >
                        关闭结果
                      </button>
                    </div>
                  </div>
                  <ul className="research-plain-list" data-testid="import-source-rows">
                    {importRows.map((row, index) => {
                      // Bound to a const so the "read the stored text" button can
                      // capture this row's source without a non-null assertion.
                      const result = row.result;
                      return (
                        <li
                          key={`${row.url}-${index}`}
                          className="research-challenge"
                          data-import-state={row.state}
                        >
                          <div className="research-claim-meta">
                            <StatusPill tone={sourceImportStateTone(row.state)}>
                              {sourceImportStateLabel(row.state)}
                            </StatusPill>
                            {result ? (
                              <>
                                <StatusPill
                                  tone={sourceRetrievalTone(
                                    result.source.retrievalStatus
                                  )}
                                >
                                  {sourceRetrievalLabel(result.source.retrievalStatus)}
                                </StatusPill>
                                <StatusPill tone="research-pill-neutral">
                                  {result.reused ? "复用已有来源" : "新建来源"}
                                </StatusPill>
                                {result.versionCreated ? (
                                  <StatusPill tone="research-pill-neutral">
                                    新建内容版本
                                  </StatusPill>
                                ) : null}
                                {result.truncated ? (
                                  <StatusPill tone="research-pill-unverified">
                                    正文已截断
                                  </StatusPill>
                                ) : null}
                              </>
                            ) : null}
                          </div>
                          <div
                            className="research-muted"
                            style={{ overflowWrap: "anywhere" }}
                          >
                            {row.url}
                          </div>
                          {result ? (
                            <>
                              <div>
                                <strong>{result.source.title}</strong>
                              </div>
                              <div
                                className="research-muted"
                                style={{ overflowWrap: "anywhere" }}
                              >
                                最终地址：{result.finalUrl}
                              </div>
                              {result.redirects.length > 0 ? (
                                <div
                                  className="research-muted"
                                  style={{ overflowWrap: "anywhere" }}
                                >
                                  跳转：{result.redirects.join(" → ")}
                                </div>
                              ) : null}
                              <div
                                className="research-muted"
                                style={{ overflowWrap: "anywhere" }}
                              >
                                内容哈希：{result.source.contentHash ?? "—"} · 抓取时间：
                                {formatDate(result.source.retrievedAt)}
                              </div>
                              <button
                                type="button"
                                className="research-button research-button-secondary"
                                onClick={() => {
                                  setReaderSourceId(result.source.id);
                                  setPanel("reader");
                                }}
                              >
                                阅读保存的原文
                              </button>
                              <button
                                type="button"
                                className="research-button research-button-secondary"
                                onClick={() => {
                                  setAnalyzeSourceId(result.source.id);
                                  setPanel("analyze");
                                }}
                                data-testid="open-analysis"
                              >
                                AI 拆解候选主张
                              </button>
                            </>
                          ) : row.state === "failed" ? (
                            <p className="research-error" role="alert">
                              {row.message}
                            </p>
                          ) : (
                            <p className="research-muted">
                              {row.state === "running"
                                ? "正在抓取，请稍候…"
                                : "排队等待处理…"}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="research-muted" style={{ marginTop: 8 }}>
                    抓取到的是页面正文纯文本，不代表内容已被核实。请进入原文挑出要引用的
                    句子，再登记为引用。失败的地址同样会留下来源记录与失败原因，可在
                    「研究内容」的来源详情里查看。
                  </p>
                </div>
              ) : null}

              {openForm === "source" ? (
                <SourceForm
                  busy={busy}
                  error={error}
                  onSubmit={async (command) => {
                    const ok = await run(
                      () => createSource(sessionId, command),
                      "Create source"
                    );
                    // 见 ClaimForm 上的说明：异步完成后只能关闭来源表单本身。
                    if (ok) setOpenForm((current) => (current === "source" ? "none" : current));
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
                    // 见 ClaimForm 上的说明：异步完成后只能关闭证据表单本身。
                    if (ok) setOpenForm((current) => (current === "evidence" ? "none" : current));
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
                onOpenEvidence={(evidenceId) => {
                  setSelectedEvidenceId(evidenceId);
                  setPanel("detail");
                }}
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
              {...(detailCopy ? { copy: detailCopy } : {})}
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
              onOpenReader={(sourceId) => {
                setReaderSourceId(sourceId);
                setPanel("reader");
              }}
              onOpenAnalysis={(sourceId) => {
                setAnalyzeSourceId(sourceId);
                setPanel("analyze");
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
