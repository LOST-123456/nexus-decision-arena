import {
  reviewOutcomeLabel,
  type ClaimVerdictStatus,
  type EvidenceGap,
  type EvidenceGapSeverity,
  type ResearchPlanStatus
} from "@nexus/shared";
import type {
  EvidenceCitation,
  FactCheckReport,
  GapPlanLink
} from "./fact-check-report";

const STATUS_TEXT: Record<ClaimVerdictStatus, string> = {
  unsupported: "无任何证据",
  insufficient_evidence: "证据不足，未下结论",
  context_only: "仅有背景材料",
  supported: "有已核实支持证据",
  refuted: "有已核实反对证据",
  mixed_evidence: "证据相互冲突",
  inconclusive: "交叉审查后仍未确定"
};

const GAP_SEVERITY_TEXT: Record<EvidenceGapSeverity, string> = {
  blocking: "阻断",
  important: "重要",
  advisory: "提示"
};

function formatDate(value: string | null): string {
  return value ?? "未记录";
}

const GAP_PLAN_STATUS_TEXT: Record<ResearchPlanStatus | "not_planned", string> = {
  not_planned: "尚未加入研究计划",
  queued: "已加入研究计划，尚未执行",
  running: "检索进行中",
  completed: "研究计划已完成（结果见工作台）",
  failed: "检索失败",
  needs_human: "需要人工决定",
  not_applicable: "已判定不适用",
  closed: "已关闭"
};

/** An annotated gap: the diagnosis plus the plan's answer to it. */
type AnnotatedGap = EvidenceGap & { plan: GapPlanLink };

function gapLine(gap: AnnotatedGap): string[] {
  const lines = [
    `- [${GAP_SEVERITY_TEXT[gap.severity]}] ${gap.message}`
  ];
  for (const detail of gap.detail) {
    lines.push(`  - ${detail}`);
  }
  if (gap.evidenceIds.length > 0) {
    lines.push(`  - 涉及材料：${gap.evidenceIds.join("、")}`);
  }
  if (gap.challengeIds.length > 0) {
    lines.push(`  - 涉及质询：${gap.challengeIds.join("、")}`);
  }
  const planLine = `  - 研究计划：${GAP_PLAN_STATUS_TEXT[gap.plan.status]}`;
  lines.push(
    gap.plan.note ? `${planLine}——${gap.plan.note}` : planLine
  );
  for (const suggestion of gap.suggestions) {
    // `status` is "suggested" by construction; nothing here was searched.
    lines.push(`  - 建议（待验证，未执行检索）：${suggestion.label}`);
  }
  return lines;
}

const VERIFICATION_TEXT: Record<EvidenceCitation["verificationStatus"], string> = {
  verified: "已核实",
  rejected: "已驳回",
  unverified: "待核实"
};

const DIRECTION_TEXT: Record<EvidenceCitation["direction"], string> = {
  supports: "支持",
  opposes: "反对",
  context: "背景"
};

function citationLine(citation: EvidenceCitation): string[] {
  const provenance =
    citation.citationStatus === "linked" && citation.source
      ? `来源：《${citation.source.title}》${citation.source.publisher ? `（${citation.source.publisher}）` : ""}${citation.source.url ? ` ${citation.source.url}` : ""}`
      : citation.citationStatus === "url_only"
        ? `来源：仅有链接 ${citation.sourceRef}（未登记来源记录）`
        : "来源：**未记录**（无法追溯）";
  const lines = [
    `- **${citation.title}**（${DIRECTION_TEXT[citation.direction]} · ${VERIFICATION_TEXT[citation.verificationStatus]} · 可靠性 ${citation.reliability.toFixed(2)}）`,
    `  - 摘录：${citation.excerpt}`,
    citation.locator ? `  - 定位：${citation.locator}` : "",
    `  - ${provenance}`,
    citation.verifiedBy
      ? `  - 核实人：${citation.verifiedBy}${citation.verificationNote ? `；理由：${citation.verificationNote}` : ""}`
      : "",
    citation.citationStatus === "unlinked"
      ? "  - ⚠️ 该材料没有登记来源，报告不为其提供引用。"
      : ""
  ];
  return lines.filter(Boolean);
}

/**
 * Renders the structured report as Markdown.
 *
 * Every citation comes from a persisted row; nothing is summarised by a model
 * and no source is invented. When a material has no provenance record the
 * report says so instead of omitting it.
 */
export function renderFactCheckReportMarkdown(
  report: FactCheckReport
): string {
  const lines: string[] = [];

  lines.push("# 事实核查报告", "");
  lines.push(`- 研究问题：${report.researchQuestion ?? "（未填写）"}`);
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 报告版本：v${report.reportVersion}（材料指纹 ${report.materialsFingerprint}）`);
  lines.push(
    `- 核查范围：${report.scope.claims} 条主张 / ${report.scope.evidence} 条材料 / ${report.scope.sources} 条来源 / ${report.scope.challenges} 项质询 / ${report.scope.reviews} 次人工复核`
  );
  lines.push(
    `- 独立来源：${report.independence.headline}（同一份信息源的转载不重复计票）`
  );
  lines.push(
    `- 所用资料时间范围：发布 ${formatDate(report.materialsTimeRange.publishedAt.earliest)} ~ ${formatDate(report.materialsTimeRange.publishedAt.latest)}；获取 ${formatDate(report.materialsTimeRange.retrievedAt.earliest)} ~ ${formatDate(report.materialsTimeRange.retrievedAt.latest)}`
  );
  lines.push(
    `- 资料有效期范围：${formatDate(report.materialsTimeRange.validity.earliestFrom)} ~ ${formatDate(report.materialsTimeRange.validity.latestTo)}`
  );
  if (report.gaps.evidenceGaps.total > 0) {
    lines.push(
      `- 证据缺口：阻断 ${report.gaps.evidenceGaps.bySeverity.blocking} 项 / 重要 ${report.gaps.evidenceGaps.bySeverity.important} 项 / 提示 ${report.gaps.evidenceGaps.bySeverity.advisory} 项`
    );
  }
  lines.push("");

  lines.push("## 结论概览", "");
  for (const [status, count] of Object.entries(report.summary.byStatus)) {
    lines.push(`- ${STATUS_TEXT[status as ClaimVerdictStatus]}：${count}`);
  }
  lines.push(
    `- 待核实材料：${report.summary.unverified} 条；已核实：${report.summary.verified} 条；已驳回：${report.summary.rejected} 条`
  );
  lines.push("");

  lines.push("## 逐条主张与结论", "");
  if (report.findings.length === 0) {
    lines.push("（本次研究没有任何主张）", "");
  }
  for (const finding of report.findings) {
    lines.push(`### ${finding.statement}`, "");
    lines.push(
      `- 结论：**${STATUS_TEXT[finding.verdict.status]}**（把握度 ${Math.round(finding.verdict.confidence * 100)}%）`
    );
    if (finding.verdict.effectiveStatus !== finding.verdict.status) {
      lines.push(
        `- 人工裁定后的对外结论：**${STATUS_TEXT[finding.verdict.effectiveStatus]}**（未修改证据推导结论）`
      );
    }
    lines.push(
      `- 主张类型：${finding.type}；内部状态：${finding.claimStatus}`
    );
    lines.push(`- 结论理由：${finding.verdict.rationale}`);
    lines.push(`- 命中规则：${finding.verdict.ruleHits.join("、")}`);
    if (finding.verdict.basis.supportingEvidenceIds.length > 0) {
      lines.push(
        `- 参与判断的支持材料：${finding.verdict.basis.supportingEvidenceIds.join("、")}`
      );
    }
    if (finding.verdict.basis.opposingEvidenceIds.length > 0) {
      lines.push(
        `- 参与判断的反对材料：${finding.verdict.basis.opposingEvidenceIds.join("、")}`
      );
    }
    if (finding.verdict.basis.contextEvidenceIds.length > 0) {
      lines.push(
        `- 参与判断的背景材料：${finding.verdict.basis.contextEvidenceIds.join("、")}`
      );
    }
    for (const exclusion of finding.verdict.excluded) {
      lines.push(`- 排除材料 ${exclusion.evidenceId}：${exclusion.reason}`);
    }
    for (const basis of finding.verdict.confidenceBasis) {
      lines.push(`- 把握度依据：${basis}`);
    }
    for (const limit of finding.verdict.limits) {
      lines.push(`- 局限：${limit}`);
    }
    lines.push("");

    if (finding.supporting.length > 0) {
      lines.push("**支持证据**", "");
      for (const citation of finding.supporting) {
        lines.push(...citationLine(citation));
      }
      lines.push("");
    }
    if (finding.opposing.length > 0) {
      lines.push("**反对证据**", "");
      for (const citation of finding.opposing) {
        lines.push(...citationLine(citation));
      }
      lines.push("");
    }
    if (finding.context.length > 0) {
      lines.push("**背景材料**", "");
      for (const citation of finding.context) {
        lines.push(...citationLine(citation));
      }
      lines.push("");
    }
    if (finding.excluded.length > 0) {
      lines.push("**未参与结论的材料**", "");
      for (const citation of finding.excluded) {
        lines.push(...citationLine(citation));
      }
      lines.push("");
    }

    if (finding.challenges.length > 0) {
      lines.push("**交叉审查发现**", "");
      for (const challenge of finding.challenges) {
        lines.push(
          `- [${challenge.unresolved ? "未解决" : "已解决"}] ${challenge.question}（严重度 ${challenge.severity}，${challenge.type}）`
        );
        if (challenge.requiredEvidence.length > 0) {
          lines.push(
            `  - 挑战者要求的证据：${challenge.requiredEvidence.join("；")}`
          );
        }
        if (challenge.unverifiedReferences.length > 0) {
          lines.push(
            `  - ⚠️ 以上要求中，${challenge.unverifiedReferences.length} 项在本研究中**没有登记为证据**，不构成引用`
          );
        }
      }
      lines.push("");
    }

    if (finding.reviewHistory.length > 0) {
      lines.push("**人工复核记录**", "");
      for (const review of finding.reviewHistory) {
        lines.push(
          `- ${review.createdAt} · ${review.reviewer} · ${reviewOutcomeLabel(review.outcome)}：${review.rationale}`
        );
        lines.push(
          `  - 裁定时的推导结论：${STATUS_TEXT[review.verdictStatusAtReview]}（把握度 ${Math.round(review.verdictConfidenceAtReview * 100)}%）`
        );
      }
      lines.push("");
    }

    if (finding.runs.length > 0) {
      lines.push("**交叉审查运行记录**", "");
      for (const run of finding.runs) {
        lines.push(
          `- ${run.startedAt} · ${run.purpose} · ${run.status}${run.error ? `：${run.error}` : ""}`
        );
      }
      lines.push("");
    }

    if (finding.gaps.length > 0) {
      lines.push("**证据缺口与建议补充材料**", "");
      for (const gap of finding.gaps) {
        lines.push(...gapLine(gap));
      }
      lines.push("");
    }
  }

  lines.push("## 证据缺口与未决问题", "");
  if (report.gaps.insufficientEvidence.length === 0) {
    lines.push("- 无：所有主张都有可用的已核实材料。");
  }
  for (const gap of report.gaps.insufficientEvidence) {
    lines.push(`- 证据不足：${gap.statement}`);
  }
  for (const conflict of report.gaps.unresolvedConflicts) {
    lines.push(`- 未解决冲突（严重度 ${conflict.severity}）：${conflict.summary}`);
  }
  for (const assumption of report.gaps.assumptions) {
    lines.push(`- 假设（不可核实）：${assumption.statement}`);
  }
  for (const citation of report.gaps.unlinkedCitations) {
    lines.push(`- 无来源材料：${citation.title}`);
  }
  lines.push("");

  if (report.limits.length > 0) {
    lines.push("## 适用范围与时间范围", "");
    for (const limit of report.limits) {
      lines.push(`- ${limit}`);
    }
    lines.push("");
  }

  lines.push("## 可追溯性", "");
  lines.push(`- 材料指纹：${report.materialsFingerprint}`);
  lines.push(`- 事件序号上界：${report.provenance.lastEventSequence}`);
  lines.push(`- 主张：${report.provenance.claimIds.length} 条`);
  lines.push(`- 证据：${report.provenance.evidenceIds.length} 条`);
  lines.push(`- 来源：${report.provenance.sourceIds.length} 条`);
  lines.push(`- 质询：${report.provenance.challengeIds.length} 项`);
  lines.push(`- Agent 运行：${report.provenance.agentRunIds.length} 次`);
  lines.push(`- 人工复核：${report.provenance.reviewIds.length} 次`);
  lines.push("");

  return lines.join("\n");
}
