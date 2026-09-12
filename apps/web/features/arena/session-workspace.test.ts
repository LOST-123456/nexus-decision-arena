import { describe, expect, it } from "vitest";
import { isReportAvailable, previewSnapshotAt } from "./session-workspace";

describe("session workspace replay", () => {
  it("restores map state at the selected sequence", () => {
    const analyzing = previewSnapshotAt(8, "demo");
    const checkpoint = previewSnapshotAt(42, "demo");

    expect(analyzing).toMatchObject({
      phase: "ANALYZING",
      operationalStatus: "ACTIVE",
      currentConclusion: "建议立项",
      lastSequence: 8
    });
    expect(analyzing.claims).toHaveLength(0);
    expect(checkpoint).toMatchObject({
      phase: "HUMAN_REVIEW",
      operationalStatus: "PAUSED",
      lastSequence: 42
    });
    expect(checkpoint.claims.length).toBeGreaterThan(0);
    expect(checkpoint.conflicts[0]?.status).toBe("human_review");
  });
  it("only exposes reports for terminal decision phases", () => {
    expect(isReportAvailable("HUMAN_REVIEW")).toBe(false);
    expect(isReportAvailable("REASSESSING")).toBe(false);
    expect(isReportAvailable("DECIDED")).toBe(true);
    expect(isReportAvailable("REPORT_READY")).toBe(true);
  });
});
