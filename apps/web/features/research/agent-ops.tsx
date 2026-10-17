"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  agentRunFailureCodeLabel,
  agentRunStatusLabel,
  canCancelRun,
  isRetryableRun,
  type AgentRunDetail,
  type AgentRunView
} from "@nexus/shared";
import {
  cancelAgentRun,
  getAgentRun,
  listAgentRuns,
  retryAgentRun
} from "./api";
import { formatDate, runStatusTone } from "./labels";
import { StatusPill } from "./components";
import { ConfirmDialog } from "../../components/ui/dialog";
import { Notice } from "../../components/ui/notice";
import { Button } from "../../components/ui/button";

function purposeLabel(purpose: AgentRunView["purpose"]): string {
  return purpose === "cross_review" ? "交叉审查" : "分析";
}

function formatDuration(durationMs: number | undefined): string {
  if (typeof durationMs !== "number") return "—";
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
}

function tokenLabel(run: AgentRunView): string {
  if (!run.tokenUsage) return "未提供";
  return `${run.tokenUsage.totalTokens.toLocaleString()} tokens`;
}

/**
 * Agent Operations Center.
 *
 * One surface that reads the single `agent_runs` table and lets a researcher
 * cancel a run that is still in flight and retry one that failed. It does not
 * mint a second run system and it never writes evidence or verdicts on a run's
 * behalf — cancel only ever records `cancelled_by_user`, and retry re-runs the
 * same agent work (challenges and response claims), which the rest of the app
 * already treats as proposals, not conclusions.
 */
export function AgentOpsPanel({
  sessionId,
  canEdit
}: {
  sessionId: string;
  canEdit: boolean;
}) {
  const [runs, setRuns] = useState<AgentRunView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // The run waiting for a confirmation before it is cancelled. A cancel is
  // terminal for that run, so it is asked for rather than assumed.
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await listAgentRuns(sessionId);
      setRuns(next.runs);
      setLoadError(null);
    } catch (cause) {
      setLoadError(
        cause instanceof Error ? cause.message : "无法读取运行列表"
      );
    }
  }, [sessionId]);

  // The list is live: re-read every few seconds, but pause while the tab is
  // hidden so a background session does not keep hitting the API.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void reload();
    };
    void reload();
    timer = setInterval(tick, 5000);
    const onVisible = () => {
      if (!document.hidden) void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      void cancelled;
    };
  }, [reload]);

  const openRun = useCallback(
    async (runId: string) => {
      setSelectedRunId(runId);
      setDetail(null);
      setDetailError(null);
      setActionError(null);
      try {
        const next = await getAgentRun(sessionId, runId);
        setDetail(next);
      } catch (cause) {
        setDetailError(
          cause instanceof Error ? cause.message : "无法读取运行详情"
        );
      }
    },
    [sessionId]
  );

  async function doCancel(runId: string) {
    setBusy(true);
    setActionError(null);
    try {
      await cancelAgentRun(sessionId, runId);
      await reload();
      if (selectedRunId) await openRun(selectedRunId);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "取消失败");
    } finally {
      setBusy(false);
    }
  }

  async function doRetry(runId: string) {
    setBusy(true);
    setActionError(null);
    try {
      await retryAgentRun(sessionId, runId);
      await reload();
      if (selectedRunId) await openRun(selectedRunId);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "重试失败");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="research-column">
        <Notice
          eyebrow="AGENT OPS / 读取失败"
          title="无法读取 Agent 运行列表"
          reason={loadError}
          hint="运行记录仍在 core 服务里；重试只是重新读取，不会取消或重跑任何一次运行。"
          role="alert"
          testId="agent-ops-load-error"
          actions={<Button onClick={() => void reload()}>重试</Button>}
        />
      </div>
    );
  }

  if (!runs) {
    return (
      <div className="research-column">
        <div className="research-empty">正在载入 Agent 运行中心…</div>
      </div>
    );
  }

  const selected = detail ?? null;
  const selectedMeta = runs.find((run) => run.id === selectedRunId) ?? null;
  const shownRun: AgentRunView | null = selected ?? selectedMeta;

  return (
    <div className="research-column" data-testid="agent-ops-panel">
      <div className="agent-ops-grid">
        <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">
            Agent 运行中心（{runs.length}）
          </span>
          <button
            type="button"
            className="research-button research-button-secondary"
            onClick={() => void reload()}
          >
            刷新
          </button>
        </div>
        <p className="research-muted">
          这里展示的是同一张 <code>agent_runs</code> 表中的真实运行记录：状态、
          角色、耗时、Token 用量与失败原因。取消只记录「用户取消」，重试会开启一次
          新的运行（新的 id、更高的尝试次数、并指回被重试的运行），不会改动任何
          结论。
        </p>
        {runs.length === 0 ? (
          <p className="research-muted" style={{ marginTop: 8 }}>
            还没有任何 Agent 运行。可在「交叉审查」里对一条主张发起审查，运行会
            出现在这里。
          </p>
        ) : (
          <div className="research-table-scroll">
            <table className="research-table" data-testid="agent-run-list">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>角色</th>
                  <th>类型</th>
                  <th>开始</th>
                  <th>耗时</th>
                  <th>Token</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    key={run.id}
                    data-run-id={run.id}
                    data-run-status={run.status}
                    data-testid="agent-run-row"
                  >
                    <td>
                      <StatusPill tone={runStatusTone(run.status)}>
                        {agentRunStatusLabel(run.status)}
                      </StatusPill>
                    </td>
                    <td>{run.roleName}</td>
                    <td>{purposeLabel(run.purpose)}</td>
                    <td className="research-muted">
                      {formatDate(run.startedAt)}
                    </td>
                    <td className="research-muted">
                      {formatDuration(run.durationMs)}
                    </td>
                    <td className="research-muted">{tokenLabel(run)}</td>
                    <td>
                      <button
                        type="button"
                        className="research-button research-button-secondary"
                        onClick={() => void openRun(run.id)}
                      >
                        详情
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedRunId ? (
        <section className="research-panel" style={{ marginTop: 12 }}>
          <div className="research-panel-head">
            <span className="research-panel-title">运行详情</span>
            <button
              type="button"
              className="research-button research-button-secondary"
              onClick={() => {
                setSelectedRunId(null);
                setDetail(null);
              }}
            >
              关闭
            </button>
          </div>
          {detailError ? (
            <p className="research-error" role="alert">
              {detailError}
            </p>
          ) : !shownRun ? (
            <p className="research-muted">正在载入…</p>
          ) : (
            <AgentRunDetailView
              run={shownRun}
              detail={detail}
              canEdit={canEdit}
              busy={busy}
              actionError={actionError}
              onCancel={() => setCancelTarget(shownRun.id)}
              onRetry={() => void doRetry(shownRun.id)}
            />
          )}
        </section>
      ) : null}
      <ConfirmDialog
        open={cancelTarget !== null}
        title="取消这次运行？"
        description="取消只记录「用户取消」，不会改动任何主张、证据或结论；这次运行已经产生的质询与回应仍会保留在运行记录中。取消无法撤销。"
        confirmLabel="取消运行"
        busy={busy}
        testId="agent-run-cancel-dialog"
        onCancel={() => setCancelTarget(null)}
        onConfirm={() => {
          const runId = cancelTarget;
          if (!runId) return;
          void (async () => {
            await doCancel(runId);
            setCancelTarget(null);
          })();
        }}
      />
      </div>
    </div>
  );
}

function AgentRunDetailView({
  run,
  detail,
  canEdit,
  busy,
  actionError,
  onCancel,
  onRetry
}: {
  run: AgentRunView;
  detail: AgentRunDetail | null;
  canEdit: boolean;
  busy: boolean;
  actionError: string | null;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const canCancel = canCancelRun(run.status);
  const canRetry = isRetryableRun(run.status);
  const cancelDisabledReason =
    !canEdit
      ? "观众不可取消运行"
      : !canCancel
        ? "该运行已结束，无法取消"
        : null;
  const retryDisabledReason =
    !canEdit
      ? "观众不可重试运行"
      : !canRetry
        ? "该运行不可重试"
        : null;

  return (
    <div>
      <dl className="research-deflist">
        <div>
          <dt>状态</dt>
          <dd>
            <StatusPill tone={runStatusTone(run.status)}>
              {agentRunStatusLabel(run.status)}
            </StatusPill>
          </dd>
        </div>
        <div>
          <dt>角色</dt>
          <dd>{run.roleName}</dd>
        </div>
        <div>
          <dt>类型</dt>
          <dd>{purposeLabel(run.purpose)}</dd>
        </div>
        <div>
          <dt>尝试</dt>
          <dd>第 {run.attempt} 次</dd>
        </div>
        {run.parentRunId ? (
          <div>
            <dt>重试自</dt>
            <dd className="research-muted">
              <code>{run.parentRunId.slice(0, 8)}</code>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>开始</dt>
          <dd className="research-muted">{formatDate(run.startedAt)}</dd>
        </div>
        <div>
          <dt>结束</dt>
          <dd className="research-muted">
            {run.completedAt ? formatDate(run.completedAt) : "—"}
          </dd>
        </div>
        <div>
          <dt>耗时</dt>
          <dd className="research-muted">
            {run.durationMs != null ? `${run.durationMs} ms` : "—"}
          </dd>
        </div>
        <div>
          <dt>Token 用量</dt>
          <dd className="research-muted">
            {run.tokenUsage
              ? `${run.tokenUsage.totalTokens.toLocaleString()}（提示 ${run.tokenUsage.promptTokens.toLocaleString()} / 补全 ${run.tokenUsage.completionTokens.toLocaleString()}）`
              : "未提供"}
          </dd>
        </div>
        {run.provider ? (
          <div>
            <dt>模型</dt>
            <dd className="research-muted">
              {run.provider}
              {run.model ? ` / ${run.model}` : ""}
            </dd>
          </div>
        ) : null}
      </dl>

      {run.status === "failed" || run.status === "timed_out" ? (
        <div className="research-panel" style={{ marginTop: 8 }}>
          <div className="research-panel-head">
            <span className="research-panel-title">失败诊断</span>
          </div>
          {run.errorCode ? (
            <p>
              <StatusPill tone="research-pill-rejected">
                {agentRunFailureCodeLabel(run.errorCode)}
              </StatusPill>{" "}
              <span className="research-muted">{run.errorCode}</span>
            </p>
          ) : (
            <p className="research-muted">未记录失败类别。</p>
          )}
          {run.error ? (
            <p className="research-error" role="alert">
              {run.error}
            </p>
          ) : null}
        </div>
      ) : null}

      {detail ? (
        <div className="research-panel" style={{ marginTop: 8 }}>
          <div className="research-panel-head">
            <span className="research-panel-title">
              事件时间线（{detail.events.length}）
            </span>
          </div>
          {detail.events.length === 0 ? (
            <p className="research-muted">该运行没有记录到事件。</p>
          ) : (
            <ol className="research-timeline" data-testid="agent-run-events">
              {detail.events.map((event) => (
                <li key={event.sequence}>
                  <span className="research-muted">#{event.sequence}</span>{" "}
                  <code>{event.type}</code>{" "}
                  <span className="research-muted">
                    {formatDate(event.occurredAt)}
                  </span>
                </li>
              ))}
            </ol>
          )}

          <div className="research-panel-head" style={{ marginTop: 8 }}>
            <span className="research-panel-title">关联产出</span>
          </div>
          <p className="research-muted">
            质询 {detail.outcome.challengeIds.length} · 冲突{" "}
            {detail.outcome.conflictIds.length} · 回应主张{" "}
            {detail.outcome.responseClaimIds.length}
          </p>
        </div>
      ) : (
        <p className="research-muted" style={{ marginTop: 8 }}>
          正在载入事件与关联产出…
        </p>
      )}

      <div className="research-actions" style={{ marginTop: 12 }}>
        {actionError ? (
          <p className="research-error" role="alert">
            {actionError}
          </p>
        ) : null}
        <button
          type="button"
          className="research-button research-button-secondary"
          disabled={busy || cancelDisabledReason !== null}
          title={cancelDisabledReason ?? undefined}
          onClick={onCancel}
          data-testid="agent-run-cancel"
        >
          {run.status === "cancelled" ? "已取消" : "取消运行"}
        </button>
        {/* The reason a control is off used to live only in `title`, which a
            keyboard or screen-reader user never sees. It is real content, so
            it is rendered where everyone can read it. */}
        {cancelDisabledReason ? (
          <span className="research-muted" data-testid="agent-run-cancel-reason">
            {cancelDisabledReason}
          </span>
        ) : null}
        <button
          type="button"
          className="research-button"
          disabled={busy || retryDisabledReason !== null}
          title={retryDisabledReason ?? undefined}
          onClick={onRetry}
          data-testid="agent-run-retry"
        >
          重试运行
        </button>
        {retryDisabledReason ? (
          <span className="research-muted" data-testid="agent-run-retry-reason">
            {retryDisabledReason}
          </span>
        ) : null}
      </div>
    </div>
  );
}
