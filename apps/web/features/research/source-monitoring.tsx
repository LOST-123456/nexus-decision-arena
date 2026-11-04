"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  RevalidationTask,
  SnapshotDiff,
  SourceCheckOutcome,
  SourceMonitorStatus
} from "@nexus/shared";
import {
  checkSourceDrift,
  getSourceDiff,
  listRevalidationTasks,
  resolveRevalidationTask
} from "./api";
import { StatusPill } from "./components";
import { formatDateTime } from "./labels";

/**
 * 来源监控 — whether the material a research rests on has moved.
 *
 * 这个面板接的是后端一直存在、但界面上没有入口的六个接口：来源漂移检查、
 * 监控摘要、快照差异，以及复验任务队列（打开 / 复议 / 关闭）。
 *
 * 三条口径，写在这里免得以后被改掉：
 *  1. **检查不是结论。** `changed` 只说明"页面上的字与存着的版本不同"，
 *     它不改任何核实状态、不改任何主张判定。面板上也只这么说。
 *  2. **检查失败不是变化。** `unavailable`（打不开）/`failed`（没检成）
 *     与内容无关，界面上必须分开写，不能合成一句"有更新"。
 *  3. **关闭任务不是通过结论。** 关掉一条复验任务，意思是"我重读了材料"，
 *     不是"结论变了"，也不是"结论被确认"。
 */

const MONITOR_STATUS_LABEL: Record<SourceMonitorStatus, string> = {
  not_checked: "未检查",
  checking: "检查中",
  unchanged: "未变化",
  changed: "内容有变化",
  unavailable: "页面打不开",
  failed: "检查未完成"
};

/** 枚举名不直接上屏：`url`、`document` 是数据模型里的词，不是给人看的。 */
const SOURCE_KIND_LABEL: Record<string, string> = {
  url: "网页",
  document: "文档",
  dataset: "数据集",
  manual: "手工录入"
};

function monitorTone(status: SourceMonitorStatus): string {
  switch (status) {
    case "changed":
      return "research-pill-unverified";
    case "unavailable":
    case "failed":
      return "research-pill-context";
    case "unchanged":
      return "research-pill-verified";
    default:
      return "research-pill-neutral";
  }
}

const TASK_STATUS_LABEL: Record<RevalidationTask["status"], string> = {
  open: "待处理",
  in_review: "复核中",
  resolved: "已处理",
  dismissed: "已忽略"
};

function taskTone(status: RevalidationTask["status"]): string {
  switch (status) {
    case "open":
      return "research-pill-unverified";
    case "in_review":
      return "research-pill-context";
    case "resolved":
      return "research-pill-verified";
    default:
      return "research-pill-neutral";
  }
}

type SourceRow = { id: string; title: string; kind: string };

export function SourceMonitoringPanel({
  sessionId,
  sources,
  canEdit
}: {
  sessionId: string;
  sources: readonly SourceRow[];
  canEdit: boolean;
}) {
  const [tasks, setTasks] = useState<RevalidationTask[] | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [checking, setChecking] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, SourceCheckOutcome>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const [diffs, setDiffs] = useState<Record<string, SnapshotDiff | null>>({});
  const [diffBusy, setDiffBusy] = useState<string | null>(null);

  const [resolving, setResolving] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [taskActionError, setTaskActionError] = useState<string | null>(null);
  const [taskMessage, setTaskMessage] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setTaskError(null);
    try {
      const response = await listRevalidationTasks(sessionId);
      setTasks(response.tasks);
    } catch (cause) {
      setTasks([]);
      setTaskError(
        cause instanceof Error ? cause.message : "读取复验任务失败"
      );
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  async function runCheck(source: SourceRow): Promise<void> {
    setChecking(source.id);
    setRowError((current) => ({ ...current, [source.id]: "" }));
    try {
      const outcome = await checkSourceDrift(sessionId, source.id);
      setOutcomes((current) => ({ ...current, [source.id]: outcome }));
      // 只有 changed 会开任务；把新任务插进来，省得用户再点一次刷新。
      if (outcome.revalidationTask) {
        const task = outcome.revalidationTask;
        setTasks((current) => {
          const list = current ?? [];
          return list.some((item) => item.id === task.id)
            ? list
            : [task, ...list];
        });
      }
    } catch (cause) {
      setRowError((current) => ({
        ...current,
        [source.id]: cause instanceof Error ? cause.message : "检查失败"
      }));
    } finally {
      setChecking(null);
    }
  }

  async function openDiff(source: SourceRow): Promise<void> {
    setDiffBusy(source.id);
    setRowError((current) => ({ ...current, [source.id]: "" }));
    try {
      const diff = await getSourceDiff(sessionId, source.id);
      setDiffs((current) => ({ ...current, [source.id]: diff }));
    } catch (cause) {
      setDiffs((current) => ({ ...current, [source.id]: null }));
      setRowError((current) => ({
        ...current,
        [source.id]: cause instanceof Error ? cause.message : "读取差异失败"
      }));
    } finally {
      setDiffBusy(null);
    }
  }

  async function moveTask(
    task: RevalidationTask,
    status: "in_review" | "resolved" | "dismissed"
  ): Promise<void> {
    const note = (notes[task.id] ?? "").trim();
    // 关闭必须有理由：没有理由的关闭等于把待办按掉，审计记录里只剩一个勾。
    if (status !== "in_review" && note === "") {
      setTaskActionError("关闭这条任务需要写一句理由（会写进审计记录）。");
      return;
    }
    setResolving(task.id);
    setTaskActionError(null);
    setTaskMessage(null);
    try {
      const updated = await resolveRevalidationTask(sessionId, task.id, {
        status,
        ...(note ? { note } : {})
      });
      setTasks((current) =>
        (current ?? []).map((item) => (item.id === updated.id ? updated : item))
      );
      setNotes((current) => ({ ...current, [task.id]: "" }));
      setTaskMessage(
        status === "in_review"
          ? "已标记为复核中。"
          : "已关闭。关闭的是这条待办，不是结论——报告不会因此改口。"
      );
    } catch (cause) {
      setTaskActionError(
        cause instanceof Error ? cause.message : "更新任务失败"
      );
    } finally {
      setResolving(null);
    }
  }

  const openTasks = (tasks ?? []).filter(
    (task) => task.status === "open" || task.status === "in_review"
  );
  const closedTasks = (tasks ?? []).filter(
    (task) => task.status === "resolved" || task.status === "dismissed"
  );

  return (
    <div
      className="research-body"
      data-mode="verify"
      data-testid="research-body"
      id="research-workspace-panel"
    >
      <div className="research-column">
        <section className="research-panel" data-testid="source-monitoring">
          <header className="research-panel-header">
            <div>
              <h2 className="research-panel-title">来源监控</h2>
              <p className="research-muted">
                检查这里的页面有没有在你核实之后变过。检查只说明"字变了 / 没变"，
                不改核实状态，也不改任何主张的判定。
              </p>
            </div>
            <button
              type="button"
              className="research-button research-button-secondary"
              onClick={() => void loadTasks()}
              disabled={loading}
            >
              {loading ? "读取中…" : "刷新任务"}
            </button>
          </header>

          {taskError ? (
            <p className="research-error" role="alert">
              {taskError}
            </p>
          ) : null}

          {loading ? (
            <p className="research-muted">正在读取复验任务…</p>
          ) : openTasks.length === 0 ? (
            <p className="research-muted" data-testid="monitoring-no-open-tasks">
              没有待处理的复验任务。来源被检查且内容与已存版本不同时，这里才会出现一条。
            </p>
          ) : (
            <div className="research-table-scroll">
              <table className="research-table" data-testid="revalidation-tasks">
                <thead>
                  <tr>
                    <th scope="col">来源</th>
                    <th scope="col">为什么重核</th>
                    <th scope="col">影响</th>
                    <th scope="col">状态</th>
                    <th scope="col">处理</th>
                  </tr>
                </thead>
                <tbody>
                  {openTasks.map((task) => (
                    <tr key={task.id}>
                      <td>
                        <span className="research-source-title">
                          {task.sourceTitle}
                        </span>
                        <div className="research-muted">
                          触发于 {formatDateTime(task.createdAt)}
                        </div>
                      </td>
                      <td>{task.reason}</td>
                      <td className="research-muted">
                        证据 {task.affectedEvidenceIds.length} 条 · 主张{" "}
                        {task.affectedClaimIds.length} 条
                      </td>
                      <td>
                        <StatusPill tone={taskTone(task.status)}>
                          {TASK_STATUS_LABEL[task.status]}
                        </StatusPill>
                      </td>
                      <td>
                        <div className="research-actions">
                          <input
                            className="research-input"
                            placeholder="关闭时必填：你重读后看到了什么"
                            value={notes[task.id] ?? ""}
                            onChange={(event) =>
                              setNotes((current) => ({
                                ...current,
                                [task.id]: event.target.value
                              }))
                            }
                            aria-label={`处理理由 ${task.sourceTitle}`}
                          />
                          {task.status === "open" ? (
                            <button
                              type="button"
                              className="research-button research-button-secondary"
                              disabled={!canEdit || resolving === task.id}
                              onClick={() => void moveTask(task, "in_review")}
                            >
                              开始复核
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="research-button"
                            disabled={!canEdit || resolving === task.id}
                            onClick={() => void moveTask(task, "resolved")}
                          >
                            已重核
                          </button>
                          <button
                            type="button"
                            className="research-button research-button-secondary"
                            disabled={!canEdit || resolving === task.id}
                            onClick={() => void moveTask(task, "dismissed")}
                          >
                            忽略
                          </button>
                        </div>
                        {!canEdit ? (
                          <div className="research-muted">
                            当前账号只能查看，处理任务需要 Reviewer 权限。
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {taskActionError ? (
            <p className="research-error" role="alert">
              {taskActionError}
            </p>
          ) : null}
          {taskMessage ? (
            <p className="research-muted" role="status">
              {taskMessage}
            </p>
          ) : null}

          {closedTasks.length > 0 ? (
            <p className="research-muted" data-testid="monitoring-closed-count">
              已关闭 {" "}
              {closedTasks.length} 条（关闭不改变结论，报告里仍按原判定呈现）。
            </p>
          ) : null}
        </section>

        <section className="research-panel">
          <header className="research-panel-header">
            <div>
              <h2 className="research-panel-title">逐条检查</h2>
              <p className="research-muted">
                检查会真的去访问那个地址一次。抓不到、被拒绝、超时都会如实记下来，
                这类结果**不是**"内容变了"。
              </p>
            </div>
          </header>

          {sources.length === 0 ? (
            <p className="research-muted">
              这项研究还没有来源。先在「研究内容」里导入网页。
            </p>
          ) : (
            <div className="research-table-scroll">
              <table className="research-table" data-testid="monitor-sources">
                <thead>
                  <tr>
                    <th scope="col">来源</th>
                    <th scope="col">检查结果</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((source) => {
                    const outcome = outcomes[source.id];
                    const diff = diffs[source.id];
                    const error = rowError[source.id];
                    return (
                      <tr key={source.id}>
                        <td>
                          <span className="research-source-title">
                            {source.title}
                          </span>
                          <div className="research-muted">
                            {SOURCE_KIND_LABEL[source.kind] ?? source.kind}
                          </div>
                        </td>
                        <td>
                          {outcome ? (
                            <>
                              <StatusPill tone={monitorTone(outcome.status)}>
                                {MONITOR_STATUS_LABEL[outcome.status]}
                              </StatusPill>
                              <div className="research-muted">
                                {outcome.message}
                              </div>
                              <div className="research-muted">
                                {formatDateTime(outcome.checkedAt)} · 本次检查后剩余{" "}
                                {outcome.remainingChecks} 次
                              </div>
                              {outcome.status === "changed" ? (
                                <div className="research-muted">
                                  已存为新版本；报告不会自动改口，需要你判断是否重新核实。
                                </div>
                              ) : null}
                            </>
                          ) : (
                            <span className="research-muted">未检查</span>
                          )}
                          {error ? (
                            <p className="research-error" role="alert">
                              {error}
                            </p>
                          ) : null}
                          {diff ? (
                            <div
                              className="research-muted"
                              data-testid={`diff-${source.id}`}
                            >
                              {/*
                                只有一个版本时说"无从比较"，不说"增 0 字 / 删 0 字"：
                                后者读起来像"确认过没变"，而事实是还没有可比的第二个版本。
                              */}
                              {diff.previousSnapshotId === null ? (
                                <div>只有一个已存版本，暂时无从比较。</div>
                              ) : (
                                <div>
                                  增 {diff.addedChars} 字 / 删 {diff.removedChars}{" "}
                                  字
                                  {diff.titleChanged ? " · 标题也变了" : ""}
                                </div>
                              )}
                              {diff.highlights.length > 0 ? (
                                <div>
                                  先看这些：
                                  {diff.highlights
                                    .slice(0, 5)
                                    .map((item) => item.text)
                                    .join(" / ")}
                                </div>
                              ) : null}
                              {diff.missingExcerpts.length > 0 ? (
                                <div>
                                  有 {diff.missingExcerpts.length} 条已引用的摘录在新版本里
                                  找不到了：{diff.missingExcerpts
                                    .map((item) => item.title)
                                    .join("、")}
                                </div>
                              ) : null}
                              <div>差异只是提示，不是结论。</div>
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <div className="research-actions">
                            <button
                              type="button"
                              className="research-button"
                              disabled={!canEdit || checking === source.id}
                              onClick={() => void runCheck(source)}
                              data-testid={`check-${source.id}`}
                            >
                              {checking === source.id ? "检查中…" : "检查更新"}
                            </button>
                            <button
                              type="button"
                              className="research-button research-button-secondary"
                              disabled={diffBusy === source.id}
                              onClick={() => void openDiff(source)}
                            >
                              {diffBusy === source.id ? "读取中…" : "看最近差异"}
                            </button>
                          </div>
                          {!canEdit ? (
                            <div className="research-muted">
                              检查需要 Reviewer 权限；查看差异不受限。
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
