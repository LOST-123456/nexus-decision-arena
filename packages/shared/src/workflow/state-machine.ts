export const SESSION_PHASES = [
  "CREATED",
  "PLANNING",
  "ANALYZING",
  "CHALLENGING",
  "CONFLICT_DETECTED",
  "HUMAN_REVIEW",
  "REASSESSING",
  "DECIDED",
  "REPORT_READY"
] as const;

export type SessionPhase = (typeof SESSION_PHASES)[number];

/**
 * 运行阶段的中文说法。
 *
 * 页面以前直接 `phase.replaceAll("_", " ")`，于是用户看到的是
 * `REASSESSING` —— 一个只有当过开发的人才认得的词。阶段名是产品对用户
 * 讲"现在做到哪一步"的话术，属于领域语言，放在这里统一维护。
 */
export const SESSION_PHASE_LABELS: Record<SessionPhase, string> = {
  CREATED: "已创建",
  PLANNING: "拆解中",
  ANALYZING: "多角色分析中",
  CHALLENGING: "交叉质询中",
  CONFLICT_DETECTED: "冲突已识别",
  HUMAN_REVIEW: "等待人工裁决",
  REASSESSING: "补充分析中",
  DECIDED: "已形成结论",
  REPORT_READY: "报告已就绪"
};

export function sessionPhaseLabel(phase: string): string {
  return phase in SESSION_PHASE_LABELS
    ? SESSION_PHASE_LABELS[phase as SessionPhase]
    : phase;
}

/** 阶段是否意味着"后台正在干活"——界面据此显示进行中占位而不是空白。 */
export function isPhaseWorking(phase: string): boolean {
  return (
    phase === "PLANNING" ||
    phase === "ANALYZING" ||
    phase === "CHALLENGING" ||
    phase === "REASSESSING"
  );
}

/**
 * 一轮评审在后台要走的步数。
 *
 * 为什么需要：从「多角色分析中」到「交叉质询中」中间隔着十几秒，页面上
 * 只有阶段名和时针在动，用户看到的是一块几乎静止的屏。有了步序号，「第 2
 * 步 / 共 4 步」本身就说明了还剩几步，等待就有了长度。
 *
 * 只收后台自己走的四步：人工裁决与出结论不是机器步，混进来会让分母忽大忽小。
 */
export const SESSION_RUN_STEPS = [
  "PLANNING",
  "ANALYZING",
  "CHALLENGING",
  "CONFLICT_DETECTED"
] as const;

/**
 * 当前阶段是这一轮的第几步。
 *
 * 返回 `null` 表示「不在机器的某一步上」——已创建、等待人工、已出结论都
 * 不算；强给一个数字会让「共 4 步」变成谎话。`REASSESSING` 是回到第 2 步
 * 重跑（重新分析），所以步号往回走是对的，页面需要说明这是回头不是退步。
 */
export function sessionPhaseStep(
  phase: string
): { step: number; total: number; label: string; restarted: boolean } | null {
  const total = SESSION_RUN_STEPS.length;
  if (phase === "REASSESSING") {
    return {
      step: SESSION_RUN_STEPS.indexOf("ANALYZING") + 1,
      total,
      label: "重新分析",
      restarted: true
    };
  }
  const index = SESSION_RUN_STEPS.indexOf(
    phase as (typeof SESSION_RUN_STEPS)[number]
  );
  if (index < 0) {
    return null;
  }
  return {
    step: index + 1,
    total,
    label: SESSION_PHASE_LABELS[SESSION_RUN_STEPS[index] as SessionPhase],
    restarted: false
  };
}

/**
 * 现在的结论是不是还没定稿。
 *
 * AI 在质询前就会写下一个倾向，之后可能被自己推翻（实测第 3 秒写「建议
 * 立项」，第 13 秒改成「暂缓规模化扩张」）。把它摆在页头叫「当前结论」，
 * 读的人会当成终局，后面再变就是「系统改口」。所以：只有 DECIDED 之后才
 * 叫结论，之前一律是「初步倾向」，并且明确标注未定稿。
 */
export function isConclusionFinal(phase: string): boolean {
  return phase === "DECIDED" || phase === "REPORT_READY";
}

const transitions: Record<SessionPhase, readonly SessionPhase[]> = {
  CREATED: ["PLANNING"],
  PLANNING: ["ANALYZING"],
  ANALYZING: ["CHALLENGING"],
  CHALLENGING: ["CONFLICT_DETECTED", "DECIDED"],
  CONFLICT_DETECTED: ["HUMAN_REVIEW", "DECIDED"],
  HUMAN_REVIEW: ["REASSESSING", "DECIDED"],
  REASSESSING: ["CHALLENGING", "DECIDED"],
  DECIDED: ["REPORT_READY"],
  REPORT_READY: []
};

export function canTransition(
  from: SessionPhase,
  to: SessionPhase
): boolean {
  return transitions[from].includes(to);
}

export function transitionSession(
  from: SessionPhase,
  to: SessionPhase
): SessionPhase {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid session transition: ${from} -> ${to}`);
  }
  return to;
}
