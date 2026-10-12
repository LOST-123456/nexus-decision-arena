import type {
  Claim,
  Evidence,
  RevalidationReportWarnings,
  RevalidationTask,
  Source,
  SourceSnapshot
} from "@nexus/shared";

/**
 * Derives what the fact-check report has to say about monitoring.
 *
 * Pure and derived: the open tasks, the changed sources, the excerpts that
 * need re-confirming and the claims they bear on all come from persisted rows.
 * The verdict pipeline cannot see this block — an open re-check is a reason to
 * re-read the report, never a reason to change a verdict.
 *
 * `sourceVersions` records the exact capture each source was at when the
 * report was built, so a reader can tell which version a conclusion was drawn
 * from even after the page moves on.
 */

export function deriveRevalidationWarnings(input: {
  tasks: readonly RevalidationTask[];
  claims: readonly Claim[];
  evidence: readonly Evidence[];
  sources: readonly Source[];
  /** The current capture per source, from the snapshot table. */
  latestSnapshots: readonly SourceSnapshot[];
}): RevalidationReportWarnings {
  const evidenceById = new Map(
    input.evidence.map((item) => [item.id, item])
  );
  const claimById = new Map(input.claims.map((item) => [item.id, item]));
  const sourceById = new Map(input.sources.map((item) => [item.id, item]));
  const snapshotBySource = new Map(
    input.latestSnapshots.map((snapshot) => [snapshot.sourceId, snapshot])
  );

  const openTasks = input.tasks.filter((task) => task.status === "open");
  const inReviewTasks = input.tasks.filter((task) => task.status === "in_review");

  // A source "changed" when a task that is still open was opened by its drift.
  const changedSources = [
    ...new Map(
      [...openTasks, ...inReviewTasks].map((task) => [task.sourceId, task])
    ).values()
  ]
    .map((task) => {
      const source = sourceById.get(task.sourceId);
      const snapshot = snapshotBySource.get(task.sourceId);
      return {
        sourceId: task.sourceId,
        title: task.sourceTitle || source?.title || "（未命名来源）",
        checkedAt: task.updatedAt,
        currentContentHash:
          snapshot?.contentHash ?? task.triggerContentHash
      };
    })
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));

  // Excerpts named by an unresolved task, de-duplicated across tasks. An
  // excerpt whose row is gone is named as gone rather than silently dropped:
  // a task pointing at material that no longer exists is itself worth seeing.
  const reconfirmationByEvidence = new Map<
    string,
    {
      evidenceId: string;
      title: string;
      sourceId: string;
      reason: string;
    }
  >();
  for (const task of [...openTasks, ...inReviewTasks]) {
    for (const evidenceId of task.affectedEvidenceIds) {
      if (reconfirmationByEvidence.has(evidenceId)) continue;
      const item = evidenceById.get(evidenceId);
      if (!item?.sourceId) continue;
      reconfirmationByEvidence.set(evidenceId, {
        evidenceId,
        title: item.title,
        sourceId: item.sourceId,
        reason: "该摘录所在的来源已发生变化，需再次确认。"
      });
    }
  }
  const evidenceNeedingReconfirmation = [
    ...reconfirmationByEvidence.values()
  ].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));

  const affectedClaims = [
    ...new Map(
      [...openTasks, ...inReviewTasks]
        .flatMap((task) => task.affectedClaimIds)
        .map((claimId) => [claimId, claimId] as const)
    ).values()
  ]
    .map((claimId) => ({
      claimId,
      statement:
        claimById.get(claimId)?.statement ??
        "（该主张在当前材料中已不可读，建议在工作台确认）"
    }))
    .sort((left, right) => left.claimId.localeCompare(right.claimId));

  const lastCheckedAt = input.tasks.reduce<string | null>(
    (latest, task) =>
      latest === null || task.updatedAt > latest ? task.updatedAt : latest,
    null
  );

  return {
    openTaskCount: openTasks.length,
    inReviewTaskCount: inReviewTasks.length,
    changedSources,
    evidenceNeedingReconfirmation,
    affectedClaims,
    lastCheckedAt,
    sourceVersions: input.sources
      .map((source) => {
        const snapshot = snapshotBySource.get(source.id);
        return {
          sourceId: source.id,
          title: source.title,
          contentHash: snapshot?.contentHash ?? null,
          retrievedAt: snapshot?.retrievedAt ?? null
        };
      })
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
  };
}
