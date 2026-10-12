import type {
  EvidenceRepository,
  RevalidationTaskEvent,
  SourceCheckRepository,
  SourceFileRepository,
  RevalidationTaskRepository
} from "@nexus/db";
import { SourceNotFoundError } from "@nexus/db";
import { newId } from "@nexus/shared";
import {
  SourceCheckOutcomeSchema,
  type Claim,
  type ClaimImpact,
  type ClaimVerdict,
  type Evidence,
  type EvidenceImpact,
  type ExecutionEvent,
  type RevalidationTask,
  type RevalidationTaskStatus,
  type SnapshotDiff,
  type Source,
  type SourceCheckOutcome,
  type SourceMonitoringSummary,
  type SourceMonitorStatus,
  type SourceSnapshot
} from "@nexus/shared";
import { PageFetchError, type FetchedPage } from "./page-fetch";
import { describeFetchFailure } from "./source-import-service";
import { diffSnapshots } from "./snapshot-diff";
import { deriveEvidenceImpacts } from "./evidence-impact";
import { deriveClaimImpacts } from "./claim-impact";
import { deriveRevalidationWarnings } from "./revalidation-warnings";

/**
 * Source monitoring: whether the material a research relied on has moved.
 *
 * Four rules shape everything here:
 *
 *  1. **Monitoring is its own axis.** A check records whether the page could
 *     be read *now* and whether its text is a version already stored. It never
 *     writes `verificationStatus`, never touches `claims`, and never re-rules
 *     on a verdict.
 *  2. **A failed check is not a change.** A timeout, a 403, a blocked target
 *     and an exhausted budget all land in `source_checks` as `unavailable` or
 *     `failed` with a reason, and none of them opens a re-check task. Only a
 *     readable page whose text differs from every stored version counts as
 *     drift.
 *  3. **A change produces work, not an edit.** The new capture is stored
 *     through the evidence repository (the same path an import uses), both
 *     versions survive, and what is affected is derived and handed to a person
 *     as a persisted, attributed task.
 *  4. **Budgets before requests.** Rate limit, session quota and failure-retry
 *     budget are read from the check trail before any network call, so
 *     monitoring cannot be turned into a probe.
 *
 * What this service deliberately does not do: schedule anything. There is no
 * background queue in this build, so every check is a person's explicit
 * request; the `checking` status exists in the vocabulary for a future
 * scheduler, and no row is ever left claiming a check is in flight.
 */

export type SourceMonitorLimits = {
  /** Checks of one source per hour. */
  maxChecksPerSourcePerHour: number;
  /** Checks across one session per hour. */
  maxChecksPerSessionPerHour: number;
  /** Failed checks of one source per day, before retries stop. */
  maxFailuresPerSourcePerDay: number;
};

export const DEFAULT_MONITOR_LIMITS: SourceMonitorLimits = {
  maxChecksPerSourcePerHour: 6,
  maxChecksPerSessionPerHour: 60,
  maxFailuresPerSourcePerDay: 12
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export class RevalidationTaskStateError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "RevalidationTaskStateError";
  }
}

/** The transitions a person may make from the UI. */
const ALLOWED_TASK_TRANSITIONS: RevalidationTaskStatus[] = [
  "in_review",
  "resolved",
  "dismissed"
];

export type TaskDetail = {
  task: RevalidationTask;
  history: RevalidationTaskEvent[];
  evidence: Evidence[];
  claims: Array<{ id: string; statement: string }>;
};

/** What a check established, before the row and the event are written. */
type CheckOutcomeInput = {
  status: SourceMonitorStatus;
  reasonCode: string | null;
  message: string;
  previousSnapshotId: string | null;
  currentSnapshotId: string | null;
  previousContentHash: string | null;
  currentContentHash: string | null;
  httpStatus: number | null;
  newVersionStored: boolean;
  evidenceImpacts: EvidenceImpact[];
  claimImpacts: ClaimImpact[];
  revalidationTask: RevalidationTask | null;
};

/** The narrow slice of the workspace projection this service reads. */
type WorkspaceProjection = {
  claims: Claim[];
  verdicts: ClaimVerdict[];
};

type MonitorDependencies = {
  evidence: Pick<
    EvidenceRepository,
    | "getSource"
    | "listSnapshots"
    | "getCurrentSnapshot"
    | "listEvidenceForSource"
    | "listEvidence"
    | "listSources"
    | "listLatestSnapshots"
    | "recordRetrievalSuccess"
  >;
  checks: Pick<
    SourceCheckRepository,
    | "insertCheck"
    | "lastCheck"
    | "listChecks"
    | "countRecentChecks"
    | "countUnsuccessfulSince"
    | "countSessionRecentChecks"
  >;
  tasks: Pick<
    RevalidationTaskRepository,
    | "insertTask"
    | "findCurrentByTrigger"
    | "getTask"
    | "listTasks"
    | "listTaskHistory"
    | "transitionTask"
  >;
  /** File rows, so a re-uploaded document can be recognized as a new version. */
  files: Pick<SourceFileRepository, "listSourceFiles">;
  fetch: (url: string) => Promise<FetchedPage>;
  /** The workspace projection, reused so claim impacts cannot disagree with it. */
  workspace?: ((sessionId: string) => Promise<WorkspaceProjection | null>) | undefined;
  appendEvent: (input: {
    sessionId: string;
    correlationId: string;
    type: ExecutionEvent["type"];
    payload: Record<string, unknown>;
  }) => Promise<unknown>;
  limits?: Partial<SourceMonitorLimits>;
  now?: () => Date;
};

export class SourceMonitorService {
  private readonly limits: SourceMonitorLimits;

  constructor(private readonly dependencies: MonitorDependencies) {
    this.limits = {
      ...DEFAULT_MONITOR_LIMITS,
      ...dependencies.limits
    };
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  /**
   * Checks one source for drift.
   *
   * The order is the contract: budgets first (nothing is requested when the
   * budget says no), then the kind-specific read, then the comparison, then —
   * only for a real change — the derived impacts and the task. Every outcome,
   * including a refusal, is written to `source_checks` before it is returned.
   */
  async checkSource(input: {
    sessionId: string;
    sourceId: string;
    actor: string;
  }): Promise<SourceCheckOutcome> {
    const source = await this.dependencies.evidence.getSource(
      input.sessionId,
      input.sourceId
    );
    if (!source) {
      throw new SourceNotFoundError(input.sourceId);
    }

    const startedAt = this.now();
    await this.appendEvent({
      sessionId: input.sessionId,
      correlationId: source.id,
      type: "SOURCE_CHECK_STARTED",
      payload: {
        sourceId: source.id,
        kind: source.kind,
        url: source.canonicalUrl ?? source.url ?? null,
        checkedBy: input.actor
      }
    });

    // The rate limit is read before anything is requested: monitoring must
    // not turn into a probe, so an exhausted budget refuses before the fetch.
    const budgetLeft = await this.remainingChecks(
      input.sessionId,
      input.sourceId,
      startedAt
    );

    // Budgets are enforced by recording the refusal, not by silence: a reader
    // can see that a check was attempted and why it was not carried out.
    if (budgetLeft <= 0) {
      return this.recordRefusal(input, source, {
        status: "failed",
        reasonCode: "rate_limited",
        errorCode: "rate_limited",
        message: `检查频率达到上限：每来源每小时最多 ${this.limits.maxChecksPerSourcePerHour} 次、每会话每小时最多 ${this.limits.maxChecksPerSessionPerHour} 次。`,
        httpStatus: null
      });
    }

    const unsuccessful = await this.dependencies.checks.countUnsuccessfulSince(
      input.sessionId,
      input.sourceId,
      new Date(startedAt.getTime() - DAY_MS).toISOString()
    );
    if (unsuccessful >= this.limits.maxFailuresPerSourcePerDay) {
      return this.recordRefusal(input, source, {
        status: "failed",
        reasonCode: "retry_budget_exhausted",
        errorCode: "retry_budget_exhausted",
        message: `该来源近期未能完成检查的次数已达上限（24 小时内 ${unsuccessful} 次），暂停重试；请稍后手动检查。`,
        httpStatus: null
      });
    }

    if (source.kind === "url") {
      return this.checkUrlSource(input, source);
    }
    if (source.kind === "document") {
      return this.checkDocumentSource(input, source);
    }

    // Manual notes and datasets have no address to read and no uploaded bytes
    // to compare: saying so is the honest outcome, and pretending otherwise
    // would be the dishonest one.
    return this.recordRefusal(input, source, {
      status: "unavailable",
      reasonCode: "not_monitorable",
      errorCode: "not_monitorable",
      message: "该来源类型（手动登记/数据集）不支持自动监测，无法检查内容变化。",
      httpStatus: null
    });
  }

  /** Reads the page and compares its text with the stored versions. */
  private async checkUrlSource(
    input: { sessionId: string; sourceId: string; actor: string },
    source: Source
  ): Promise<SourceCheckOutcome> {
    const url = source.canonicalUrl ?? source.url;
    if (!url) {
      return this.recordRefusal(input, source, {
        status: "failed",
        reasonCode: "no_url",
        errorCode: "no_url",
        message: "该来源没有登记可读取的地址，无法监测。",
        httpStatus: null
      });
    }

    const currentSnapshot = await this.dependencies.evidence.getCurrentSnapshot(
      input.sessionId,
      source.id
    );

    let page: FetchedPage;
    try {
      page = await this.dependencies.fetch(url);
    } catch (cause) {
      // A page that could not be read is `unavailable`, never `changed`: a
      // timeout says nothing about the content, and a 403 is not a deletion.
      const failure = describeFetchFailure(cause);
      const httpStatus =
        cause instanceof PageFetchError && cause.code === "bad-status"
          ? httpStatusFromMessage(cause.message)
          : null;
      return this.recordRefusal(input, source, {
        status: "unavailable",
        reasonCode: failure.code,
        errorCode: failure.code,
        message: failure.message,
        httpStatus
      });
    }

    if (currentSnapshot && currentSnapshot.contentHash === page.contentHash) {
      // Same normalized text as the stored capture: the page was read and
      // nothing moved. No snapshot is written, because there is nothing new
      // to store.
      const outcome = await this.finishCheck(input, {
        status: "unchanged",
        reasonCode: null,
        message: "页面可以读取，正文与已保存版本一致（内容哈希相同）。",
        previousSnapshotId: currentSnapshot.id,
        currentSnapshotId: currentSnapshot.id,
        previousContentHash: currentSnapshot.contentHash,
        currentContentHash: page.contentHash,
        httpStatus: page.status,
        newVersionStored: false,
        evidenceImpacts: [],
        claimImpacts: [],
        revalidationTask: null
      });
      await this.appendEvent({
        sessionId: input.sessionId,
        correlationId: source.id,
        type: "SOURCE_CHECK_COMPLETED",
        payload: {
          sourceId: source.id,
          status: "unchanged",
          contentHash: page.contentHash,
          httpStatus: page.status,
          checkedBy: input.actor
        }
      });
      return outcome;
    }

    // A version that was not stored before: keep the old capture, store the
    // new one through the same write path an import uses, and derive what the
    // drift reaches.
    const retrievedAt = page.retrievedAt;
    const snapshotId = newId();
    const recorded = await this.dependencies.evidence.recordRetrievalSuccess({
      snapshot: {
        id: snapshotId,
        sessionId: input.sessionId,
        sourceId: source.id,
        canonicalUrl: page.canonicalUrl,
        contentHash: page.contentHash,
        contentType: page.contentType,
        content: page.content,
        contentBytes: page.contentBytes,
        charCount: page.charCount,
        retrievedAt,
        createdAt: this.now().toISOString(),
        ...(page.title ? { title: page.title } : {}),
        ...(page.author ? { author: page.author } : {}),
        ...(page.publisher ? { publisher: page.publisher } : {}),
        ...(page.publishedAt ? { publishedAt: page.publishedAt } : {})
      },
      source: {},
      event: {
        correlationId: source.id,
        type: "SOURCE_RETRIEVED",
        payload: {
          sourceId: source.id,
          canonicalUrl: page.canonicalUrl,
          contentType: page.contentType,
          contentHash: page.contentHash,
          charCount: page.charCount,
          redirectCount: page.redirects.length,
          truncated: page.truncated,
          // Marked so the trail can tell a monitoring capture from an import
          // without inventing a second event vocabulary.
          origin: "source-monitoring",
          retrievedBy: input.actor
        }
      }
    });

    const newSnapshot = recorded.snapshot;
    const impacts = await this.deriveImpacts(
      input.sessionId,
      source,
      currentSnapshot,
      newSnapshot
    );
    const task = await this.openTaskForChange(input, source, {
      previousSnapshot: currentSnapshot,
      currentSnapshot: newSnapshot,
      impacts
    });

    const outcome = await this.finishCheck(input, {
      status: "changed",
      reasonCode: "content_changed",
      message: `页面可以读取，正文与已保存版本不同：已保留旧版本并存入新版本（${currentSnapshot ? `${currentSnapshot.charCount} 字 → ` : ""}${newSnapshot.charCount} 字）。`,
      previousSnapshotId: currentSnapshot?.id ?? null,
      currentSnapshotId: newSnapshot.id,
      previousContentHash: currentSnapshot?.contentHash ?? null,
      currentContentHash: newSnapshot.contentHash,
      httpStatus: page.status,
      newVersionStored: recorded.created,
      evidenceImpacts: impacts.evidenceImpacts,
      claimImpacts: impacts.claimImpacts,
      revalidationTask: task
    });

    await this.appendEvent({
      sessionId: input.sessionId,
      correlationId: source.id,
      type: "SOURCE_CONTENT_CHANGED",
      payload: {
        sourceId: source.id,
        previousContentHash: currentSnapshot?.contentHash ?? null,
        currentContentHash: newSnapshot.contentHash,
        previousSnapshotId: currentSnapshot?.id ?? null,
        currentSnapshotId: newSnapshot.id,
        newVersionStored: recorded.created,
        affectedEvidenceCount: impacts.evidenceImpacts.filter(
          (impact) => impact.impact !== "unaffected"
        ).length,
        affectedClaimCount: impacts.claimImpacts.length,
        taskId: task?.id ?? null,
        checkedBy: input.actor
      }
    });

    return outcome;
  }

  /**
   * Checks a document source for a newer upload of the same file.
   *
   * Local files are never fetched — there is no address to read. What can be
   * established is whether the researcher uploaded a *new version* since:
   * each upload of different bytes is its own Source with its own capture, so
   * a newer row with the same file name is a version this source has fallen
   * behind. When there is none, the honest answer is "unchanged", not a
   * pretense of having checked something.
   */
  private async checkDocumentSource(
    input: { sessionId: string; sourceId: string; actor: string },
    source: Source
  ): Promise<SourceCheckOutcome> {
    const versions = await this.resolveDocumentVersions(
      input.sessionId,
      source
    );

    if (versions.current === null) {
      return this.recordRefusal(input, source, {
        status: "unavailable",
        reasonCode: "no_capture",
        errorCode: "no_capture",
        message: "该文件来源没有已保存的正文版本，无法比较。",
        httpStatus: null
      });
    }

    if (
      versions.previous === null ||
      versions.current.id === versions.previous.id ||
      versions.current.contentHash === versions.previous.contentHash
    ) {
      const outcome = await this.finishCheck(input, {
        status: "unchanged",
        reasonCode: null,
        message: "未检测到同一文件的新上传版本，当前版本仍是最新。",
        previousSnapshotId: versions.previous?.id ?? null,
        currentSnapshotId: versions.current.id,
        previousContentHash: versions.previous?.contentHash ?? null,
        currentContentHash: versions.current.contentHash,
        httpStatus: null,
        newVersionStored: false,
        evidenceImpacts: [],
        claimImpacts: [],
        revalidationTask: null
      });
      await this.appendEvent({
        sessionId: input.sessionId,
        correlationId: source.id,
        type: "SOURCE_CHECK_COMPLETED",
        payload: {
          sourceId: source.id,
          status: "unchanged",
          contentHash: versions.current.contentHash,
          httpStatus: null,
          checkedBy: input.actor
        }
      });
      return outcome;
    }

    const impacts = await this.deriveImpacts(
      input.sessionId,
      source,
      versions.previous,
      versions.current
    );
    const task = await this.openTaskForChange(input, source, {
      previousSnapshot: versions.previous,
      currentSnapshot: versions.current,
      impacts
    });

    const outcome = await this.finishCheck(input, {
      status: "changed",
      reasonCode: "new_upload_version",
      message: `检测到同名文件的新上传版本：旧版本 ${versions.previous.charCount} 字，新版本 ${versions.current.charCount} 字。`,
      previousSnapshotId: versions.previous.id,
      currentSnapshotId: versions.current.id,
      previousContentHash: versions.previous.contentHash,
      currentContentHash: versions.current.contentHash,
      httpStatus: null,
      // Nothing is stored by the check: the newer version was already stored
      // when it was uploaded.
      newVersionStored: false,
      evidenceImpacts: impacts.evidenceImpacts,
      claimImpacts: impacts.claimImpacts,
      revalidationTask: task
    });

    await this.appendEvent({
      sessionId: input.sessionId,
      correlationId: source.id,
      type: "SOURCE_CONTENT_CHANGED",
      payload: {
        sourceId: source.id,
        previousContentHash: versions.previous.contentHash,
        currentContentHash: versions.current.contentHash,
        previousSnapshotId: versions.previous.id,
        currentSnapshotId: versions.current.id,
        newVersionStored: false,
        affectedEvidenceCount: impacts.evidenceImpacts.filter(
          (impact) => impact.impact !== "unaffected"
        ).length,
        affectedClaimCount: impacts.claimImpacts.length,
        taskId: task?.id ?? null,
        checkedBy: input.actor
      }
    });

    return outcome;
  }

  /**
   * The monitoring panel for one source.
   *
   * `not_checked` and a real last-check status are kept distinct: "nobody
   * looked" must never read as "somebody looked and found nothing".
   */
  async getMonitoring(
    sessionId: string,
    sourceId: string
  ): Promise<SourceMonitoringSummary> {
    const source = await this.dependencies.evidence.getSource(
      sessionId,
      sourceId
    );
    if (!source) {
      throw new SourceNotFoundError(sourceId);
    }
    const [lastCheck, snapshots, openTasks] = await Promise.all([
      this.dependencies.checks.lastCheck(sessionId, sourceId),
      this.dependencies.evidence.listSnapshots(sessionId, sourceId),
      this.dependencies.tasks.listTasks(sessionId, { status: "open" })
    ]);
    const currentSnapshot = snapshots[0] ?? null;
    return {
      sourceId: source.id,
      sessionId,
      title: source.title,
      kind: source.kind,
      url: source.canonicalUrl ?? source.url ?? null,
      monitorStatus: lastCheck?.status ?? "not_checked",
      lastCheckedAt: lastCheck?.checkedAt ?? null,
      lastCheckedBy: lastCheck?.checkedBy ?? null,
      snapshotCount: snapshots.length,
      currentContentHash: currentSnapshot?.contentHash ?? null,
      currentSnapshotId: currentSnapshot?.id ?? null,
      latestCheckStatus: lastCheck?.status ?? null,
      openTaskId:
        openTasks.find((task) => task.sourceId === sourceId)?.id ?? null
    };
  }

  /**
   * The comparison between a source's two most recent versions.
   *
   * For a document source the "current" version is the newest upload of the
   * same file, which may live under a different Source row — the same
   * resolution the check itself uses, so the two can never disagree.
   */
  async getDiff(sessionId: string, sourceId: string): Promise<SnapshotDiff> {
    const source = await this.dependencies.evidence.getSource(
      sessionId,
      sourceId
    );
    if (!source) {
      throw new SourceNotFoundError(sourceId);
    }

    let previous: SourceSnapshot | null;
    let current: SourceSnapshot | null;
    if (source.kind === "document") {
      const versions = await this.resolveDocumentVersions(sessionId, source);
      previous = versions.previous;
      current = versions.current;
    } else {
      const snapshots = await this.dependencies.evidence.listSnapshots(
        sessionId,
        sourceId
      );
      current = snapshots[0] ?? null;
      previous = snapshots[1] ?? null;
    }

    const excerpts = await this.dependencies.evidence.listEvidenceForSource(
      sessionId,
      sourceId
    );
    return diffSnapshots({
      sessionId,
      sourceId,
      previous,
      current,
      excerpts
    });
  }

  /** Every re-check task in a session, newest first. */
  async listTasks(
    sessionId: string,
    options: { status?: RevalidationTaskStatus | undefined } = {}
  ): Promise<RevalidationTask[]> {
    return this.dependencies.tasks.listTasks(sessionId, options);
  }

  /**
   * One task with its history and the material it names.
   *
   * The task stores ids; the evidence and claims are read back from the same
   * tables the workspace reads, so the detail panel cannot show material that
   * does not exist.
   */
  async getTaskDetail(
    sessionId: string,
    taskId: string
  ): Promise<TaskDetail> {
    const task = await this.dependencies.tasks.getTask(sessionId, taskId);
    const [history, evidence, workspace] = await Promise.all([
      this.dependencies.tasks.listTaskHistory(sessionId, taskId),
      this.dependencies.evidence.listEvidence(sessionId),
      this.dependencies.workspace?.(sessionId) ?? Promise.resolve(null)
    ]);
    return {
      task,
      history,
      evidence: evidence.filter((item) =>
        task.affectedEvidenceIds.includes(item.id)
      ),
      claims: (workspace?.claims ?? []).filter((claim) =>
        task.affectedClaimIds.includes(claim.id)
      )
    };
  }

  /**
   * Moves a task to a new status on a person's instruction.
   *
   * Closing needs a reason, and the reason is what the repository refuses to
   * store without. The same request twice is the same transition, not a second
   * one: an unchanged status returns the task as it stands.
   */
  async resolveTask(input: {
    sessionId: string;
    taskId: string;
    status: RevalidationTaskStatus;
    note?: string | undefined;
    actor: string;
  }): Promise<RevalidationTask> {
    if (!ALLOWED_TASK_TRANSITIONS.includes(input.status)) {
      throw new RevalidationTaskStateError(
        `不能将复核任务直接置为 ${input.status}；可用的转变为：${ALLOWED_TASK_TRANSITIONS.join("、")}。`,
        "invalid_transition",
        400
      );
    }
    const current = await this.dependencies.tasks.getTask(
      input.sessionId,
      input.taskId
    );
    if (current.status === input.status) {
      return current;
    }
    const note = input.note?.trim();
    if (
      (input.status === "resolved" || input.status === "dismissed") &&
      (!note || note.length === 0)
    ) {
      throw new RevalidationTaskStateError(
        "关闭复核任务必须填写理由（note），说明重新核查的结论。",
        "note_required",
        400
      );
    }

    const task = await this.dependencies.tasks.transitionTask({
      sessionId: input.sessionId,
      taskId: input.taskId,
      status: input.status,
      actor: input.actor,
      ...(note ? { note } : {})
    });

    await this.appendEvent({
      sessionId: input.sessionId,
      correlationId: task.id,
      type: "REVALIDATION_TASK_RESOLVED",
      payload: {
        taskId: task.id,
        sourceId: task.sourceId,
        fromStatus: current.status,
        toStatus: task.status,
        note: note ?? null,
        actor: input.actor
      }
    });

    return task;
  }

  /** What the fact-check report has to say about monitoring. */
  async reportWarnings(sessionId: string) {
    const [tasks, evidence, sources, snapshots] = await Promise.all([
      this.dependencies.tasks.listTasks(sessionId),
      this.dependencies.evidence.listEvidence(sessionId),
      this.dependencies.evidence.listSources(sessionId),
      this.dependencies.evidence.listLatestSnapshots(sessionId)
    ]);
    const workspace = (await this.dependencies.workspace?.(sessionId)) ?? null;
    return deriveRevalidationWarnings({
      tasks,
      claims: workspace?.claims ?? [],
      evidence,
      sources,
      latestSnapshots: snapshots
    });
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private async remainingChecks(
    sessionId: string,
    sourceId: string,
    now: Date
  ): Promise<number> {
    const since = new Date(now.getTime() - HOUR_MS).toISOString();
    const [sourceChecks, sessionChecks] = await Promise.all([
      this.dependencies.checks.countRecentChecks(sessionId, sourceId, since),
      this.dependencies.checks.countSessionRecentChecks(sessionId, since)
    ]);
    const sourceRemaining =
      this.limits.maxChecksPerSourcePerHour - sourceChecks;
    const sessionRemaining =
      this.limits.maxChecksPerSessionPerHour - sessionChecks;
    return Math.max(0, Math.min(sourceRemaining, sessionRemaining));
  }

  /**
   * Records a check that established nothing — a refusal, an unreadable page,
   * an unmonitorable kind — and reports it as such.
   *
   * The row is written first: "we tried and could not read it" has to be
   * distinguishable from "we never looked", and neither may be recorded as a
   * change. The reason codes are written by this method rather than borrowed
   * from `finishCheck`, because the database rule for an unreadable outcome
   * demands both a reason and an error code.
   */
  private async recordRefusal(
    input: { sessionId: string; sourceId: string; actor: string },
    source: Source,
    outcome: {
      status: Extract<SourceMonitorStatus, "unavailable" | "failed">;
      reasonCode: string;
      errorCode: string;
      message: string;
      httpStatus: number | null;
    }
  ): Promise<SourceCheckOutcome> {
    const checkedAt = this.now().toISOString();
    await this.dependencies.checks.insertCheck({
      record: {
        id: newId(),
        sessionId: input.sessionId,
        sourceId: source.id,
        status: outcome.status,
        reasonCode: outcome.reasonCode,
        message: outcome.message,
        errorCode: outcome.errorCode,
        errorMessage: outcome.message,
        checkedBy: input.actor,
        newVersionStored: false
      }
    });
    await this.appendEvent({
      sessionId: input.sessionId,
      correlationId: source.id,
      type: "SOURCE_CHECK_FAILED",
      payload: {
        sourceId: source.id,
        status: outcome.status,
        reasonCode: outcome.reasonCode,
        errorCode: outcome.errorCode,
        message: outcome.message,
        httpStatus: outcome.httpStatus,
        checkedBy: input.actor
      }
    });
    return SourceCheckOutcomeSchema.parse({
      sourceId: source.id,
      sessionId: input.sessionId,
      status: outcome.status,
      reasonCode: outcome.reasonCode,
      message: outcome.message,
      checkedAt,
      checkedBy: input.actor,
      previousSnapshotId: null,
      currentSnapshotId: null,
      previousContentHash: null,
      currentContentHash: null,
      httpStatus: outcome.httpStatus,
      newVersionStored: false,
      evidenceImpacts: [],
      claimImpacts: [],
      revalidationTask: null,
      // Counted after the refusal lands, with the same meaning as a completed
      // check: how many attempts remain once this one is on the record.
      remainingChecks: await this.remainingChecks(
        input.sessionId,
        input.sourceId,
        this.now()
      )
    });
  }

  /**
   * Writes the completed check row, then stamps how much of the budget is
   * left once this check is on the record — the honest "checks remaining"
   * number for the client, counted after the fact rather than before it.
   */
  private async finishCheck(
    input: { sessionId: string; sourceId: string; actor: string },
    outcome: CheckOutcomeInput
  ): Promise<SourceCheckOutcome> {
    const checkedAt = this.now().toISOString();
    await this.dependencies.checks.insertCheck({
      record: {
        id: newId(),
        sessionId: input.sessionId,
        sourceId: input.sourceId,
        status: outcome.status,
        reasonCode: outcome.reasonCode,
        message: outcome.message,
        previousSnapshotId: outcome.previousSnapshotId,
        currentSnapshotId: outcome.currentSnapshotId,
        previousContentHash: outcome.previousContentHash,
        currentContentHash: outcome.currentContentHash,
        httpStatus: outcome.httpStatus,
        newVersionStored: outcome.newVersionStored,
        checkedBy: input.actor
      }
    });
    return SourceCheckOutcomeSchema.parse({
      ...outcome,
      sourceId: input.sourceId,
      sessionId: input.sessionId,
      checkedAt,
      checkedBy: input.actor,
      // Counted after the row lands, so the number answers "how many checks
      // are left *after this one*" rather than "how many were left before".
      remainingChecks: await this.remainingChecks(
        input.sessionId,
        input.sourceId,
        this.now()
      )
    });
  }

  /**
   * Derives what a version change reaches: the excerpts, then the claims
   * through the same workspace projection the UI reads.
   */
  private async deriveImpacts(
    sessionId: string,
    source: Source,
    previous: SourceSnapshot | null,
    current: SourceSnapshot
  ): Promise<{
    evidenceImpacts: EvidenceImpact[];
    claimImpacts: ClaimImpact[];
  }> {
    const excerpts = await this.dependencies.evidence.listEvidenceForSource(
      sessionId,
      source.id
    );
    const evidenceImpacts = deriveEvidenceImpacts({
      excerpts,
      previous,
      current
    });
    const workspace = (await this.dependencies.workspace?.(sessionId)) ?? null;
    if (!workspace) {
      return { evidenceImpacts, claimImpacts: [] };
    }
    const claimImpacts = deriveClaimImpacts({
      claims: workspace.claims,
      evidence: excerpts,
      impacts: evidenceImpacts,
      verdicts: workspace.verdicts
    });
    return { evidenceImpacts, claimImpacts };
  }

  /**
   * Opens the re-check a change asks for — or resolves to the one already
   * open for this exact version.
   *
   * The deduplication read comes first and the unique index backs it up: the
   * same version of the same source cannot open a second reminder, however
   * many times the check is re-run.
   */
  private async openTaskForChange(
    input: { sessionId: string; sourceId: string; actor: string },
    source: Source,
    versions: {
      previousSnapshot: SourceSnapshot | null;
      currentSnapshot: SourceSnapshot;
      impacts: { evidenceImpacts: EvidenceImpact[]; claimImpacts: ClaimImpact[] };
    }
  ): Promise<RevalidationTask | null> {
    const { previousSnapshot, currentSnapshot, impacts } = versions;
    const movedEvidence = impacts.evidenceImpacts.filter(
      (impact) => impact.impact !== "unaffected"
    );
    if (movedEvidence.length === 0 && impacts.claimImpacts.length === 0) {
      // Nothing anyone cited moved: a changed page with no dependent material
      // is not a reason to create work.
      return null;
    }

    const existing = await this.dependencies.tasks.findCurrentByTrigger(
      input.sessionId,
      source.id,
      currentSnapshot.contentHash
    );
    if (existing) {
      return existing;
    }

    const affectedEvidenceIds = movedEvidence.map((impact) => impact.evidenceId);
    const affectedClaimIds = [
      ...new Set(impacts.claimImpacts.map((impact) => impact.claimId))
    ];
    const missing = movedEvidence.filter(
      (impact) => impact.impact === "anchor_missing"
    ).length;
    const reason = missing > 0
      ? `来源《${source.title}》的内容发生变化，其中有 ${missing} 条摘录已不在新版本中：该主张依赖的部分材料已发生变化，建议重新核查。`
      : `来源《${source.title}》的内容发生变化，${movedEvidence.length} 条摘录受影响：该主张依赖的部分材料已发生变化，建议重新核查。`;

    const task = await this.dependencies.tasks.insertTask({
      task: {
        id: newId(),
        sessionId: input.sessionId,
        sourceId: source.id,
        sourceTitle: source.title,
        triggerContentHash: currentSnapshot.contentHash,
        previousSnapshotId: previousSnapshot?.id ?? null,
        currentSnapshotId: currentSnapshot.id,
        affectedEvidenceIds,
        affectedClaimIds,
        reason
      }
    });

    await this.appendEvent({
      sessionId: input.sessionId,
      correlationId: task.id,
      type: "REVALIDATION_TASK_CREATED",
      payload: {
        taskId: task.id,
        sourceId: source.id,
        triggerContentHash: task.triggerContentHash,
        affectedEvidenceIds,
        affectedClaimIds,
        reason,
        createdBy: input.actor
      }
    });

    return task;
  }

  /**
   * The two versions of a document source: its own capture, and the newest
   * upload of the same file when there is one.
   *
   * The file row whose bytes hash matches this source's `file:///sha256/...`
   * locator names the original upload; another row with that name and a
   * different hash is a newer version. Content decides, exactly as it does at
   * import time — a renamed copy is the same document, and a same-named
   * different document is not this one.
   */
  private async resolveDocumentVersions(
    sessionId: string,
    source: Source
  ): Promise<{ previous: SourceSnapshot | null; current: SourceSnapshot | null }> {
    const own = await this.dependencies.evidence.getCurrentSnapshot(
      sessionId,
      source.id
    );
    const files = await this.dependencies.files.listSourceFiles(sessionId);
    const ownSha = shaFromFileUrl(source.canonicalUrl ?? source.url ?? "");
    const original = ownSha
      ? files.find((file) => file.sha256 === ownSha)
      : files.find((file) => file.sourceId === source.id);
    if (!original) {
      return { previous: own, current: own };
    }
    const newer = files.find(
      (file) =>
        file.fileName === original.fileName &&
        file.sha256 !== original.sha256 &&
        file.parseStatus === "parsed" &&
        file.sourceId !== null &&
        file.sourceId !== source.id &&
        file.createdAt > original.createdAt
    );
    if (!newer?.sourceId) {
      return { previous: own, current: own };
    }
    const newerSnapshot = await this.dependencies.evidence.getCurrentSnapshot(
      sessionId,
      newer.sourceId
    );
    if (!newerSnapshot) {
      return { previous: own, current: own };
    }
    return { previous: own, current: newerSnapshot };
  }

  private async appendEvent(input: {
    sessionId: string;
    correlationId: string;
    type: ExecutionEvent["type"];
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.dependencies.appendEvent(input);
  }
}

/** The `file:///sha256/<hash>` locator a file import registers. */
function shaFromFileUrl(url: string): string | null {
  const match = /^file:\/\/\/sha256\/([0-9a-f]{64})$/.exec(url.trim());
  return match?.[1] ?? null;
}

/** The status a page answered with, read back out of the fetch error text. */
function httpStatusFromMessage(message: string): number | null {
  const match = /status (\d{3})/i.exec(message);
  const status = match?.[1];
  return status ? Number(status) : null;
}
