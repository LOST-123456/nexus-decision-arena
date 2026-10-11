"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  ResearchPlanAction,
  ResearchPlanItem,
  SearchCandidate
} from "@nexus/shared";
import {
  approveResearchSearchTask,
  createResearchSearchTask,
  getResearchSearchTask,
  listResearchSearchTasks,
  rejectResearchSearchTask,
  ResearchSearchFailedError,
  type ResearchSearchTaskListItem
} from "./api";
import { StatusPill } from "./components";
import {
  formatDate,
  researchSearchFailureLabel,
  researchSearchStatusLabel,
  researchSearchStatusTone,
  sourceKindLabel
} from "./labels";

/**
 * 受控检索任务 — the search surface that never lies about what it did.
 *
 * The contract this panel holds to:
 *  - a search only ever produces *candidates*. The panel says 候选来源, never
 *    "AI 已验证", and never shows an evidence badge for them;
 *  - approving a task registers its candidates as Sources (provenance), and the
 *    button is labelled accordingly — it does NOT create evidence. The UI makes
 *    the two steps visibly distinct;
 *  - rejecting is recorded, never silently dropped;
 *  - the controlled search is deterministic and network-free in this build, so
 *    every candidate carries a placeholder url a person must replace before it
 *    could back an evidence claim.
 */

type PlanItemLike = ResearchPlanItem & { availableActions: ResearchPlanAction[] };

type Notice = { kind: "info" | "success" | "error"; text: string } | null;

function Keywords({ keywords }: { keywords: readonly string[] }) {
  if (keywords.length === 0) {
    return <span className="research-muted">（无）</span>;
  }
  return (
    <span className="research-keyword-row">
      {keywords.map((keyword, index) => (
        <span key={`${keyword}-${index}`} className="research-pill research-pill-neutral">
          {keyword}
        </span>
      ))}
    </span>
  );
}

export function ResearchSearchTasks({
  sessionId,
  canEdit,
  planItems,
  onChanged
}: {
  sessionId: string;
  canEdit: boolean;
  planItems: PlanItemLike[];
  onChanged?: (() => void | Promise<void>) | undefined;
}) {
  const [tasks, setTasks] = useState<ResearchSearchTaskListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const [creating, setCreating] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [purpose, setPurpose] = useState("");
  const [keywordsText, setKeywordsText] = useState("");

  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Record<string, SearchCandidate[]>>({});
  const [candidateError, setCandidateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listResearchSearchTasks(sessionId);
      setTasks(response.tasks);
    } catch (exception) {
      setError(
        exception instanceof ResearchSearchFailedError
          ? researchSearchFailureLabel(exception.code)
          : exception instanceof Error
            ? exception.message
            : "读取检索任务失败"
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
      setNotice(null);
      try {
        await action();
        setNotice({ kind: "success", text: successText });
        await load();
        await onChanged?.();
      } catch (exception) {
        setNotice({
          kind: "error",
          text:
            exception instanceof ResearchSearchFailedError
              ? researchSearchFailureLabel(exception.code)
              : exception instanceof Error
                ? `操作失败：${exception.message}`
                : "操作失败"
        });
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged]
  );

  const openCreate = useCallback(() => {
    setCreating(true);
    setSelectedItemId("");
    setQuery("");
    setPurpose("");
    setKeywordsText("");
  }, []);

  const onPickItem = useCallback(
    (itemId: string) => {
      setSelectedItemId(itemId);
      const item = planItems.find((entry) => entry.id === itemId);
      if (item) {
        setQuery(item.question);
        setPurpose(`为「${item.title}」补充可核对的来源`);
        setKeywordsText(item.query.terms.join("，"));
      }
    },
    [planItems]
  );

  const submitCreate = useCallback(async () => {
    if (!selectedItemId) {
      setNotice({ kind: "error", text: "请先选择一个研究缺口。" });
      return;
    }
    const keywords = keywordsText
      .split(/[，,\n]/)
      .map((part) => part.trim())
      .filter(Boolean);
    await run(
      async () => {
        await createResearchSearchTask(sessionId, {
          planItemId: selectedItemId,
          query,
          purpose,
          keywords
        });
      },
      "已创建检索任务并运行：结果为候选来源，请人工核实后再决定是否登记为来源。"
    );
    setCreating(false);
  }, [selectedItemId, keywordsText, query, purpose, run, sessionId]);

  const approve = useCallback(
    (taskId: string) =>
      run(
        async () => {
          await approveResearchSearchTask(sessionId, taskId);
        },
        "已核准：候选来源已登记为「来源」，尚未成为证据。"
      ),
    [run, sessionId]
  );

  const reject = useCallback(
    (taskId: string) =>
      run(
        async () => {
          await rejectResearchSearchTask(sessionId, taskId);
        },
        "已驳回该检索任务的候选来源，未登记任何来源。"
      ),
    [run, sessionId]
  );

  const toggleExpand = useCallback(
    async (taskId: string) => {
      if (expandedTaskId === taskId) {
        setExpandedTaskId(null);
        return;
      }
      setExpandedTaskId(taskId);
      setCandidateError(null);
      try {
        const view = await getResearchSearchTask(sessionId, taskId);
        setCandidates((previous) => ({
          ...previous,
          [taskId]: view.candidates
        }));
      } catch (exception) {
        setCandidateError(
          exception instanceof ResearchSearchFailedError
            ? researchSearchFailureLabel(exception.code)
            : exception instanceof Error
              ? exception.message
              : "读取候选来源失败"
        );
      }
    },
    [expandedTaskId, sessionId]
  );

  return (
    <section className="research-search-tasks" data-testid="research-search-tasks">
      <div className="research-search-tasks-header">
        <h3>受控检索任务</h3>
        {canEdit ? (
          <button
            type="button"
            className="research-button-secondary"
            onClick={openCreate}
            disabled={busy}
          >
            发起受控检索
          </button>
        ) : null}
      </div>

      <p className="research-muted">
        受控检索本构建不联网，仅依据关键词确定性地给出<strong>候选来源</strong>；候选不等同于证据，需人工核实并核准为「来源」后，再单独核实为证据。
      </p>

      {notice ? (
        <div className={`research-notice research-notice-${notice.kind}`}>
          {notice.text}
        </div>
      ) : null}

      {loading ? (
        <div className="research-muted">加载中…</div>
      ) : error ? (
        <div className="research-notice research-notice-error">{error}</div>
      ) : tasks.length === 0 ? (
        <div className="research-muted">还没有检索任务。</div>
      ) : (
        <ul className="research-search-task-list">
          {tasks.map((task) => {
            const expanded = expandedTaskId === task.id;
            const taskCandidates = candidates[task.id] ?? [];
            return (
              <li
                key={task.id}
                className="research-search-task-card"
                data-testid="research-search-task"
              >
                <div className="research-search-task-row">
                  <span className="research-search-task-label">研究缺口</span>
                  <span>{task.query}</span>
                </div>
                <div className="research-search-task-row">
                  <span className="research-search-task-label">搜索目标</span>
                  <span>{task.purpose}</span>
                </div>
                <div className="research-search-task-row">
                  <span className="research-search-task-label">关键词</span>
                  <Keywords keywords={task.keywords} />
                </div>
                <div className="research-search-task-row">
                  <span className="research-search-task-label">候选来源数量</span>
                  <span>{task.candidateCount}</span>
                </div>
                <div className="research-search-task-row">
                  <span className="research-search-task-label">状态</span>
                  <StatusPill tone={researchSearchStatusTone(task.status)}>
                    {researchSearchStatusLabel(task.status)}
                  </StatusPill>
                  {task.rejectedAt ? (
                    <span className="research-muted">
                      （已驳回{task.rejectedBy ? ` · ${task.rejectedBy}` : ""} · {formatDate(task.rejectedAt)}）
                    </span>
                  ) : null}
                </div>
                {task.status === "failed" && task.failureReason ? (
                  <div className="research-search-task-row">
                    <span className="research-search-task-label">失败原因</span>
                    <span className="research-notice research-notice-error">
                      {task.failureReason}
                    </span>
                  </div>
                ) : null}

                <div className="research-search-task-actions">
                  <button
                    type="button"
                    className="research-button-link"
                    onClick={() => void toggleExpand(task.id)}
                    disabled={busy}
                  >
                    {expanded ? "收起候选来源" : `查看候选来源（${task.candidateCount}）`}
                  </button>
                  {canEdit && task.status === "completed" && !task.rejectedAt ? (
                    <>
                      <button
                        type="button"
                        className="research-button-primary"
                        onClick={() => void approve(task.id)}
                        disabled={busy}
                      >
                        核准为来源
                      </button>
                      <button
                        type="button"
                        className="research-button-secondary"
                        onClick={() => void reject(task.id)}
                        disabled={busy}
                      >
                        驳回
                      </button>
                    </>
                  ) : null}
                </div>

                {expanded ? (
                  <div className="research-search-candidates">
                    <p className="research-muted">
                      以下为候选项，<strong>尚未核实、不是证据</strong>；仅在其被核准为「来源」后，才进入来源清单，仍需单独核实。
                    </p>
                    {candidateError ? (
                      <div className="research-notice research-notice-error">
                        {candidateError}
                      </div>
                    ) : taskCandidates.length === 0 ? (
                      <div className="research-muted">（无候选来源）</div>
                    ) : (
                      <ul className="research-candidate-list">
                        {taskCandidates.map((candidate) => (
                          <li
                            key={candidate.id}
                            className="research-candidate-item"
                          >
                            <div>
                              <a
                                href={candidate.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {candidate.title}
                              </a>{" "}
                              <StatusPill tone="research-pill-neutral">
                                {sourceKindLabel(candidate.sourceType)}
                              </StatusPill>
                            </div>
                            <div className="research-muted">
                              {candidate.publisher} · {formatDate(candidate.retrievedAt)}
                              {candidate.approvedAt ? " · 已核准为来源" : " · 待人工核实（非证据）"}
                            </div>
                            {candidate.note ? (
                              <div className="research-candidate-note">
                                {candidate.note}
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {creating ? (
        <div className="research-search-create-form" data-testid="research-search-create">
          <div className="research-form-row">
            <label htmlFor="search-plan-item">关联研究缺口</label>
            <select
              id="search-plan-item"
              value={selectedItemId}
              onChange={(event) => onPickItem(event.target.value)}
              disabled={busy}
            >
              <option value="">请选择…</option>
              {planItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </div>
          <div className="research-form-row">
            <label htmlFor="search-query">研究缺口（检索问题）</label>
            <textarea
              id="search-query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              disabled={busy}
            />
          </div>
          <div className="research-form-row">
            <label htmlFor="search-purpose">搜索目标</label>
            <input
              id="search-purpose"
              type="text"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              disabled={busy}
            />
          </div>
          <div className="research-form-row">
            <label htmlFor="search-keywords">关键词（逗号或换行分隔）</label>
            <textarea
              id="search-keywords"
              value={keywordsText}
              onChange={(event) => setKeywordsText(event.target.value)}
              disabled={busy}
            />
          </div>
          <div className="research-search-create-actions">
            <button
              type="button"
              className="research-button-primary"
              onClick={() => void submitCreate()}
              disabled={busy}
            >
              创建并检索
            </button>
            <button
              type="button"
              className="research-button-secondary"
              onClick={() => setCreating(false)}
              disabled={busy}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
