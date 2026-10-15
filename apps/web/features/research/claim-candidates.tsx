"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Evidence } from "@nexus/shared";
import {
  acceptClaimCandidate,
  acceptEvidenceCandidate,
  AnalysisFailedError,
  extractClaims,
  getExtractionRun,
  getSourceDetail,
  listExtractionRuns,
  recordCandidateDecisions,
  type ClaimCandidate,
  type ClaimExtractionResult,
  type EvidenceCandidate
} from "./api";
import { StatusPill } from "./components";
import {
  candidateClaimTypeLabel,
  candidateStatusLabel,
  candidateStatusTone,
  directionLabel,
  directionTone,
  extractionFailureLabel,
  extractionRunStatusLabel,
  extractionRunStatusTone,
  formatDate,
  locatorKindLabel,
  locatorStatusLabel,
  locatorStatusTone,
  verificationLabel,
  verificationTone
} from "./labels";

/**
 * Review surface for AI-proposed claims and excerpts.
 *
 * The contract this component holds to:
 *  - a candidate is a proposal, so nothing here counts as material until it is
 *    accepted, and acceptance goes through the same claim and evidence
 *    endpoints every hand-entered record uses;
 *  - an excerpt is shown together with the page text it came from, and whether
 *    the server could actually find it there — not whether the model said it
 *    was there;
 *  - every accepted excerpt is displayed as still `unverified`, because locating
 *    a quote and standing behind it are different acts;
 *  - rejecting writes nothing but the rejection.
 */

type Notice =
  | { kind: "info" | "success" | "error"; text: string }
  | null;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wraps every occurrence of the given phrases in the page text.
 *
 * Whitespace-tolerant on purpose: the stored capture and the candidate's copy of
 * the sentence can differ in runs of spaces and still be the same sentence.
 */
function highlightPhrases(
  text: string,
  phrases: readonly string[]
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const phrase of phrases) {
    const trimmed = phrase.trim();
    if (trimmed.length < 2) continue;
    const pattern = escapeRegExp(trimmed).replace(/\s+/g, "\\s+");
    const regex = new RegExp(pattern, "gi");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
      if (match.index === regex.lastIndex) regex.lastIndex += 1;
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function Highlighted({
  text,
  phrases,
  ...rest
}: {
  text: string;
  phrases: readonly string[];
} & React.HTMLAttributes<HTMLPreElement>) {
  const nodes = useMemo(() => {
    const ranges = highlightPhrases(text, phrases);
    if (ranges.length === 0) return [text];
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    ranges.forEach((range, index) => {
      if (range.start > cursor) parts.push(text.slice(cursor, range.start));
      parts.push(
        <mark
          key={`${range.start}-${index}`}
          style={{ background: "rgba(250, 204, 21, 0.35)", color: "inherit" }}
        >
          {text.slice(range.start, range.end)}
        </mark>
      );
      cursor = range.end;
    });
    if (cursor < text.length) parts.push(text.slice(cursor));
    return parts;
  }, [text, phrases]);
  return <pre {...rest}>{nodes}</pre>;
}

export function ClaimCandidatesPanel({
  sessionId,
  sourceId,
  sourceTitle,
  claims,
  canEdit,
  onClose,
  onChanged
}: {
  sessionId: string;
  sourceId: string;
  sourceTitle: string;
  /** Formal claims, offered when attaching an excerpt to work that already exists. */
  claims: { id: string; statement: string }[];
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const [result, setResult] = useState<ClaimExtractionResult | null>(null);
  const [snapshotContent, setSnapshotContent] = useState<string | null>(null);
  const [snapshotHash, setSnapshotHash] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failureCode, setFailureCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [loaded, setLoaded] = useState(false);

  const loadExisting = useCallback(async () => {
    try {
      const [{ runs }, detail] = await Promise.all([
        listExtractionRuns(sessionId, sourceId),
        getSourceDetail(sessionId, sourceId)
      ]);
      const current =
        detail.snapshots.find(
          (item) => item.id === detail.currentSnapshotId
        ) ?? detail.snapshots[0];
      setSnapshotContent(current?.content ?? "");
      setSnapshotHash(current?.contentHash ?? null);
      const latest = runs[0];
      if (latest) {
        const full = await getExtractionRun(sessionId, latest.id);
        setResult(full);
        setFailureCode(null);
      } else {
        setResult(null);
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法载入分析结果");
    } finally {
      setLoaded(true);
    }
  }, [sessionId, sourceId]);

  useEffect(() => {
    void loadExisting();
  }, [loadExisting]);

  async function runAnalysis() {
    setBusy(true);
    setError(null);
    setFailureCode(null);
    setNotice(null);
    setPhase("正在读取保存的原文并分析…");
    try {
      const next = await extractClaims(sessionId, sourceId);
      setResult(next);
      setSelected(new Set());
      setDrafts({});
      setNotice(
        next.reused
          ? {
              kind: "info",
              text: "这条资料已经在同样的原文版本上分析过，直接复用了上次的结果，没有重复写入。"
            }
          : {
              kind: "info",
              text: `已生成 ${next.claimCandidates.length} 条候选主张、${next.evidenceCandidates.length} 条候选摘录，其中 ${next.run.anchorMatched} 条摘录能在原文中定位。`
            }
      );
      await loadExisting();
      await onChanged();
    } catch (cause) {
      if (cause instanceof AnalysisFailedError) {
        setError(cause.message);
        setFailureCode(cause.code ?? null);
      } else {
        setError(cause instanceof Error ? cause.message : "分析失败");
      }
    } finally {
      setPhase(null);
      setBusy(false);
    }
  }

  const pending = useMemo(
    () =>
      (result?.claimCandidates ?? []).filter(
        (candidate) => candidate.status === "proposed"
      ),
    [result]
  );
  const evidenceByClaim = useMemo(() => {
    const map = new Map<string, EvidenceCandidate[]>();
    for (const item of result?.evidenceCandidates ?? []) {
      const list = map.get(item.claimCandidateId) ?? [];
      list.push(item);
      map.set(item.claimCandidateId, list);
    }
    return map;
  }, [result]);

  const allSelected = pending.length > 0 && pending.every((item) => selected.has(item.id));

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((current) =>
      current.size === pending.length ? new Set() : new Set(pending.map((item) => item.id))
    );
  }

  /**
   * Accepts a batch by going through the ordinary domain endpoints.
   *
   * One call per candidate, its idempotency key derived from the candidate id:
   * pressing accept twice replays the first response instead of producing a
   * second claim. The ruling is then recorded, and nothing here ever sets a
   * verification state — what comes back is `unverified` and is shown as such.
   */
  async function acceptBatch(ids: string[]) {
    if (!result) return;
    const decisions: Parameters<typeof recordCandidateDecisions>[2] = [];
    let acceptedClaims = 0;
    let acceptedEvidence = 0;
    const statuses: Evidence["verificationStatus"][] = [];

    for (const id of ids) {
      const candidate = (result.claimCandidates ?? []).find((item) => item.id === id);
      if (!candidate || candidate.status !== "proposed") continue;
      const evidence = (evidenceByClaim.get(id) ?? []).filter(
        (item) => item.status === "proposed"
      );
      try {
        const outcome = await acceptClaimCandidate({
          sessionId,
          candidate,
          statement: (drafts[id] ?? candidate.statement).trim(),
          evidence,
          sourceTitle,
          snapshotHash
        });
        decisions.push({
          candidateId: id,
          kind: "claim",
          status: "accepted",
          createdClaimId: outcome.claimId
        });
        acceptedClaims += 1;
        acceptedEvidence += outcome.evidenceIds.length;
        outcome.evidenceIds.forEach((evidenceId, index) => {
          const item = evidence[index];
          if (!item) return;
          decisions.push({
            candidateId: item.id,
            kind: "evidence",
            status: "accepted",
            createdEvidenceId: evidenceId
          });
        });
        statuses.push(...outcome.verificationStatuses);
      } catch (cause) {
        setNotice({
          kind: "error",
          text: `采纳「${candidate.statement.slice(0, 24)}…」失败：${
            cause instanceof Error ? cause.message : "未知错误"
          }`
        });
      }
    }

    if (decisions.length === 0) return;
    try {
      await recordCandidateDecisions(sessionId, result.run.id, decisions);
    } catch (cause) {
      setNotice({
        kind: "error",
        text: `已采纳但记录决策失败：${
          cause instanceof Error ? cause.message : "未知错误"
        }。请刷新页面查看当前状态。`
      });
    }
    const unverifiedCount = statuses.filter((item) => item === "unverified").length;
    setNotice({
      kind: "success",
      text:
        `已采纳 ${acceptedClaims} 条候选主张、${acceptedEvidence} 条候选摘录。` +
        `全部 ${unverifiedCount} 条新证据仍为「未核实」——核实是独立的动作，请在证据列表或核实工作台中完成。`
    });
    setSelected(new Set());
    await loadExisting();
    await onChanged();
  }

  async function rejectBatch(ids: string[]) {
    if (!result) return;
    const decisions: Parameters<typeof recordCandidateDecisions>[2] = ids.map((id) => ({
      candidateId: id,
      kind: "claim" as const,
      status: "rejected" as const,
      rejectReason: "审阅者认为不构成需要核实的主张"
    }));
    // Rejected excerpts go with their claim, and no claim or evidence row is
    // ever created on this path.
    for (const id of ids) {
      for (const item of evidenceByClaim.get(id) ?? []) {
        if (item.status !== "proposed") continue;
        decisions.push({
          candidateId: item.id,
          kind: "evidence",
          status: "rejected",
          rejectReason: "所属候选主张被拒绝"
        });
      }
    }
    try {
      await recordCandidateDecisions(sessionId, result.run.id, decisions);
      setNotice({
        kind: "info",
        text: `已拒绝 ${ids.length} 条候选主张（及其摘录），没有写入任何主张或证据。`
      });
      setSelected(new Set());
      await loadExisting();
      await onChanged();
    } catch (cause) {
      setNotice({
        kind: "error",
        text: cause instanceof Error ? cause.message : "记录拒绝失败"
      });
    }
  }

  async function saveEdit(candidate: ClaimCandidate) {
    const next = (drafts[candidate.id] ?? candidate.statement).trim();
    if (next.length === 0) {
      setNotice({ kind: "error", text: "主张内容不能为空。" });
      return;
    }
    setDrafts((current) => ({ ...current, [candidate.id]: next }));
    setEditing(null);
  }

  async function attachToExistingClaim(
    candidate: EvidenceCandidate,
    claimId: string
  ) {
    if (!result) return;
    try {
      const outcome = await acceptEvidenceCandidate({
        sessionId,
        claimId,
        candidate,
        sourceTitle,
        snapshotHash
      });
      await recordCandidateDecisions(sessionId, result.run.id, [
        {
          candidateId: candidate.id,
          kind: "evidence",
          status: "accepted",
          createdEvidenceId: outcome.evidenceId
        }
      ]);
      setNotice({
        kind: "success",
        text: `已把这条摘录挂到既有主张上，核实状态为「${verificationLabel(
          outcome.verificationStatus
        )}」。`
      });
      await loadExisting();
      await onChanged();
    } catch (cause) {
      setNotice({
        kind: "error",
        text: cause instanceof Error ? cause.message : "挂载摘录失败"
      });
    }
  }

  const run = result?.run ?? null;

  return (
    <div className="research-column" data-testid="claim-candidates">
      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">AI 辅助 Claim 拆解</span>
          <div className="research-actions">
            {run ? (
              <StatusPill tone={extractionRunStatusTone(run.status)}>
                {extractionRunStatusLabel(run.status)}
              </StatusPill>
            ) : null}
            <button
              type="button"
              className="research-button research-button-secondary"
              onClick={onClose}
            >
              关闭
            </button>
          </div>
        </div>
        <p className="research-question">{sourceTitle}</p>
        <p className="research-muted">
          系统会读取这个来源<strong>已保存的原文快照</strong>，提出候选主张与候选摘录。
          候选不会进入任何结论或统计：它们只是建议，必须逐条确认后才通过既有接口写入，
          写入后<strong>仍然是未核实</strong>，需要走既有的人工核实流程。
        </p>
        {run ? (
          <dl className="research-facts" style={{ marginTop: 8 }}>
            <dt>分析引擎</dt>
            <dd>{`${run.provider} · ${run.model}`}</dd>
            <dt>原文规模</dt>
            <dd>{`${run.charCount} 字 / ${run.segmentCount} 段`}</dd>
            <dt>定位结果</dt>
            <dd>{`能在原文中找到 ${run.anchorMatched} 条，无法定位 ${run.anchorMissing} 条`}</dd>
            <dt>尝试次数</dt>
            <dd>{run.attempt}</dd>
            <dt>分析时间</dt>
            <dd>{formatDate(run.completedAt ?? run.startedAt)}</dd>
          </dl>
        ) : null}
        {run && !isRealModel(run.model) ? (
          <p className="research-muted" data-testid="analysis-provider-note">
            当前运行的是确定性样例引擎（{run.model}），不是真实模型：
            它逐句复制原文、不会凭空编造引文。若要用真实模型验证行为，需配置 LLM 凭据并以
            openai-compatible 模式启动后端（本轮未配置，故真实模型验证为未运行）。
          </p>
        ) : null}
        <div className="research-actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="research-button"
            onClick={() => void runAnalysis()}
            disabled={busy || !canEdit}
            data-testid="analyze-source"
          >
            {result ? "重新分析这份资料" : "分析这份资料"}
          </button>
        </div>
        {phase ? (
          <p className="research-muted" data-testid="analysis-phase" aria-live="polite">
            {phase}
          </p>
        ) : null}
        {busy ? (
          <div
            data-testid="analysis-progress"
            style={{
              height: 4,
              borderRadius: 2,
              background: "var(--wb-surface-subtle, rgba(0,0,0,0.06))",
              overflow: "hidden",
              marginTop: 8
            }}
          >
            <div
              style={{
                width: "40%",
                height: "100%",
                background: "var(--wb-accent, #2563eb)"
              }}
            />
          </div>
        ) : null}
        {!canEdit ? (
          <p className="research-muted">当前账号为只读角色，无法生成或采纳候选。</p>
        ) : null}
        {error ? (
          <div role="alert" style={{ marginTop: 8 }}>
            <p className="research-error" data-testid="analysis-error">
              {failureCode
                ? `${extractionFailureLabel(
                    failureCode as Parameters<typeof extractionFailureLabel>[0]
                  )}：${error}`
                : error}
            </p>
            {failureCode === "timeout" || failureCode === "provider_unavailable" ? (
              <button
                type="button"
                className="research-button research-button-secondary"
                onClick={() => void runAnalysis()}
                disabled={busy}
                data-testid="retry-analysis"
              >
                重试
              </button>
            ) : null}
          </div>
        ) : null}
        {notice ? (
          <p
            className="research-muted"
            role="status"
            data-testid="candidate-notice"
            style={{ marginTop: 8, overflowWrap: "anywhere" }}
          >
            {notice.text}
          </p>
        ) : null}
      </section>

      {loaded && !result && !error ? (
        <section className="research-panel">
          <p className="research-muted">
            还没有对这份资料做过提取。点击上方「分析这份资料」开始。
          </p>
        </section>
      ) : null}

      {result && result.claimCandidates.length === 0 && run?.status === "succeeded" ? (
        <section className="research-panel" data-testid="candidates-empty">
          <p className="research-muted">
            分析完成，但没有从这份原文中提出任何主张。这不是错误——
            页面可能只含有导航或声明性文字，没有可核实的断言。
          </p>
        </section>
      ) : null}

      {result && result.claimCandidates.length > 0 ? (
        <section className="research-panel">
          <div className="research-panel-head">
            <span className="research-panel-title">
              候选主张（{result.claimCandidates.length}）
            </span>
            <span className="research-muted">
              待处理 {pending.length} 条
            </span>
          </div>
          <div className="research-actions" style={{ marginBottom: 8, flexWrap: "wrap" }}>
            <label
              className="research-muted"
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                aria-label="全选待处理候选"
                data-testid="select-all-candidates"
              />
              全选待处理
            </label>
            <button
              type="button"
              className="research-button"
              disabled={busy || selected.size === 0 || !canEdit}
              onClick={() => void acceptBatch([...selected])}
              data-testid="accept-selected"
            >
              批量采纳（{selected.size}）
            </button>
            <button
              type="button"
              className="research-button research-button-secondary"
              disabled={busy || selected.size === 0 || !canEdit}
              onClick={() => void rejectBatch([...selected])}
              data-testid="reject-selected"
            >
              批量拒绝（{selected.size}）
            </button>
          </div>

          <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="research-label">候选主张列表</legend>
            <ul className="research-plain-list" data-testid="candidate-list">
              {result.claimCandidates.map((candidate) => {
                const items = evidenceByClaim.get(candidate.id) ?? [];
                const decided = candidate.status !== "proposed";
                const draft = drafts[candidate.id] ?? candidate.statement;
                const isEditing = editing === candidate.id;
                return (
                  <li
                    key={candidate.id}
                    className="research-challenge"
                    data-candidate-id={candidate.id}
                    data-candidate-status={candidate.status}
                  >
                    <div className="research-claim-meta">
                      <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                        <input
                          type="checkbox"
                          checked={selected.has(candidate.id)}
                          disabled={decided || !canEdit}
                          onChange={() => toggle(candidate.id)}
                          aria-label={`选择候选主张：${candidate.statement.slice(0, 30)}`}
                        />
                        <span className="research-muted">
                          第 {candidate.segmentIndex + 1} 段
                        </span>
                      </label>
                      <StatusPill tone="research-pill-neutral">
                        {candidateClaimTypeLabel(candidate.type)}
                      </StatusPill>
                      <StatusPill tone={candidateStatusTone(candidate.status)}>
                        {candidateStatusLabel(candidate.status)}
                      </StatusPill>
                    </div>

                    {isEditing ? (
                      <div className="research-field">
                        <label
                          className="research-label"
                          htmlFor={`statement-${candidate.id}`}
                        >
                          编辑主张内容
                        </label>
                        <textarea
                          id={`statement-${candidate.id}`}
                          className="research-textarea"
                          rows={3}
                          value={draft}
                          onChange={(event) =>
                            setDrafts((current) => ({
                              ...current,
                              [candidate.id]: event.target.value
                            }))
                          }
                        />
                      </div>
                    ) : (
                      <div className="research-claim-statement">{draft}</div>
                    )}

                    {candidate.context ? (
                      <p className="research-muted" style={{ overflowWrap: "anywhere" }}>
                        上下文：{candidate.context}
                      </p>
                    ) : null}
                    {candidate.qualifiers.length > 0 ? (
                      <p className="research-muted">
                        限定条件：{candidate.qualifiers.join("；")}
                      </p>
                    ) : null}
                    {candidate.uncertainty.length > 0 ? (
                      <p className="research-muted">
                        不确定项：{candidate.uncertainty.join("；")}
                      </p>
                    ) : null}
                    <p className="research-muted">提取理由：{candidate.rationale}</p>

                    {items.length > 0 ? (
                      <div className="research-grid-2">
                        <div>
                          <p className="research-label">候选摘录（{items.length}）</p>
                          <ul className="research-plain-list">
                            {items.map((item) => (
                              <li key={item.id} className="research-challenge">
                                <div className="research-claim-meta">
                                  <StatusPill
                                    tone={locatorStatusTone(item.locatorStatus)}
                                  >
                                    {locatorStatusLabel(item.locatorStatus)}
                                  </StatusPill>
                                  <StatusPill tone={directionTone(item.direction)}>
                                    {directionLabel(item.direction)}
                                  </StatusPill>
                                  <span className="research-muted">
                                    {locatorKindLabel(item.locatorKind)} ·{" "}
                                    {item.locator ?? "—"}
                                  </span>
                                </div>
                                <div className="research-excerpt">{item.excerpt}</div>
                                {item.locatorStatus === "missing" ? (
                                  <p className="research-muted">
                                    这段摘录没有出现在当前保存的原文中。服务端不会伪造定位，
                                    即使采纳也会保持「无法定位」。
                                  </p>
                                ) : null}
                                {item.uncertainty.length > 0 ? (
                                  <p className="research-muted">
                                    不确定项：{item.uncertainty.join("；")}
                                  </p>
                                ) : null}
                                <p className="research-muted">
                                  提取理由：{item.rationale}
                                </p>
                                {decided && item.status === "accepted" ? (
                                  <StatusPill tone={verificationTone("unverified")}>
                                    采纳后为未核实
                                  </StatusPill>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div>
                          <p className="research-label">原文对照（命中处高亮）</p>
                          <Highlighted
                            text={snapshotContent ?? ""}
                            phrases={items.map((item) => item.excerpt)}
                            data-testid="candidate-source-compare"
                            style={{
                              whiteSpace: "pre-wrap",
                              overflowWrap: "anywhere",
                              maxHeight: 260,
                              overflowY: "auto",
                              margin: 0,
                              padding: 10,
                              borderRadius: 8,
                              background: "var(--wb-surface-subtle, rgba(0,0,0,0.03))",
                              font: "inherit",
                              fontSize: 13,
                              lineHeight: 1.6
                            }}
                          />
                        </div>
                      </div>
                    ) : null}

                    <div className="research-actions" style={{ marginTop: 8, flexWrap: "wrap" }}>
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            className="research-button"
                            onClick={() => void saveEdit(candidate)}
                          >
                            保存修改
                          </button>
                          <button
                            type="button"
                            className="research-button research-button-secondary"
                            onClick={() => {
                              setDrafts((current) => {
                                const next = { ...current };
                                delete next[candidate.id];
                                return next;
                              });
                              setEditing(null);
                            }}
                          >
                            放弃修改
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="research-button research-button-secondary"
                          disabled={decided || !canEdit}
                          onClick={() => setEditing(candidate.id)}
                        >
                          编辑
                        </button>
                      )}
                      <button
                        type="button"
                        className="research-button"
                        disabled={decided || busy || !canEdit}
                        onClick={() => void acceptBatch([candidate.id])}
                        data-testid="accept-candidate"
                      >
                        采纳这条
                      </button>
                      <button
                        type="button"
                        className="research-button research-button-secondary"
                        disabled={decided || busy || !canEdit}
                        onClick={() => void rejectBatch([candidate.id])}
                        data-testid="reject-candidate"
                      >
                        拒绝这条
                      </button>
                      {claims.length > 0 && items.length > 0 ? (
                        <label
                          className="research-muted"
                          style={{ display: "inline-flex", gap: 6, alignItems: "center" }}
                        >
                          挂到既有主张：
                          <select
                            className="research-select"
                            defaultValue=""
                            disabled={decided || busy || !canEdit}
                            onChange={(event) => {
                              const claimId = event.target.value;
                              if (claimId === "") return;
                              void attachToExistingClaim(items[0]!, claimId);
                              event.target.value = "";
                            }}
                          >
                            <option value="">选择主张…</option>
                            {claims.map((claim) => (
                              <option key={claim.id} value={claim.id}>
                                {claim.statement.slice(0, 40)}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        </section>
      ) : null}
    </div>
  );
}

/** Fixtures must never be presented as a model result. */
function isRealModel(model: string): boolean {
  return !/(fixture|deterministic|clause-splitter|mock)/i.test(model);
}
