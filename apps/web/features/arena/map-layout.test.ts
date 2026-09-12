import { describe, expect, it } from "vitest";
import {
  DECISION_MAP_MIN_READABLE_ZOOM,
  getDecisionMapSizingPolicy
} from "./map-layout";

describe("Decision Map sizing policy", () => {
  it("keeps desktop and mobile zoom at a readable floor", () => {
    const desktop = getDecisionMapSizingPolicy(1440);
    const mobile = getDecisionMapSizingPolicy(390);

    expect(desktop.minZoom).toBeGreaterThanOrEqual(
      DECISION_MAP_MIN_READABLE_ZOOM
    );
    expect(mobile.minZoom).toBeGreaterThanOrEqual(
      DECISION_MAP_MIN_READABLE_ZOOM
    );
    expect(desktop.fitViewMinZoom).toBe(desktop.minZoom);
    expect(mobile.fitViewMinZoom).toBe(mobile.minZoom);
    expect(desktop.panOnScroll).toBe(true);
    expect(mobile.panOnScroll).toBe(true);
  });
});
