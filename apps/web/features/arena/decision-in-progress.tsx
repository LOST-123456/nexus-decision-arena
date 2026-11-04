"use client";

import { SESSION_RUN_STEPS, sessionPhaseLabel, sessionPhaseStep } from "@nexus/shared";
import { useEffect, useState } from "react";

/**
 * What sits in the decision column while the backend is working.
 *
 * Why this exists: a supplement round is a blocking server call that took
 * 25.5 seconds in the recorded session. Without a placeholder the panel that
 * held the three buttons simply disappeared and came back looking identical,
 * so a reviewer reasonably concluded their click had done nothing. This shows
 * the phase, the round, and a running clock — three independent signals that
 * the system is alive and which step it is on.
 */
export function DecisionInProgress({
  phase,
  round,
  pendingAction,
  failureMessage = null,
  progress = null,
  stallAfterSeconds = 180
}: {
  phase: string;
  round: number;
  /**
   * 后台那一轮报的错。补充分析不再压在 HTTP 请求上，失败回不到调用方，
   * 只能靠 core 写下的 AGENT_RUN_FAILED 事件带回来（见 supplement-failure.ts）。
   */
  failureMessage?: string | null;
  /**
   * 这一轮质询的进度：已提出 / 已完成 / 总数。
   *
   * 只有计时器的时候，"在推进"和"卡住了"长得一模一样；有了它，等待就是
   * 有形状的。两个口径分开是因为它们是两件事：问题问出来了不等于这一条
   * 走完了。
   */
  progress?: { asked: number; done: number; total: number } | null;
  /**
   * 多久之后开始怀疑"这一轮其实没在跑"。
   *
   * 补充分析改成后台执行之后，前端拿不到它的失败：如果那个后台任务挂了
   * （进程被关掉、模型报错），会话会一直停在 REASSESSING。这个计时器就是
   * 为了不让那一屏永远转下去。
   */
  stallAfterSeconds?: number;
  /**
   * Present only while the originating request is still open. When the phase
   * moves on but the response has not landed yet, the panel keeps explaining
   * itself instead of blinking back to an empty column.
   */
  pendingAction: string | null;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const label = sessionPhaseLabel(phase);
  const expectsHumanReview = phase !== "DECIDED";
  /**
   * 这一轮走到第几步。
   *
   * 实测首屏有 3–11 秒几乎完全静止：阶段名不变、时针在走，看着像卡死。
   * 「第 2 步 / 共 4 步」+ 四格进度条让等待有长度，也让阶段推进看得见。
   */
  const step = sessionPhaseStep(phase);

  return (
    <section
      className="decision-in-progress"
      aria-label="Analysis in progress"
      aria-live="polite"
    >
      <p className="eyebrow">WORKING</p>
      <h2>
        {label}
        <span className="decision-in-progress-round">第 {round} 轮</span>
      </h2>
      {step !== null ? (
        <div className="decision-in-progress-step">
          <p className="decision-in-progress-step-label">
            第 {step.step} 步 / 共 {step.total} 步
            <span aria-hidden="true">·</span>
            {step.label}
            {step.restarted ? "（回头重跑一遍分析）" : ""}
          </p>
          <ol
            className="decision-in-progress-step-track"
            aria-hidden="true"
            data-step={step.step}
          >
            {SESSION_RUN_STEPS.map((phaseName, index) => (
              <li
                key={phaseName}
                className={
                  index + 1 < step.step
                    ? "is-done"
                    : index + 1 === step.step
                      ? "is-current"
                      : ""
                }
              />
            ))}
          </ol>
        </div>
      ) : null}
      <p className="decision-in-progress-copy">
        {pendingAction === "request_more_analysis"
          ? "补充的一轮正在跑：重新逐条质询现有主张，并检查新材料是否足以回答这些质询。"
          : "这一轮正在推进，不需要你操作。"}
        {expectsHumanReview
          ? "完成后会回到这里，由你继续裁决。"
          : "完成后会直接给出结论。"}
      </p>
      {progress !== null && progress.total > 0 ? (
        <p className="decision-in-progress-progress" role="status">
          本轮共 {progress.total} 条质询
          <span aria-hidden="true">·</span>已提出 {progress.asked} 条
          <span aria-hidden="true">·</span>已完成 {progress.done} 条
          {progress.done >= progress.total ? "（全部走完，正在收尾）" : ""}
        </p>
      ) : null}
      {failureMessage !== null ? (
        <p className="decision-in-progress-stall" role="alert">
          后台这一轮没有跑起来：{failureMessage}
          。你的裁决已经存下来了，不会丢；先确认模型配置可用，再刷新本页看阶段有没有
          动。如果阶段仍然停在「重新评估」，说明这一轮没有接上，需要再提交一次「要求
          补充分析」。
        </p>
      ) : elapsed >= stallAfterSeconds ? (
        <p className="decision-in-progress-stall" role="status">
          已经 {formatElapsed(elapsed)} 没有进展。这一轮是在后台跑的，如果期间
          站点窗口被关掉过，它不会自己接上：重新启动站点后刷新本页；若阶段仍在
          这里不动，就再提交一次「要求补充分析」。
        </p>
      ) : null}
      <p className="decision-in-progress-clock">
        已进行 <strong>{formatElapsed(elapsed)}</strong>
        <span aria-hidden="true">·</span>
        <span>这一页会在结果回来时自动更新，不必刷新</span>
      </p>
    </section>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} 分 ${String(rest).padStart(2, "0")} 秒`;
}
