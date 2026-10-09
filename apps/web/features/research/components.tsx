"use client";

import { useState, type ReactNode } from "react";
import type {
  AgentRun,
  Challenge,
  Claim,
  ClaimReview,
  ClaimVerdict,
  Conflict,
  Evidence,
  Source
} from "@nexus/shared";
import {
  challengeStatusLabel,
  challengeStatusTone,
  challengeTypeLabel,
  claimStatusLabel,
  directionLabel,
  directionTone,
  evidenceKindLabel,
  formatDate,
  resolutionStrategyLabel,
  reviewOutcomeLabel,
  reviewOutcomeTone,
  runPurposeLabel,
  runStatusLabel,
  runStatusTone,
  sourceKindLabel,
  verificationLabel,
  verificationTone,
  verdictLabel,
  verdictTone
} from "./labels";

export function StatusPill({
  tone,
  children
}: {
  tone: string;
  children: ReactNode;
}) {
  return <span className={`research-pill ${tone}`}>{children}</span>;
}

/**
 * The fact-check verdict is shown next to the claim's own business status and
 * the workflow phase, because they answer different questions.
 *
 * The derived status and the human-adjusted status are both shown: a person's
 * ruling is never allowed to quietly replace what the evidence supports.
 */
export function VerdictCard({
  verdict,
  claimStatus,
  title = "事实核查结论",
  scope = "verdict"
}: {
  verdict: ClaimVerdict;
  claimStatus: string;
  /** Heading text; the review center labels it as the current conclusion. */
  title?: string;
  /** Namespace for the test ids, so two cards on one page stay distinguishable. */
  scope?: string;
}) {
  const percent = Math.round(verdict.confidence * 100);
  const overridden = verdict.effectiveStatus !== verdict.status;

  return (
    <div className="research-verdict" data-testid={`${scope}-card`}>
      <div style={{ flex: 1 }}>
        <div className="research-verdict-status">
          {title}：{verdictLabel(verdict.status)}
        </div>
        {overridden ? (
          <div
            className="research-verdict-status"
            data-testid={`${scope}-effective-status`}
          >
            对外结论：{verdictLabel(verdict.effectiveStatus)}
            <span className="research-muted">
              （人工裁定后的结论；证据推导结论保持不变）
            </span>
          </div>
        ) : null}
        <div className="research-verdict-rationale">{verdict.rationale}</div>
        <div className="research-muted" style={{ marginTop: 4 }}>
          主张状态：{claimStatus}
        </div>
        <div className="research-meter" style={{ marginTop: 6 }}>
          <span
            className="research-meter-fill"
            style={{ width: `${percent}%` }}
            role="img"
            aria-label={`结论把握度 ${percent}%，不代表确定性`}
          />
        </div>
        <div className="research-muted">
          把握度 {percent}%（已核实 {verdict.counts.verified} /
          待核实 {verdict.counts.unverified} /
          已驳回 {verdict.counts.rejected}
          {verdict.counts.expired > 0
            ? ` / 超出有效期 ${verdict.counts.expired}`
            : ""}
          {verdict.counts.notYetEffective > 0
            ? ` / 未生效 ${verdict.counts.notYetEffective}`
            : ""}）
        </div>

        {verdict.openQuestions.length > 0 ? (
          <div style={{ marginTop: 8 }}>
            <div className="research-label">交叉审查未解决的问题</div>
            <ul className="research-plain-list">
              {verdict.openQuestions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {verdict.limits.length > 0 ? (
          <div style={{ marginTop: 8 }}>
            <div className="research-label">适用范围与时间范围</div>
            <ul className="research-plain-list">
              {verdict.limits.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {verdict.review ? (
          <div style={{ marginTop: 8 }} data-testid="verdict-review">
            <div className="research-label">最新人工裁定</div>
            <div className="research-muted">
              {reviewOutcomeLabel(verdict.review.outcome)} ·{" "}
              {verdict.review.reviewer} · {formatDate(verdict.review.createdAt)}
            </div>
            <div className="research-muted">{verdict.review.rationale}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Cross-examination context for one claim: who examined it, whether the run
 * succeeded, what the challenger asked, and what of that is really registered
 * as evidence. Nothing here is invented — a demand that matches no registered
 * excerpt is labelled as such.
 */
export function CrossReviewPanel({
  runs,
  challenges,
  claimId,
  canRun,
  running,
  error,
  onRun
}: {
  runs: AgentRun[];
  challenges: Challenge[];
  claimId: string;
  canRun: boolean;
  running: boolean;
  error: string | null;
  onRun: () => void;
}) {
  const claimChallenges = challenges.filter(
    (challenge) => challenge.targetClaimId === claimId
  );
  const unresolved = claimChallenges.filter(
    (challenge) => challenge.status !== "resolved"
  );

  return (
    <div className="research-column" data-testid="cross-review-panel">
      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">
            交叉审查（{claimChallenges.length} 项质询）
          </span>
          {canRun ? (
            <button
              type="button"
              className="research-button"
              disabled={running}
              onClick={onRun}
            >
              {running ? "审查中…" : "发起交叉审查"}
            </button>
          ) : (
            <span className="research-muted">只读</span>
          )}
        </div>
        {!canRun ? (
          <p className="research-muted">
            当前角色只能查看审查记录，不能发起新的交叉审查。
          </p>
        ) : null}
        {error ? (
          <p className="research-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="research-muted">
          交叉审查复用现有 Agent 执行链路，每次都会产生真实的 Agent 运行记录。
          {unresolved.length > 0
            ? ` 当前有 ${unresolved.length} 项质询尚未解决，结论因此保持不确定。`
            : " 当前没有未解决的质询。"}
        </p>
      </section>

      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">
            运行记录（{runs.length}）
          </span>
        </div>
        {runs.length === 0 ? (
          <div className="research-empty">
            还没有针对该主张的交叉审查运行记录。
          </div>
        ) : (
          <table className="research-table" data-testid="cross-review-runs">
            <thead>
              <tr>
                <th scope="col">用途</th>
                <th scope="col">角色</th>
                <th scope="col">状态</th>
                <th scope="col">开始</th>
                <th scope="col">失败原因</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td className="research-muted">{runPurposeLabel(run.purpose)}</td>
                  <td className="research-muted">{run.roleId.slice(0, 8)}</td>
                  <td>
                    <StatusPill tone={runStatusTone(run.status)}>
                      {runStatusLabel(run.status)}
                    </StatusPill>
                  </td>
                  <td className="research-muted">{formatDate(run.startedAt)}</td>
                  <td className="research-muted">{run.error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">质询与挑战</span>
        </div>
        {claimChallenges.length === 0 ? (
          <div className="research-empty">还没有质询记录。</div>
        ) : (
          <ul className="research-plain-list" data-testid="challenge-list">
            {claimChallenges.map((challenge) => (
              <li key={challenge.id} className="research-challenge">
                <div className="research-claim-meta">
                  <StatusPill tone={challengeStatusTone(challenge.status)}>
                    {challengeStatusLabel(challenge.status)}
                  </StatusPill>
                  <StatusPill tone="research-pill-neutral">
                    {challengeTypeLabel(challenge.type)}
                  </StatusPill>
                  <span className="research-muted">
                    严重度 {challenge.severity} ·{" "}
                    {resolutionStrategyLabel(challenge.resolutionStrategy)}
                  </span>
                </div>
                <div>{challenge.question}</div>
                <div className="research-muted">
                  挑战者要求的证据（挑战者自述，未登记为证据）：
                  {challenge.requiredEvidence.join("；")}
                </div>
                {challenge.responseClaimId ? (
                  <div className="research-muted">
                    已产生修订主张（revises{" "}
                    {challenge.responseClaimId.slice(0, 8)}）
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * The human checkpoint for one claim. Rulings are append-only: the form adds a
 * new ruling and every earlier one stays visible below it.
 */
export function ReviewPanel({
  verdict,
  reviews,
  canReview,
  busy,
  error,
  onSubmit
}: {
  verdict: ClaimVerdict;
  reviews: ClaimReview[];
  canReview: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: (
    outcome: "confirmed" | "rejected" | "needs_more_evidence",
    rationale: string
  ) => void;
}) {
  const [outcome, setOutcome] = useState<
    "confirmed" | "rejected" | "needs_more_evidence"
  >("confirmed");
  const [rationale, setRationale] = useState("");

  const options: Array<{
    value: "confirmed" | "rejected" | "needs_more_evidence";
    label: string;
    hint: string;
  }> = [
    {
      value: "confirmed",
      label: "确认结论",
      hint: "接受当前推导结论（不会提升结论强度）"
    },
    {
      value: "rejected",
      label: "否证主张",
      hint: "认为该主张不成立，对外结论变为「有已核实反对证据」"
    },
    {
      value: "needs_more_evidence",
      label: "要求补证据",
      hint: "暂不下结论，对外结论回到「证据不足」"
    }
  ];

  return (
    <div className="research-column" data-testid="review-panel">
      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">人工复核</span>
          <StatusPill tone={verdictTone(verdict.effectiveStatus)}>
            {verdictLabel(verdict.effectiveStatus)}
          </StatusPill>
        </div>
        <p className="research-muted">
          复核裁定会写入独立记录（记录人、时间、理由、依据），不会覆盖证据推导出的结论，
          也不会删除此前的人工裁决。
        </p>
      </section>

      {canReview ? (
        <section className="research-panel">
          <div className="research-panel-head">
            <span className="research-panel-title">记录新裁定</span>
          </div>
          <div className="research-form">
            <div className="research-field">
              <label className="research-label" htmlFor="review-outcome">
                裁定
              </label>
              <select
                id="review-outcome"
                className="research-select"
                value={outcome}
                onChange={(event) =>
                  setOutcome(
                    event.target.value as
                      | "confirmed"
                      | "rejected"
                      | "needs_more_evidence"
                  )
                }
              >
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="research-muted">
                {options.find((option) => option.value === outcome)?.hint}
              </p>
            </div>
            <div className="research-field">
              <label className="research-label" htmlFor="review-rationale">
                裁定理由（必填，至少 10 字，写入审计记录）
              </label>
              <textarea
                id="review-rationale"
                className="research-textarea"
                value={rationale}
                onChange={(event) => setRationale(event.target.value)}
                placeholder="例如：已对照年报第 14 页表格逐字核对，支持该主张。"
              />
            </div>
            <div className="research-actions">
              <button
                type="button"
                className="research-button"
                disabled={busy || rationale.trim().length < 10}
                onClick={() => onSubmit(outcome, rationale)}
              >
                {busy ? "提交中…" : "提交裁定"}
              </button>
            </div>
            {error ? (
              <p className="research-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </section>
      ) : (
        <section className="research-panel">
          <p className="research-muted">
            当前角色只能查看裁定记录，不能提交新的裁定。
          </p>
        </section>
      )}

      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">
            裁定历史（{reviews.length}）
          </span>
        </div>
        {reviews.length === 0 ? (
          <div className="research-empty">还没有人工裁定记录。</div>
        ) : (
          <ul className="research-plain-list" data-testid="review-history">
            {reviews.map((review) => (
              <li key={review.id} className="research-challenge">
                <div className="research-claim-meta">
                  <StatusPill tone={reviewOutcomeTone(review.outcome)}>
                    {reviewOutcomeLabel(review.outcome)}
                  </StatusPill>
                  <span className="research-muted">
                    {review.reviewer} · {formatDate(review.createdAt)}
                  </span>
                </div>
                <div>{review.rationale}</div>
                <div className="research-muted">
                  裁定时的推导结论：{verdictLabel(review.verdictStatusAtReview)}
                  （把握度{" "}
                  {Math.round(review.verdictConfidenceAtReview * 100)}%）
                  {review.evidenceIds.length > 0
                    ? ` · 依据 ${review.evidenceIds.length} 条证据`
                    : ""}
                  {review.sourceIds.length > 0
                    ? ` / ${review.sourceIds.length} 条来源`
                    : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Review Center for one claim. Everything a reviewer needs before ruling sits
 * in one place: the claim in its research scope, the excerpts that support,
 * oppose or merely frame it (with their verification state and source), what
 * cross-examination left open, the derived verdict, unresolved conflicts and
 * the rulings already on record. Actions are the ones the backend really
 * exposes, and they are only offered when the claim has a verdict to rule on.
 */
export function ReviewCenter({
  claim,
  verdict,
  supporting,
  opposing,
  context,
  excluded,
  conflicts,
  runs,
  challenges,
  reviews,
  sourcesById,
  canReview,
  busy,
  error,
  onSubmitReview,
  onOpenCrossReview
}: {
  claim: Claim;
  verdict: ClaimVerdict;
  supporting: Evidence[];
  opposing: Evidence[];
  context: Evidence[];
  excluded: Evidence[];
  conflicts: Conflict[];
  runs: AgentRun[];
  challenges: Challenge[];
  reviews: ClaimReview[];
  sourcesById: Map<string, Source>;
  canReview: boolean;
  busy: boolean;
  error: string | null;
  onSubmitReview: (outcome: ClaimReview["outcome"], rationale: string) => void;
  onOpenCrossReview: () => void;
}) {
  const unresolvedConflicts = conflicts.filter(
    (conflict) => conflict.status !== "resolved"
  );
  const failedRuns = runs.filter((run) => run.status === "failed");

  function evidenceRow(item: Evidence) {
    const source = item.sourceId ? sourcesById.get(item.sourceId) : undefined;
    return (
      <li key={item.id} className="research-challenge">
        <div className="research-claim-meta">
          <StatusPill tone={verificationTone(item.verificationStatus)}>
            {verificationLabel(item.verificationStatus)}
          </StatusPill>
          <StatusPill tone={directionTone(item.direction)}>
            {directionLabel(item.direction)}
          </StatusPill>
          <StatusPill tone="research-pill-neutral">
            {evidenceKindLabel(item.kind)}
          </StatusPill>
          <span className="research-muted">
            可靠度 {item.reliability.toFixed(2)}
          </span>
        </div>
        <div>
          <strong>{item.title}</strong>
        </div>
        <div className="research-excerpt">{item.content}</div>
        <div className="research-muted">
          来源：
          {source
            ? `${source.title}${source.publisher ? ` · ${source.publisher}` : ""}`
            : "未登记来源"}
          {item.locator ? ` · 定位 ${item.locator}` : ""}
          {item.sourceRef ? ` · ${item.sourceRef}` : ""}
        </div>
      </li>
    );
  }

  return (
    <div className="research-column" data-testid="review-center">
      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">审核上下文</span>
          <StatusPill tone={verdictTone(verdict.effectiveStatus)}>
            {verdictLabel(verdict.effectiveStatus)}
          </StatusPill>
        </div>
        <p className="research-question">{claim.statement}</p>
        <div className="research-claim-meta" style={{ marginTop: 6 }}>
          <StatusPill tone="research-pill-neutral">
            {claimStatusLabel(claim.status)}
          </StatusPill>
          <span className="research-muted">
            类型 {claim.type} · 立场 {claim.stance} · 重要性 {claim.importance}
          </span>
        </div>
        <div style={{ marginTop: 10 }}>
          <VerdictCard
            verdict={verdict}
            claimStatus={claimStatusLabel(claim.status)}
            title="当前核查结论"
            scope="review-verdict"
          />
        </div>
      </section>

      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">
            证据（支持 {supporting.length} / 反对 {opposing.length} / 背景{" "}
            {context.length}）
          </span>
        </div>
        <div className="research-label">支持该主张</div>
        {supporting.length === 0 ? (
          <p className="research-muted">没有支持该主张的材料。</p>
        ) : (
          <ul className="research-plain-list" data-testid="review-supporting">
            {supporting.map(evidenceRow)}
          </ul>
        )}
        <div className="research-label" style={{ marginTop: 10 }}>
          反对该主张
        </div>
        {opposing.length === 0 ? (
          <p className="research-muted">没有反对该主张的材料。</p>
        ) : (
          <ul className="research-plain-list" data-testid="review-opposing">
            {opposing.map(evidenceRow)}
          </ul>
        )}
        <div className="research-label" style={{ marginTop: 10 }}>
          背景与旁证
        </div>
        {context.length === 0 ? (
          <p className="research-muted">没有背景材料。</p>
        ) : (
          <ul className="research-plain-list" data-testid="review-context">
            {context.map(evidenceRow)}
          </ul>
        )}
        {excluded.length > 0 ? (
          <>
            <div className="research-label" style={{ marginTop: 10 }}>
              未生效 / 已过有效期（不参与结论）
            </div>
            <ul className="research-plain-list" data-testid="review-excluded">
              {excluded.map(evidenceRow)}
            </ul>
          </>
        ) : null}
      </section>

      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">
            交叉审查（{challenges.length} 项质询，
            {verdict.crossReview.unresolved} 项未解决）
          </span>
          <button
            type="button"
            className="research-button research-button-secondary"
            onClick={onOpenCrossReview}
          >
            查看交叉审查
          </button>
        </div>
        <p className="research-muted">
          {runs.length} 次 Agent 运行，其中失败 {failedRuns.length} 次。
          {verdict.crossReview.severeUnresolved > 0
            ? ` 有 ${verdict.crossReview.severeUnresolved} 项高严重度质询仍未解决，结论因此保持不确定。`
            : " 当前没有高严重度未解决质询。"}
        </p>
        {verdict.openQuestions.length > 0 ? (
          <ul className="research-plain-list" data-testid="review-open-questions">
            {verdict.openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        ) : null}
      </section>

      {unresolvedConflicts.length > 0 ? (
        <section className="research-panel">
          <div className="research-panel-head">
            <span className="research-panel-title">
              未解决冲突（{unresolvedConflicts.length}）
            </span>
          </div>
          <ul className="research-plain-list" data-testid="review-conflicts">
            {unresolvedConflicts.map((conflict) => (
              <li key={conflict.id} className="research-challenge">
                <div className="research-claim-meta">
                  <StatusPill tone="research-pill-opposes">
                    严重度 {conflict.severity}
                  </StatusPill>
                  <span className="research-muted">{conflict.status}</span>
                </div>
                <div>{conflict.summary}</div>
                <div className="research-muted">
                  建议：{conflict.resolutionSuggestion}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ReviewPanel
        verdict={verdict}
        reviews={reviews}
        canReview={canReview}
        busy={busy}
        error={error}
        onSubmit={onSubmitReview}
      />
    </div>
  );
}

export function EvidenceTable({
  evidence,
  claimsById,
  sourcesById,
  selectedId,
  onSelect,
  emptyHint
}: {
  evidence: Evidence[];
  claimsById: Map<string, Claim>;
  sourcesById: Map<string, Source>;
  selectedId: string | null;
  onSelect: (evidenceId: string) => void;
  emptyHint: string;
}) {
  if (evidence.length === 0) {
    return <div className="research-empty">{emptyHint}</div>;
  }

  return (
    <table className="research-table" data-testid="evidence-table">
      <caption className="research-muted" style={{ textAlign: "left", paddingBottom: 6 }}>
        共 {evidence.length} 条证据材料；只有「已核实」的材料参与结论。
      </caption>
      <thead>
        <tr>
          <th scope="col">方向</th>
          <th scope="col">材料</th>
          <th scope="col">来源</th>
          <th scope="col">定位</th>
          <th scope="col">可靠性</th>
          <th scope="col">核实</th>
        </tr>
      </thead>
      <tbody>
        {evidence.map((item) => {
          const source = item.sourceId ? sourcesById.get(item.sourceId) : undefined;
          const claimStatements = item.claimIds.map((claimId) => {
            const claim = claimsById.get(claimId);
            return claim ? claim.statement : "（未知主张）";
          });
          return (
            <tr key={item.id} aria-selected={selectedId === item.id}>
              <td>
                <StatusPill tone={directionTone(item.direction)}>
                  {directionLabel(item.direction)}
                </StatusPill>
              </td>
              <td>
                <button
                  type="button"
                  className="research-row-button"
                  onClick={() => onSelect(item.id)}
                  aria-expanded={selectedId === item.id}
                >
                  {item.title}
                </button>
                <div className="research-excerpt">{item.content}</div>
                <div className="research-muted">
                  {evidenceKindLabel(item.kind)}
                  {claimStatements.length > 0
                    ? ` · 关联：${claimStatements.join("；")}`
                    : ""}
                </div>
              </td>
              <td>
                {source ? (
                  <span>{source.title}</span>
                ) : item.sourceRef ? (
                  <a href={item.sourceRef} target="_blank" rel="noreferrer">
                    {item.sourceRef}
                  </a>
                ) : (
                  <span className="research-muted">未记录</span>
                )}
              </td>
              <td className="research-muted">{item.locator ?? "—"}</td>
              <td>{item.reliability.toFixed(2)}</td>
              <td>
                <StatusPill tone={verificationTone(item.verificationStatus)}>
                  {verificationLabel(item.verificationStatus)}
                </StatusPill>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function SourceDetail({
  evidence,
  source,
  claims,
  onVerify,
  verifying,
  error,
  canEdit
}: {
  evidence: Evidence;
  source: Source | null;
  claims: Claim[];
  onVerify: (status: "verified" | "rejected" | "unverified", note: string) => void;
  verifying: boolean;
  error: string | null;
  canEdit: boolean;
}) {
  return (
    <div className="research-column" data-testid="source-detail">
      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">原文摘录</span>
          <StatusPill tone={verificationTone(evidence.verificationStatus)}>
            {verificationLabel(evidence.verificationStatus)}
          </StatusPill>
        </div>
        <blockquote className="research-quote">{evidence.content}</blockquote>
        <p className="research-muted" style={{ marginTop: 8 }}>
          {evidence.description}
        </p>
        {evidence.verifiedBy ? (
          <dl className="research-facts" style={{ marginTop: 10 }}>
            <dt>核实人</dt>
            <dd>{evidence.verifiedBy}</dd>
            <dt>核实时间</dt>
            <dd>{formatDate(evidence.verifiedAt)}</dd>
            <dt>核实理由</dt>
            <dd>{evidence.verificationNote}</dd>
          </dl>
        ) : null}
      </section>

      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">来源详情</span>
          {source ? (
            <StatusPill tone="research-pill-neutral">
              {sourceKindLabel(source.kind)}
            </StatusPill>
          ) : null}
        </div>
        {source ? (
          <>
            <div className="research-source-title">{source.title}</div>
            <dl className="research-facts" style={{ marginTop: 8 }}>
              <dt>发布机构</dt>
              <dd>{source.publisher ?? "—"}</dd>
              <dt>作者</dt>
              <dd>{source.author ?? "—"}</dd>
              <dt>发布日期</dt>
              <dd>{formatDate(source.publishedAt)}</dd>
              <dt>链接</dt>
              <dd>
                {source.url ? (
                  <a href={source.url} target="_blank" rel="noreferrer">
                    {source.url}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
              <dt>备注</dt>
              <dd>{source.note ?? "—"}</dd>
            </dl>
          </>
        ) : (
          <p className="research-muted">
            该材料没有关联来源记录{evidence.sourceRef ? `，仅有链接 ${evidence.sourceRef}` : ""}。
            缺少来源的摘录无法复核。
          </p>
        )}
      </section>

      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">关联主张</span>
          <span className="research-muted">{claims.length} 条</span>
        </div>
        {claims.length === 0 ? (
          <p className="research-muted">尚未关联任何主张。</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {claims.map((claim) => (
              <li key={claim.id} style={{ marginBottom: 4 }}>
                {claim.statement}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canEdit ? (
        <section className="research-panel">
          <div className="research-panel-head">
            <span className="research-panel-title">核实</span>
          </div>
          <VerificationForm
            current={evidence.verificationStatus}
            onSubmit={onVerify}
            busy={verifying}
          />
          {error ? (
            <p className="research-error" style={{ marginTop: 8 }} role="alert">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export function VerificationForm({
  current,
  onSubmit,
  busy
}: {
  current: Evidence["verificationStatus"];
  onSubmit: (status: "verified" | "rejected" | "unverified", note: string) => void;
  busy: boolean;
}) {
  const [note, setNote] = useState("");
  const options: Array<{
    status: "verified" | "rejected" | "unverified";
    label: string;
  }> = [
    { status: "verified", label: "标记为已核实" },
    { status: "rejected", label: "标记为已驳回" },
    { status: "unverified", label: "退回待核实" }
  ];

  return (
    <div className="research-form">
      <div className="research-field">
        <label className="research-label" htmlFor="verification-note">
          核实理由（必填，写入审计记录）
        </label>
        <textarea
          id="verification-note"
          className="research-textarea"
          name="verificationNote"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="例如：与报告第 14 页表格逐字核对一致。"
        />
      </div>
      <div className="research-actions">
        {options
          .filter((option) => option.status !== current)
          .map((option) => (
            <button
              key={option.status}
              type="button"
              className={
                option.status === "verified"
                  ? "research-button"
                  : "research-button research-button-secondary"
              }
              disabled={busy}
              onClick={() => onSubmit(option.status, note)}
            >
              {option.label}
            </button>
          ))}
      </div>
      <p className="research-muted">
        核实人取自当前登录身份，不能由页面指定；模型输出不会自动进入已核实状态。
      </p>
    </div>
  );
}
