import { CANDIDATE_CLAIM_TYPE_LABELS } from "@nexus/shared";
import type {
  CandidateClaimType,
  CandidateStatus,
  ClaimExtractionRun,
  ExtractionFailureCode,
  AgentRun,
  Challenge,
  ClaimReviewOutcome,
  ClaimStatus,
  ClaimVerdictExclusion,
  ClaimVerdictRule,
  ClaimVerdictStatus,
  EvidenceDirection,
  EvidenceGapAction,
  EvidenceGapKind,
  EvidenceGapSeverity,
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

/** The rule that produced a verdict, spelled out so it can be checked. */
export function verdictRuleLabel(rule: ClaimVerdictRule): string {
  switch (rule) {
    case "no_evidence":
      return "没有任何关联材料";
    case "no_verified_evidence":
      return "材料均未核实";
    case "verified_support_and_opposition":
      return "已核实支持与反对并存";
    case "support_blocked_by_open_challenge":
      return "支持被未解决质询阻断";
    case "opposition_blocked_by_open_challenge":
      return "反对被未解决质询阻断";
    case "verified_support_only":
      return "仅有已核实支持";
    case "verified_opposition_only":
      return "仅有已核实反对";
    default:
      return "仅有已核实背景材料";
  }
}

/** Why one excerpt did not take part in the verdict. */
export function exclusionReasonLabel(reason: ClaimVerdictExclusion["reason"]): string {
  switch (reason) {
    case "unverified":
      return "尚未核实";
    case "rejected":
      return "人工驳回";
    case "expired":
      return "超出有效期";
    default:
      return "尚未生效";
  }
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

/**
 * Evidence-gap wording. A gap is a diagnosis of what is missing, never a
 * claim about what was found, so the wording always points at the next step.
 */
export function gapSeverityLabel(severity: EvidenceGapSeverity): string {
  if (severity === "blocking") return "阻断";
  if (severity === "important") return "重要";
  return "提示";
}

export function gapSeverityTone(severity: EvidenceGapSeverity): string {
  if (severity === "blocking") return "research-pill-rejected";
  if (severity === "important") return "research-pill-unverified";
  return "research-pill-neutral";
}

export function gapKindLabel(kind: EvidenceGapKind): string {
  switch (kind) {
    case "no_verified_support":
      return "尚无已核实支持证据";
    case "unverified_material":
      return "材料尚未核实";
    case "no_counter_check":
      return "缺少反向检查";
    case "missing_primary_source":
      return "缺少一手来源";
    case "source_expired":
      return "来源已过期";
    case "source_not_yet_effective":
      return "来源尚未生效";
    case "unknown_publication_date":
      return "发布时间不明确";
    case "source_independence_unverified":
      return "来源独立性未确认";
    case "excerpt_not_locatable":
      return "原文摘录无法定位";
    case "unresolved_dispute":
      return "仍有未决争议";
    case "unmapped_reference":
      return "引用未登记为证据";
    default:
      return "人工要求补充证据";
  }
}

export function gapActionLabel(action: EvidenceGapAction): string {
  switch (action) {
    case "record_source":
      return "录入来源";
    case "verify_evidence":
      return "去核实材料";
    case "add_supporting_evidence":
      return "添加支持证据";
    case "add_opposing_evidence":
      return "添加反方证据";
    case "add_primary_source":
      return "补充一手来源";
    default:
      return "重新交叉审查";
  }
}

/**
 * Retrieval state is its own axis and is labelled as such: whether the page
 * could be read says nothing about whether anyone has stood behind an excerpt
 * from it, so the wording never borrows verification language.
 */
export function sourceRetrievalLabel(
  status: "not_requested" | "pending" | "fetched" | "failed" | undefined
): string {
  if (status === "fetched") return "已抓取原文";
  if (status === "pending") return "抓取中";
  if (status === "failed") return "抓取失败";
  return "未抓取原文";
}

export function sourceRetrievalTone(
  status: "not_requested" | "pending" | "fetched" | "failed" | undefined
): string {
  if (status === "fetched") return "research-pill-verified";
  if (status === "pending") return "research-pill-unverified";
  if (status === "failed") return "research-pill-rejected";
  return "research-pill-neutral";
}

/**
 * Locator state, kept separate from verification on purpose: an excerpt can be
 * located in the page and still be unverified, and it can be verified while the
 * sentence it quotes has since disappeared.
 */
export function locatorStatusLabel(
  status: "unanchored" | "anchored" | "missing" | undefined
): string {
  if (status === "anchored") return "已定位到原文";
  if (status === "missing") return "无法定位，需重新确认";
  return "未做定位核对";
}

export function locatorStatusTone(
  status: "unanchored" | "anchored" | "missing" | undefined
): string {
  if (status === "anchored") return "research-pill-verified";
  if (status === "missing") return "research-pill-rejected";
  return "research-pill-neutral";
}

export function locatorKindLabel(
  kind:
    | "quote"
    | "heading"
    | "paragraph"
    | "page"
    | "timestamp"
    | "manual"
    | undefined
): string {
  if (kind === "quote") return "原文摘录";
  if (kind === "heading") return "标题锚点";
  if (kind === "paragraph") return "段落锚点";
  if (kind === "page") return "页码";
  if (kind === "timestamp") return "时间点";
  if (kind === "manual") return "人工描述";
  return "—";
}

/**
 * Progress of one url inside a multi-url import.
 *
 * These are client-side steps of a single request, not a stored status, so they
 * are named after what the workspace is doing: waiting its turn, being read, or
 * finished. The stored `retrievalStatus` is shown alongside them rather than
 * being folded into one label, because "we finished trying" and "we got the
 * text" are different facts.
 */
export function sourceImportStateLabel(
  state: "pending" | "running" | "done" | "failed"
): string {
  if (state === "done") return "已提取";
  if (state === "failed") return "失败";
  if (state === "running") return "处理中";
  return "待处理";
}

export function sourceImportStateTone(
  state: "pending" | "running" | "done" | "failed"
): string {
  if (state === "done") return "research-pill-verified";
  if (state === "failed") return "research-pill-rejected";
  if (state === "running") return "research-pill-unverified";
  return "research-pill-neutral";
}

/**
 * What stage an AI-assisted analysis is at.
 *
 * Deliberately separate from any domain status: an extraction task is about
 * whether the *suggestion engine* got an answer, which says nothing about the
 * claims themselves. A task that failed must never read like a claim being
 * rejected.
 */
export function extractionRunStatusLabel(
  status: ClaimExtractionRun["status"]
): string {
  if (status === "running") return "分析中";
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "失败";
  return "排队中";
}

export function extractionRunStatusTone(
  status: ClaimExtractionRun["status"]
): string {
  if (status === "succeeded") return "research-pill-verified";
  if (status === "failed") return "research-pill-rejected";
  if (status === "running") return "research-pill-unverified";
  return "research-pill-neutral";
}

/**
 * Turns a failure code into the sentence a researcher needs.
 *
 * Every code names something different to do next, which is why none of them
 * collapse into "the analysis failed": a timeout is retryable, a refused answer
 * is not, and an empty page is not a failure at all.
 */
export function extractionFailureLabel(
  code: ExtractionFailureCode
): string {
  if (code === "no_snapshot") return "这个来源还没有抓到原文";
  if (code === "empty_content") return "保存的原文里没有可分析的段落";
  if (code === "provider_unavailable") return "模型不可用（未配置凭据或无法连接）";
  if (code === "timeout") return "模型响应超时";
  if (code === "aborted") return "分析已被取消";
  if (code === "refused") return "模型拒绝回答";
  if (code === "empty_output") return "模型返回了空响应";
  if (code === "invalid_json") return "模型返回的内容不是合法 JSON";
  if (code === "schema_rejected") return "模型返回了不合约定结构的 JSON";
  if (code === "storage_unavailable") return "候选未能保存到数据库";
  return "分析失败";
}

/** The candidate's own taxonomy, wider than the formal claim types. */
export function candidateClaimTypeLabel(type: CandidateClaimType): string {
  return CANDIDATE_CLAIM_TYPE_LABELS[type] ?? type;
}

export function candidateStatusLabel(status: CandidateStatus): string {
  if (status === "accepted") return "已采纳";
  if (status === "rejected") return "已拒绝";
  return "待处理";
}

export function candidateStatusTone(status: CandidateStatus): string {
  if (status === "accepted") return "research-pill-verified";
  if (status === "rejected") return "research-pill-rejected";
  return "research-pill-neutral";
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}
