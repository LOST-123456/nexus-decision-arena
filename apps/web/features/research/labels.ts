import {
  CANDIDATE_CLAIM_TYPE_LABELS,
  QUALITY_DIMENSION_LABELS,
  QUALITY_FINDING_CATEGORY_LABELS,
  RESEARCH_QUALITY_RULE_VERSION
} from "@nexus/shared";
import type {
  ResearchPlanStatus,
  ResearchSearchTaskStatus,
  ResearchSearchFailureCode,
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
  SessionPhase,
  CitationIntegrityStatus,
  ClaimSupportSummaryStatus,
  CitationReviewFailureCode,
  SupportAssessmentStatus,
  SourceProvenanceKind,
  SourceRelationKind,
  SourceLinkConfidence,
  ConflictStatus,
  EvidenceMapNode,
  EvidenceMapNodeType,
  EvidenceMapRelation,
  ReportDiffEntityType,
  ReportDiffChangeKind,
  ReportDiffCategory,
  QualityStatus,
  QualitySeverity,
  QualityFindingCategory,
  QualityFindingScope,
  QualityRecommendationAction,
  QualityDimensionId
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

/* ------------------------------------------------------------------ *
 * Imported local files
 * ------------------------------------------------------------------ */

/**
 * The kind decided by the server from the bytes, never from the file name — so
 * it is labelled as a fact about the file rather than as its extension.
 */
export function sourceFileKindLabel(
  kind: "pdf" | "docx" | "txt" | "markdown" | "csv" | undefined
): string {
  if (kind === "pdf") return "PDF";
  if (kind === "docx") return "Word 文档";
  if (kind === "csv") return "CSV 表格";
  if (kind === "markdown") return "Markdown";
  return "纯文本";
}

/**
 * How reading a file went.
 *
 * `needs_ocr` and `failed` are outcomes, not errors to hide: a document we could
 * not read must be visible as one, because "no text" and "nothing was found"
 * are very different claims.
 */
export function fileParseStatusLabel(
  status: "parsed" | "needs_ocr" | "failed" | undefined
): string {
  if (status === "parsed") return "已读取原文";
  if (status === "needs_ocr") return "需要 OCR（无文字层）";
  if (status === "failed") return "读取失败";
  return "未知状态";
}

export function fileParseStatusTone(
  status: "parsed" | "needs_ocr" | "failed" | undefined
): string {
  if (status === "parsed") return "research-pill-verified";
  if (status === "failed") return "research-pill-rejected";
  if (status === "needs_ocr") return "research-pill-unverified";
  return "research-pill-neutral";
}

/**
 * What failure code means for the person holding the file.
 *
 * Each line says what to do next where there is something to do, and none of
 * them implies the file was read.
 */
export function fileFailureCodeMessage(
  code: string | undefined,
  fallback: string
): string {
  if (code === "unsupported_type") {
    return "不支持的文件类型：只接受 PDF、Word(.docx)、TXT、Markdown 与 CSV。";
  }
  if (code === "file_too_large") return "文件超过大小上限，请压缩或拆分后重试。";
  if (code === "empty_file") return "文件为空，没有可读内容。";
  if (code === "storage_unavailable") {
    return "文件存储不可用：请稍后重试，或联系管理员检查存储目录。";
  }
  return fallback;
}

/** Per-column csv type, as a display hint inferred from the values present. */
export function csvColumnTypeLabel(
  type: "integer" | "number" | "boolean" | "date" | "text" | "empty"
): string {
  if (type === "integer") return "整数（推断）";
  if (type === "number") return "数值（推断）";
  if (type === "boolean") return "布尔（推断）";
  if (type === "date") return "日期（推断）";
  if (type === "empty") return "无值";
  return "文本";
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

/**
 * Layer A: where the quote stands as text.
 *
 * These are answers about the stored page only. `anchored` says the words are
 * there — it says nothing about whether they support the claim, which is why
 * the UI always renders layer A and layer B as two separate pills.
 */
export function citationIntegrityLabel(
  status: CitationIntegrityStatus | undefined
): string {
  if (status === "anchored") return "原文可定位";
  if (status === "stale") return "快照版本已变，需重确认";
  if (status === "partial") return "引用不完整/被截断";
  if (status === "missing") return "原文中找不到该引用";
  if (status === "unmapped") return "未登记引用，无法核查";
  if (status === "unanchored") return "来源无原文可核对";
  return "尚未核查";
}

export function citationIntegrityTone(
  status: CitationIntegrityStatus | undefined
): string {
  if (status === "anchored") return "research-pill-verified";
  if (status === "stale") return "research-pill-unverified";
  if (status === "partial") return "research-pill-unverified";
  if (status === "missing") return "research-pill-rejected";
  return "research-pill-neutral";
}

export function citationMatchKindLabel(
  kind: "exact" | "normalized" | "elided" | null | undefined
): string {
  if (kind === "exact") return "精确匹配";
  if (kind === "normalized") return "折叠空白后匹配";
  if (kind === "elided") return "省略片段按顺序匹配";
  return "";
}

/**
 * Layer B: how the excerpt bears on the claim.
 *
 * Deliberately worded as an assessment, not a verdict: none of these labels
 * claim truth, and none of them is a verification state.
 */
export function supportAssessmentLabel(
  status: SupportAssessmentStatus | undefined
): string {
  if (status === "support") return "支持该主张";
  if (status === "oppose") return "反对该主张";
  if (status === "context") return "仅为背景";
  if (status === "insufficient") return "支持不足";
  if (status === "ambiguous") return "关系不明确";
  return "尚未评估";
}

export function supportAssessmentTone(
  status: SupportAssessmentStatus | undefined
): string {
  if (status === "support") return "research-pill-supports";
  if (status === "oppose") return "research-pill-opposes";
  if (status === "context") return "research-pill-context";
  return "research-pill-neutral";
}

export function citationReviewFailureLabel(
  code: CitationReviewFailureCode | undefined
): string {
  if (code === "no_evidence") return "还没有可核查的摘录";
  if (code === "claim_not_found") return "该主张或核查记录不在当前研究中";
  if (code === "provider_unavailable") return "模型不可用（未配置凭据或无法连接）";
  if (code === "timeout") return "模型响应超时";
  if (code === "aborted") return "评估已被取消";
  if (code === "refused") return "模型拒绝回答";
  if (code === "empty_output") return "模型返回了空响应";
  if (code === "invalid_json") return "模型返回的内容不是合法 JSON";
  if (code === "schema_rejected") return "模型返回了不合约定结构的 JSON";
  if (code === "storage_unavailable") return "核查结果未能保存到数据库";
  return "核查失败";
}

/**
 * The per-claim roll-up. `mixed` exists precisely so that support and
 * opposition are not averaged into a single direction.
 */
export function claimSupportSummaryLabel(
  status: ClaimSupportSummaryStatus | undefined
): string {
  if (status === "support") return "摘录支持该主张";
  if (status === "oppose") return "摘录反对该主张";
  if (status === "mixed") return "支持与反对并存（冲突）";
  if (status === "context") return "只有背景材料";
  if (status === "insufficient") return "摘录支持不足";
  if (status === "ambiguous") return "关系不明确";
  if (status === "unavailable") return "评估未完成";
  return "尚未评估";
}

export function claimSupportSummaryTone(
  status: ClaimSupportSummaryStatus | undefined
): string {
  if (status === "support") return "research-pill-supports";
  if (status === "oppose") return "research-pill-opposes";
  if (status === "mixed") return "research-pill-unverified";
  if (status === "context") return "research-pill-context";
  if (status === "unavailable") return "research-pill-rejected";
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

/* ------------------------------------------------------------------ *
 * Source independence
 * ------------------------------------------------------------------ */

/**
 * 来源类型. `unknown` is rendered as a real answer, not as a blank: "we could
 * not establish this from the recorded facts" is a finding, and dressing it up
 * as a confident label is exactly what this axis exists to avoid.
 */
export function sourceProvenanceLabel(kind: SourceProvenanceKind): string {
  if (kind === "primary") return "一手资料";
  if (kind === "secondary") return "二手转述";
  if (kind === "commentary") return "评论/观点";
  if (kind === "official_notice") return "机构公告";
  if (kind === "dataset") return "数据集";
  return "来源类型未知";
}

export function sourceProvenanceTone(kind: SourceProvenanceKind): string {
  if (kind === "primary") return "research-pill-supports";
  if (kind === "dataset") return "research-pill-context";
  if (kind === "secondary") return "research-pill-neutral";
  if (kind === "unknown") return "research-pill-unverified";
  return "research-pill-neutral";
}

export function sourceRelationKindLabel(kind: SourceRelationKind): string {
  if (kind === "same_page") return "同一页面";
  if (kind === "duplicate") return "内容重复";
  if (kind === "reprint") return "转载";
  if (kind === "quotes") return "引用";
  if (kind === "same_origin") return "同源";
  if (kind === "near_duplicate") return "疑似重复";
  return "判定为不相关";
}

export function sourceLinkConfidenceLabel(
  confidence: SourceLinkConfidence
): string {
  return confidence === "confirmed" ? "已确认" : "疑似，待确认";
}

export function sourceAnalysisFailureLabel(code: string | undefined): string {
  if (code === "source_not_found") return "找不到该来源，它可能不属于这份研究。";
  if (code === "invalid_request") return "请求内容不合法，请检查后重试。";
  if (code === "storage_unavailable") return "来源分析暂不可用。";
  return "来源分析失败，请重试。";
}

/* ------------------------------------------------------------------ *
 * Research plan
 * ------------------------------------------------------------------ */

/**
 * 研究计划执行状态. `queued` is deliberately labelled 尚未执行, never
 * 进行中: nothing has run, and the label is the promise.
 */
export function researchPlanStatusLabel(
  status: ResearchPlanStatus
): string {
  if (status === "queued") return "尚未执行";
  if (status === "running") return "检索进行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "检索失败";
  if (status === "needs_human") return "需要人工决定";
  if (status === "not_applicable") return "不适用";
  return "已关闭";
}

export function researchPlanStatusTone(status: ResearchPlanStatus): string {
  if (status === "completed") return "research-pill-supports";
  if (status === "failed") return "research-pill-opposes";
  if (status === "queued") return "research-pill-unverified";
  if (status === "running") return "research-pill-context";
  return "research-pill-neutral";
}

export function researchPlanFailureLabel(
  code: string | undefined
): string {
  if (code === "plan_item_not_found") return "找不到该计划条目，它可能已被更新。";
  if (code === "gap_not_found") return "该缺口不在当前诊断中，请刷新后重试。";
  if (code === "invalid_request") return "请求内容不合法，请检查后重试。";
  if (code === "invalid_transition") return "该条目当前状态不允许此操作，请刷新后重试。";
  if (code === "search_unavailable")
    return "本构建尚未接入受控网页搜索，无法执行检索。";
  if (code === "source_not_found") return "引用的材料不属于这份研究。";
  if (code === "storage_unavailable") return "研究计划暂不可用。";
  return "研究计划操作失败，请重试。";
}

/* ------------------------------------------------------------------ *
 * Controlled research search
 * ------------------------------------------------------------------ */

/**
 * 受控检索任务状态. The status vocabulary is honest about what ran: `queued`
 * means nothing has, and there is deliberately no "AI 已验证" label anywhere —
 * a search only ever produces candidates, never verified evidence.
 */
export function researchSearchStatusLabel(
  status: ResearchSearchTaskStatus
): string {
  if (status === "queued") return "已创建，尚未检索";
  if (status === "searching") return "检索进行中";
  if (status === "completed") return "已找到候选来源";
  if (status === "failed") return "检索失败";
  return "已取消";
}

export function researchSearchStatusTone(
  status: ResearchSearchTaskStatus
): string {
  if (status === "completed") return "research-pill-unverified";
  if (status === "failed") return "research-pill-opposes";
  if (status === "searching") return "research-pill-context";
  if (status === "queued") return "research-pill-neutral";
  return "research-pill-rejected";
}

export function researchSearchFailureLabel(
  code: string | undefined
): string {
  if (code === "search_task_not_found") return "找不到该检索任务，它可能已被更新。";
  if (code === "plan_item_not_found") return "该计划条目不属于这份研究，无法创建检索任务。";
  if (code === "invalid_request") return "请求内容不合法，请检查后重试。";
  if (code === "invalid_transition") return "该检索任务当前状态不允许此操作，请刷新后重试。";
  if (code === "search_failed") return "受控检索未能返回结果，请重试。";
  if (code === "storage_unavailable") return "受控检索暂不可用。";
  return "受控检索操作失败，请重试。";
}

/* ---------------------------------------------------------------------- */
/* Evidence Map                                                            */
/* ---------------------------------------------------------------------- */

export function conflictStatusLabel(status: ConflictStatus): string {
  if (status === "detected") return "已检出";
  if (status === "human_review") return "待人工裁定";
  return "已解决";
}

export const evidenceMapNodeTypeLabel: Record<EvidenceMapNodeType, string> = {
  claim: "主张",
  evidence: "证据",
  source: "来源",
  conflict: "冲突",
  challenge: "质询"
};

export const evidenceMapRelationLabel: Record<EvidenceMapRelation, string> = {
  supports: "支持",
  opposes: "反对",
  context: "背景",
  provided_by: "出自来源",
  involved_in: "涉入冲突",
  questions: "质询",
  generated_by: "衍生质询"
};

/**
 * Status text for one map node, reusing the workspace's own label functions
 * so a status never reads differently inside the map than in its panel.
 */
export function evidenceMapNodeStatusLabel(node: EvidenceMapNode): string {
  switch (node.type) {
    case "claim":
      return claimStatusLabel(node.status);
    case "evidence":
      return verificationLabel(node.status);
    case "source":
      return sourceRetrievalLabel(node.status);
    case "conflict":
      return conflictStatusLabel(node.status);
    case "challenge":
      return challengeStatusLabel(node.status);
  }
}

/* ---------------------------------------------------------------------- */
/* Immutable report versions                                               */
/* ---------------------------------------------------------------------- */

/**
 * Which kind of thing moved between two versions.
 *
 * The entity type names the row, never a judgement about it: a "source" entry
 * says a capture changed, nothing about what the new text means.
 */
export function reportDiffEntityLabel(type: ReportDiffEntityType): string {
  switch (type) {
    case "claim":
      return "主张";
    case "evidence":
      return "材料摘录";
    case "source":
      return "来源版本";
    case "review":
      return "人工裁定";
    case "conflict":
      return "未解决冲突";
    default:
      return "来源监测任务";
  }
}

export function reportDiffKindLabel(kind: ReportDiffChangeKind): string {
  if (kind === "added") return "新增";
  if (kind === "removed") return "已消失";
  return "已变化";
}

export function reportDiffKindTone(kind: ReportDiffChangeKind): string {
  if (kind === "added") return "research-pill-supports";
  if (kind === "removed") return "research-pill-opposes";
  return "research-pill-unverified";
}

/**
 * The one distinction the comparison exists to keep:
 *
 * - `verdict` — what the material supports changed (a conclusion, a ruling).
 * - `risk` — whether that material is still current changed (a capture, a
 *   locator, a monitoring task).
 *
 * They are shown side by side and never merged, because "the page changed"
 * is not "the finding was overturned".
 */
export function reportDiffCategoryLabel(
  category: ReportDiffCategory
): string {
  if (category === "verdict") return "结论 / 裁定变化";
  return "来源时效风险";
}

export function reportDiffCategoryTone(
  category: ReportDiffCategory
): string {
  if (category === "verdict") return "research-pill-unverified";
  return "research-pill-context";
}

/** The field that moved, spelled out the way the report spells it. */
export function reportDiffFieldLabel(field: string | null): string {
  switch (field) {
    case "statement":
      return "主张表述";
    case "claimStatus":
      return "主张状态";
    case "verdictStatus":
      return "核查结论";
    case "verdictConfidence":
      return "结论把握度";
    case "verificationStatus":
      return "核实状态";
    case "locatorStatus":
      return "原文定位状态";
    case "contentHash":
      return "所引原文版本";
    case "snapshotId":
      return "所引快照";
    case "outcome":
      return "裁定结果";
    default:
      return field ?? "—";
  }
}

/** A monitoring task as a version recorded it. */
export function reportSnapshotTaskStatusLabel(status: string): string {
  if (status === "open") return "待处理";
  if (status === "in_review") return "复核中";
  if (status === "resolved") return "已处理";
  return "已忽略";
}

/** Date and time, for save moments that can share a calendar day. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* ---------------------------------------------------------------------- */
/* Research quality assessment                                              */
/* ---------------------------------------------------------------------- */

/**
 * The status vocabulary of the quality assessment.
 *
 * `insufficient_data` is a real answer and gets a real label: "we could not
 * compute this" is never dressed up as a low score, and never as a blank.
 */
export function qualityStatusLabel(status: QualityStatus): string {
  switch (status) {
    case "strong":
      return "充分";
    case "adequate":
      return "基本满足";
    case "weak":
      return "偏弱";
    case "at_risk":
      return "存在风险";
    default:
      return "数据不足，无法评估";
  }
}

export function qualityStatusTone(status: QualityStatus): string {
  if (status === "strong") return "research-pill-verified";
  if (status === "adequate") return "research-pill-supports";
  if (status === "weak") return "research-pill-unverified";
  if (status === "at_risk") return "research-pill-rejected";
  return "research-pill-neutral";
}

/**
 * Severity is a property of the rule that fired, not of how bad it feels:
 * a single unverified excerpt is a warning, a severe challenge nobody has
 * answered is critical. The tone never carries the meaning alone — the text
 * label does.
 */
export function qualitySeverityLabel(severity: QualitySeverity): string {
  if (severity === "critical") return "严重";
  if (severity === "warning") return "警告";
  return "提示";
}

export function qualitySeverityTone(severity: QualitySeverity): string {
  if (severity === "critical") return "research-pill-rejected";
  if (severity === "warning") return "research-pill-unverified";
  return "research-pill-neutral";
}

/** What kind of thing a finding is about, in the panel's own words. */
export function qualityScopeLabel(scope: QualityFindingScope): string {
  if (scope === "claim") return "主张";
  if (scope === "evidence") return "材料";
  if (scope === "source") return "来源";
  return "会话";
}

/**
 * What a recommendation would do. Every action names a surface that already
 * exists; nothing here promises a write the build cannot perform.
 */
export function qualityActionLabel(action: QualityRecommendationAction): string {
  switch (action) {
    case "open_claim_detail":
      return "查看主张详情";
    case "open_evidence_detail":
      return "查看材料详情";
    case "open_source_reader":
      return "阅读来源原文";
    case "open_source_relations":
      return "处理来源关系";
    case "open_research_plan":
      return "加入研究计划";
    case "open_human_review":
      return "进入人工复核";
    case "record_source":
      return "登记来源";
    case "verify_evidence":
      return "核实材料";
    case "add_supporting_evidence":
      return "补充支持证据";
    case "add_opposing_evidence":
      return "补充反方证据";
    default:
      return "重新交叉审查";
  }
}

/**
 * A dimension score, or the honest answer when there is none.
 *
 * "无法计算" is printed, never 0 and never 100: a dimension the rules could
 * not evaluate has no score, and showing one would be an invention.
 */
export function qualityScoreText(score: number | null): string {
  return score === null ? "无法计算" : `${score} / 100`;
}

/** One finding category, from the shared taxonomy so the panel and the API agree. */
export function qualityFindingCategoryLabel(
  category: QualityFindingCategory
): string {
  return QUALITY_FINDING_CATEGORY_LABELS[category] ?? category;
}

/** One dimension name, from the shared taxonomy. */
export function qualityDimensionLabel(dimension: QualityDimensionId): string {
  return QUALITY_DIMENSION_LABELS[dimension] ?? dimension;
}

/**
 * The rule version behind an assessment, in words.
 *
 * The overview reads better with a name a person can recognise, but the exact
 * machine id stays visible in the panel's footer — a reader must always be
 * able to tell precisely which rules produced the number. An unknown version
 * is shown as it arrived: no label is ever invented for rules this build does
 * not know about.
 */
export function qualityRuleVersionLabel(version: string): string {
  if (version === RESEARCH_QUALITY_RULE_VERSION) return "研究质量-v1";
  return version;
}