/**
 * 字还得看得清的最小缩放。
 *
 * 低于这个值，节点标题（0.81rem）就掉到 11px 以下。它是"阅读"的下限，
 * 不是"全览"的下限——这两件事原来被混成一个数，于是全览也被顶在 0.85。
 */
export const DECISION_MAP_MIN_READABLE_ZOOM = 0.85;

/**
 * 全览时必须允许缩到多小。
 *
 * 决策地图是固定五列布局（x = 0/300/600/900/1220，节点宽 200px）。一场真实
 * 会话有 26–36 个节点，图能到 1470px 宽、3500px 高；工作区中栏在 1280 视口
 * 下只有约 630×480。要真的把这样的图装进一屏，需要 0.14 倍左右。
 *
 * 缩放下限原来是 0.85，于是"全览"这件事根本做不到：fitView 装不下也照装，
 * 右侧整列冲突卡被画布边缘切掉，而页面上没有任何"还有内容"的痕迹。下限放
 * 到 0.05 之后，全览才是真的全览——哪怕它会小到只剩结构。
 *
 * 注意：这里是「手能缩到多小」，不是「打开时多大」。打开时的下限见
 * `fitViewMinZoom`，它仍然是可读尺度。
 */
export const DECISION_MAP_MIN_OVERVIEW_ZOOM = 0.05;

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
    /*
     * 手能动到的下限：允许一直缩到能装下整张图，否则「全览」按钮按了也没用
     * （React Flow 的 fitView 会被这一层 clamp 顶住）。
     */
    minZoom: DECISION_MAP_MIN_OVERVIEW_ZOOM,
    /*
     * 打开页面时的下限仍是可读尺度：先看得清，再谈看全。装不下时页面会明说
     * 「还有节点在视野外」并给一键全览——宁可默认可读、把全貌交给用户点，
     * 也不要默认给一屏看不清的小方块。
     */
    fitViewMinZoom: DECISION_MAP_MIN_READABLE_ZOOM,
    fitViewMaxZoom: mobile ? 1.15 : 1.2,
    fitViewPadding: mobile ? 0.08 : 0.16,
    panOnScroll: true
  };
}
