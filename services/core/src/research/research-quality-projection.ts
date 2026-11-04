import { createHash } from "node:crypto";
import {
  isConflictAwaitingHumanDecision,
  qualityStatusForScore,
  QUALITY_DIMENSION_LABELS,
  QUALITY_DIMENSION_WEIGHTS,
  QUALITY_OVERALL_MIN_COVERAGE,
  QUALITY_TOTAL_WEIGHT,
  RESEARCH_QUALITY_RULE_VERSION,
  RESEARCH_QUALITY_SCHEMA_VERSION,
  ResearchQualityAssessmentSchema,
  type ClaimQualityFinding,
  type EvidenceQualityFinding,
  type QualityDimension,
  type QualityDimensionId,
  type QualityFinding,
  type QualityFindingCategory,
  type QualityOverall,
  type QualityRecommendation,
  type QualityRecommendationAction,
  type QualitySeverity,
  type ResearchQualityAssessment,
  type ResearchQualityInput,
  type SourceQualityFinding
} from "@nexus/shared";
import type { Evidence } from "@nexus/shared";
import type { EvidenceGap } from "@nexus/shared";

/**
 * The scoring engine — a pure projection over the research workspace.
 *
 * Everything here is a deterministic rule over persisted rows: the same input
 * always produces the same assessment, there is no clock inside the function
 * (`assessedAt` is injected), and nothing writes. Claim statuses, verdicts,
 * verification states, human rulings and saved report snapshots are read, never
 * touched.
 *
 * Three honesty rules the structure exists to keep:
 *
 *   1. **A dimension that cannot be computed scores null.** Not 0, not 100.
 *      `insufficient_data` is a real answer and is displayed as one.
 *   2. **The overall score excludes missing weight instead of zeroing it.** It
 *      is only reported at all when at least half the total weight is
 *      computable; otherwise the six dimensions carry the reading alone.
 *   3. **Independence is never inferred from surface differences.** Two
 *      different urls are not two independent sources; only a confirmed link
 *      (or a person's statement) establishes a relationship, and an
 *      unconfirmed near-duplicate makes the whole dimension unscoreable
 *      rather than quietly lowering it.
 */

/** A challenge this severe that is still open is a critical finding. */
const SEVERE_THRESHOLD = 4;

/** A publisher group this large is worth a warning, not just a note. */
const PUBLISHER_CONCENTRATION_WARNING_SIZE = 3;

const DIMENSION_IDS: QualityDimensionId[] = [
  "evidence_coverage",
  "verification_quality",
  "source_independence",
  "conflict_resolution",
  "research_completeness",
  "source_freshness"
];

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function ratio(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return part / whole;
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function sortedIds(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function band(score: number): QualityDimension["status"] {
  return qualityStatusForScore(score);
}

function dimension(input: {
  id: QualityDimensionId;
  score: number | null;
  status: QualityDimension["status"];
  explanation: string;
  inputMetrics: Record<string, number | string | boolean | null>;
  limitations?: string[] | undefined;
}): QualityDimension {
  return {
    id: input.id,
    score: input.score === null ? null : round(input.score),
    weight: QUALITY_DIMENSION_WEIGHTS[input.id],
    status: input.status,
    explanation: input.explanation,
    inputMetrics: input.inputMetrics,
    limitations: input.limitations ?? [],
    ruleVersion: RESEARCH_QUALITY_RULE_VERSION
  };
}

function insufficient(input: {
  id: QualityDimensionId;
  explanation: string;
  inputMetrics: Record<string, number | string | boolean | null>;
  limitations?: string[] | undefined;
}): QualityDimension {
  return dimension({
    id: input.id,
    score: null,
    status: "insufficient_data",
    explanation: input.explanation,
    inputMetrics: input.inputMetrics,
    limitations: input.limitations
  });
}

/* ------------------------------------------------------------------ *
 * Dimension 1 — evidence coverage
 * ------------------------------------------------------------------ */

/**
 * Coverage is about *whether claims are backed by material that was checked*,
 * never about how much material exists. More excerpts do not make a claim
 * better covered, so counts appear only as context; the score is a ratio of
 * claims.
 */
function evaluateCoverage(
  input: ResearchQualityInput
): QualityDimension {
  const claims = input.claims;
  const evidenceByClaim = new Map<string, typeof input.evidence>();
  for (const item of input.evidence) {
    for (const claimId of item.claimIds) {
      evidenceByClaim.set(claimId, [
        ...(evidenceByClaim.get(claimId) ?? []),
        item
      ]);
    }
  }

  const withAnyEvidence = claims.filter(
    (claim) => (evidenceByClaim.get(claim.id) ?? []).length > 0
  ).length;
  const withVerified = claims.filter((claim) => {
    const verdict = input.verdicts.find((item) => item.claimId === claim.id);
    return (verdict?.counts.verified ?? 0) > 0;
  }).length;
  const withVerifiedSupport = claims.filter((claim) => {
    const verdict = input.verdicts.find((item) => item.claimId === claim.id);
    return (verdict?.counts.verifiedSupporting ?? 0) > 0;
  }).length;

  const metrics = {
    claims: claims.length,
    claimsWithEvidence: withAnyEvidence,
    claimsWithoutEvidence: claims.length - withAnyEvidence,
    claimsWithVerifiedEvidence: withVerified,
    claimsWithOnlyUnverifiedEvidence: withAnyEvidence - withVerified,
    claimsWithVerifiedSupport: withVerifiedSupport,
    evidenceTotal: input.evidence.length,
    verifiedSupportingTotal: input.verdicts.reduce(
      (total, verdict) => total + verdict.counts.verifiedSupporting,
      0
    ),
    verifiedOpposingTotal: input.verdicts.reduce(
      (total, verdict) => total + verdict.counts.verifiedOpposing,
      0
    )
  };

  if (claims.length === 0) {
    return insufficient({
      id: "evidence_coverage",
      explanation:
        "本研究会话没有任何主张，证据覆盖率无从计算。空会话不给分，也不给低分。",
      inputMetrics: metrics
    });
  }

  const coverage =
    0.4 * ratio(withAnyEvidence, claims.length) +
    0.35 * ratio(withVerified, claims.length) +
    0.25 * ratio(withVerifiedSupport, claims.length);
  const score = 100 * coverage;

  const limitations: string[] = [];
  if (withVerifiedSupport < claims.length) {
    limitations.push(
      `${claims.length - withVerifiedSupport} 条主张尚无已核实支持证据，覆盖率因此受限。`
    );
  }
  if (withAnyEvidence > withVerified) {
    limitations.push(
      `${withAnyEvidence - withVerified} 条主张只有未核实材料；未核实材料不计入覆盖。`
    );
  }
  limitations.push(
    "评分只问“主张是否被已核实材料覆盖”，不问材料多少——摘录数量本身不提高本维度分数。"
  );

  return dimension({
    id: "evidence_coverage",
    score,
    status: band(score),
    explanation:
      `覆盖率 = 100 × (0.40 × 有材料主张占比 ${ratio(withAnyEvidence, claims.length).toFixed(2)}` +
      ` + 0.35 × 有已核实材料主张占比 ${ratio(withVerified, claims.length).toFixed(2)}` +
      ` + 0.25 × 有已核实支持证据主张占比 ${ratio(withVerifiedSupport, claims.length).toFixed(2)})` +
      ` = ${round(score)}。分子分母都只数主张，不数摘录条数。`,
    inputMetrics: metrics,
    limitations
  });
}

/* ------------------------------------------------------------------ *
 * Dimension 2 — verification quality
 * ------------------------------------------------------------------ */

/**
 * Of the material that exists, how much has a person behind it, and how much
 * of it can still be found in its source. Locating an excerpt is not the same
 * as standing behind it, so the two are separate inputs and separate sentences.
 */
function evaluateVerification(input: ResearchQualityInput): QualityDimension {
  const evidence = input.evidence;
  const verified = evidence.filter(
    (item) => item.verificationStatus === "verified"
  );
  const unverified = evidence.filter(
    (item) => item.verificationStatus === "unverified"
  );
  const rejected = evidence.filter(
    (item) => item.verificationStatus === "rejected"
  );
  const anchored = evidence.filter((item) => item.locatorStatus === "anchored");
  const locatorMissing = evidence.filter(
    (item) => item.locatorStatus === "missing"
  );
  const withoutLocator = evidence.filter(
    (item) => !item.locator || item.locator.trim() === ""
  );
  const recordsComplete = verified.filter(
    (item) =>
      typeof item.verifiedBy === "string" &&
      item.verifiedBy.trim() !== "" &&
      typeof item.verificationNote === "string" &&
      item.verificationNote.trim() !== ""
  );

  const metrics = {
    evidenceTotal: evidence.length,
    verified: verified.length,
    unverified: unverified.length,
    rejected: rejected.length,
    locatorAnchored: anchored.length,
    locatorMissing: locatorMissing.length,
    withoutLocator: withoutLocator.length,
    verificationRecordsComplete: recordsComplete.length
  };

  if (evidence.length === 0) {
    return insufficient({
      id: "verification_quality",
      explanation:
        "本研究会话没有任何材料，核实程度无从计算。没有材料不等于材料没问题。",
      inputMetrics: metrics
    });
  }

  const verifiedRatio = ratio(verified.length, evidence.length);
  const locatableRatio = ratio(anchored.length, evidence.length);
  const score = 100 * (0.7 * verifiedRatio + 0.3 * locatableRatio);

  const limitations: string[] = [];
  if (unverified.length > 0) {
    limitations.push(
      `${unverified.length} 条材料尚未核实，不能作为结论依据；未核实是待办状态，不自动变成缺陷。`
    );
  }
  if (rejected.length > 0) {
    limitations.push(
      `${rejected.length} 条材料被人工驳回并留下理由，未参与结论。`
    );
  }
  if (locatorMissing.length > 0) {
    limitations.push(
      `${locatorMissing.length} 条摘录在其来源当前版本中已无法定位，需要重新核查。`
    );
  }
  limitations.push(
    "定位成功只说明摘录能在原文中找到，不等于内容语义成立，也不等于人工已认可——核实状态由人工记录，本投影只读取。"
  );

  return dimension({
    id: "verification_quality",
    score,
    status: band(score),
    explanation:
      `核实程度 = 100 × (0.70 × 已核实材料占比 ${verifiedRatio.toFixed(2)}` +
      ` + 0.30 × 引用定位正常材料占比 ${locatableRatio.toFixed(2)}) = ${round(score)}。` +
      "两条轴分别计数：verificationStatus 是人工是否认可，locatorStatus 是摘录能否在原文中重新找到。",
    inputMetrics: metrics,
    limitations
  });
}

/* ------------------------------------------------------------------ *
 * Dimension 3 — source independence
 * ------------------------------------------------------------------ */

/**
 * The reprint guard. Only confirmed links merge sources; a suspected
 * near-duplicate makes the whole dimension unscoreable (unknown, not a low
 * score) until a person rules on it. Fewer than two sources is likewise
 * unscoreable: there is no relationship to assess, and one source is not
 * independent corroboration of anything.
 */
function evaluateIndependence(
  input: ResearchQualityInput
): QualityDimension {
  const sources = input.sources;
  const summary = input.independence;
  const metrics = {
    pages: sources.length,
    confirmedIndependentSources: summary?.confirmedIndependentSources ?? null,
    suspectedIndependentSources: summary?.suspectedIndependentSources ?? null,
    confirmedLinks: summary?.confirmedLinks.length ?? null,
    suspectedLinks: summary?.suspectedLinks.length ?? null,
    analysisAvailable: summary !== null
  };

  if (sources.length === 0) {
    return insufficient({
      id: "source_independence",
      explanation: "本研究会话没有登记任何来源，来源独立性无从计算。",
      inputMetrics: metrics
    });
  }
  if (sources.length === 1) {
    return insufficient({
      id: "source_independence",
      explanation:
        "只有 1 个已登记来源：不存在来源之间的关系可评估，单一来源也不构成对任何主张的独立佐证。",
      inputMetrics: metrics
    });
  }
  if (!summary) {
    return insufficient({
      id: "source_independence",
      explanation:
        "来源独立性分析在当前构建中不可用，本维度记为未知而非低分。",
      inputMetrics: metrics
    });
  }
  if (summary.suspectedLinks.length > 0) {
    return insufficient({
      id: "source_independence",
      explanation:
        `发现 ${summary.suspectedLinks.length} 组文本相近的疑似同源，尚未经人工确认。在确认之前，来源独立性记为未知——不按低分计，也不按已独立计。`,
      inputMetrics: metrics,
      limitations: [
        "疑似同源需要在「来源关系」中由人工确认或排除；文本相似本身不构成同源证据。",
        "若全部疑似都被确认为同源，独立信息源将减少至 " +
          `${summary.suspectedIndependentSources} 条。`
      ]
    });
  }

  const score = 100 * ratio(summary.confirmedIndependentSources, sources.length);
  const limitations: string[] = [
    "评分只计入经规范化地址或内容版本确认的同源合并；未发现可疑重复不代表来源必然独立。"
  ];
  if (summary.suspectedIndependentSources < summary.confirmedIndependentSources) {
    limitations.push(
      `若全部疑似重复都被确认，独立信息源将减少至 ${summary.suspectedIndependentSources} 条。`
    );
  }

  return dimension({
    id: "source_independence",
    score,
    status: band(score),
    explanation:
      `独立性 = 100 × 已确认独立信息源 ${summary.confirmedIndependentSources} / 登记页面 ${sources.length} = ${round(score)}。` +
      "同一规范化地址或同一内容哈希的多个页面合并为一条独立信息源；转载不重复计票。",
    inputMetrics: metrics,
    limitations
  });
}

/* ------------------------------------------------------------------ *
 * Dimension 4 — conflict resolution
 * ------------------------------------------------------------------ */

/**
 * How recorded disagreements are being handled — not whether they exist.
 * Opposing evidence is not a defect; ignoring it is. With no conflicts and no
 * challenges at all there is nothing to assess, and saying so is the honest
 * answer (no disagreement found is not the same as none exists).
 */
function evaluateConflicts(input: ResearchQualityInput): QualityDimension {
  const conflicts = input.conflicts;
  const challenges = input.challenges;
  const awaiting = conflicts.filter(isConflictAwaitingHumanDecision);
  const resolvedConflicts = conflicts.filter(
    (conflict) => conflict.status === "resolved"
  );
  const answered = challenges.filter(
    (challenge) => challenge.status === "resolved"
  );
  const unanswered = challenges.filter(
    (challenge) => challenge.status !== "resolved"
  );
  const opposingVerified = input.verdicts.reduce(
    (total, verdict) => total + verdict.counts.verifiedOpposing,
    0
  );

  const metrics = {
    conflicts: conflicts.length,
    conflictsAwaitingHumanDecision: awaiting.length,
    conflictsResolved: resolvedConflicts.length,
    challenges: challenges.length,
    challengesAnswered: answered.length,
    challengesUnanswered: unanswered.length,
    verifiedOpposingEvidence: opposingVerified
  };

  if (conflicts.length === 0 && challenges.length === 0) {
    return insufficient({
      id: "conflict_resolution",
      explanation:
        "本研究会话没有记录任何冲突或质询，冲突处理情况无从计算。没有发现分歧不等于不存在分歧。",
      inputMetrics: metrics
    });
  }

  const components: Array<{ weight: number; value: number; label: string }> =
    [];
  if (conflicts.length > 0) {
    components.push({
      weight: 0.5,
      value: ratio(resolvedConflicts.length, conflicts.length),
      label: `已解决冲突占比 ${ratio(resolvedConflicts.length, conflicts.length).toFixed(2)}`
    });
  }
  if (challenges.length > 0) {
    components.push({
      weight: 0.5,
      value: ratio(answered.length, challenges.length),
      label: `已回应质询占比 ${ratio(answered.length, challenges.length).toFixed(2)}`
    });
  }
  const totalWeight = components.reduce(
    (total, component) => total + component.weight,
    0
  );
  const weighted = components.reduce(
    (total, component) => total + component.weight * component.value,
    0
  );
  const score = 100 * (weighted / totalWeight);

  const limitations: string[] = [];
  if (opposingVerified > 0) {
    limitations.push(
      `存在 ${opposingVerified} 条已核实反对证据：反对证据的存在本身不是质量缺陷，未解决而不回应才是。`
    );
  }
  if (awaiting.length > 0) {
    limitations.push(
      `${awaiting.length} 项冲突仍在等待人工决定，结论不能超出本轮审查范围。`
    );
  }

  return dimension({
    id: "conflict_resolution",
    score,
    status: band(score),
    explanation:
      `冲突处理 = 100 × (${components
        .map((component) => `${component.label}`)
        .join(" + ")}) / 权重合计 ${totalWeight.toFixed(1)} = ${round(score)}。` +
      "评分对象是“有没有被处理”，不是“有没有分歧”。",
    inputMetrics: metrics,
    limitations
  });
}

/* ------------------------------------------------------------------ *
 * Dimension 5 — research completeness
 * ------------------------------------------------------------------ */

/**
 * Whether diagnosed gaps are owned and worked. Creating a plan item is a
 * decision about work, not evidence; a queued item has executed nothing, and a
 * search task that was created but never ran says nothing either.
 */
function evaluateCompleteness(input: ResearchQualityInput): QualityDimension {
  const gaps = input.gaps;
  const planItems = input.planItems;
  const plannedGapIds = new Set(planItems.map((item) => item.gapId));
  const plannedGaps = gaps.filter((gap) => plannedGapIds.has(gap.id));
  const blockingGaps = gaps.filter((gap) => gap.severity === "blocking");
  const settledItems = planItems.filter((item) =>
    ["completed", "closed", "not_applicable"].includes(item.status)
  );
  const queuedItems = planItems.filter((item) => item.status === "queued");
  const executedStatuses = ["searching", "completed", "failed"];
  const searchTasks = input.searchTasks;
  const executedSearches = (searchTasks ?? []).filter((task) =>
    executedStatuses.includes(task.status)
  ).length;

  const metrics = {
    gaps: gaps.length,
    blockingGaps: blockingGaps.length,
    plannedGaps: plannedGaps.length,
    notPlannedGaps: gaps.length - plannedGaps.length,
    planItems: planItems.length,
    planItemsSettled: settledItems.length,
    planItemsQueued: queuedItems.length,
    searchTasksCreated: searchTasks?.length ?? null,
    searchTasksExecuted: searchTasks ? executedSearches : null,
    searchAvailable: searchTasks !== null
  };

  if (gaps.length === 0 && planItems.length === 0) {
    return insufficient({
      id: "research_completeness",
      explanation:
        "当前规则没有诊断出任何缺口，也没有研究计划条目。这不代表研究已完整，只代表按现有规则没有发现待补项，因此完整度无从计算。",
      inputMetrics: metrics
    });
  }

  const components: Array<{ weight: number; value: number; label: string }> =
    [];
  if (gaps.length > 0) {
    components.push({
      weight: 0.4,
      value: ratio(plannedGaps.length, gaps.length),
      label: `已纳入计划的缺口占比 ${ratio(plannedGaps.length, gaps.length).toFixed(2)}`
    });
  }
  if (planItems.length > 0) {
    components.push({
      weight: 0.6,
      value: ratio(settledItems.length, planItems.length),
      label: `已有结果的计划条目占比 ${ratio(settledItems.length, planItems.length).toFixed(2)}`
    });
  }
  const totalWeight = components.reduce(
    (total, component) => total + component.weight,
    0
  );
  const weighted = components.reduce(
    (total, component) => total + component.weight * component.value,
    0
  );
  const score = 100 * (weighted / totalWeight);

  const limitations: string[] = [];
  if (queuedItems.length > 0) {
    limitations.push(
      `${queuedItems.length} 个计划条目尚未执行：本构建未接入受控网页检索，start_search 不可用，条目保持“尚未执行”。`
    );
  }
  if (
    searchTasks !== null &&
    searchTasks.length > executedSearches
  ) {
    limitations.push(
      `${searchTasks.length - executedSearches} 个检索任务已创建但未执行；任务创建不等于检索执行，检索候选不等于正式证据。`
    );
  }
  if (blockingGaps.length > 0) {
    limitations.push(
      `${blockingGaps.length} 项阻断性缺口未关闭前，相关主张不能给出确定性结论。`
    );
  }

  return dimension({
    id: "research_completeness",
    score,
    status: band(score),
    explanation:
      `完整度 = 100 × (${components
        .map((component) => component.label)
        .join(" + ")}) / 权重合计 ${totalWeight.toFixed(1)} = ${round(score)}。` +
      "缺口是推导出来的，计划条目是人的决定；只有带结果的条目计入完成。",
    inputMetrics: metrics,
    limitations
  });
}

/* ------------------------------------------------------------------ *
 * Dimension 6 — source freshness
 * ------------------------------------------------------------------ */

/**
 * Whether the cited material has moved. Never checked is not the same as
 * unchanged, and a change is a reason to re-read, never a reason to re-decide:
 * the historical verification record is carried through untouched.
 */
function evaluateFreshness(input: ResearchQualityInput): QualityDimension {
  const monitoring = input.monitoring;
  const metrics = {
    monitoringConfigured: monitoring !== null,
    checks: monitoring?.tasks.length ?? null,
    openTasks: monitoring?.warnings.openTaskCount ?? null,
    inReviewTasks: monitoring?.warnings.inReviewTaskCount ?? null,
    changedSources: monitoring?.warnings.changedSources.length ?? null,
    evidenceNeedingReconfirmation:
      monitoring?.warnings.evidenceNeedingReconfirmation.length ?? null,
    affectedClaims: monitoring?.warnings.affectedClaims.length ?? null,
    lastCheckedAt: monitoring?.warnings.lastCheckedAt ?? null
  };

  if (!monitoring) {
    return insufficient({
      id: "source_freshness",
      explanation:
        "未配置来源监测，无法评估来源变化风险。从未检查不等于来源没有变化。",
      inputMetrics: metrics
    });
  }
  if (monitoring.tasks.length === 0) {
    return insufficient({
      id: "source_freshness",
      explanation:
        "从未对任何来源执行过检查，来源变化风险无从计算。未检查不等于没问题。",
      inputMetrics: metrics
    });
  }

  const settled = monitoring.tasks.filter((task) =>
    ["resolved", "dismissed"].includes(task.status)
  );
  const score = 100 * ratio(settled.length, monitoring.tasks.length);

  const limitations: string[] = [];
  const outstanding =
    monitoring.warnings.openTaskCount + monitoring.warnings.inReviewTaskCount;
  if (outstanding > 0) {
    limitations.push(
      `${outstanding} 项来源变化待处理：相关结论所依据的材料版本可能已更新，结论本身未因此改变。`
    );
  }
  limitations.push(
    "来源发生变化不等于历史结论错误；重新核查的结论由人工在工作台记录，本投影不改写任何核实状态。"
  );

  return dimension({
    id: "source_freshness",
    score,
    status: band(score),
    explanation:
      `时效 = 100 × 已处理的检查 ${settled.length} / 检查总数 ${monitoring.tasks.length} = ${round(score)}。` +
      "待处理与复核中的来源变化会打开重新核查任务，但不改变任何已有结论。",
    inputMetrics: metrics,
    limitations
  });
}

/* ------------------------------------------------------------------ *
 * Overall
 * ------------------------------------------------------------------ */

function buildOverall(
  dimensions: QualityDimension[]
): { overall: QualityOverall; coverage: number } {
  const computable = dimensions.filter(
    (item) => item.score !== null
  ) as Array<QualityDimension & { score: number }>;
  const computableWeight = computable.reduce(
    (total, item) => total + item.weight,
    0
  );
  const coverage = computableWeight / QUALITY_TOTAL_WEIGHT;
  const assessedDimensions = computable.length;

  const weightNote = DIMENSION_IDS.map(
    (id) => `${QUALITY_DIMENSION_LABELS[id]} ${QUALITY_DIMENSION_WEIGHTS[id]}`
  ).join(" / ");

  if (assessedDimensions === 0 || coverage < QUALITY_OVERALL_MIN_COVERAGE) {
    const reason =
      assessedDimensions === 0
        ? "六个维度全部无法计算"
        : `可计算维度权重仅 ${Math.round(coverage * 100)}%，不足 ${Math.round(
            QUALITY_OVERALL_MIN_COVERAGE * 100
          )}%`;
    return {
      coverage,
      overall: {
        score: null,
        status: "insufficient_data",
        explanation:
          `不给出综合分数：${reason}。缺失的维度不计入、也不按 0 分计——用少数维度拼出的总分看起来会比实际证据确定得多。请看下方六维诊断与质量问题列表。` +
          `（权重设定：${weightNote}，合计 ${QUALITY_TOTAL_WEIGHT}。）`,
        assessedDimensions,
        coverage: round(coverage),
        ruleVersion: RESEARCH_QUALITY_RULE_VERSION
      }
    };
  }

  const weighted = computable.reduce(
    (total, item) => total + item.weight * item.score,
    0
  );
  const score = round(weighted / computableWeight);

  return {
    coverage,
    overall: {
      score,
      status: qualityStatusForScore(score),
      explanation:
        `综合分数 = 各可计算维度分数按权重加权的平均 = ${score}` +
        `（${computable
          .map(
            (item) =>
              `${QUALITY_DIMENSION_LABELS[item.id]} ${item.score}×${item.weight}`
          )
          .join(" + ")}）÷ 可计算权重 ${computableWeight}。` +
        `不可计算的 ${dimensions.length - assessedDimensions} 个维度被排除，不按 0 计。` +
        `本分数只描述研究流程与证据组织质量，不是结论正确的概率，也不能反推任何主张的真假。` +
        `（权重设定：${weightNote}，合计 ${QUALITY_TOTAL_WEIGHT}。）`,
      assessedDimensions,
      coverage: round(coverage),
      ruleVersion: RESEARCH_QUALITY_RULE_VERSION
    }
  };
}

/* ------------------------------------------------------------------ *
 * Source relationship reading
 * ------------------------------------------------------------------ */

type SourceRelationReading = {
  confirmed: Map<string, string[]>;
  suspected: Map<string, string[]>;
  unrelated: Map<string, string[]>;
};

function readSourceRelations(
  input: ResearchQualityInput
): SourceRelationReading {
  const reading: SourceRelationReading = {
    confirmed: new Map(),
    suspected: new Map(),
    unrelated: new Map()
  };
  const links = input.independence;
  if (!links) return reading;
  const known = new Set(input.sources.map((source) => source.id));

  const push = (
    target: Map<string, string[]>,
    from: string,
    to: string
  ): void => {
    if (!known.has(from) || !known.has(to) || from === to) return;
    target.set(from, sortedIds([...(target.get(from) ?? []), to]));
  };

  // Confirmed same-origin links: proven by a rule or asserted by a person. A
  // person's `unrelated` statement is confirmed too, but it says the opposite
  // of same-origin, so it never enters this map.
  for (const link of links.confirmedLinks) {
    if (link.kind === "unrelated") continue;
    push(reading.confirmed, link.fromSourceId, link.toSourceId);
    push(reading.confirmed, link.toSourceId, link.fromSourceId);
  }
  // A person's `unrelated` declaration is evidence of independence, and it is
  // the only thing that is: nothing else in this build proves two pages are
  // different information.
  for (const link of links.confirmedLinks) {
    if (link.kind !== "unrelated") continue;
    push(reading.unrelated, link.fromSourceId, link.toSourceId);
    push(reading.unrelated, link.toSourceId, link.fromSourceId);
  }
  for (const link of links.suspectedLinks) {
    push(reading.suspected, link.fromSourceId, link.toSourceId);
    push(reading.suspected, link.toSourceId, link.fromSourceId);
  }
  return reading;
}

function buildSourceFindings(
  input: ResearchQualityInput,
  relations: SourceRelationReading,
  emit: (finding: QualityFinding) => void
): SourceQualityFinding[] {
  const known = new Set(input.sources.map((source) => source.id));
  const clusters = input.independence?.clusters ?? [];
  // Transitive closure over confirmed same-origin links: A~B and B~C means A
  // and C are the same information too, which is exactly what the cluster
  // count already assumes. Clusters never contain an `unrelated` statement
  // (see `buildClusters`), so this never reads one as a merge.
  const clusterMembers = new Map<string, Set<string>>();
  for (const cluster of clusters) {
    for (const sourceId of cluster.sourceIds) {
      if (!known.has(sourceId)) continue;
      clusterMembers.set(
        sourceId,
        new Set(cluster.sourceIds.filter((other) => other !== sourceId))
      );
    }
  }

  const byPublisher = new Map<string, string[]>();
  for (const source of input.sources) {
    const publisher = source.publisher?.trim();
    if (!publisher) continue;
    byPublisher.set(publisher, [
      ...(byPublisher.get(publisher) ?? []),
      source.id
    ]);
  }
  const concentratedPublishers = new Map<string, string[]>();
  for (const [publisher, ids] of byPublisher) {
    if (ids.length >= 2) concentratedPublishers.set(publisher, sortedIds(ids));
  }

  const findings: SourceQualityFinding[] = [...input.sources]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((source) => {
      const confirmed = sortedIds([
        ...(relations.confirmed.get(source.id) ?? []),
        ...(clusterMembers.get(source.id) ?? [])
      ]);
      const suspected = sortedIds(relations.suspected.get(source.id) ?? []);
      const unrelated = sortedIds(relations.unrelated.get(source.id) ?? []);
      const undetermined = sortedIds(
        input.sources
          .filter((other) => other.id !== source.id)
          .map((other) => other.id)
          .filter(
            (otherId) =>
              !confirmed.includes(otherId) &&
              !suspected.includes(otherId) &&
              !unrelated.includes(otherId)
          )
      );

      let relationStatus: SourceQualityFinding["relationStatus"] = "unknown";
      if (confirmed.length > 0) relationStatus = "confirmed_same_origin";
      else if (suspected.length > 0) relationStatus = "suspected_same_origin";
      else if (unrelated.length > 0) relationStatus = "independent";

      const findingIds: string[] = [];

      if (relationStatus === "confirmed_same_origin") {
        const kinds = clusters
          .filter((cluster) => cluster.sourceIds.includes(source.id))
          .flatMap((cluster) => cluster.confirmedKinds);
        emit({
          id: `duplicate_source:${source.id}`,
          scope: "source",
          entityId: source.id,
          category: "duplicate_source",
          severity: "info",
          reason:
            `该来源与 ${confirmed.length} 个其他来源经确认属于同一份独立信息源` +
            `（依据：${[...new Set(kinds)].sort().join("、") || "人工声明"}）。` +
            "同一份信息源的多个页面不构成多份佐证。",
          ruleId: "source.confirmed_same_origin",
          evidenceReferences: [],
          claimId: null,
          recommendation: "open_source_relations"
        });
        findingIds.push(`duplicate_source:${source.id}`);
      }

      if (relationStatus === "suspected_same_origin") {
        emit({
          id: `insufficient_independence:${source.id}`,
          scope: "source",
          entityId: source.id,
          category: "insufficient_independence",
          severity: "info",
          reason:
            `该来源与 ${suspected.length} 个其他来源文本相近，疑似同源但未经人工确认。` +
            "在人工确认之前，来源独立性记为未知，不计入合并也不计为独立。",
          ruleId: "source.suspected_same_origin",
          evidenceReferences: [],
          claimId: null,
          recommendation: "open_source_relations"
        });
        findingIds.push(`insufficient_independence:${source.id}`);
      }

      const group = concentratedPublishers.get(source.publisher?.trim() ?? "");
      if (group && group.length >= 2) {
        const severity: QualitySeverity =
          group.length >= PUBLISHER_CONCENTRATION_WARNING_SIZE
            ? "warning"
            : "info";
        emit({
          id: `publisher_concentration:${source.id}`,
          scope: "source",
          entityId: source.id,
          category: "publisher_concentration",
          severity,
          reason:
            `${group.length} 个来源登记了同一发布方「${source.publisher}」。` +
            "同一发布方不等于同源，不同地址也不等于独立——需要人工核对原始出处。",
          ruleId: "source.publisher_concentration",
          evidenceReferences: [],
          claimId: null,
          recommendation: "open_source_relations"
        });
        findingIds.push(`publisher_concentration:${source.id}`);
      }

      return {
        sourceId: source.id,
        title: source.title,
        publisher: source.publisher ?? null,
        canonicalUrl: source.canonicalUrl ?? null,
        relationStatus,
        confirmedSameOriginSourceIds: confirmed,
        suspectedSameOriginSourceIds: suspected,
        unrelatedSourceIds: unrelated,
        undeterminedSourceIds: undetermined,
        findingIds
      };
    });

  return findings;
}

/* ------------------------------------------------------------------ *
 * Claim and evidence diagnostics
 * ------------------------------------------------------------------ */

function buildClaimFindings(
  input: ResearchQualityInput,
  emit: (finding: QualityFinding) => void
): ClaimQualityFinding[] {
  const evidenceByClaim = new Map<string, Evidence[]>();
  for (const item of input.evidence) {
    for (const claimId of item.claimIds) {
      evidenceByClaim.set(claimId, [
        ...(evidenceByClaim.get(claimId) ?? []),
        item
      ]);
    }
  }
  const evidenceById = byId(input.evidence);
  const sourceById = byId(input.sources);
  const verdictByClaimId = new Map(
    input.verdicts.map((verdict) => [verdict.claimId, verdict])
  );
  const gapsByClaim = new Map<string, EvidenceGap[]>();
  for (const gap of input.gaps) {
    gapsByClaim.set(gap.claimId, [...(gapsByClaim.get(gap.claimId) ?? []), gap]);
  }
  const clusterOf = new Map<string, string>();
  for (const cluster of input.independence?.clusters ?? []) {
    for (const sourceId of cluster.sourceIds) {
      clusterOf.set(sourceId, cluster.clusterId);
    }
  }
  const atRiskEvidence = new Set(
    (input.monitoring?.warnings.evidenceNeedingReconfirmation ?? []).map(
      (item) => item.evidenceId
    )
  );
  const affectedClaims = new Set(
    (input.monitoring?.warnings.affectedClaims ?? []).map(
      (item) => item.claimId
    )
  );

  return [...input.claims]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((claim) => {
      const claimEvidence = evidenceByClaim.get(claim.id) ?? [];
      const verdict = verdictByClaimId.get(claim.id);
      const claimGaps = gapsByClaim.get(claim.id) ?? [];
      const findingIds: string[] = [];
      const recommendations: string[] = [];

      // --- supporting material and the origins behind it -----------------
      const supportingIds = verdict?.basis.supportingEvidenceIds ?? [];
      const supportingItems = supportingIds
        .map((id) => evidenceById.get(id))
        .filter((item): item is Evidence => item !== undefined);
      const supportingSourceIds = sortedIds(
        supportingItems
          .map((item) => item.sourceId)
          .filter((id): id is string => typeof id === "string")
      );
      const clusterIds = sortedIds(
        supportingSourceIds.map((id) => clusterOf.get(id) ?? `source:${id}`)
      );
      // Null, not 0, when there is nothing to judge: a claim with no
      // supporting material at all has no independence to measure, and
      // "0 independent sources" would read as a measured result where the
      // honest answer is that independence could not be established.
      const independentSourceCount =
        supportingIds.length === 0
          ? null
          : input.independence === null
            ? null
            : supportingSourceIds.length === 0
              ? null
              : clusterIds.length;

      // --- findings -------------------------------------------------------
      if (claimEvidence.length === 0) {
        const severity: QualitySeverity =
          claim.importance >= SEVERE_THRESHOLD ? "critical" : "warning";
        emit({
          id: `missing_evidence:${claim.id}`,
          scope: "claim",
          entityId: claim.id,
          category: "missing_evidence",
          severity,
          reason: `该主张（重要度 ${claim.importance}/5）没有任何关联材料，无法判断。`,
          ruleId: "claim.no_evidence",
          evidenceReferences: [],
          claimId: claim.id,
          recommendation: "add_supporting_evidence"
        });
        findingIds.push(`missing_evidence:${claim.id}`);
        recommendations.push("补充该主张的证据材料");
      }

      const unverifiedCount = verdict?.counts.unverified ?? 0;
      if (unverifiedCount > 0) {
        emit({
          id: `unverified_evidence:${claim.id}`,
          scope: "claim",
          entityId: claim.id,
          category: "unverified_evidence",
          severity: "warning",
          reason: `${unverifiedCount} 条关联材料尚未核实，不能作为结论依据。`,
          ruleId: "claim.unverified_evidence",
          evidenceReferences: claimEvidence
            .filter((item) => item.verificationStatus === "unverified")
            .map((item) => item.id)
            .sort(),
          claimId: claim.id,
          recommendation: "verify_evidence"
        });
        findingIds.push(`unverified_evidence:${claim.id}`);
        recommendations.push("逐条核实该主张的材料");
      }

      // Five excerpts reprinting one report are one source, not five proofs.
      if (
        supportingIds.length >= 2 &&
        independentSourceCount !== null &&
        independentSourceCount <= 1
      ) {
        const samePage =
          supportingSourceIds.length <= 1 && clusterIds.length <= 1;
        emit({
          id: `single_source_dependency:${claim.id}`,
          scope: "claim",
          entityId: claim.id,
          category: "single_source_dependency",
          severity: "warning",
          reason:
            `${supportingIds.length} 条已核实支持材料${
              samePage ? "全部来自同一个来源" : "经确认属于同一份信息源"
            }，只构成 1 份独立佐证。多份摘录不等于多份证明。`,
          ruleId: "claim.single_source_dependency",
          evidenceReferences: [...supportingIds].sort(),
          claimId: claim.id,
          recommendation: "record_source"
        });
        findingIds.push(`single_source_dependency:${claim.id}`);
        recommendations.push("寻找真正独立的原始出处");
      }

      const claimConflicts = input.conflicts.filter(
        (conflict) =>
          conflict.claimIds.includes(claim.id) &&
          isConflictAwaitingHumanDecision(conflict)
      );
      for (const conflict of claimConflicts) {
        const severity: QualitySeverity =
          conflict.severity >= SEVERE_THRESHOLD ? "critical" : "warning";
        emit({
          id: `unresolved_conflict:${conflict.id}`,
          scope: "claim",
          entityId: claim.id,
          category: "unresolved_conflict",
          severity,
          reason: `冲突「${conflict.summary}」（严重度 ${conflict.severity}）仍在等待人工决定。`,
          ruleId: "conflict.awaiting_decision",
          evidenceReferences: [],
          claimId: claim.id,
          recommendation: "open_human_review"
        });
        findingIds.push(`unresolved_conflict:${conflict.id}`);
      }
      if (claimConflicts.length > 0) {
        recommendations.push("处理未解决冲突");
      }

      const claimChallenges = input.challenges.filter(
        (challenge) => challenge.targetClaimId === claim.id
      );
      const unanswered = claimChallenges.filter(
        (challenge) => challenge.status !== "resolved"
      );
      for (const challenge of unanswered) {
        const severity: QualitySeverity =
          challenge.severity >= SEVERE_THRESHOLD ? "critical" : "warning";
        emit({
          id: `unanswered_challenge:${challenge.id}`,
          scope: "claim",
          entityId: claim.id,
          category: "unanswered_challenge",
          severity,
          reason: `质询「${challenge.question}」（严重度 ${challenge.severity}）尚未回应。`,
          ruleId: "challenge.unanswered",
          evidenceReferences: [],
          claimId: claim.id,
          recommendation: "run_cross_review"
        });
        findingIds.push(`unanswered_challenge:${challenge.id}`);
      }
      if (unanswered.length > 0) {
        recommendations.push("回应交叉审查质询");
      }

      const atRiskForClaim = claimEvidence.filter((item) =>
        atRiskEvidence.has(item.id)
      );
      if (atRiskForClaim.length > 0) {
        emit({
          id: `stale_source:${claim.id}`,
          scope: "claim",
          entityId: claim.id,
          category: "stale_source",
          severity: "warning",
          reason:
            `${atRiskForClaim.length} 条材料所在的来源已发生变化，需要重新核查。` +
            "来源变化不改变历史结论，但结论所依据的材料版本可能已更新。",
          ruleId: "monitoring.affected_claim",
          evidenceReferences: atRiskForClaim.map((item) => item.id).sort(),
          claimId: claim.id,
          recommendation: "open_source_reader"
        });
        findingIds.push(`stale_source:${claim.id}`);
        recommendations.push("重新核查发生变化的来源");
      }
      if (affectedClaims.has(claim.id) && atRiskForClaim.length === 0) {
        emit({
          id: `stale_source:${claim.id}`,
          scope: "claim",
          entityId: claim.id,
          category: "stale_source",
          severity: "warning",
          reason:
            "来源监测将该主张列为可能受影响：其材料所引来源已发生变化，建议重新核查。",
          ruleId: "monitoring.affected_claim",
          evidenceReferences: [],
          claimId: claim.id,
          recommendation: "open_source_reader"
        });
        findingIds.push(`stale_source:${claim.id}`);
        recommendations.push("重新核查发生变化的来源");
      }

      const plannedGapIds = new Set(
        input.planItems.map((item) => item.gapId)
      );
      for (const gap of claimGaps) {
        if (plannedGapIds.has(gap.id)) continue;
        const severity: QualitySeverity =
          gap.severity === "blocking"
            ? "critical"
            : gap.severity === "important"
              ? "warning"
              : "info";
        emit({
          id: `open_research_gap:${gap.id}`,
          scope: "claim",
          entityId: claim.id,
          category: "open_research_gap",
          severity,
          reason: gap.message,
          ruleId: `gap.${gap.kind}`,
          evidenceReferences: [...gap.evidenceIds].sort(),
          claimId: claim.id,
          recommendation: "open_research_plan"
        });
        findingIds.push(`open_research_gap:${gap.id}`);
      }
      if (claimGaps.some((gap) => !plannedGapIds.has(gap.id))) {
        recommendations.push("把研究缺口纳入计划");
      }

      void sourceById;
      return {
        claimId: claim.id,
        statement: claim.statement,
        claimStatus: claim.status,
        importance: claim.importance,
        verdictStatus: verdict?.status ?? "unsupported",
        evidenceTotal: claimEvidence.length,
        evidenceVerified: verdict?.counts.verified ?? 0,
        evidenceUnverified: verdict?.counts.unverified ?? 0,
        evidenceSupporting: verdict?.counts.verifiedSupporting ?? 0,
        evidenceOpposing: verdict?.counts.verifiedOpposing ?? 0,
        independentSourceCount,
        unresolvedConflictCount: claimConflicts.length,
        unansweredChallengeCount: unanswered.length,
        openGapCount: claimGaps.filter((gap) => !plannedGapIds.has(gap.id))
          .length,
        blockingGapCount: claimGaps.filter(
          (gap) => gap.severity === "blocking"
        ).length,
        sourceUpdateRiskCount: atRiskForClaim.length,
        relatedRunIds: sortedIds(
          input.agentRuns
            .filter(
              (run) =>
                run.purpose === "cross_review" && run.targetClaimId === claim.id
            )
            .map((run) => run.id)
        ),
        findingIds,
        recommendations
      };
    });
}

function buildEvidenceFindings(
  input: ResearchQualityInput,
  emit: (finding: QualityFinding) => void
): EvidenceQualityFinding[] {
  const evidenceById = byId(input.evidence);
  const reconfirmation = new Map(
    (input.monitoring?.warnings.evidenceNeedingReconfirmation ?? []).map(
      (item) => [item.evidenceId, item]
    )
  );

  return [...input.evidence]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => {
      const findingIds: string[] = [];
      const locator = item.locator?.trim() ?? "";
      const hasSourceRecord = typeof item.sourceId === "string";
      const hasVerificationRecord =
        item.verificationStatus !== "unverified" &&
        typeof item.verifiedBy === "string" &&
        item.verifiedBy.trim() !== "" &&
        typeof item.verificationNote === "string" &&
        item.verificationNote.trim() !== "";

      if (!hasSourceRecord && !item.sourceRef) {
        emit({
          id: `missing_source_record:${item.id}`,
          scope: "evidence",
          entityId: item.id,
          category: "missing_source_record",
          severity: "warning",
          reason: "该材料既没有登记来源记录，也没有来源链接，无法追溯。",
          ruleId: "evidence.no_source",
          evidenceReferences: [item.id],
          claimId: item.claimIds[0] ?? null,
          recommendation: "record_source"
        });
        findingIds.push(`missing_source_record:${item.id}`);
      }

      if (item.locatorStatus === "missing") {
        emit({
          id: `broken_citation:${item.id}`,
          scope: "evidence",
          entityId: item.id,
          category: "broken_citation",
          severity: "warning",
          reason:
            "该摘录在其来源的当前版本中已无法定位。历史核实记录保持不变；需要重新核查，而不是改写核实状态。",
          ruleId: "evidence.locator_missing",
          evidenceReferences: [item.id],
          claimId: item.claimIds[0] ?? null,
          recommendation: "open_source_reader"
        });
        findingIds.push(`broken_citation:${item.id}`);
      } else if (locator === "" && item.verificationStatus === "verified") {
        emit({
          id: `broken_citation:${item.id}`,
          scope: "evidence",
          entityId: item.id,
          category: "broken_citation",
          severity: "info",
          reason: "该材料没有记录原文定位，无法重新定位核对。",
          ruleId: "evidence.locator_absent",
          evidenceReferences: [item.id],
          claimId: item.claimIds[0] ?? null,
          recommendation: "open_source_reader"
        });
        findingIds.push(`broken_citation:${item.id}`);
      }

      const risk = reconfirmation.get(item.id);
      if (risk) {
        emit({
          id: `stale_source:${item.id}`,
          scope: "evidence",
          entityId: item.id,
          category: "stale_source",
          severity: "warning",
          reason: risk.reason,
          ruleId: "monitoring.evidence_reconfirmation",
          evidenceReferences: [item.id],
          claimId: item.claimIds[0] ?? null,
          recommendation: "open_source_reader"
        });
        findingIds.push(`stale_source:${item.id}`);
      }

      void evidenceById;
      return {
        evidenceId: item.id,
        claimIds: [...item.claimIds].sort(),
        title: item.title,
        direction: item.direction,
        verificationStatus: item.verificationStatus,
        locatorStatus: item.locatorStatus ?? null,
        hasSourceRecord,
        hasExcerpt: item.content.trim().length > 0,
        hasLocator: locator !== "",
        hasVerificationRecord,
        sourceUpdateRisk: risk !== undefined,
        sourceUpdateRiskReason: risk?.reason ?? null,
        findingIds
      };
    });
}

/* ------------------------------------------------------------------ *
 * Recommendations
 * ------------------------------------------------------------------ */

const RECOMMENDATION_TITLES: Record<QualityFindingCategory, string> = {
  missing_evidence: "补充证据材料",
  unverified_evidence: "核实未核实材料",
  single_source_dependency: "补充独立原始出处",
  unresolved_conflict: "处理未解决冲突",
  unanswered_challenge: "回应交叉审查质询",
  broken_citation: "重新定位引用",
  stale_source: "重新核查变化的来源",
  open_research_gap: "把缺口纳入研究计划",
  insufficient_independence: "确认来源是否同源",
  duplicate_source: "核对重复登记的来源",
  missing_source_record: "补齐材料来源",
  publisher_concentration: "核对同一发布方的来源"
};

const RECOMMENDATION_ACTIONS: Record<
  QualityFindingCategory,
  QualityRecommendationAction
> = {
  missing_evidence: "add_supporting_evidence",
  unverified_evidence: "verify_evidence",
  single_source_dependency: "record_source",
  unresolved_conflict: "open_human_review",
  unanswered_challenge: "run_cross_review",
  broken_citation: "open_source_reader",
  stale_source: "open_source_reader",
  open_research_gap: "open_research_plan",
  insufficient_independence: "open_source_relations",
  duplicate_source: "open_source_relations",
  missing_source_record: "record_source",
  publisher_concentration: "open_source_relations"
};

const SEVERITY_ORDER: Record<QualitySeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2
};

/**
 * Actions whose *subject* is a source rather than a claim or an excerpt.
 *
 * These are the recommendations a reader answers by re-reading a source, so the
 * card belongs to the source. That matters because the rules fire per row they
 * read: one changed source produces a `stale_source` finding on the source, one
 * on every affected excerpt and one on every affected claim. Left keyed by
 * `scope:entityId`, the same source becomes a dozen cards repeating one
 * sentence.
 */
const SOURCE_ANCHORED_ACTIONS = new Set<QualityRecommendationAction>([
  "open_source_reader",
  "open_source_relations"
]);

function buildRecommendations(
  findings: readonly QualityFinding[],
  claimStatements: Map<string, string>,
  sourceTitles: Map<string, string>,
  evidenceSourceIds: Map<string, string>
): QualityRecommendation[] {
  /**
   * The source a source-anchored finding is really about, or null when it
   * cannot be established from persisted rows. Only a finding that resolves to
   * exactly one source is anchored: an excerpt list spanning two sources is not
   * evidence that either of them moved, so it stays keyed where it was.
   */
  const anchorOf = (finding: QualityFinding): string | null => {
    if (!SOURCE_ANCHORED_ACTIONS.has(RECOMMENDATION_ACTIONS[finding.category])) {
      return null;
    }
    if (finding.scope === "source") return finding.entityId;
    const sourceIds = new Set<string>();
    for (const evidenceId of finding.evidenceReferences) {
      const sourceId = evidenceSourceIds.get(evidenceId);
      if (sourceId !== undefined) sourceIds.add(sourceId);
    }
    return sourceIds.size === 1 ? [...sourceIds][0] ?? null : null;
  };

  const groups = new Map<
    string,
    {
      category: QualityFindingCategory;
      scope: QualityFinding["scope"];
      entityId: string;
      anchor: string | null;
      severity: QualitySeverity;
      findings: QualityFinding[];
    }
  >();
  for (const finding of findings) {
    const anchor = anchorOf(finding);
    const key = anchor
      ? `${finding.category}:source:${anchor}`
      : `${finding.scope}:${finding.entityId}:${finding.category}`;
    const current = groups.get(key);
    if (current) {
      current.findings.push(finding);
      if (
        SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[current.severity]
      ) {
        current.severity = finding.severity;
      }
      continue;
    }
    groups.set(key, {
      category: finding.category,
      scope: finding.scope,
      entityId: finding.entityId,
      anchor,
      severity: finding.severity,
      findings: [finding]
    });
  }

  return [...groups.entries()]
    .sort(
      ([, left], [, right]) =>
        SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
        (left.anchor ?? left.entityId).localeCompare(
          right.anchor ?? right.entityId
        ) ||
        left.category.localeCompare(right.category)
    )
    .map(([key, group]) => {
      const subject =
        group.anchor !== null
          ? (sourceTitles.get(group.anchor) ?? group.anchor)
          : group.scope === "claim"
            ? (claimStatements.get(group.entityId) ?? group.entityId)
            : group.scope === "source"
              ? (sourceTitles.get(group.entityId) ?? group.entityId)
              : group.scope === "evidence"
                ? "材料"
                : "本研究会话";
      const reasons = [...new Set(group.findings.map((finding) => finding.reason))];
      return {
        id: `recommendation:${key}`,
        title: `${RECOMMENDATION_TITLES[group.category]}：${subject}`,
        detail: reasons.join("；"),
        action: RECOMMENDATION_ACTIONS[group.category],
        claimId:
          group.scope === "claim"
            ? group.entityId
            : (group.findings.find((item) => item.claimId !== null)?.claimId ??
              null),
        evidenceIds: sortedIds(
          group.findings.flatMap((finding) => finding.evidenceReferences)
        ),
        sourceIds: sortedIds(group.anchor === null ? [] : [group.anchor]),
        findingIds: sortedIds(group.findings.map((finding) => finding.id))
      };
    });
}

/* ------------------------------------------------------------------ *
 * Fingerprint and limitations
 * ------------------------------------------------------------------ */

function inputFingerprint(input: ResearchQualityInput): string {
  const payload = [
    input.claims.map((item) => `${item.id}:${item.status}`).sort(),
    input.evidence
      .map(
        (item) =>
          `${item.id}:${item.verificationStatus}:${item.direction}:${item.locatorStatus ?? "none"}`
      )
      .sort(),
    input.sources
      .map((item) => `${item.id}:${item.contentHash ?? "none"}`)
      .sort(),
    input.challenges.map((item) => `${item.id}:${item.status}`).sort(),
    input.conflicts.map((item) => `${item.id}:${item.status}`).sort(),
    input.gaps.map((item) => `${item.id}:${item.severity}`).sort()
  ]
    .map((group) => group.join(","))
    .join("|");
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function globalLimitations(
  input: ResearchQualityInput,
  dimensions: QualityDimension[]
): string[] {
  const limitations: string[] = [];
  for (const item of dimensions) {
    for (const limit of item.limitations) {
      if (!limitations.includes(limit)) limitations.push(limit);
    }
  }
  if (!input.independence) {
    limitations.push("来源独立性分析不可用：来源间关系无法评估。");
  }
  if (!input.monitoring) {
    limitations.push("未配置来源监测：来源变化风险无法评估。");
  }
  if (input.planItems.length === 0) {
    limitations.push("研究计划当前没有条目：缺口是否有人跟进无法评估。");
  }
  limitations.push(
    "本评估为只读投影：不修改主张状态、核查结论、人工裁定或已保存的报告快照。"
  );
  limitations.push(
    "质量分数描述研究流程与证据组织，不是结论正确的概率，也不能反推任何主张的真假。"
  );
  return limitations;
}

/* ------------------------------------------------------------------ *
 * The projection
 * ------------------------------------------------------------------ */

/**
 * Projects the research quality assessment. Pure: same input, same output,
 * no I/O, no clock of its own.
 */
export function projectResearchQuality(
  input: ResearchQualityInput
): ResearchQualityAssessment {
  const collected: QualityFinding[] = [];
  const emit = (finding: QualityFinding): void => {
    collected.push(finding);
  };

  const sourceRelations = readSourceRelations(input);
  const sourceFindings = buildSourceFindings(input, sourceRelations, emit);
  const claimFindings = buildClaimFindings(input, emit);
  const evidenceFindings = buildEvidenceFindings(input, emit);

  const findings = collected.sort(
    (left, right) =>
      SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
      left.scope.localeCompare(right.scope) ||
      left.id.localeCompare(right.id)
  );

  const dimensions: QualityDimension[] = [
    evaluateCoverage(input),
    evaluateVerification(input),
    evaluateIndependence(input),
    evaluateConflicts(input),
    evaluateCompleteness(input),
    evaluateFreshness(input)
  ];
  const { overall } = buildOverall(dimensions);

  const recommendations = buildRecommendations(
    findings,
    new Map(input.claims.map((claim) => [claim.id, claim.statement])),
    new Map(input.sources.map((source) => [source.id, source.title])),
    // An excerpt knows which source it was taken from; that link is what lets a
    // source-anchored recommendation name the source it is about instead of
    // going out with no target at all.
    new Map(
      input.evidence.flatMap((item) =>
        typeof item.sourceId === "string"
          ? [[item.id, item.sourceId] as const]
          : []
      )
    )
  );

  return ResearchQualityAssessmentSchema.parse({
    sessionId: input.sessionId,
    assessedAt: input.assessedAt,
    schemaVersion: RESEARCH_QUALITY_SCHEMA_VERSION,
    ruleVersion: RESEARCH_QUALITY_RULE_VERSION,
    inputFingerprint: inputFingerprint(input),
    overall,
    dimensions,
    claimFindings,
    evidenceFindings,
    sourceFindings,
    findings,
    recommendations,
    limitations: globalLimitations(input, dimensions)
  });
}
