"use client";

import { useCallback, useEffect, useState } from "react";
import type { EvidenceGap } from "@nexus/shared";
import {
  addToResearchPlan,
  decidePlanItem,
  editPlanItemQuery,
  getResearchPlan,
  listPlanItemHistory,
  recordPlanOutcome,
  ResearchPlanFailedError,
  type ResearchPlanView
} from "./api";
import { StatusPill } from "./components";
import { ResearchSearchTasks } from "./research-search-tasks";
import {
  formatDate,
  researchPlanFailureLabel,
  researchPlanStatusLabel,
  researchPlanStatusTone
} from "./labels";

/**
 * 研究计划 — the step between "a diagnosis says something is missing" and
 * "here is what we decided to do about it".
 *
 * The contract this panel holds to:
 *  - a gap is a derived diagnosis; a plan item is a person's decision. This
 *    surface never pretends otherwise and never shows a derived gap as work
 *    that somebody started;
 *  - this build has no controlled web search. `start_search` is nowhere on
 *    the screen, every queued item reads 尚未执行, and the headline says so
 *    plainly — a paragraph of model prose is never displayed as a result;
 *  - closing or rejecting a gap requires a stated reason, recorded verbatim;
 *  - an outcome is what a person found by hand, citing registered material.
 */

type Notice = { kind: "info" | "success" | "error"; text: string } | null;

export function ResearchPlanPanel({
  sessionId,
  canEdit,
  onChanged
}: {
  sessionId: string;
  canEdit: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const [view, setView] = useState<ResearchPlanView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // One inline form at a time: edit the query, decide, or record an outcome.
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingTerms, setEditingTerms] = useState("");
  const [editingNotes, setEditingNotes] = useState("");
  const [deciding, setDeciding] = useState<{
    itemId: string;
    result: "not_applicable" | "closed";
    reason: string;
  } | null>(null);
  const [outcoming, setOutcoming] = useState<{
    itemId: string;
    summary: string;
  } | null>(null);
  const [history, setHistory] = useState<{
    gapId: string;
    items: Array<{ id: string; status: string; updatedAt: string }>;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      setView(await getResearchPlan(sessionId));
    } catch (error) {
      setFailure(
        error instanceof ResearchPlanFailedError
          ? researchPlanFailureLabel(error.code)
          : error instanceof Error
            ? error.message
            : "读取研究计划失败"
      );
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (action: () => Promise<void>, successText: string) => {
      setBusy(true);
      try {
        await action();
        setNotice({ kind: "success", text: successText });
        await load();
        await onChanged?.();
      } catch (error) {
        setNotice({
          kind: "error",
          text:
            error instanceof ResearchPlanFailedError
              ? researchPlanFailureLabel(error.code)
              : error instanceof Error
                ? `操作失败：${error.message}`
                : "操作失败"
        });
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged]
  );

  const addGap = useCallback(
    (gap: EvidenceGap) => {
      void run(async () => {
        await addToResearchPlan(sessionId, { gapId: gap.id });
      }, "已加入研究计划，条目当前状态为「尚未执行」。");
    },
    [run, sessionId]
  );

  const submitQueryEdit = useCallback(
    (itemId: string) => {
      const terms = editingTerms
        .split(/[,,、;；\n]/)
        .map((term) => term.trim())
        .filter((term) => term.length > 0);
      void run(async () => {
        await editPlanItemQuery(sessionId, itemId, {
          terms,
          notes: editingNotes.trim() || null
        });
        setEditingItemId(null);
      }, "已更新检索词。");
    },
    [editingNotes, editingTerms, run, sessionId]
  );

  const submitDecision = useCallback(() => {
    if (!deciding) return;
    if (deciding.reason.trim().length < 10) {
      setNotice({ kind: "error", text: "判定理由至少 10 个字。" });
      return;
    }
    const decision = deciding;
    void run(async () => {
      await decidePlanItem(sessionId, decision.itemId, {
        result: decision.result,
        reason: decision.reason.trim()
      });
      setDeciding(null);
    }, "已记录判定。");
  }, [deciding, run, sessionId]);

  const submitOutcome = useCallback(() => {
    if (!outcoming) return;
    if (outcoming.summary.trim().length < 10) {
      setNotice({ kind: "error", text: "结果说明至少 10 个字。" });
      return;
    }
    const outcome = outcoming;
    void run(async () => {
      await recordPlanOutcome(sessionId, outcome.itemId, {
        summary: outcome.summary.trim()
      });
      setOutcoming(null);
    }, "已记录结果，条目标记为已完成。");
  }, [outcoming, run, sessionId]);

  const toggleHistory = useCallback(
    (gapId: string) => {
      if (history?.gapId === gapId) {
        setHistory(null);
        return;
      }
      void (async () => {
        setBusy(true);
        try {
          const response = await listPlanItemHistory(sessionId, gapId);
          setHistory({ gapId, items: response.items });
        } catch (error) {
          setNotice({
            kind: "error",
            text:
              error instanceof ResearchPlanFailedError
                ? researchPlanFailureLabel(error.code)
                : "读取历史失败"
          });
        } finally {
          setBusy(false);
        }
      })();
    },
    [history, sessionId]
  );

  return (
    <section className="research-panel" data-testid="research-plan">
      <header className="research-panel-header">
        <div>
          <h2 className="research-panel-title">研究计划</h2>
          <p className="research-muted">
            把「缺什么」变成「去做什么」：每一条都是人工加入的任务，状态只说真话。
          </p>
        </div>
        <div className="research-actions">
          <button
            type="button"
            className="research-button research-button-secondary"
            data-testid="refresh-plan"
            disabled={busy}
            onClick={() => void load()}
          >
            刷新
          </button>
        </div>
      </header>

      {notice ? (
        <p
          className={notice.kind === "error" ? "research-error" : "research-muted"}
          data-testid="plan-notice"
        >
          {notice.text}
        </p>
      ) : null}

      {failure ? (
        <div className="research-actions" data-testid="plan-error">
          <p className="research-error">{failure}</p>
          <button
            type="button"
            className="research-button research-button-secondary"
            data-testid="retry-plan"
            onClick={() => void load()}
          >
            重试
          </button>
        </div>
      ) : null}

      {loading && !view ? (
        <p className="research-muted" data-testid="plan-loading">
          正在读取研究计划…
        </p>
      ) : null}

      {view ? (
        <>
          <div className="research-facts" data-testid="plan-summary">
            <div>
              <div className="research-label">计划条目</div>
              <p style={{ margin: 0 }}>{view.summary.total} 项</p>
            </div>
            <div>
              <div className="research-label">尚未执行</div>
              <p data-testid="plan-not-started" style={{ margin: 0 }}>
                {view.summary.notStarted} 项
              </p>
            </div>
            <div>
              <div className="research-label">已完成</div>
              <p style={{ margin: 0 }}>{view.summary.completed} 项</p>
            </div>
            <div>
              <div className="research-label">已关闭/不适用</div>
              <p style={{ margin: 0 }}>{view.summary.dismissed} 项</p>
            </div>
          </div>

          <p className="research-muted" data-testid="plan-headline">
            {view.headline}
          </p>

          {!view.searchAvailable ? (
            <p className="research-muted" data-testid="plan-search-note">
              本构建未接入受控网页搜索：条目不会自动执行检索，也不会显示任何「检索结果」；结果只能由人工登记。
            </p>
          ) : null}

          <div>
            <h3 className="research-label">计划条目</h3>
            {view.items.length === 0 ? (
              <p className="research-muted" data-testid="plan-empty">
                研究计划还没有条目。下方是当前诊断出的证据缺口，可以逐条加入计划。
              </p>
            ) : (
              <ul className="research-plain-list" data-testid="plan-items">
                {view.items.map((item) => (
                  <li key={item.id} data-testid={`plan-item-${item.id}`}>
                    <div className="research-actions">
                      <span data-testid={`plan-status-${item.id}`}>
                        <StatusPill tone={researchPlanStatusTone(item.status)}>
                          {researchPlanStatusLabel(item.status)}
                        </StatusPill>
                      </span>
                      <span className="research-muted">优先级 {item.priority}</span>
                      <strong data-testid={`plan-title-${item.id}`}>
                        {item.title}
                      </strong>
                    </div>

                    <p className="research-muted">{item.question}</p>
                    {item.whyInsufficient.length > 0 ? (
                      <ul className="research-plain-list">
                        {item.whyInsufficient.map((line) => (
                          <li key={line} className="research-muted">
                            {line}
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    <div className="research-facts">
                      <div>
                        <div className="research-label">需要的材料</div>
                        <div>{item.query.neededEvidenceKind}</div>
                      </div>
                      <div>
                        <div className="research-label">建议来源类型</div>
                        <div>
                          {item.query.sourceTypes.length > 0
                            ? item.query.sourceTypes.join("、")
                            : "未指定"}
                        </div>
                      </div>
                      <div>
                        <div className="research-label">检索词</div>
                        <div data-testid={`plan-terms-${item.id}`}>
                          {item.query.terms.length > 0
                            ? item.query.terms.join("、")
                            : "（未填写）"}
                        </div>
                      </div>
                      <div>
                        <div className="research-label">时间范围</div>
                        <div>
                          {item.query.timeRange
                            ? `${item.query.timeRange.from ?? "—"} 至 ${item.query.timeRange.to ?? "—"}`
                            : "未限定"}
                        </div>
                      </div>
                    </div>

                    {item.outcome ? (
                      <p data-testid={`plan-outcome-${item.id}`}>
                        结果（{item.outcome.recordedBy} 记录于{" "}
                        {formatDate(item.outcome.recordedAt)}）：
                        {item.outcome.summary}
                      </p>
                    ) : null}
                    {item.decisionReason ? (
                      <p className="research-muted">
                        判定：{item.decisionReason}（{item.decidedBy}）
                      </p>
                    ) : null}
                    {item.failureReason ? (
                      <p className="research-error">失败原因：{item.failureReason}</p>
                    ) : null}

                    {canEdit ? (
                      <div className="research-actions" data-testid={`plan-actions-${item.id}`}>
                        {item.availableActions.includes("edit_query") ? (
                          <button
                            type="button"
                            className="research-button research-button-secondary"
                            disabled={busy}
                            onClick={() => {
                              setEditingItemId(item.id);
                              setEditingTerms(item.query.terms.join("、"));
                              setEditingNotes(item.query.notes ?? "");
                            }}
                          >
                            编辑检索词
                          </button>
                        ) : null}
                        {item.availableActions.includes("add_manual_source") ? (
                          <button
                            type="button"
                            className="research-button research-button-secondary"
                            disabled={busy}
                            onClick={() =>
                              setOutcoming({ itemId: item.id, summary: "" })
                            }
                          >
                            登记人工查找结果
                          </button>
                        ) : null}
                        {item.availableActions.includes("record_outcome") ? (
                          <button
                            type="button"
                            className="research-button research-button-secondary"
                            disabled={busy}
                            onClick={() =>
                              setOutcoming({ itemId: item.id, summary: "" })
                            }
                          >
                            记录结果
                          </button>
                        ) : null}
                        {item.availableActions.includes("mark_not_applicable") ? (
                          <button
                            type="button"
                            className="research-button research-button-secondary"
                            disabled={busy}
                            onClick={() =>
                              setDeciding({
                                itemId: item.id,
                                result: "not_applicable",
                                reason: ""
                              })
                            }
                          >
                            标记不适用
                          </button>
                        ) : null}
                        {item.availableActions.includes("close") ? (
                          <button
                            type="button"
                            className="research-button research-button-secondary"
                            disabled={busy}
                            onClick={() =>
                              setDeciding({
                                itemId: item.id,
                                result: "closed",
                                reason: ""
                              })
                            }
                          >
                            关闭
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="research-button research-button-secondary"
                          disabled={busy}
                          onClick={() => void toggleHistory(item.gapId)}
                        >
                          {history?.gapId === item.gapId ? "收起历史" : "查看历史"}
                        </button>
                      </div>
                    ) : null}

                    {editingItemId === item.id ? (
                      <form
                        className="research-facts"
                        data-testid="plan-query-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          submitQueryEdit(item.id);
                        }}
                      >
                        <div>
                          <label
                            className="research-label"
                            htmlFor={`plan-terms-input-${item.id}`}
                          >
                            检索词（用顿号或逗号分隔）
                          </label>
                          <textarea
                            id={`plan-terms-input-${item.id}`}
                            data-testid="plan-terms-input"
                            value={editingTerms}
                            rows={2}
                            onChange={(event) =>
                              setEditingTerms(event.target.value)
                            }
                          />
                        </div>
                        <div>
                          <label
                            className="research-label"
                            htmlFor={`plan-notes-input-${item.id}`}
                          >
                            备注
                          </label>
                          <input
                            id={`plan-notes-input-${item.id}`}
                            data-testid="plan-notes-input"
                            value={editingNotes}
                            onChange={(event) =>
                              setEditingNotes(event.target.value)
                            }
                          />
                        </div>
                        <div className="research-actions">
                          <button
                            type="submit"
                            className="research-button"
                            data-testid="plan-query-submit"
                            disabled={busy}
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            className="research-button research-button-secondary"
                            onClick={() => setEditingItemId(null)}
                          >
                            取消
                          </button>
                        </div>
                      </form>
                    ) : null}

                    {deciding && deciding.itemId === item.id ? (
                      <form
                        className="research-facts"
                        data-testid="plan-decision-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          submitDecision();
                        }}
                      >
                        <div>
                          <label className="research-label" htmlFor={`plan-decision-result-${item.id}`}>
                            判定
                          </label>
                          <select
                            id={`plan-decision-result-${item.id}`}
                            data-testid="plan-decision-result"
                            value={deciding.result}
                            onChange={(event) =>
                              setDeciding({
                                ...deciding,
                                result: event.target.value as
                                  | "not_applicable"
                                  | "closed"
                              })
                            }
                          >
                            <option value="not_applicable">不适用</option>
                            <option value="closed">关闭</option>
                          </select>
                        </div>
                        <div>
                          <label className="research-label" htmlFor={`plan-decision-reason-${item.id}`}>
                            判定理由（至少 10 个字，将原样记录）
                          </label>
                          <textarea
                            id={`plan-decision-reason-${item.id}`}
                            data-testid="plan-decision-reason"
                            value={deciding.reason}
                            rows={2}
                            onChange={(event) =>
                              setDeciding({ ...deciding, reason: event.target.value })
                            }
                          />
                        </div>
                        <div className="research-actions">
                          <button
                            type="submit"
                            className="research-button"
                            data-testid="plan-decision-submit"
                            disabled={busy}
                          >
                            提交判定
                          </button>
                          <button
                            type="button"
                            className="research-button research-button-secondary"
                            onClick={() => setDeciding(null)}
                          >
                            取消
                          </button>
                        </div>
                      </form>
                    ) : null}

                    {outcoming && outcoming.itemId === item.id ? (
                      <form
                        className="research-facts"
                        data-testid="plan-outcome-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          submitOutcome();
                        }}
                      >
                        <div>
                          <label className="research-label" htmlFor={`plan-outcome-summary-${item.id}`}>
                            结果说明（至少 10 个字；来源与证据请先在对应面板登记）
                          </label>
                          <textarea
                            id={`plan-outcome-summary-${item.id}`}
                            data-testid="plan-outcome-summary"
                            value={outcoming.summary}
                            rows={2}
                            onChange={(event) =>
                              setOutcoming({ ...outcoming, summary: event.target.value })
                            }
                          />
                        </div>
                        <div className="research-actions">
                          <button
                            type="submit"
                            className="research-button"
                            data-testid="plan-outcome-submit"
                            disabled={busy}
                          >
                            记录结果
                          </button>
                          <button
                            type="button"
                            className="research-button research-button-secondary"
                            onClick={() => setOutcoming(null)}
                          >
                            取消
                          </button>
                        </div>
                      </form>
                    ) : null}

                    {history && history.gapId === item.gapId ? (
                      <ul
                        className="research-plain-list"
                        data-testid={`plan-history-${item.id}`}
                      >
                        {history.items.map((entry) => (
                          <li key={entry.id} className="research-muted">
                            {formatDate(entry.updatedAt)} ·{" "}
                            {researchPlanStatusLabel(
                              entry.status as Parameters<
                                typeof researchPlanStatusLabel
                              >[0]
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="research-label">待处理的证据缺口</h3>
            {view.availableGaps.length === 0 ? (
              <p className="research-muted" data-testid="plan-gaps-empty">
                没有待处理的缺口：当前诊断出的缺口都已加入计划或不适用于本研究。
              </p>
            ) : (
              <ul className="research-plain-list" data-testid="plan-available-gaps">
                {view.availableGaps.map((gap) => (
                  <li key={gap.id}>
                    <div className="research-actions">
                      <StatusPill
                        tone={
                          gap.severity === "blocking"
                            ? "research-pill-opposes"
                            : "research-pill-unverified"
                        }
                      >
                        {gap.severity === "blocking"
                          ? "阻断"
                          : gap.severity === "important"
                            ? "重要"
                            : "提示"}
                      </StatusPill>
                      <span>{gap.message}</span>
                    </div>
                    {gap.detail.length > 0 ? (
                      <p className="research-muted">{gap.detail.join("；")}</p>
                    ) : null}
                    {canEdit ? (
                      <button
                        type="button"
                        className="research-button research-button-secondary"
                        data-testid={`add-gap-${gap.id}`}
                        disabled={busy}
                        onClick={() => addGap(gap)}
                      >
                        加入研究计划
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <ResearchSearchTasks
            sessionId={sessionId}
            canEdit={canEdit}
            planItems={view.items}
            onChanged={onChanged}
          />
        </>
      ) : null}
    </section>
  );
}
