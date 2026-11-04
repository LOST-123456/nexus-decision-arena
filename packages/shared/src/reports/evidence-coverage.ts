import type { Claim } from "../domain/claim";
import type { Evidence } from "../domain/evidence";

/**
 * 这一轮结论背后，有多少主张真的有已核实证据。
 *
 * 为什么需要它：产品可以给出"有限立项"这样的建议，但读者有权知道自己看的
 * 是"核过的结论"还是"没人核过的建议"。此前的报告只写"5 项关键质询、0 项
 * 关联证据"，把判断留给了读者；而这个产品最不能出的错，就是让人以为
 * AI 说过的话已经被核实过。
 *
 * 三条判定规则，都不看模型的说法，只看落库的状态：
 *
 *  1. 一条主张算"有支撑"，必须至少有一条**已核实**的证据挂在它上面。
 *  2. 那条证据必须是 `supports`。`context` 是背景材料，按定义不构成支撑；
 *     `opposes` 是反证，更不是支撑。
 *  3. `assumption` 类型的证据永远不算——schema 已经禁止它被标为 verified，
 *     这里再挡一次，是因为这条规则太重要，不能只靠一个地方守。
 *
 * 分母为 0 时不返回 100%：没有主张可统计，不构成"已核实"。
 */
export type ReportEvidenceCoverageLevel = "unverified" | "partial" | "verified";

export type ReportEvidenceCoverage = {
  totalClaims: number;
  /** 一条证据都没有的主张数。 */
  claimsWithoutEvidence: number;
  /** 没有任何**已核实支撑证据**的主张数——这是"结论未获核实"的直接度量。 */
  claimsWithoutVerifiedEvidence: number;
  totalEvidence: number;
  verifiedEvidence: number;
  /**
   * 0~1。分母为 0 时是 `null`，不是 1——"没有主张"不等于"全部核实过"。
   */
  coverageRatio: number | null;
  level: ReportEvidenceCoverageLevel;
  /** 给页眉/导出用的一句中文，口径只在这里定义一次。 */
  statement: string;
  /** 一句话告诉读者该怎么用这份报告。 */
  usage: string;
};

export const COVERAGE_LEVEL_LABELS: Record<ReportEvidenceCoverageLevel, string> = {
  unverified: "证据不足",
  partial: "部分核实",
  verified: "已核实"
};

export function coverageLevelLabel(level: string): string {
  return level in COVERAGE_LEVEL_LABELS
    ? COVERAGE_LEVEL_LABELS[level as ReportEvidenceCoverageLevel]
    : level;
}

export function computeReportEvidenceCoverage(
  claims: readonly Pick<Claim, "id" | "evidenceIds">[],
  evidence: readonly Pick<
    Evidence,
    "claimIds" | "verificationStatus" | "direction" | "kind"
  >[]
): ReportEvidenceCoverage {
  const supportingVerified = new Set<string>();
  for (const item of evidence) {
    if (item.verificationStatus !== "verified") continue;
    if (item.direction !== "supports") continue;
    if (item.kind === "assumption") continue;
    for (const claimId of item.claimIds) {
      supportingVerified.add(claimId);
    }
  }

  const totalClaims = claims.length;
  const claimsWithoutEvidence = claims.filter(
    (claim) => claim.evidenceIds.length === 0
  ).length;
  const claimsWithoutVerifiedEvidence = claims.filter(
    (claim) => !supportingVerified.has(claim.id)
  ).length;
  const totalEvidence = evidence.length;
  const verifiedEvidence = evidence.filter(
    (item) => item.verificationStatus === "verified"
  ).length;

  const coverageRatio =
    totalClaims === 0
      ? null
      : (totalClaims - claimsWithoutVerifiedEvidence) / totalClaims;

  const level: ReportEvidenceCoverageLevel =
    totalClaims === 0 || claimsWithoutVerifiedEvidence === totalClaims
      ? "unverified"
      : claimsWithoutVerifiedEvidence === 0
        ? "verified"
        : "partial";

  return {
    totalClaims,
    claimsWithoutEvidence,
    claimsWithoutVerifiedEvidence,
    totalEvidence,
    verifiedEvidence,
    coverageRatio,
    level,
    statement: buildStatement({
      totalClaims,
      claimsWithoutVerifiedEvidence,
      totalEvidence,
      verifiedEvidence
    }),
    usage: buildUsage(level)
  };
}

function buildStatement(input: {
  totalClaims: number;
  claimsWithoutVerifiedEvidence: number;
  totalEvidence: number;
  verifiedEvidence: number;
}): string {
  if (input.totalClaims === 0) {
    return "本轮没有记录任何主张，无法给出证据覆盖率。";
  }
  if (input.totalEvidence === 0) {
    return `${input.totalClaims} 条主张，0 条证据——全部结论都没有可追溯依据。`;
  }
  return (
    `${input.totalClaims} 条主张，其中 ${input.claimsWithoutVerifiedEvidence} 条没有任何已核实证据；` +
    `共 ${input.totalEvidence} 条证据，${input.verifiedEvidence} 条已核实。`
  );
}

function buildUsage(level: ReportEvidenceCoverageLevel): string {
  if (level === "verified") {
    return "每条主张都有已核实证据支撑，结论可以作为决策依据。";
  }
  return "本报告的结论属于建议，不是已经核实的结果：标出的缺口要补上、并由人确认之后，它才具备决策效力。";
}
