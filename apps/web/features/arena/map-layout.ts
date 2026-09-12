export const DECISION_MAP_MIN_READABLE_ZOOM = 0.85;

export type DecisionMapSizingPolicy = {
  minZoom: number;
  fitViewMinZoom: number;
  fitViewMaxZoom: number;
  fitViewPadding: number;
  panOnScroll: true;
};

export function getDecisionMapSizingPolicy(
  viewportWidth: number
): DecisionMapSizingPolicy {
  const mobile = viewportWidth < 768;

  return {
    minZoom: DECISION_MAP_MIN_READABLE_ZOOM,
    fitViewMinZoom: DECISION_MAP_MIN_READABLE_ZOOM,
    fitViewMaxZoom: mobile ? 1.15 : 1.2,
    fitViewPadding: mobile ? 0.08 : 0.16,
    panOnScroll: true
  };
}
