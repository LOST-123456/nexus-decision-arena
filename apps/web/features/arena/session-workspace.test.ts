import { describe, expect, it } from "vitest";
import { previewSnapshotAt } from "./session-workspace";

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
});
