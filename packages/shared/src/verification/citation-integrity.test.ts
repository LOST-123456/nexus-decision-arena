import { describe, expect, it } from "vitest";
import {
  currentAssessments,
  summarizeClaimSupport,
  type ClaimSupportAssessment,
  type SupportAssessmentStatus
} from "./citation-integrity";

/**
 * The roll-up rules.
 *
 * The rule under test throughout: support and opposition do not cancel out.
 * A claim with three supporters and one opponent is `mixed` — the number of
 * items on each side is reported, never used to pick a winner. And an
 * assessment whose cited fragment could not be found in the source is counted
 * and surfaced, never treated as support.
 */

let counter = 0;

function assessment(
  status: SupportAssessmentStatus,
  options: {
    claimId?: string;
    evidenceId?: string;
    located?: boolean;
    createdAt?: string;
  } = {}
): ClaimSupportAssessment {
  counter += 1;
  return {
    id: `assessment-${counter}`,
    sessionId: "session-1",
    claimId: options.claimId ?? "claim-1",
    evidenceId: options.evidenceId ?? `evidence-${counter}`,
    status,
    confidence: 0.7,
    rationale: "because the excerpt says so",
    matchedExcerpt: "a fragment",
    matchedExcerptLocated: options.located ?? true,
    signals: [],
    provider: "FakeProvider",
    model: "fake-model",
    promptVersion: "citation-review-v1",
    origin: "model",
    actor: "Researcher (researcher)",
    supersedesId: null,
    isCurrent: true,
    createdAt: options.createdAt ?? new Date().toISOString()
  };
}

describe("summarizeClaimSupport", () => {
  it("reports 'unassessed' when nothing has been read yet", () => {
    const summary = summarizeClaimSupport("claim-1", []);
    expect(summary.status).toBe("unassessed");
    expect(summary.counts.support).toBe(0);
  });

  it("reports a failure as the state rather than an empty success", () => {
    const summary = summarizeClaimSupport("claim-1", [], { unavailable: true });
    expect(summary.status).toBe("unavailable");
    expect(summary.note).toContain("支持度评估未能完成");
  });

  it("returns 'support' only when nothing opposes", () => {
    const summary = summarizeClaimSupport("claim-1", [
      assessment("support"),
      assessment("support")
    ]);
    expect(summary.status).toBe("support");
    expect(summary.counts.support).toBe(2);
  });

  it("returns 'mixed' when both directions exist, without picking a winner", () => {
    const summary = summarizeClaimSupport("claim-1", [
      assessment("support"),
      assessment("support"),
      assessment("support"),
      assessment("oppose")
    ]);
    expect(summary.status).toBe("mixed");
    expect(summary.counts.support).toBe(3);
    expect(summary.counts.oppose).toBe(1);
    expect(summary.note).toContain("不按条数多数裁决");
  });

  it("treats real-but-unpersuasive material as insufficient, not support", () => {
    const summary = summarizeClaimSupport("claim-1", [
      assessment("insufficient"),
      assessment("insufficient")
    ]);
    expect(summary.status).toBe("insufficient");
  });

  it("keeps background material out of the support count", () => {
    const summary = summarizeClaimSupport("claim-1", [assessment("context")]);
    expect(summary.status).toBe("context");
    expect(summary.counts.support).toBe(0);
  });

  it("names the unlocated fragments instead of counting them", () => {
    const summary = summarizeClaimSupport("claim-1", [
      assessment("support", { located: false }),
      assessment("support")
    ]);
    expect(summary.status).toBe("support");
    expect(summary.unlocatedCount).toBe(1);
    expect(summary.note).toContain("未能在来源中找到");
  });
});

describe("currentAssessments", () => {
  it("keeps only the newest assessment per (claim, excerpt) pair", () => {
    const older = assessment("support", {
      claimId: "claim-1",
      evidenceId: "evidence-1",
      createdAt: "2026-10-01T00:00:00.000Z"
    });
    const newer = assessment("oppose", {
      claimId: "claim-1",
      evidenceId: "evidence-1",
      createdAt: "2026-10-02T00:00:00.000Z"
    });
    const other = assessment("support", {
      claimId: "claim-1",
      evidenceId: "evidence-2",
      createdAt: "2026-10-02T00:00:00.000Z"
    });
    const result = currentAssessments([older, newer, other]);
    expect(result).toHaveLength(2);
    expect(result.find((item) => item.evidenceId === "evidence-1")?.id).toBe(
      newer.id
    );
  });
});
