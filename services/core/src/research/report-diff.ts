import {
  type ReportClaimReference,
  type ReportDiffChangeKind,
  type ReportDiffEntry,
  type ReportEvidenceReference,
  type ReportMonitoringReference,
  type ReportReviewReference,
  type ReportSourceReference,
  type ReportVersionDiff,
  type ResearchReportSnapshot,
  REPORT_SCHEMA_VERSION
} from "@nexus/shared";
import type { FactCheckReport } from "./fact-check-report";

/**
 * Compares two saved versions of the fact-check report.
 *
 * Pure: it reads the two frozen snapshots and nothing else. Two rules it
 * exists to enforce:
 *
 * 1. **Identity is an id, never a resemblance.** Claims are matched by
 *    claimId, excerpts by evidenceId, captures by sourceId, rulings by
 *    reviewId. Anything without a counterpart on the other side is reported
 *    as added or removed — text similarity is not evidence that two rows
 *    are the same row.
 * 2. **A source moving is not a conclusion falling over.** Every entry is
 *    categorised. `verdict` entries are about what the material supports;
 *    `risk` entries are about whether that material is still current. The
 *    two travel side by side and are never merged into one status, so "the
 *    page changed" can never be read as "the finding was overturned".
 *
 * Value placement is the same for every entity: an `added` entry carries the
 * new entity in `newValue` and `oldValue` stays null; a `removed` entry
 * carries it in `oldValue` and `newValue` stays null; a `changed` entry
 * carries both. `field` is null for additions and removals.
 */

/** The payload of a snapshot, as the report object it was built as. */
export function snapshotPayload(
  snapshot: ResearchReportSnapshot
): FactCheckReport {
  if (snapshot.reportSchemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new ReportPayloadFormatError(
      `Snapshot ${snapshot.snapshotId} declares report schema v${snapshot.reportSchemaVersion}; this build reads v${REPORT_SCHEMA_VERSION}.`
    );
  }
  const payload = snapshot.reportPayload;
  if (
    !isRecord(payload) ||
    typeof payload.sessionId !== "string" ||
    !Array.isArray(payload.findings)
  ) {
    throw new ReportPayloadFormatError(
      `Snapshot ${snapshot.snapshotId} does not hold a fact-check report payload.`
    );
  }
  return payload as unknown as FactCheckReport;
}

export class ReportPayloadFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportPayloadFormatError";
  }
}

export function diffReportSnapshots(
  from: ResearchReportSnapshot,
  to: ResearchReportSnapshot
): ReportVersionDiff {
  const entries: ReportDiffEntry[] = [
    ...diffClaims(from, to),
    ...diffEvidence(from, to),
    ...diffSources(from, to),
    ...diffReviews(from, to),
    ...diffConflicts(from, to),
    ...diffMonitoring(from, to)
  ];

  return {
    fromSnapshotId: from.snapshotId,
    toSnapshotId: to.snapshotId,
    fromVersion: from.version,
    toVersion: to.version,
    fromMaterialsFingerprint: from.materialsFingerprint,
    toMaterialsFingerprint: to.materialsFingerprint,
    entries,
    counts: {
      added: entries.filter((entry) => entry.kind === "added").length,
      removed: entries.filter((entry) => entry.kind === "removed").length,
      changed: entries.filter((entry) => entry.kind === "changed").length,
      verdict: entries.filter((entry) => entry.category === "verdict").length,
      risk: entries.filter((entry) => entry.category === "risk").length
    }
  };
}

/* ------------------------------------------------------------------ *
 * Claims and their verdicts
 * ------------------------------------------------------------------ */

function diffClaims(
  from: ResearchReportSnapshot,
  to: ResearchReportSnapshot
): ReportDiffEntry[] {
  const fromClaims = new Map(
    from.claimReferences.map((item) => [item.claimId, item])
  );
  const toClaims = new Map(
    to.claimReferences.map((item) => [item.claimId, item])
  );
  // The rationale each verdict was reached on, so a changed verdict carries
  // the stored reason instead of a guess.
  const toRationale = new Map(
    snapshotPayload(to).findings.map((finding) => [
      finding.claimId,
      finding.verdict.rationale
    ])
  );

  const entries: ReportDiffEntry[] = [];
  for (const [claimId, before] of fromClaims) {
    const after = toClaims.get(claimId);
    if (!after) {
      entries.push(
        claimEntry("removed", claimId, null, claimValue(before), null, null)
      );
      continue;
    }
    entries.push(
      ...claimChanges(claimId, before, after, toRationale.get(claimId) ?? null)
    );
  }
  for (const [claimId, after] of toClaims) {
    if (fromClaims.has(claimId)) continue;
    entries.push(
      claimEntry("added", claimId, null, null, claimValue(after), null)
    );
  }
  return entries;
}

function claimChanges(
  claimId: string,
  before: ReportClaimReference,
  after: ReportClaimReference,
  rationale: string | null
): ReportDiffEntry[] {
  const entries: ReportDiffEntry[] = [];
  if (before.statement !== after.statement) {
    entries.push(
      claimEntry(
        "changed",
        claimId,
        "statement",
        before.statement,
        after.statement,
        null
      )
    );
  }
  if (before.claimStatus !== after.claimStatus) {
    entries.push(
      claimEntry(
        "changed",
        claimId,
        "claimStatus",
        before.claimStatus,
        after.claimStatus,
        null
      )
    );
  }
  // The verdict is the conclusion itself: a change here is a fact-judgement
  // change, and it carries the stored rationale when there is one.
  if (before.verdictStatus !== after.verdictStatus) {
    entries.push(
      claimEntry(
        "changed",
        claimId,
        "verdictStatus",
        before.verdictStatus,
        after.verdictStatus,
        rationale
      )
    );
  }
  if (before.verdictConfidence !== after.verdictConfidence) {
    entries.push(
      claimEntry(
        "changed",
        claimId,
        "verdictConfidence",
        before.verdictConfidence,
        after.verdictConfidence,
        null
      )
    );
  }
  return entries;
}

function claimEntry(
  kind: ReportDiffChangeKind,
  claimId: string,
  field: string | null,
  oldValue: unknown,
  newValue: unknown,
  reason: string | null
): ReportDiffEntry {
  return {
    entityType: "claim",
    entityId: claimId,
    kind,
    category: "verdict",
    field,
    oldValue,
    newValue,
    reason,
    relatedSourceIds: [],
    changedAt: null
  };
}

function claimValue(reference: ReportClaimReference): Record<string, unknown> {
  return {
    statement: reference.statement,
    claimStatus: reference.claimStatus,
    verdictStatus: reference.verdictStatus,
    verdictConfidence: reference.verdictConfidence
  };
}

/* ------------------------------------------------------------------ *
 * Excerpts and their verification state
 * ------------------------------------------------------------------ */

function diffEvidence(
  from: ResearchReportSnapshot,
  to: ResearchReportSnapshot
): ReportDiffEntry[] {
  const fromEvidence = new Map(
    from.evidenceReferences.map((item) => [item.evidenceId, item])
  );
  const toEvidence = new Map(
    to.evidenceReferences.map((item) => [item.evidenceId, item])
  );

  const entries: ReportDiffEntry[] = [];
  for (const [evidenceId, before] of fromEvidence) {
    const after = toEvidence.get(evidenceId);
    if (!after) {
      entries.push(
        evidenceEntry(
          "removed",
          evidenceId,
          null,
          evidenceValue(before),
          null,
          before.sourceId
        )
      );
      continue;
    }
    if (before.verificationStatus !== after.verificationStatus) {
      entries.push(
        evidenceEntry(
          "changed",
          evidenceId,
          "verificationStatus",
          before.verificationStatus,
          after.verificationStatus,
          after.sourceId
        )
      );
    }
    // Where an excerpt sits inside its source is a currency question, not a
    // conclusion: a locator that moved or vanished is reported as risk.
    if (before.locatorStatus !== after.locatorStatus) {
      entries.push(
        evidenceEntry(
          "changed",
          evidenceId,
          "locatorStatus",
          before.locatorStatus,
          after.locatorStatus,
          after.sourceId
        )
      );
    }
  }
  for (const [evidenceId, after] of toEvidence) {
    if (fromEvidence.has(evidenceId)) continue;
    entries.push(
      evidenceEntry(
        "added",
        evidenceId,
        null,
        null,
        evidenceValue(after),
        after.sourceId
      )
    );
  }
  return entries;
}

function evidenceEntry(
  kind: ReportDiffChangeKind,
  evidenceId: string,
  field: string | null,
  oldValue: unknown,
  newValue: unknown,
  sourceId: string | null
): ReportDiffEntry {
  return {
    entityType: "evidence",
    entityId: evidenceId,
    kind,
    category: field === "locatorStatus" ? "risk" : "verdict",
    field,
    oldValue,
    newValue,
    reason: null,
    relatedSourceIds: sourceId ? [sourceId] : [],
    changedAt: null
  };
}

function evidenceValue(
  reference: ReportEvidenceReference
): Record<string, unknown> {
  return {
    title: reference.title,
    verificationStatus: reference.verificationStatus,
    locatorStatus: reference.locatorStatus
  };
}

/* ------------------------------------------------------------------ *
 * Source captures: the risk axis
 * ------------------------------------------------------------------ */

function diffSources(
  from: ResearchReportSnapshot,
  to: ResearchReportSnapshot
): ReportDiffEntry[] {
  const fromSources = new Map(
    from.sourceReferences.map((item) => [item.sourceId, item])
  );
  const toSources = new Map(
    to.sourceReferences.map((item) => [item.sourceId, item])
  );

  const entries: ReportDiffEntry[] = [];
  for (const [sourceId, before] of fromSources) {
    const after = toSources.get(sourceId);
    if (!after) {
      entries.push(
        sourceEntry("removed", sourceId, null, sourceValue(before), null)
      );
      continue;
    }
    if (
      before.snapshotId !== after.snapshotId ||
      before.contentHash !== after.contentHash
    ) {
      // The page moved underneath the conclusion. That is a reason to
      // re-read, never a reason to re-decide: the entry records that the
      // cited capture changed and says nothing about what the new text
      // means, so it can never be read as a verdict change.
      entries.push(
        sourceEntry(
          "changed",
          sourceId,
          "contentHash",
          before.contentHash,
          after.contentHash
        )
      );
    }
  }
  for (const [sourceId, after] of toSources) {
    if (fromSources.has(sourceId)) continue;
    entries.push(
      sourceEntry("added", sourceId, null, null, sourceValue(after))
    );
  }
  return entries;
}

function sourceEntry(
  kind: ReportDiffChangeKind,
  sourceId: string,
  field: string | null,
  oldValue: unknown,
  newValue: unknown
): ReportDiffEntry {
  return {
    entityType: "source",
    entityId: sourceId,
    kind,
    category: "risk",
    field,
    oldValue,
    newValue,
    reason: null,
    relatedSourceIds: [sourceId],
    changedAt: null
  };
}

function sourceValue(
  reference: ReportSourceReference
): Record<string, unknown> {
  return {
    title: reference.title,
    snapshotId: reference.snapshotId,
    contentHash: reference.contentHash
  };
}

/* ------------------------------------------------------------------ *
 * Human rulings
 * ------------------------------------------------------------------ */

function diffReviews(
  from: ResearchReportSnapshot,
  to: ResearchReportSnapshot
): ReportDiffEntry[] {
  const fromReviews = new Map(
    from.reviewReferences.map((item) => [item.reviewId, item])
  );
  const toReviews = new Map(
    to.reviewReferences.map((item) => [item.reviewId, item])
  );

  const entries: ReportDiffEntry[] = [];
  for (const [reviewId, before] of fromReviews) {
    const after = toReviews.get(reviewId);
    if (!after) {
      entries.push(
        reviewEntry(
          "removed",
          reviewId,
          null,
          reviewValue(before),
          null,
          null,
          before
        )
      );
      continue;
    }
    if (before.outcome !== after.outcome) {
      entries.push(
        reviewEntry(
          "changed",
          reviewId,
          "outcome",
          before.outcome,
          after.outcome,
          null,
          after
        )
      );
    }
  }
  for (const [reviewId, after] of toReviews) {
    if (fromReviews.has(reviewId)) continue;
    entries.push(
      reviewEntry(
        "added",
        reviewId,
        null,
        null,
        reviewValue(after),
        null,
        after
      )
    );
  }
  return entries;
}

function reviewEntry(
  kind: ReportDiffChangeKind,
  reviewId: string,
  field: string | null,
  oldValue: unknown,
  newValue: unknown,
  reason: string | null,
  reference: ReportReviewReference
): ReportDiffEntry {
  return {
    entityType: "review",
    entityId: reviewId,
    kind,
    category: "verdict",
    field,
    oldValue,
    newValue,
    reason,
    relatedSourceIds: [],
    changedAt: reference.createdAt
  };
}

function reviewValue(
  reference: ReportReviewReference
): Record<string, unknown> {
  return {
    claimId: reference.claimId,
    outcome: reference.outcome,
    reviewer: reference.reviewer
  };
}

/* ------------------------------------------------------------------ *
 * Conflicts awaiting a human decision
 * ------------------------------------------------------------------ */

function diffConflicts(
  from: ResearchReportSnapshot,
  to: ResearchReportSnapshot
): ReportDiffEntry[] {
  // Only the unresolved set is part of a report, so a conflict leaving the
  // set means it stopped awaiting a decision. Which of "resolved", "closed"
  // or "deleted" it was cannot be told from the snapshots alone, and the
  // entry says exactly that much instead of picking one.
  const fromOpen = new Map(
    snapshotPayload(from).gaps.unresolvedConflicts.map((item) => [
      item.conflictId,
      item
    ])
  );
  const toOpen = new Map(
    snapshotPayload(to).gaps.unresolvedConflicts.map((item) => [
      item.conflictId,
      item
    ])
  );

  const entries: ReportDiffEntry[] = [];
  for (const conflictId of fromOpen.keys()) {
    if (toOpen.has(conflictId)) continue;
    entries.push({
      entityType: "conflict",
      entityId: conflictId,
      kind: "changed",
      category: "verdict",
      field: "awaitingHumanDecision",
      oldValue: true,
      newValue: false,
      reason:
        "该冲突不再处于等待人工决定状态（已解决、已关闭或已删除，快照无法进一步区分）。",
      relatedSourceIds: [],
      changedAt: null
    });
  }
  for (const conflictId of toOpen.keys()) {
    if (fromOpen.has(conflictId)) continue;
    entries.push({
      entityType: "conflict",
      entityId: conflictId,
      kind: "changed",
      category: "verdict",
      field: "awaitingHumanDecision",
      oldValue: false,
      newValue: true,
      reason: null,
      relatedSourceIds: [],
      changedAt: null
    });
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * Monitoring risk
 * ------------------------------------------------------------------ */

function diffMonitoring(
  from: ResearchReportSnapshot,
  to: ResearchReportSnapshot
): ReportDiffEntry[] {
  const fromTasks = new Map(
    from.monitoringReferences.map((item) => [item.taskId, item])
  );
  const toTasks = new Map(
    to.monitoringReferences.map((item) => [item.taskId, item])
  );

  const entries: ReportDiffEntry[] = [];
  for (const [taskId, before] of fromTasks) {
    const after = toTasks.get(taskId);
    if (!after) {
      entries.push(
        monitoringEntry("removed", taskId, null, before.status, null, before.sourceId)
      );
      continue;
    }
    if (before.status !== after.status) {
      entries.push(
        monitoringEntry(
          "changed",
          taskId,
          "status",
          before.status,
          after.status,
          after.sourceId
        )
      );
    }
  }
  for (const [taskId, after] of toTasks) {
    if (fromTasks.has(taskId)) continue;
    entries.push(
      monitoringEntry("added", taskId, null, null, after.status, after.sourceId)
    );
  }
  return entries;
}

function monitoringEntry(
  kind: ReportDiffChangeKind,
  taskId: string,
  field: string | null,
  oldValue: unknown,
  newValue: unknown,
  sourceId: string
): ReportDiffEntry {
  return {
    entityType: "revalidation",
    entityId: taskId,
    kind,
    category: "risk",
    field,
    oldValue,
    newValue,
    reason: null,
    relatedSourceIds: [sourceId],
    changedAt: null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
