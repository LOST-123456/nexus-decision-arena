import {
  conflictTypeLabel,
  humanActionShortLabel,
  type Conflict,
  type HumanDecision
} from "@nexus/shared";
import { useState } from "react";

type CheckpointRole = {
  id: string;
  name: string;
};

const defaultRationale: Record<HumanDecision["action"], string> = {
  accept_challenge: "质询依据充分，接受该质询结论。",
  uphold_claim: "经复核维持原判断，并保留持续监测要求。",
  request_more_analysis: "现有证据不足以裁决，要求补充一轮分析。"
};

/** 按钮点下去之后立刻要发生时的事，用来解释"为什么现在走不了"。 */
const pendingHint: Record<HumanDecision["action"], string> = {
  accept_challenge: "正在写入裁决并更新结论…",
  uphold_claim: "正在写入裁决并更新结论…",
  request_more_analysis:
    "已提交，正在跑补充的一轮分析（通常 5~15 秒）。这一轮会重新交叉质询，期间不能再次裁决。"
};

export function HumanCheckpoint({
  conflictSummary,
  conflictType,
  roles = [],
  onDecision,
  pending = false,
  pendingAction = null,
  round,
  queue,
  lastOutcome = null,
  errorMessage,
  previewOnly = false
}: {
  conflictSummary: string;
  /** 这条冲突属于哪一类分歧。只给枚举名用户判断不了该补材料还是该改判断。 */
  conflictType?: Conflict["type"];
  roles?: readonly CheckpointRole[];
  onDecision(
    action: HumanDecision["action"],
    rationale: string,
    affectedAgentRoleIds: string[]
  ): void;
  /** @deprecated 由 `pendingAction` 取代；保留是为了不破坏既有调用方。 */
  pending?: boolean;
  /** 正在提交的那个动作。它显示进度，另外两个显示"为什么现在点不了"。 */
  pendingAction?: HumanDecision["action"] | null;
  /** 当前是第几轮（人工裁决 + 补充分析的轮次），从 1 起。 */
  round?: number;
  /** 本轮还有几条待裁决，以及当前这条排第几。 */
  queue?: { position: number; total: number };
  /** 上一次裁决的结果，用来回答"我刚点的那个到底生效没有"。 */
  lastOutcome?: {
    action: HumanDecision["action"];
    previousConclusion: string;
    conclusion: string;
  } | null;
  errorMessage?: string;
  previewOnly?: boolean;
}) {
  const [rationale, setRationale] = useState("");
  const [affectedAgentRoleIds, setAffectedAgentRoleIds] = useState<string[]>([]);

  const busy = pending || pendingAction !== null;
  const actionLabel = (action: HumanDecision["action"]): string =>
    humanActionShortLabel(action);

  function submit(action: HumanDecision["action"]): void {
    if (busy) return;
    onDecision(
      action,
      rationale.trim() || defaultRationale[action],
      affectedAgentRoleIds
    );
  }

  function toggleRole(roleId: string): void {
    setAffectedAgentRoleIds((current) =>
      current.includes(roleId)
        ? current.filter((id) => id !== roleId)
        : [...current, roleId]
    );
  }

  const meta = [
    round !== undefined ? `第 ${round} 轮` : null,
    queue ? `本轮待裁决 ${queue.position} / ${queue.total}` : null
  ].filter((item): item is string => item !== null);

  return (
    <section
      className="human-checkpoint"
      aria-label={previewOnly ? "Human Checkpoint preview only" : "Human Checkpoint"}
      aria-busy={busy}
    >
      <div className="checkpoint-heading">
        <p className="eyebrow">HUMAN CHECKPOINT</p>
        {previewOnly ? (
          <span className="checkpoint-mode">PREVIEW / NOT PERSISTED</span>
        ) : null}
      </div>

      {errorMessage ? (
        <p className="checkpoint-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {lastOutcome ? (
        <p className="checkpoint-last-outcome" aria-live="polite">
          <span>上一步</span>
          <strong>{actionLabel(lastOutcome.action)}</strong>
          <span aria-hidden="true">{"›"}</span>
          <span>
            结论 {lastOutcome.previousConclusion} {"→"}{" "}
            <strong>{lastOutcome.conclusion}</strong>
          </span>
        </p>
      ) : null}

      <h2>{conflictSummary}</h2>
      {conflictType || meta.length > 0 ? (
        <p className="checkpoint-meta">
          {conflictType ? (
            <span className={`checkpoint-type checkpoint-type-${conflictType}`}>
              {conflictTypeLabel(conflictType)}
            </span>
          ) : null}
          {meta.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </p>
      ) : null}

      <label className="checkpoint-rationale">
        <span>人工理由</span>
        <textarea
          rows={3}
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          placeholder="说明采纳、维持或要求补充分析的具体依据"
          disabled={busy}
        />
      </label>

      {roles.length > 0 ? (
        <fieldset className="checkpoint-impact" disabled={busy}>
          <legend>影响范围</legend>
          <div className="checkpoint-impact-options">
            {roles.map((role) => (
              <label key={role.id}>
                <input
                  type="checkbox"
                  checked={affectedAgentRoleIds.includes(role.id)}
                  onChange={() => toggleRole(role.id)}
                />
                <span>{role.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <div className="human-checkpoint-actions">
        {(
          [
            ["accept_challenge", "checkpoint-action checkpoint-action-accept"],
            ["uphold_claim", "checkpoint-action checkpoint-action-uphold"],
            ["request_more_analysis", "checkpoint-action checkpoint-action-more"]
          ] as const
        ).map(([action, className]) => {
          const isThisOne = pendingAction === action;
          return (
            <button
              key={action}
              type="button"
              className={`${className}${isThisOne ? " is-pending" : ""}`}
              disabled={busy}
              aria-busy={isThisOne}
              /**
               * 被挡住不等于没反应：三个按钮同时变灰会让人以为界面坏了，
               * 所以把"为什么现在点不了"写在按钮自己的提示里。
               */
              {...(busy && !isThisOne
                ? { title: "这一轮提交还在进行，完成后才能再选" }
                : {})}
              onClick={() => submit(action)}
            >
              {isThisOne ? "提交中…" : actionLabel(action)}
            </button>
          );
        })}
      </div>

      {pendingAction ? (
        <p className="checkpoint-progress" role="status" aria-live="polite">
          {pendingHint[pendingAction]}
        </p>
      ) : null}
    </section>
  );
}
