import type { HumanDecision } from "@nexus/shared";

export function HumanCheckpoint({
  conflictSummary,
  onDecision,
  pending = false,
  errorMessage
}: {
  conflictSummary: string;
  onDecision(
    action: HumanDecision["action"],
    rationale: string
  ): void;
  pending?: boolean;
  errorMessage?: string;
}) {
  return (
    <section
      className="human-checkpoint"
      aria-label="Human Checkpoint"
      aria-busy={pending}
    >
      <p className="eyebrow">HUMAN CHECKPOINT</p>
      <h2>{conflictSummary}</h2>

      <div className="human-checkpoint-actions">
        <button
          type="button"
          className="checkpoint-action checkpoint-action-accept"
          disabled={pending}
          onClick={() => onDecision("accept_challenge", "质询依据充分")}
        >
          采纳质询
        </button>
        <button
          type="button"
          className="checkpoint-action checkpoint-action-uphold"
          disabled={pending}
          onClick={() => onDecision("uphold_claim", "维持原判断")}
        >
          维持判断
        </button>
        <button
          type="button"
          className="checkpoint-action checkpoint-action-more"
          disabled={pending}
          onClick={() => onDecision("request_more_analysis", "补充材料")}
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
