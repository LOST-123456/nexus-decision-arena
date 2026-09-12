import { describe, expect, it } from "vitest";
import { toPreviewInspectorDTO } from "./preview-inspector";
import { previewSession } from "./preview-session";

describe("preview Inspector fixture", () => {
  it("uses the shared DTO contract for preview data", () => {
    const inspector = toPreviewInspectorDTO(previewSession);

    expect(inspector?.claim.statement).toBe(
      previewSession.claims[0]?.statement
    );
    expect(inspector?.decisionRationale.summary).toBeTruthy();
    expect(inspector?.provenance).toEqual({
      agentRun: undefined,
      promptVersion: undefined
    });
  });
});
