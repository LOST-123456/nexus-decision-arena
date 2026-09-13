import type { HumanDecision } from "@nexus/shared";
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

export function HumanCheckpoint({
  conflictSummary,
  roles = [],
  onDecision,
  pending = false,
  errorMessage,
  previewOnly = false
}: {
  conflictSummary: string;
  roles?: readonly CheckpointRole[];
  onDecision(
    action: HumanDecision["action"],
    rationale: string,
    affectedAgentRoleIds: string[]
  ): void;
  pending?: boolean;
  errorMessage?: string;
  previewOnly?: boolean;
}) {
  const [rationale, setRationale] = useState("");
  const [affectedAgentRoleIds, setAffectedAgentRoleIds] = useState<string[]>([]);

  function submit(action: HumanDecision["action"]): void {
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

  return (
    <section
      className="human-checkpoint"
      aria-label={previewOnly ? "Human Checkpoint preview only" : "Human Checkpoint"}
      aria-busy={pending}
    >
      <div className="checkpoint-heading">
        <p className="eyebrow">HUMAN CHECKPOINT</p>
        {previewOnly ? (
          <span className="checkpoint-mode">PREVIEW / NOT PERSISTED</span>
        ) : null}
      </div>
      <h2>{conflictSummary}</h2>

      <label className="checkpoint-rationale">
        <span>人工理由</span>
        <textarea
          rows={3}
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          placeholder="说明采纳、维持或要求补充分析的具体依据"
          disabled={pending}
        />
      </label>

      {roles.length > 0 ? (
        <fieldset className="checkpoint-impact" disabled={pending}>
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
        <button
          type="button"
          className="checkpoint-action checkpoint-action-accept"
          disabled={pending}
          onClick={() => submit("accept_challenge")}
        >
          采纳质询
        </button>
        <button
          type="button"
          className="checkpoint-action checkpoint-action-uphold"
          disabled={pending}
          onClick={() => submit("uphold_claim")}
        >
          维持判断
        </button>
        <button
          type="button"
          className="checkpoint-action checkpoint-action-more"
          disabled={pending}
          onClick={() => submit("request_more_analysis")}
        >
          要求补充分析
        </button>
      </div>

      {errorMessage ? (
        <p className="checkpoint-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </section>
  );
}