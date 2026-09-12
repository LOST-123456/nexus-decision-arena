import type { HumanDecision } from "@nexus/shared";

export function HumanCheckpoint({
  conflictSummary,
  onDecision,
  pending = false,
  errorMessage,
  previewOnly = false
}: {
  conflictSummary: string;
  onDecision(
    action: HumanDecision["action"],
    rationale: string
  ): void;
  pending?: boolean;
  errorMessage?: string;
  previewOnly?: boolean;
}) {
  return (
    <section
      className="human-checkpoint"
      aria-label={
        previewOnly
          ? "Human Checkpoint preview only"
          : "Human Checkpoint"
      }
      aria-busy={pending}
    >
      <div className="checkpoint-heading">
        <p className="eyebrow">HUMAN CHECKPOINT</p>
        {previewOnly ? (
          <span className="checkpoint-mode">PREVIEW / NOT PERSISTED</span>
        ) : null}
      </div>
      <h2>{conflictSummary}</h2>

      <div className="human-checkpoint-actions">
        <button
          type="button"
          className="checkpoint-action checkpoint-action-accept"
          disabled={pending}
          onClick={() =>
            onDecision(
              "accept_challenge",
              "\u8d28\u8be2\u4f9d\u636e\u5145\u5206"
            )
          }
        >
          {"\u91c7\u7eb3\u8d28\u8be2"}
        </button>
        <button
          type="button"
          className="checkpoint-action checkpoint-action-uphold"
          disabled={pending}
          onClick={() => onDecision("uphold_claim", "\u7ef4\u6301\u539f\u5224\u65ad")}
        >
          {"\u7ef4\u6301\u5224\u65ad"}
        </button>
        <button
          type="button"
          className="checkpoint-action checkpoint-action-more"
          disabled={pending}
          onClick={() =>
            onDecision("request_more_analysis", "\u8865\u5145\u6750\u6599")
          }
        >
          {"\u8981\u6c42\u8865\u5145\u5206\u6790"}
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