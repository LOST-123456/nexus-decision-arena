import { describe, expect, it } from "vitest";
import {
  DECISION_MAP_MIN_OVERVIEW_ZOOM,
  DECISION_MAP_MIN_READABLE_ZOOM,
  getDecisionMapSizingPolicy
} from "./map-layout";

describe("Decision Map sizing policy", () => {
  /**
   * 「看全」和「看清」是两个下限，不能合成一个数。
   *
   * 合成 0.85 的后果真实发生过：图比中栏大，fitView 装不下也照装，右侧冲突
   * 卡被画布边缘切掉且无提示。合成 0.3 又会让 26 个节点的图开局就是 30%，
   * 满屏看不清的小方块。
   *
   * 所以：手能缩到 0.3（全览才真的能全），打开页面仍按 0.85 起（先看清）。
   */
  it("keeps an overview floor far below the reading floor", () => {
    const desktop = getDecisionMapSizingPolicy(1440);
    const mobile = getDecisionMapSizingPolicy(390);

    expect(DECISION_MAP_MIN_OVERVIEW_ZOOM).toBeLessThan(
      DECISION_MAP_MIN_READABLE_ZOOM
    );
    for (const policy of [desktop, mobile]) {
      // 全览按钮真的能把整张图装进来：36 个节点的图（约 1470×3500）放进
      // 630×480 的中栏要 0.14 倍左右，下限必须容得下，否则按钮按了没用。
      expect(policy.minZoom).toBe(DECISION_MAP_MIN_OVERVIEW_ZOOM);
      expect(policy.minZoom).toBeLessThanOrEqual(0.2);
      // 但开局仍然是可读尺度，而不是一屏小方块。
      expect(policy.fitViewMinZoom).toBe(DECISION_MAP_MIN_READABLE_ZOOM);
      expect(policy.panOnScroll).toBe(true);
    }
  });
});
