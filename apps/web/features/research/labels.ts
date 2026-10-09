import type {
  AgentRun,
  Challenge,
  ClaimReviewOutcome,
  ClaimStatus,
  ClaimVerdictStatus,
  EvidenceDirection,
  EvidenceKind,
  SessionPhase
} from "@nexus/shared";

/**
 * Display text for the four things the domain keeps strictly apart:
 *   1. workflow phase        — where the research is
 *   2. evidence verification — whether one excerpt was checked
 *   3. claim status          — the claim's standing in the debate
 *   4. fact-check verdict    — what can be concluded about a claim
 *
 * `accepted` / `rejected` are deliberately NOT rendered as true / false: a
 * claim can be accepted by the panel and still carry an `insufficient_evidence`
 * verdict, and those must stay visibly different.
 */

export function verificationLabel(
  status: "unverified" | "verified" | "rejected"
): string {
  if (status === "verified") return "已核实";
  if (status === "rejected") return "已驳回";
  return "待核实";
}

export function directionLabel(direction: EvidenceDirection): string {
  if (direction === "supports") return "支持";
  if (direction === "opposes") return "反对";
  return "背景";
}

export function directionTone(direction: EvidenceDirection): string {
  if (direction === "supports") return "research-pill-supports";
  if (direction === "opposes") return "research-pill-opposes";
  return "research-pill-context";
}

export function verificationTone(
  status: "unverified" | "verified" | "rejected"
): string {
  if (status === "verified") return "research-pill-verified";
  if (status === "rejected") return "research-pill-rejected";
  return "research-pill-unverified";
}

export function evidenceKindLabel(kind: EvidenceKind): string {
  if (kind === "external_reference") return "外部来源";
  if (kind === "calculation") return "推算";
  if (kind === "project_input") return "项目输入";
  return "假设";
}

export function sourceKindLabel(
  kind: "url" | "document" | "dataset" | "manual"
): string {
  if (kind === "url") return "网页";
  if (kind === "document") return "文档";
  if (kind === "dataset") return "数据集";
  return "手工录入";
}

export function claimStatusLabel(status: ClaimStatus): string {
  if (status === "accepted") return "已采纳（内部结论）";
  if (status === "rejected") return "已否决（内部结论）";
  if (status === "contested") return "有争议";
  if (status === "supported") return "有支持证据";
  return "待评估";
}

export function verdictLabel(status: ClaimVerdictStatus): string {
  switch (status) {
    case "supported":
      return "有已核实支持证据";
    case "refuted":
      return "有已核实反对证据";
    case "mixed_evidence":
      return "证据相互冲突";
    case "inconclusive":
      return "交叉审查后仍未确定";
    case "insufficient_evidence":
      return "证据不足，未下结论";
    case "context_only":
      return "仅有背景材料";
    default:
      return "无任何证据";
  }
}

/** Tone for a verdict pill; kept in one place so it cannot drift per page. */
export function verdictTone(status: ClaimVerdictStatus): string {
  if (status === "supported") return "research-pill-verified";
  if (status === "refuted") return "research-pill-rejected";
  if (status === "mixed_evidence" || status === "inconclusive") {
    return "research-pill-unverified";
  }
  return "research-pill-neutral";
}

export function runStatusLabel(status: AgentRun["status"]): string {
  if (status === "running") return "运行中";
  if (status === "completed") return "已完成";
  return "已失败";
}

export function runStatusTone(status: AgentRun["status"]): string {
  if (status === "completed") return "research-pill-verified";
  if (status === "failed") return "research-pill-rejected";
  return "research-pill-neutral";
}

export function runPurposeLabel(purpose: AgentRun["purpose"]): string {
  return purpose === "cross_review" ? "交叉审查" : "角色分析";
}

export function reviewOutcomeLabel(outcome: ClaimReviewOutcome): string {
  if (outcome === "confirmed") return "确认结论";
  if (outcome === "rejected") return "否证主张";
  return "要求补证据";
}

export function reviewOutcomeTone(outcome: ClaimReviewOutcome): string {
  if (outcome === "confirmed") return "research-pill-verified";
  if (outcome === "rejected") return "research-pill-rejected";
  return "research-pill-unverified";
}

export function challengeTypeLabel(type: Challenge["type"]): string {
  switch (type) {
    case "evidence_gap":
      return "证据缺口";
    case "logic_flaw":
      return "逻辑缺陷";
    case "contradiction":
      return "相互矛盾";
    case "feasibility":
      return "可行性";
    default:
      return "优先级";
  }
}

export function challengeStatusLabel(status: Challenge["status"]): string {
  switch (status) {
    case "open":
      return "待回应";
    case "answered":
      return "已回应";
    case "validating":
      return "验证中";
    case "resolved":
      return "已解决";
    default:
      return "未解决";
  }
}

export function challengeStatusTone(status: Challenge["status"]): string {
  if (status === "resolved") return "research-pill-verified";
  if (status === "unresolved") return "research-pill-rejected";
  return "research-pill-unverified";
}

export function resolutionStrategyLabel(
  strategy: Challenge["resolutionStrategy"]
): string {
  switch (strategy) {
    case "provide_evidence":
      return "需补充证据";
    case "revise_claim":
      return "需修订主张";
    case "withdraw_claim":
      return "需撤回主张";
    default:
      return "需人工裁定";
  }
}

export function citationStatusLabel(
  status: "linked" | "url_only" | "unlinked"
): string {
  if (status === "linked") return "已登记来源";
  if (status === "url_only") return "仅有链接";
  return "无来源记录";
}

export function citationStatusTone(
  status: "linked" | "url_only" | "unlinked"
): string {
  if (status === "linked") return "research-pill-verified";
  if (status === "url_only") return "research-pill-unverified";
  return "research-pill-rejected";
}

export function workflowLabel(phase: string): string {
  const known: Record<SessionPhase, string> = {
    CREATED: "待启动",
    PLANNING: "规划中",
    ANALYZING: "分析中",
    CHALLENGING: "交叉质询中",
    CONFLICT_DETECTED: "发现分歧",
    HUMAN_REVIEW: "待人工裁定",
    REASSESSING: "复议中",
    DECIDED: "已裁定",
    REPORT_READY: "报告已生成"
  };
  return known[phase as SessionPhase] ?? phase;
}

/** Verification backlog wording used on Research Home. */
export function pendingVerificationLabel(count: number): string {
  return count === 0 ? "无待核实材料" : `${count} 条待核实`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}
