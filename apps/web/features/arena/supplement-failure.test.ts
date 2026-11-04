import type { ExecutionEvent } from "@nexus/shared";
import { describe, expect, it } from "vitest";
import { findSupplementFailure } from "./supplement-failure";

const SESSION = "0198f3c0-0000-7000-8000-00000000aa01";
const CORRELATION = "0198f3c0-0000-7000-8000-00000000bb01";

function event(
  sequence: number,
  type: ExecutionEvent["type"],
  payload: unknown
): ExecutionEvent {
  return {
    id: `0198f3c0-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: SESSION,
    sequence,
    correlationId: CORRELATION,
    type,
    payload,
    occurredAt: "2026-10-30T00:00:00.000Z"
  };
}

const reassessing = (sequence: number) =>
  event(sequence, "SESSION_STATE_CHANGED", { phase: "REASSESSING" });
const failed = (sequence: number, stage: string, message?: string) =>
  event(sequence, "AGENT_RUN_FAILED", { stage, message });

describe("findSupplementFailure", () => {
  it("把后台那一轮的失败原因交回页面", () => {
    const events = [
      reassessing(10),
      failed(11, "supplement_round", "model unreachable")
    ];
    expect(findSupplementFailure(events, "REASSESSING")).toBe(
      "model unreachable"
    );
  });

  it("阶段已经离开重新评估就不再提旧失败", () => {
    const events = [
      reassessing(10),
      failed(11, "supplement_round", "model unreachable"),
      event(12, "SESSION_STATE_CHANGED", {
        phase: "HUMAN_REVIEW",
        operationalStatus: "PAUSED"
      })
    ];
    expect(findSupplementFailure(events, "HUMAN_REVIEW")).toBeNull();
  });

  it("新一轮重新评估之后，上一轮的失败不再冒出来", () => {
    const events = [
      reassessing(10),
      failed(11, "supplement_round", "old failure"),
      event(12, "SESSION_STATE_CHANGED", { phase: "HUMAN_REVIEW" }),
      reassessing(20)
    ];
    expect(findSupplementFailure(events, "REASSESSING")).toBeNull();
  });

  it("别的阶段留下的失败不算到补充分析头上", () => {
    const events = [
      reassessing(10),
      failed(11, "claim_extraction", "extraction down")
    ];
    expect(findSupplementFailure(events, "REASSESSING")).toBeNull();
  });

  it("没有原因也照说，而不是装作没事", () => {
    const events = [reassessing(10), failed(11, "supplement_round")];
    expect(findSupplementFailure(events, "REASSESSING")).toBe(
      "没有留下失败原因"
    );
  });
});
