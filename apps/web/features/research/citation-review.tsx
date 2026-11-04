"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CitationIntegrityStatus,
  Evidence,
  SupportAssessmentStatus
} from "@nexus/shared";
import {
  assessClaimSupport,
  checkCitations,
  CitationReviewFailedError,
  correctCitation,
  getCitationHistory,
  getCitationReview,
  type CitationIntegrityCheck,
  type ClaimSupportAssessment,
  type ClaimSupportSummary,
  type CitationReviewSnapshot
} from "./api";
import { StatusPill } from "./components";
import {
  citationIntegrityLabel,
  citationIntegrityTone,
  citationMatchKindLabel,
  citationReviewFailureLabel,
  claimSupportSummaryLabel,
  claimSupportSummaryTone,
  directionLabel,
  directionTone,
  formatDate,
  supportAssessmentLabel,
  supportAssessmentTone,
  verificationLabel,
  verificationTone
} from "./labels";

/**
 * Two independent readings of every citation, side by side.
 *
 * Layer A (引用完整性) is answered by the server against stored captures: is the
 * quote still there, in the version it was taken from, complete? Layer B (支持度)
 * is a model-assisted reading of whether the quote bears on the claim at all.
 *
 * The contract this panel holds to:
 *  - the two states are rendered as two separate pills, never merged into one
 *    "citation quality" score, because "the words are on the page" and "the
 *    words support the claim" are different facts;
 *  - an assessment is labelled as advice and is never shown as verification —
 *    the excerpt's own verification pill comes from `evidence` and is untouched
 *    by anything here;
 *  - a fragment the server could not find in the source is marked as unlocated
 *    rather than displayed as a quotation;
 *  - a correction adds a record; the earlier conclusion, its author and its
 *    timestamp stay visible in the history below it.
 */

type Notice = { kind: "info" | "success" | "error"; text: string } | null;

type ClaimLite = { id: string; statement: string };

const INTEGRITY_OPTIONS: readonly CitationIntegrityStatus[] = [
  "anchored",
  "stale",
  "partial",
  "missing",
  "unmapped",
  "unanchored"
];

const SUPPORT_OPTIONS: readonly SupportAssessmentStatus[] = [
  "support",
  "oppose",
  "context",
  "insufficient",
  "ambiguous"
];

/**
 * Built as one list of `{value,label}` so the two status vocabularies stay
 * separate: a correction of an integrity check cannot offer "支持该主张".
 */
function correctionOptions(
  kind: "integrity" | "support"
): Array<{ value: string; label: string }> {
  return kind === "integrity"
    ? INTEGRITY_OPTIONS.map((value) => ({
        value,
        label: citationIntegrityLabel(value)
      }))
    : SUPPORT_OPTIONS.map((value) => ({
        value,
        label: supportAssessmentLabel(value)
      }));
}

export function CitationReviewPanel({
  sessionId,
  evidence,
  claims,
  sourcesById,
  canEdit,
  onChanged,
  navigation
}: {
  sessionId: string;
  evidence: Evidence[];
  claims: ClaimLite[];
  sourcesById: Map<string, { id: string; title: string }>;
  canEdit: boolean;
  onChanged?: () => void | Promise<void>;
  /**
   * Where a reader may go from here.
   *
   * This panel used to be a dead end: it said "this citation no longer resolves"
   * and offered no way to get to the excerpt or the claim it was talking about,
   * so acting on a finding meant going back to the tab bar and hunting through
   * the workspace by title. Optional, because the panel is also rendered on its
   * own in tests and by callers that have nowhere to navigate to.
   */
  navigation?: {
    onOpenEvidence?: (evidenceId: string) => void;
    onOpenClaim?: (claimId: string) => void;
  };
}) {
  const [snapshot, setSnapshot] = useState<CitationReviewSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [assessingClaimId, setAssessingClaimId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [failure, setFailure] = useState<{ text: string } | null>(null);
  const [openContext, setOpenContext] = useState<string | null>(null);
  const [historyByKey, setHistoryByKey] = useState<
    Record<string, Array<CitationIntegrityCheck | ClaimSupportAssessment>>
  >({});
  const [correction, setCorrection] = useState<{
    kind: "integrity" | "support";
    targetId: string;
    status: string;
    rationale: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await getCitationReview(sessionId);
      setSnapshot(result);
    } catch (error) {
      setNotice({
        kind: "error",
        text:
          error instanceof Error
            ? `读取引用核查结果失败：${error.message}`
            : "读取引用核查结果失败"
      });
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const checksByEvidence = useMemo(() => {
    const map = new Map<string, CitationIntegrityCheck>();
    for (const check of snapshot?.checks ?? []) {
      map.set(check.evidenceId, check);
    }
    return map;
  }, [snapshot]);

  const assessmentsByEvidence = useMemo(() => {
    const map = new Map<string, ClaimSupportAssessment[]>();
    for (const item of snapshot?.assessments ?? []) {
      const list = map.get(item.evidenceId) ?? [];
      list.push(item);
      map.set(item.evidenceId, list);
    }
    return map;
  }, [snapshot]);

  const summaryByClaim = useMemo(() => {
    const map = new Map<string, ClaimSupportSummary>();
    for (const item of snapshot?.summaries ?? []) {
      map.set(item.claimId, item);
    }
    return map;
  }, [snapshot]);

  const claimsById = useMemo(
    () => new Map(claims.map((claim) => [claim.id, claim])),
    [claims]
  );

  async function runCheck() {
    setChecking(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = await checkCitations(sessionId);
      setSnapshot((current) => ({
        checks: result.checks,
        assessments: current?.assessments ?? [],
        summaries: current?.summaries ?? []
      }));
      setNotice({
        kind: "success",
        text: `已核查 ${result.checks.length} 条引用的完整性。`
      });
      await onChanged?.();
    } catch (error) {
      const message =
        error instanceof CitationReviewFailedError
          ? `${citationReviewFailureLabel(error.code)}：${
              error.message
            }`
          : error instanceof Error
            ? error.message
            : "核查失败";
      setFailure({ text: message });
    } finally {
      setChecking(false);
    }
  }

  async function runAssessment(claimId: string) {
    setAssessingClaimId(claimId);
    setFailure(null);
    try {
      const result = await assessClaimSupport(sessionId, claimId);
      setSnapshot((current) => ({
        checks: current?.checks ?? [],
        assessments: [
          ...(current?.assessments ?? []).filter(
            (item) => item.claimId !== claimId
          ),
          ...result.assessments
        ],
        summaries: [
          ...(current?.summaries ?? []).filter(
            (item) => item.claimId !== claimId
          ),
          result.summary
        ]
      }));
      setNotice({
        kind: "success",
        text: `已评估 ${result.assessments.length} 条摘录与该主张的关系（汇总：${claimSupportSummaryLabel(result.summary.status)}）。`
      });
      await onChanged?.();
    } catch (error) {
      const message =
        error instanceof CitationReviewFailedError
          ? `${citationReviewFailureLabel(error.code)}：${
              error.message
            }`
          : error instanceof Error
            ? error.message
            : "评估失败";
      setFailure({ text: message });
    } finally {
      setAssessingClaimId(null);
    }
  }

  async function showHistory(
    key: string,
    input: { kind: "integrity"; evidenceId: string } | {
      kind: "support";
      claimId: string;
      evidenceId: string;
    }
  ) {
    try {
      const result = await getCitationHistory(sessionId, input);
      setHistoryByKey((current) => ({ ...current, [key]: result.items }));
    } catch (error) {
      setNotice({
        kind: "error",
        text:
          error instanceof Error
            ? `读取历史失败：${error.message}`
            : "读取历史失败"
      });
    }
  }

  async function submitCorrection() {
    if (!correction) return;
    if (correction.rationale.trim().length < 10) {
      setNotice({ kind: "error", text: "纠正理由至少 10 个字，否则不可追溯。" });
      return;
    }
    try {
      await correctCitation(sessionId, {
        kind: correction.kind,
        targetId: correction.targetId,
        status: correction.status,
        rationale: correction.rationale.trim()
      });
      setNotice({
        kind: "success",
        text: "已记录人工纠正；原结论保留在历史中。"
      });
      setCorrection(null);
      await load();
      await onChanged?.();
    } catch (error) {
      setNotice({
        kind: "error",
        text:
          error instanceof CitationReviewFailedError
            ? `${citationReviewFailureLabel(error.code)}：${error.message}`
            : error instanceof Error
              ? error.message
              : "纠正失败"
      });
    }
  }

  const checkedCount = snapshot?.checks.length ?? 0;

  return (
    <div
      data-testid="citation-review"
      style={{ display: "grid", gap: 16 }}
    >
      <section className="research-panel">
        <header className="research-panel-head">
          <div>
            <h3>引用完整性核查（确定性）</h3>
            <p className="research-muted">
              服务端把每条摘录拿去和已保存的快照逐字比对：是否存在、是否完整连续、
              锚定版本与当前版本是否一致。这一步不用模型，因此无法被文档内容影响。
            </p>
          </div>
          {canEdit ? (
            <button
              type="button"
              className="research-button"
              data-testid="check-citations"
              onClick={() => void runCheck()}
              disabled={checking || evidence.length === 0}
            >
              {checking ? "核查中…" : checkedCount > 0 ? "重新核查" : "核查引用完整性"}
            </button>
          ) : null}
        </header>

        {checking ? (
          <div
            className="research-muted"
            data-testid="citation-progress"
            role="status"
          >
            正在核对 {evidence.length} 条摘录与已保存快照…
          </div>
        ) : null}

        {failure ? (
          <div
            className="research-error"
            data-testid="citation-error"
            role="alert"
          >
            <span>{failure.text}</span>
            {canEdit ? (
              <button
                type="button"
                className="research-button"
                data-testid="retry-citation"
                onClick={() => void runCheck()}
              >
                重试核查
              </button>
            ) : null}
          </div>
        ) : null}

        <p className="research-muted" data-testid="citation-check-summary">
          已核查 {checkedCount} / {evidence.length} 条摘录
          {checkedCount > 0
            ? ` · 可定位 ${snapshot?.checks.filter((item) => item.status === "anchored").length ?? 0} · 版本已变 ${snapshot?.checks.filter((item) => item.status === "stale").length ?? 0} · 不完整 ${snapshot?.checks.filter((item) => item.status === "partial").length ?? 0} · 找不到 ${snapshot?.checks.filter((item) => item.status === "missing").length ?? 0}`
            : ""}
        </p>
      </section>

      <section className="research-panel">
        <header className="research-panel-head">
          <div>
            <h3>Claim 与摘录的支持度对照（模型辅助）</h3>
            <p className="research-muted">
              这是辅助评估，不是核实结论：它不会把任何摘录标记为已核实，也不参与
              ClaimVerdict 统计。正反并存时输出「冲突」，不按条数多数裁决。
            </p>
          </div>
        </header>
        {claims.length === 0 ? (
          <p className="research-muted">还没有主张可以做对照。</p>
        ) : (
          <ul className="research-plain-list" data-testid="support-claim-list">
            {claims.map((claim) => {
              const summary = summaryByClaim.get(claim.id);
              const related = evidence.filter((item) =>
                item.claimIds.includes(claim.id)
              );
              return (
                <li key={claim.id}>
                  <div className="research-claim-meta">
                    <strong>{claim.statement}</strong>
                  </div>
                  <div className="research-actions">
                    <StatusPill
                      tone={claimSupportSummaryTone(summary?.status)}
                    >
                      <span data-testid={`support-summary-${claim.id}`}>
                        {claimSupportSummaryLabel(summary?.status)}
                      </span>
                    </StatusPill>
                    <span className="research-muted">
                      {related.length} 条关联摘录
                    </span>
                    {canEdit ? (
                      <button
                        type="button"
                        className="research-button"
                        data-testid={`assess-support-${claim.id}`}
                        onClick={() => void runAssessment(claim.id)}
                        disabled={
                          assessingClaimId === claim.id || related.length === 0
                        }
                      >
                        {assessingClaimId === claim.id
                          ? "评估中…"
                          : summary
                            ? "重新评估"
                            : "评估支持度"}
                      </button>
                    ) : null}
                  </div>
                  {summary ? (
                    <p className="research-muted" data-testid={`support-note-${claim.id}`}>
                      {summary.note}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="research-panel">
        <header className="research-panel-head">
          <div>
            <h3>逐条引用</h3>
            <p className="research-muted">
              每行显示两个互不相干的状态：引文在原文中是否能定位（左），
              以及该摘录对主张的支持度（右）。核实状态单独显示，不受这两者影响。
            </p>
          </div>
        </header>

        {loading ? (
          <p className="research-muted">正在读取核查结果…</p>
        ) : evidence.length === 0 ? (
          <p className="research-muted" data-testid="citations-empty">
            还没有任何摘录可以核查。
          </p>
        ) : (
          <ul className="research-plain-list" data-testid="citation-list">
            {evidence.map((item) => {
              const check = checksByEvidence.get(item.id);
              const assessments = assessmentsByEvidence.get(item.id) ?? [];
              const source = item.sourceId
                ? sourcesById.get(item.sourceId)
                : undefined;
              const contextOpen = openContext === item.id;
              return (
                <li
                  key={item.id}
                  data-testid="citation-row"
                >
                  <div className="research-claim-meta">
                    <strong>{item.title}</strong>
                    <StatusPill tone={directionTone(item.direction)}>
                      {directionLabel(item.direction)}
                    </StatusPill>
                    <StatusPill tone={verificationTone(item.verificationStatus)}>
                      {verificationLabel(item.verificationStatus)}
                    </StatusPill>
                  </div>
                  <div className="research-excerpt">{item.content}</div>
                  <div className="research-muted">
                    {source ? `来源：${source.title}` : "来源：未记录"}
                    {item.locator ? ` · 定位：${item.locator}` : ""}
                  </div>

                  <div className="research-actions">
                    <span
                      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                      data-testid={`integrity-pill-${item.id}`}
                    >
                      <span className="research-muted">原文定位</span>
                      <StatusPill tone={citationIntegrityTone(check?.status)}>
                        {citationIntegrityLabel(check?.status)}
                      </StatusPill>
                    </span>
                    {check?.matchKind ? (
                      <span className="research-muted">
                        {citationMatchKindLabel(check.matchKind)}
                      </span>
                    ) : null}
                    {check && (check.contextText || check.matchedText) ? (
                      <button
                        type="button"
                        className="research-button research-button-secondary"
                        data-testid={`citation-context-${item.id}`}
                        aria-expanded={contextOpen}
                        onClick={() =>
                          setOpenContext(contextOpen ? null : item.id)
                        }
                      >
                        {contextOpen ? "收起快照上下文" : "打开快照上下文"}
                      </button>
                    ) : null}
                    {navigation?.onOpenEvidence ? (
                      <button
                        type="button"
                        className="research-button research-button-secondary"
                        data-testid={`open-evidence-${item.id}`}
                        onClick={() => navigation.onOpenEvidence?.(item.id)}
                      >
                        查看材料详情
                      </button>
                    ) : null}
                  </div>

                  {check ? (
                    <p className="research-muted" data-testid={`integrity-reason-${item.id}`}>
                      核查理由：{check.reason}
                      {check.expectedContentHash && check.snapshotContentHash
                        ? `（锚定版本 ${check.expectedContentHash.slice(0, 8)}… / 当前版本 ${check.snapshotContentHash.slice(0, 8)}…）`
                        : ""}
                    </p>
                  ) : null}

                  {contextOpen && check ? (
                    <dl className="research-deflist">
                      {check.matchedText ? (
                        <div>
                          <dt className="research-label">命中片段</dt>
                          <dd>{check.matchedText}</dd>
                        </div>
                      ) : null}
                      {check.contextText ? (
                        <div>
                          <dt className="research-label">原文上下文</dt>
                          <dd>
                            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 200, overflowY: "auto", margin: 0, padding: 10, borderRadius: 8, background: "var(--wb-surface-subtle, rgba(0,0,0,0.03))", font: "inherit", fontSize: 13 }}>
                              {check.contextText}
                            </pre>
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : null}

                  {assessments.length > 0 ? (
                    <ul className="research-plain-list" data-testid={`assessments-${item.id}`}>
                      {assessments.map((assessment) => {
                        const claim = claimsById.get(assessment.claimId);
                        return (
                          <li key={assessment.id}>
                            <div className="research-actions">
                              <span
                                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                                data-testid={`support-pill-${item.id}`}
                              >
                                <span className="research-muted">
                                  是否支持
                                </span>
                                <StatusPill
                                  tone={supportAssessmentTone(assessment.status)}
                                >
                                  {supportAssessmentLabel(assessment.status)}
                                </StatusPill>
                              </span>
                              <span className="research-muted">
                                {claim
                                  ? claim.statement
                                  : `主张 ${assessment.claimId}`}
                              </span>
                              <span className="research-muted">
                                {assessment.origin === "human"
                                  ? `人工纠正 · ${assessment.actor}`
                                  : `模型 ${assessment.model ?? "—"}`}
                                {assessment.confidence !== null &&
                                assessment.confidence !== undefined
                                  ? ` · 置信 ${assessment.confidence.toFixed(2)}`
                                  : ""}
                              </span>
                            </div>
                            <p className="research-muted">
                              理由：{assessment.rationale}
                            </p>
                            {assessment.matchedExcerpt ? (
                              <p className="research-muted">
                                命中片段：{assessment.matchedExcerpt}
                                {assessment.matchedExcerptLocated
                                  ? "（服务端已在原文中找到）"
                                  : "（服务端未能在原文中找到，不计为支持证据）"}
                              </p>
                            ) : null}
                            {assessment.signals.length > 0 ? (
                              <p className="research-muted">
                                信号：{assessment.signals.join("；")}
                              </p>
                            ) : null}
                            <div className="research-actions">
                              {navigation?.onOpenClaim ? (
                                <button
                                  type="button"
                                  className="research-button research-button-secondary"
                                  data-testid={`open-claim-${assessment.id}`}
                                  onClick={() =>
                                    navigation.onOpenClaim?.(assessment.claimId)
                                  }
                                >
                                  查看主张
                                </button>
                              ) : null}
                              {canEdit ? (
                                <button
                                  type="button"
                                  className="research-button research-button-secondary"
                                  data-testid={`correct-support-${assessment.id}`}
                                  onClick={() =>
                                    setCorrection({
                                      kind: "support",
                                      targetId: assessment.id,
                                      status: assessment.status,
                                      rationale: ""
                                    })
                                  }
                                >
                                  人工纠正
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="research-button research-button-secondary"
                                data-testid={`support-history-${assessment.id}`}
                                onClick={() =>
                                  void showHistory(`support-${assessment.id}`, {
                                    kind: "support",
                                    claimId: assessment.claimId,
                                    evidenceId: item.id
                                  })
                                }
                              >
                                查看历史
                              </button>
                            </div>
                            {historyByKey[`support-${assessment.id}`] ? (
                              <ul className="research-plain-list">
                                {historyByKey[`support-${assessment.id}`]!.map(
                                  (entry) => (
                                    <li
                                      key={entry.id}
                                      className="research-muted"
                                    >
                                      {formatDate(entry.createdAt)} ·{" "}
                                      {supportAssessmentLabel(
                                        (entry as ClaimSupportAssessment).status
                                      )}{" "}
                                      · {entry.actor} ·{" "}
                                      {(entry as ClaimSupportAssessment).origin ===
                                      "human"
                                        ? "人工纠正"
                                        : "模型评估"}
                                    </li>
                                  )
                                )}
                              </ul>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}

                  <div className="research-actions">
                    {canEdit && check ? (
                      <button
                        type="button"
                        className="research-button research-button-secondary"
                        data-testid={`correct-integrity-${item.id}`}
                        onClick={() =>
                          setCorrection({
                            kind: "integrity",
                            targetId: check.id,
                            status: check.status,
                            rationale: ""
                          })
                        }
                      >
                        人工纠正定位结论
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="research-button research-button-secondary"
                      data-testid={`integrity-history-${item.id}`}
                      onClick={() =>
                        void showHistory(`integrity-${item.id}`, {
                          kind: "integrity",
                          evidenceId: item.id
                        })
                      }
                    >
                      查看历史
                    </button>
                  </div>

                  {historyByKey[`integrity-${item.id}`] ? (
                    <ul className="research-plain-list">
                      {historyByKey[`integrity-${item.id}`]!.map((entry) => (
                        <li key={entry.id} className="research-muted">
                          {formatDate(entry.createdAt)} ·{" "}
                          {citationIntegrityLabel(
                            (entry as CitationIntegrityCheck).status
                          )}{" "}
                          · {entry.actor} ·{" "}
                          {(entry as CitationIntegrityCheck).origin === "human"
                            ? "人工纠正"
                            : "系统核查"}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {correction ? (
        <section className="research-panel" data-testid="correction-form">
          <header className="research-panel-head">
            <div>
              <h3>
                {correction.kind === "integrity"
                  ? "人工纠正：引用完整性结论"
                  : "人工纠正：支持度结论"}
              </h3>
              <p className="research-muted">
                原结论不会被改写：系统会新增一条记录并指向被纠正的那条，
                同时留下操作人、时间和理由。
              </p>
            </div>
          </header>
          <label className="research-field">
            <span>纠正后的状态</span>
            <select
              value={correction.status}
              data-testid="correction-status"
              onChange={(event) =>
                setCorrection({ ...correction, status: event.target.value })
              }
            >
              {correctionOptions(correction.kind).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="research-field">
            <span>纠正理由（至少 10 个字）</span>
            <textarea
              rows={3}
              value={correction.rationale}
              data-testid="correction-rationale"
              onChange={(event) =>
                setCorrection({ ...correction, rationale: event.target.value })
              }
            />
          </label>
          <div className="research-actions">
            <button
              type="button"
              className="research-button"
              data-testid="correction-submit"
              onClick={() => void submitCorrection()}
            >
              提交纠正
            </button>
            <button
              type="button"
              className="research-button research-button-secondary"
              onClick={() => setCorrection(null)}
            >
              取消
            </button>
          </div>
        </section>
      ) : null}

      {notice ? (
        <p
          className={
            notice.kind === "error"
              ? "research-error"
              : "research-panel-notice"
          }
          data-testid="citation-notice"
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
