import { describe, expect, it } from "vitest";
import {
  agentRunFailureCodeLabel,
  agentRunStatusLabel,
  canCancelRun,
  canRetryRun,
  isRetrySupportedPurpose,
  isRetryableRun,
  isTerminalRun
} from "./agent-run";

describe("agent-run domain helpers", () => {
  it("labels every status", () => {
    expect(agentRunStatusLabel("queued")).toBe("排队中");
    expect(agentRunStatusLabel("running")).toBe("运行中");
    expect(agentRunStatusLabel("completed")).toBe("已完成");
    expect(agentRunStatusLabel("failed")).toBe("已失败");
    expect(agentRunStatusLabel("cancelled")).toBe("已取消");
    expect(agentRunStatusLabel("timed_out")).toBe("已超时");
  });

  it("labels every failure code", () => {
    expect(agentRunFailureCodeLabel("provider_timeout")).toBe("模型超时");
    expect(agentRunFailureCodeLabel("cancelled_by_user")).toBe("用户取消");
    expect(agentRunFailureCodeLabel("internal_error")).toBe("内部错误");
  });

  it("only failed / timed_out runs are retryable", () => {
    expect(isRetryableRun("failed")).toBe(true);
    expect(isRetryableRun("timed_out")).toBe(true);
    expect(isRetryableRun("completed")).toBe(false);
    expect(isRetryableRun("cancelled")).toBe(false);
    expect(isRetryableRun("running")).toBe(false);
    expect(isRetryableRun("queued")).toBe(false);
  });

  it("terminal runs cannot be cancelled", () => {
    expect(isTerminalRun("completed")).toBe(true);
    expect(isTerminalRun("cancelled")).toBe(true);
    expect(isTerminalRun("failed")).toBe(true);
    expect(isTerminalRun("timed_out")).toBe(true);
    expect(isTerminalRun("running")).toBe(false);
    expect(isTerminalRun("queued")).toBe(false);
  });

  it("only queued / running runs can be cancelled", () => {
    expect(canCancelRun("queued")).toBe(true);
    expect(canCancelRun("running")).toBe(true);
    expect(canCancelRun("completed")).toBe(false);
    expect(canCancelRun("failed")).toBe(false);
    expect(canCancelRun("cancelled")).toBe(false);
    expect(canCancelRun("timed_out")).toBe(false);
  });

  it("retry is wired for cross-review only", () => {
    expect(isRetrySupportedPurpose("cross_review")).toBe(true);
    expect(isRetrySupportedPurpose("analysis")).toBe(false);
  });

  it("a run can be retried only when both the state and the purpose allow it", () => {
    expect(canRetryRun({ status: "failed", purpose: "cross_review" })).toBe(true);
    expect(canRetryRun({ status: "timed_out", purpose: "cross_review" })).toBe(true);
    // The state is fine, the task type is not: a different answer, and the UI
    // has to say it differently from "this run has ended".
    expect(canRetryRun({ status: "failed", purpose: "analysis" })).toBe(false);
    // The purpose is fine, the state is not.
    expect(canRetryRun({ status: "completed", purpose: "cross_review" })).toBe(false);
    expect(canRetryRun({ status: "cancelled", purpose: "cross_review" })).toBe(false);
    expect(canRetryRun({ status: "running", purpose: "cross_review" })).toBe(false);
    expect(canRetryRun({ status: "queued", purpose: "cross_review" })).toBe(false);
  });
});
