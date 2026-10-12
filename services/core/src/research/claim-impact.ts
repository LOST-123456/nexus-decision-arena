import type {
  Claim,
  ClaimImpact,
  ClaimVerdict,
  Evidence,
  EvidenceImpact
} from "@nexus/shared";

/**
 * Projects which claims a source change reaches, and how.
 *
 * A projection, never a write. It reads the claims, the verdicts and the
 * derived excerpt impacts, and produces a request to re-check — it does not
 * touch `claim.status`, does not overwrite a `ClaimVerdict`, and never asserts
 * that a conclusion became wrong because one of its sources moved.
 *
 * A claim appears here only when at least one excerpt that is *not*
 * `unaffected` bears on it: material that is provably untouched is not a
 * reason to re-open anything.
 */

export function deriveClaimImpacts(input: {
  claims: readonly Claim[];
  evidence: readonly Evidence[];
  impacts: readonly EvidenceImpact[];
  verdicts: readonly ClaimVerdict[];
}): ClaimImpact[] {
  const verdictByClaimId = new Map(
    input.verdicts.map((verdict) => [verdict.claimId, verdict])
  );
  const evidenceById = new Map(
    input.evidence.map((item) => [item.id, item])
  );

  // Impacts worth reporting, grouped by the claims they bear on.
  const affectedByClaim = new Map<string, EvidenceImpact[]>();
  for (const impact of input.impacts) {
    if (impact.impact === "unaffected") continue;
    const item = evidenceById.get(impact.evidenceId);
    if (!item) continue;
    for (const claimId of item.claimIds) {
      const current = affectedByClaim.get(claimId) ?? [];
      current.push(impact);
      affectedByClaim.set(claimId, current);
    }
  }

  const impacts: ClaimImpact[] = [];
  for (const claim of input.claims) {
    const affected = affectedByClaim.get(claim.id);
    if (!affected || affected.length === 0) continue;
    const evidenceIds = affected.map((impact) => impact.evidenceId);
    const sourceIds = [
      ...new Set(
        affected
          .map((impact) => evidenceById.get(impact.evidenceId)?.sourceId)
          .filter((sourceId): sourceId is string => Boolean(sourceId))
      )
    ];
    const verdict = verdictByClaimId.get(claim.id);
    const missing = affected.filter(
      (impact) => impact.impact === "anchor_missing"
    ).length;
    const reason = missing > 0
      ? `该主张依赖的 ${affected.length} 条材料中，有 ${missing} 条摘录已不在来源当前版本里：该主张依赖的部分材料已发生变化，建议重新核查。`
      : `该主张依赖的 ${affected.length} 条材料已随来源更新发生变化：该主张依赖的部分材料已发生变化，建议重新核查。`;
    impacts.push({
      claimId: claim.id,
      statement: claim.statement,
      // Reported exactly as it stands now; monitoring never rewrites it.
      verdictStatus: verdict?.status ?? "unsupported",
      affectedEvidenceIds: evidenceIds,
      sourceIds,
      reason
    });
  }

  // Stable order: by claim id, so a repeated check reads the same.
  return impacts.sort((left, right) => left.claimId.localeCompare(right.claimId));
}
