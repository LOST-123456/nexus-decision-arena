import { describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { RevalidationTaskNotFoundError } from "@nexus/db";
import type { RevalidationTaskEvent, SourceCheckRecord } from "@nexus/db";
import type {
  ExecutionEvent,
  RevalidationTask,
  Source,
  SourceSnapshot,
  Evidence,
  ClaimVerdict,
  Claim
} from "@nexus/shared";
import { PageFetchError, type FetchedPage } from "./page-fetch";
import {
  DEFAULT_MONITOR_LIMITS,
  RevalidationTaskStateError,
  SourceMonitorService,
  type SourceMonitorLimits
} from "./source-monitor-service";

/**
 * The monitoring orchestrator, with every dependency faked.
 *
 * The boundary under test is the honesty of the outcomes, not the SQL:
 *  - a readable page with the same text is `unchanged` and writes no version;
 *  - a readable page with new text is `changed`: the old capture survives, the
 *    new one is stored through the evidence repository, impacts are derived
 *    and exactly one task is opened per version;
 *  - a page that cannot be read is `unavailable` with a reason — never
 *    `changed`, and never a task;
 *  - budgets refuse *before* any fetch, and the refusal is recorded;
 *  - nothing here writes a verification status, and nothing rewrites a claim.
 */

const SESSION_ID = newId();

const OLD_TEXT = [
  "国家统计局发布上半年经济数据。",
  "出口连续三个季度下滑，制造业投资增速回落至 4.2%。",
  "分析人士认为外部需求仍然疲软。"
].join("\n");

const NEW_TEXT = [
  "国家统计局发布上半年经济数据（修订版）。",
  "出口连续三个季度下滑，制造业投资增速回升至 5.6%。"
].join("\n");

function hashOf(text: string): string {
  // Any stable 64-char digest stands in for sha256 in these fakes.
  let hash = "";
  for (let round = 0; round < 8; round += 1) {
    hash += (text.length * (round + 7)).toString(16).padStart(8, "0");
  }
  return hash.padEnd(64, "0").slice(0, 64);
}

function urlSource(overrides: Partial<Source> = {}): Source {
  return {
    id: newId(),
    sessionId: SESSION_ID,
    title: "季度回顾",
    kind: "url",
    url: "https://example.test/page",
    canonicalUrl: "https://example.test/page",
    createdBy: "human",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

function makeSnapshot(
  sourceId: string,
  content: string,
  retrievedAt: string
): SourceSnapshot {
  return {
    id: newId(),
    sessionId: SESSION_ID,
    sourceId,
    canonicalUrl: "https://example.test/page",
    contentHash: hashOf(content),
    contentType: "text/plain",
    content,
    contentBytes: content.length,
    charCount: content.length,
    retrievedAt,
    createdAt: retrievedAt
  };
}

function makeExcerpt(
  sourceId: string,
  claimId: string,
  anchorText: string
): Evidence {
  return {
    id: newId(),
    sessionId: SESSION_ID,
    claimIds: [claimId],
    kind: "external_reference",
    title: "摘录：制造业投资增速",
    content: anchorText,
    description: "工作台摘录",
    sourceId,
    direction: "supports",
    reliability: 0.8,
    verificationStatus: "verified",
    verifiedBy: "复核员 (reviewer)",
    verificationNote: "与原文一致",
    locatorStatus: "anchored",
    anchorText,
    sourceContentHash: hashOf(OLD_TEXT),
    retrievedAt: "2026-10-01T00:00:00.000Z",
    createdBy: "human"
  };
}

function fetchedPage(content: string, overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    requestedUrl: "https://example.test/page",
    finalUrl: "https://example.test/page",
    canonicalUrl: "https://example.test/page",
    status: 200,
    contentType: "text/html",
    contentEncoding: null,
    content,
    contentHash: hashOf(content),
    wireBytes: content.length,
    contentBytes: content.length,
    charCount: content.length,
    title: "季度回顾",
    author: null,
    publisher: null,
    publishedAt: null,
    retrievedAt: "2026-10-03T00:00:00.000Z",
    redirects: [],
    truncated: false,
    ...overrides
  };
}

type RecordedEvent = {
  sessionId: string;
  correlationId: string;
  type: string;
  payload: Record<string, unknown>;
};

/** A strictly increasing timestamp, standing in for per-statement now(). */
function eventTimestamp(harness: { taskEvents: unknown[] }): string {
  return new Date(
    Date.parse("2026-10-01T00:00:00.000Z") + harness.taskEvents.length * 1000
  ).toISOString();
}

type Harness = {
  service: SourceMonitorService;
  sources: Source[];
  snapshots: SourceSnapshot[];
  excerpts: Evidence[];
  checks: SourceCheckRecord[];
  tasks: RevalidationTask[];
  taskEvents: RevalidationTaskEvent[];
  events: RecordedEvent[];
  fetchCalls: string[];
  /** Verification statuses as they were when the harness was built. */
  verificationBefore: Map<string, Evidence["verificationStatus"]>;
  claims: Claim[];
  verdicts: ClaimVerdict[];
};

function buildHarness(input: {
  source: Source;
  snapshots?: SourceSnapshot[];
  excerpts?: Evidence[];
  fetch: (url: string) => Promise<FetchedPage>;
  limits?: Partial<SourceMonitorLimits>;
  files?: Array<{
    id: string;
    fileName: string;
    sha256: string;
    sourceId: string | null;
    parseStatus: "parsed" | "failed" | "needs_ocr";
    createdAt: string;
  }>;
}): Harness {
  const claimId = newId();
  const claim: Claim = {
    id: claimId,
    sessionId: SESSION_ID,
    lens: "research",
    statement: "出口连续三个季度下滑。",
    type: "fact",
    stance: "support",
    importance: 3,
    confidence: 0.5,
    evidenceIds: [],
    status: "proposed",
    rootClaimId: claimId,
    revision: 1,
    relations: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z"
  };
  const verdict: ClaimVerdict = {
    claimId,
    status: "supported",
    confidence: 0.8,
    rationale: "已核实支持证据",
    counts: {
      total: 1,
      verified: 1,
      unverified: 0,
      rejected: 0,
      expired: 0,
      notYetEffective: 0,
      verifiedSupporting: 1,
      verifiedOpposing: 0,
      verifiedContext: 0
    },
    needsWork: false,
    basis: {
      supportingEvidenceIds: [],
      opposingEvidenceIds: [],
      contextEvidenceIds: []
    },
    excluded: [],
    ruleHits: [],
    confidenceBasis: [],
    openQuestions: [],
    limits: [],
    crossReview: {
      challenges: 0,
      unresolved: 0,
      severeUnresolved: 0,
      unresolvedChallengeIds: [],
      severeUnresolvedChallengeIds: [],
      lastReviewedAt: null
    },
    review: null,
    effectiveStatus: "supported"
  };

  // The service is assembled last because the fakes close over the harness
  // data, so the literal carries everything but `service`.
  const harness: Omit<Harness, "service"> = {
    sources: [input.source],
    snapshots: input.snapshots ?? [],
    // Every excerpt in this harness bears on the one claim the fake workspace
    // projects, so the claim-impact derivation has something to find.
    excerpts: (input.excerpts ?? []).map((excerpt) => ({
      ...excerpt,
      claimIds: [claimId]
    })),
    checks: [],
    tasks: [],
    taskEvents: [],
    events: [],
    fetchCalls: [],
    verificationBefore: new Map(),
    claims: [claim],
    verdicts: [verdict]
  };
  for (const excerpt of harness.excerpts) {
    harness.verificationBefore.set(excerpt.id, excerpt.verificationStatus);
  }

  let checkCounter = 0;
  const service = new SourceMonitorService({
    evidence: {
      getSource: async (sessionId, sourceId) =>
        harness.sources.find(
          (source) =>
            source.id === sourceId && source.sessionId === sessionId
        ) ?? null,
      listSnapshots: async (_sessionId, sourceId) =>
        harness.snapshots
          .filter((snapshot) => snapshot.sourceId === sourceId)
          .sort((left, right) => right.retrievedAt.localeCompare(left.retrievedAt)),
      getCurrentSnapshot: async (_sessionId, sourceId) =>
        harness.snapshots
          .filter((snapshot) => snapshot.sourceId === sourceId)
          .sort((left, right) => right.retrievedAt.localeCompare(left.retrievedAt))[0] ?? null,
      listEvidenceForSource: async (_sessionId, sourceId) =>
        harness.excerpts.filter((excerpt) => excerpt.sourceId === sourceId),
      listEvidence: async () => harness.excerpts,
      listSources: async () => harness.sources,
      listLatestSnapshots: async () => {
        const latest = new Map<string, SourceSnapshot>();
        for (const snapshot of [...harness.snapshots].sort((left, right) =>
          right.retrievedAt.localeCompare(left.retrievedAt)
        )) {
          if (!latest.has(snapshot.sourceId)) latest.set(snapshot.sourceId, snapshot);
        }
        return [...latest.values()];
      },
      recordRetrievalSuccess: async ({ snapshot, event }) => {
        const exists = harness.snapshots.some(
          (stored) =>
            stored.sourceId === snapshot.sourceId &&
            stored.contentHash === snapshot.contentHash
        );
        if (!exists) harness.snapshots.push(snapshot);
        return {
          source: input.source,
          snapshot,
          created: !exists,
          // The repository appends this inside its transaction and hands it
          // back; the service never reads it, but the shape stays honest.
          event: {
            id: newId(),
            sessionId: SESSION_ID,
            sequence: 1,
            correlationId: event.correlationId,
            type: event.type,
            payload: event.payload,
            occurredAt: "2026-10-03T00:00:00.000Z"
          } satisfies ExecutionEvent
        };
      }
    },
    checks: {
      insertCheck: async ({ record }) => {
        checkCounter += 1;
        const row: SourceCheckRecord = {
          id: newId(),
          sessionId: record.sessionId,
          sourceId: record.sourceId,
          status: record.status,
          reasonCode: record.reasonCode ?? null,
          message: record.message,
          previousSnapshotId: record.previousSnapshotId ?? null,
          currentSnapshotId: record.currentSnapshotId ?? null,
          previousContentHash: record.previousContentHash ?? null,
          currentContentHash: record.currentContentHash ?? null,
          httpStatus: record.httpStatus ?? null,
          errorCode: record.errorCode ?? null,
          errorMessage: record.errorMessage ?? null,
          newVersionStored: record.newVersionStored ?? false,
          checkedBy: record.checkedBy,
          checkedAt: new Date().toISOString(),
          createdAt: new Date().toISOString()
        };
        harness.checks.push(row);
        return row;
      },
      lastCheck: async (sessionId, sourceId) =>
        [...harness.checks]
          .filter(
            (check) =>
              check.sessionId === sessionId && check.sourceId === sourceId
          )
          .sort((left, right) => right.checkedAt.localeCompare(left.checkedAt))[0] ?? null,
      listChecks: async () => [],
      countRecentChecks: async (sessionId, sourceId, since) =>
        harness.checks.filter(
          (check) =>
            check.sessionId === sessionId &&
            check.sourceId === sourceId &&
            check.checkedAt >= since
        ).length,
      countUnsuccessfulSince: async (sessionId, sourceId, since) =>
        harness.checks.filter(
          (check) =>
            check.sessionId === sessionId &&
            check.sourceId === sourceId &&
            check.checkedAt >= since &&
            (check.status === "failed" || check.status === "unavailable")
        ).length,
      countSessionRecentChecks: async (sessionId, since) =>
        harness.checks.filter(
          (check) => check.sessionId === sessionId && check.checkedAt >= since
        ).length
    },
    tasks: {
      insertTask: async ({ task }) => {
        const now = new Date().toISOString();
        const row: RevalidationTask = {
          ...task,
          status: "open",
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
          resolvedBy: null,
          resolutionNote: null
        };
        harness.tasks.push(row);
        harness.taskEvents.push({
          id: newId(),
          taskId: row.id,
          sessionId: row.sessionId,
          fromStatus: null,
          toStatus: "open",
          note: row.reason,
          actor: "source-monitoring",
          // Monotonic so the history read has a stable order, the way the
          // database's per-statement timestamps do.
          createdAt: eventTimestamp(harness)
        });
        return row;
      },
      findCurrentByTrigger: async (sessionId, sourceId, triggerContentHash) =>
        harness.tasks.find(
          (task) =>
            task.sessionId === sessionId &&
            task.sourceId === sourceId &&
            task.triggerContentHash === triggerContentHash
        ) ?? null,
      getTask: async (sessionId, taskId) => {
        const found = harness.tasks.find(
          (task) => task.sessionId === sessionId && task.id === taskId
        );
        if (!found) throw new RevalidationTaskNotFoundError(taskId);
        return found;
      },
      listTasks: async (sessionId, options = {}) =>
        harness.tasks
          .filter(
            (task) =>
              task.sessionId === sessionId &&
              (options.status === undefined || task.status === options.status)
          )
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      listTaskHistory: async (sessionId, taskId) =>
        harness.taskEvents
          .filter(
            (event) =>
              event.sessionId === sessionId && event.taskId === taskId
          )
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      transitionTask: async ({ sessionId, taskId, status, actor, note }) => {
        const current = await (async () => {
          const found = harness.tasks.find(
            (task) => task.sessionId === sessionId && task.id === taskId
          );
          if (!found) throw new RevalidationTaskNotFoundError(taskId);
          return found;
        })();
        const closing = status === "resolved" || status === "dismissed";
        if (closing && !note) {
          throw new Error(
            "Closing a revalidation task requires a reason (resolutionNote)."
          );
        }
        const now = new Date().toISOString();
        const from = current.status;
        current.status = status;
        current.updatedAt = now;
        current.resolvedAt = closing ? (current.resolvedAt ?? now) : null;
        current.resolvedBy = closing ? actor : null;
        current.resolutionNote = closing ? (note ?? null) : null;
        harness.taskEvents.push({
          id: newId(),
          taskId,
          sessionId,
          fromStatus: from,
          toStatus: status,
          note: note ?? null,
          actor,
          createdAt: eventTimestamp(harness)
        });
        return current;
      }
    },
    files: {
      listSourceFiles: async () =>
        (input.files ?? []).map((file) => ({
          id: file.id,
          sessionId: SESSION_ID,
          fileName: file.fileName,
          declaredMimeType: "text/plain",
          detectedKind: "txt" as const,
          byteSize: 10,
          sha256: file.sha256,
          parseStatus: file.parseStatus,
          parseStats: null,
          parserVersion: "nexus-file-parsers@1",
          createdAt: file.createdAt,
          updatedAt: file.createdAt,
          // `sourceId` and `parseError` are optional on the record, so they
          // are only present when the row actually has them.
          ...(file.sourceId ? { sourceId: file.sourceId } : {})
        }))
    },
    fetch: async (url) => {
      harness.fetchCalls.push(url);
      return input.fetch(url);
    },
    workspace: async () => ({
      claims: harness.claims,
      verdicts: harness.verdicts
    }),
    appendEvent: async (event) => {
      harness.events.push(event);
      return event;
    },
    ...(input.limits ? { limits: input.limits } : {})
  });

  return { ...harness, service };
}

describe("SourceMonitorService: a page that did not move", () => {
  it("reads unchanged, stores nothing and opens no work", async () => {
    const source = urlSource();
    const stored = makeSnapshot(source.id, OLD_TEXT, "2026-10-01T00:00:00.000Z");
    const harness = buildHarness({
      source,
      snapshots: [stored],
      fetch: async () => fetchedPage(OLD_TEXT)
    });

    const outcome = await harness.service.checkSource({
      sessionId: SESSION_ID,
      sourceId: source.id,
      actor: "复核员 (reviewer)"
    });

    expect(outcome.status).toBe("unchanged");
    expect(outcome.newVersionStored).toBe(false);
    expect(outcome.currentContentHash).toBe(stored.contentHash);
    expect(outcome.revalidationTask).toBeNull();
    expect(outcome.evidenceImpacts).toEqual([]);
    // No second capture: the same version is not stored twice.
    expect(harness.snapshots).toHaveLength(1);
    expect(harness.tasks).toHaveLength(0);
    expect(harness.events.map((event) => event.type)).toEqual([
      "SOURCE_CHECK_STARTED",
      "SOURCE_CHECK_COMPLETED"
    ]);
    expect(harness.checks[0]?.status).toBe("unchanged");
  });

  it("keeps not_checked distinct from a completed check", async () => {
    const source = urlSource();
    // A stored capture the fetched page matches, so the completed check is
    // honestly `unchanged`: without it the first capture of the source would
    // be a new version, which is `changed`, not a no-op.
    const stored = makeSnapshot(source.id, OLD_TEXT, "2026-10-01T00:00:00.000Z");
    const harness = buildHarness({
      source,
      snapshots: [stored],
      fetch: async () => fetchedPage(OLD_TEXT)
    });
    const before = await harness.service.getMonitoring(SESSION_ID, source.id);
    expect(before.monitorStatus).toBe("not_checked");
    expect(before.lastCheckedAt).toBeNull();

    await harness.service.checkSource({
      sessionId: SESSION_ID,
      sourceId: source.id,
      actor: "复核员 (reviewer)"
    });
    const after = await harness.service.getMonitoring(SESSION_ID, source.id);
    expect(after.monitorStatus).toBe("unchanged");
    expect(after.lastCheckedAt).not.toBeNull();
  });
});

describe("SourceMonitorService: a page that moved", () => {
  function changedHarness(): Harness {
    const source = urlSource();
    const stored = makeSnapshot(source.id, OLD_TEXT, "2026-10-01T00:00:00.000Z");
    const excerpt = makeExcerpt(
      source.id,
      newId(),
      "分析人士认为外部需求仍然疲软。"
    );
    return buildHarness({
      source,
      snapshots: [stored],
      excerpts: [excerpt],
      fetch: async () => fetchedPage(NEW_TEXT)
    });
  }

  it("keeps both versions, derives the impact and opens one task", async () => {
    const harness = changedHarness();
    const sourceId = harness.sources[0]!.id;
    const oldHash = harness.snapshots[0]!.contentHash;

    const outcome = await harness.service.checkSource({
      sessionId: SESSION_ID,
      sourceId,
      actor: "复核员 (reviewer)"
    });

    expect(outcome.status).toBe("changed");
    expect(outcome.previousContentHash).toBe(oldHash);
    expect(outcome.currentContentHash).not.toBe(oldHash);
    expect(outcome.newVersionStored).toBe(true);
    expect(outcome.revalidationTask).not.toBeNull();

    // The old capture survives untouched next to the new one.
    expect(harness.snapshots).toHaveLength(2);
    expect(
      harness.snapshots.some((snapshot) => snapshot.contentHash === oldHash)
    ).toBe(true);

    // The vanished quote is reported as missing; the verdict it carried is
    // reported unchanged, and no evidence row was rewritten.
    const missing = outcome.evidenceImpacts.find(
      (impact) => impact.impact === "anchor_missing"
    );
    expect(missing).toBeDefined();
    expect(missing?.verificationStatus).toBe("verified");
    for (const excerpt of harness.excerpts) {
      expect(excerpt.verificationStatus).toBe(
        harness.verificationBefore.get(excerpt.id)
      );
    }

    // The claim is asked to be re-checked, with its current verdict reported
    // rather than rewritten.
    expect(outcome.claimImpacts).toHaveLength(1);
    expect(outcome.claimImpacts[0]?.verdictStatus).toBe("supported");
    expect(outcome.claimImpacts[0]?.reason).toContain("建议重新核查");

    // Exactly one task, naming the affected material.
    expect(harness.tasks).toHaveLength(1);
    expect(harness.tasks[0]?.status).toBe("open");
    expect(harness.tasks[0]?.triggerContentHash).toBe(
      outcome.currentContentHash
    );
    expect(harness.tasks[0]?.affectedEvidenceIds).toEqual([
      harness.excerpts[0]!.id
    ]);

    const eventTypes = harness.events.map((event) => event.type);
    expect(eventTypes).toContain("SOURCE_CONTENT_CHANGED");
    expect(eventTypes).toContain("REVALIDATION_TASK_CREATED");
  });

  it("does not open a second reminder when the check is repeated", async () => {
    const harness = changedHarness();
    const sourceId = harness.sources[0]!.id;
    await harness.service.checkSource({
      sessionId: SESSION_ID,
      sourceId,
      actor: "复核员 (reviewer)"
    });
    // The page still serves the new version, so the second check reads it as
    // the stored current version: no drift, no second task.
    const second = await harness.service.checkSource({
      sessionId: SESSION_ID,
      sourceId,
      actor: "复核员 (reviewer)"
    });
    expect(second.status).toBe("unchanged");
    expect(harness.tasks).toHaveLength(1);
    expect(harness.snapshots).toHaveLength(2);
  });

  it("resolves to the existing task when the same version triggers again", async () => {
    // A document source whose newer upload is a different Source row: the
    // comparison pair does not change between checks, so the drift is found
    // again — and must resolve to the task that is already open.
    const source = urlSource({ kind: "document" });
    const own = makeSnapshot(source.id, OLD_TEXT, "2026-10-01T00:00:00.000Z");
    const newerSourceId = newId();
    const newer = makeSnapshot(newerSourceId, NEW_TEXT, "2026-10-02T00:00:00.000Z");
    const excerpt = makeExcerpt(
      source.id,
      newId(),
      "分析人士认为外部需求仍然疲软。"
    );
    const harness = buildHarness({
      source,
      snapshots: [own, newer],
      excerpts: [excerpt],
      fetch: async () => {
        throw new Error("documents are never fetched");
      },
      files: [
        {
          id: newId(),
          fileName: "quarterly.pdf",
          sha256: own.contentHash,
          sourceId: source.id,
          parseStatus: "parsed",
          createdAt: "2026-10-01T00:00:00.000Z"
        },
        {
          id: newId(),
          fileName: "quarterly.pdf",
          sha256: newer.contentHash,
          sourceId: newerSourceId,
          parseStatus: "parsed",
          createdAt: "2026-10-02T00:00:00.000Z"
        }
      ]
    });

    const first = await harness.service.checkSource({
      sessionId: SESSION_ID,
      sourceId: source.id,
      actor: "复核员 (reviewer)"
    });
    expect(first.status).toBe("changed");
    expect(first.revalidationTask).not.toBeNull();

    const second = await harness.service.checkSource({
      sessionId: SESSION_ID,
      sourceId: source.id,
      actor: "复核员 (reviewer)"
    });
    expect(second.status).toBe("changed");
    expect(harness.tasks).toHaveLength(1);
    expect(second.revalidationTask?.id).toBe(first.revalidationTask?.id);
  });
});

describe("SourceMonitorService: a page that could not be read", () => {
  it("records unavailable with a reason and opens no work", async () => {
    const source = urlSource();
    const stored = makeSnapshot(source.id, OLD_TEXT, "2026-10-01T00:00:00.000Z");
    const excerpt = makeExcerpt(
      source.id,
      newId(),
      "出口连续三个季度下滑"
    );
    const harness = buildHarness({
      source,
      snapshots: [stored],
      excerpts: [excerpt],
      fetch: async () => {
        throw new PageFetchError("Retrieval timed out", "timeout");
      }
    });

    const outcome = await harness.service.checkSource({
      sessionId: SESSION_ID,
      sourceId: source.id,
      actor: "复核员 (reviewer)"
    });

    expect(outcome.status).toBe("unavailable");
    expect(outcome.reasonCode).toBe("timeout");
    expect(outcome.revalidationTask).toBeNull();
    expect(outcome.evidenceImpacts).toEqual([]);
    // Nothing was stored, nothing was opened, and no excerpt moved.
    expect(harness.snapshots).toHaveLength(1);
    expect(harness.tasks).toHaveLength(0);
    expect(excerpt.verificationStatus).toBe("verified");
    expect(harness.events.map((event) => event.type)).toContain(
      "SOURCE_CHECK_FAILED"
    );
    expect(harness.checks[0]?.status).toBe("unavailable");
    expect(harness.checks[0]?.errorCode).toBe("timeout");
  });

  it("says a manual source cannot be monitored instead of pretending", async () => {
    const source = urlSource({ kind: "manual" });
    const harness = buildHarness({
      source,
      fetch: async () => {
        throw new Error("must not be called");
      }
    });
    const outcome = await harness.service.checkSource({
      sessionId: SESSION_ID,
      sourceId: source.id,
      actor: "复核员 (reviewer)"
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.reasonCode).toBe("not_monitorable");
    expect(harness.fetchCalls).toHaveLength(0);
  });
});

describe("SourceMonitorService: budgets", () => {
  it("refuses past the per-source rate limit, and records the refusal", async () => {
    const source = urlSource();
    const stored = makeSnapshot(source.id, OLD_TEXT, "2026-10-01T00:00:00.000Z");
    const harness = buildHarness({
      source,
      snapshots: [stored],
      fetch: async () => fetchedPage(OLD_TEXT),
      limits: { maxChecksPerSourcePerHour: 1 }
    });

    const first = await harness.service.checkSource({
      sessionId: SESSION_ID,
      sourceId: source.id,
      actor: "复核员 (reviewer)"
    });
    expect(first.status).toBe("unchanged");
    expect(first.remainingChecks).toBe(0);

    const second = await harness.service.checkSource({
      sessionId: SESSION_ID,
      sourceId: source.id,
      actor: "复核员 (reviewer)"
    });
    expect(second.status).toBe("failed");
    expect(second.reasonCode).toBe("rate_limited");
    expect(second.remainingChecks).toBe(0);
    // The refusal is a recorded check, not a silent no-op.
    expect(harness.checks).toHaveLength(2);
    expect(harness.checks[1]?.status).toBe("failed");
    // And no second fetch was spent.
    expect(harness.fetchCalls).toHaveLength(1);
  });

  it("stops retrying a source that keeps failing", async () => {
    const source = urlSource();
    const harness = buildHarness({
      source,
      fetch: async () => {
        throw new PageFetchError("Could not read the page", "transport");
      },
      limits: { maxFailuresPerSourcePerDay: 2 }
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await harness.service.checkSource({
        sessionId: SESSION_ID,
        sourceId: source.id,
        actor: "复核员 (reviewer)"
      });
      expect(outcome.status).toBe("unavailable");
    }
    const exhausted = await harness.service.checkSource({
      sessionId: SESSION_ID,
      sourceId: source.id,
      actor: "复核员 (reviewer)"
    });
    expect(exhausted.status).toBe("failed");
    expect(exhausted.reasonCode).toBe("retry_budget_exhausted");
    expect(harness.fetchCalls).toHaveLength(2);
  });
});

describe("SourceMonitorService: closing the loop", () => {
  async function openedTask(harness: Harness) {
    const sourceId = harness.sources[0]!.id;
    await harness.service.checkSource({
      sessionId: SESSION_ID,
      sourceId,
      actor: "复核员 (reviewer)"
    });
    return harness.tasks[0]!;
  }

  function changedHarness(): Harness {
    const source = urlSource();
    const stored = makeSnapshot(source.id, OLD_TEXT, "2026-10-01T00:00:00.000Z");
    const excerpt = makeExcerpt(
      source.id,
      newId(),
      "分析人士认为外部需求仍然疲软。"
    );
    return buildHarness({
      source,
      snapshots: [stored],
      excerpts: [excerpt],
      fetch: async () => fetchedPage(NEW_TEXT)
    });
  }

  it("moves through review and closes only with a reason", async () => {
    const harness = changedHarness();
    const task = await openedTask(harness);

    // Closing without a reason is refused, at the service and the repository.
    await expect(
      harness.service.resolveTask({
        sessionId: SESSION_ID,
        taskId: task.id,
        status: "resolved",
        actor: "复核员 (reviewer)"
      })
    ).rejects.toThrow(RevalidationTaskStateError);

    const inReview = await harness.service.resolveTask({
      sessionId: SESSION_ID,
      taskId: task.id,
      status: "in_review",
      actor: "复核员 (reviewer)"
    });
    expect(inReview.status).toBe("in_review");

    const closed = await harness.service.resolveTask({
      sessionId: SESSION_ID,
      taskId: task.id,
      status: "resolved",
      note: "重新抓取后确认引用仍然成立",
      actor: "复核员 (reviewer)"
    });
    expect(closed.status).toBe("resolved");
    expect(closed.resolvedBy).toBe("复核员 (reviewer)");
    expect(closed.resolutionNote).toBe("重新抓取后确认引用仍然成立");
    expect(closed.resolvedAt).not.toBeNull();

    // The history keeps every transition, and the id stayed addressable.
    const detail = await harness.service.getTaskDetail(SESSION_ID, task.id);
    expect(detail.task.id).toBe(task.id);
    expect(detail.history.map((event) => event.toStatus)).toEqual([
      "resolved",
      "in_review",
      "open"
    ]);
    expect(detail.evidence).toHaveLength(1);
    expect(detail.claims).toHaveLength(1);
    expect(
      harness.events.some(
        (event) => event.type === "REVALIDATION_TASK_RESOLVED"
      )
    ).toBe(true);
  });

  it("refuses a transition the vocabulary does not allow", async () => {
    const harness = changedHarness();
    const task = await openedTask(harness);
    await expect(
      harness.service.resolveTask({
        sessionId: SESSION_ID,
        taskId: task.id,
        status: "open",
        actor: "复核员 (reviewer)"
      })
    ).rejects.toThrow(/不能将复核任务直接置为/);
  });

  it("keeps another session's task invisible", async () => {
    const harness = changedHarness();
    const task = await openedTask(harness);
    await expect(
      harness.service.getTaskDetail(newId(), task.id)
    ).rejects.toThrow(/not found/i);
    expect(await harness.service.listTasks(newId())).toEqual([]);
  });
});

describe("SourceMonitorService: the diff read", () => {
  it("compares the two most recent captures and names the vanished quote", async () => {
    const source = urlSource();
    const older = makeSnapshot(source.id, OLD_TEXT, "2026-10-01T00:00:00.000Z");
    const newer = makeSnapshot(source.id, NEW_TEXT, "2026-10-02T00:00:00.000Z");
    const excerpt = makeExcerpt(
      source.id,
      newId(),
      "分析人士认为外部需求仍然疲软。"
    );
    const harness = buildHarness({
      source,
      snapshots: [newer, older],
      excerpts: [excerpt],
      fetch: async () => fetchedPage(NEW_TEXT)
    });

    const diff = await harness.service.getDiff(SESSION_ID, source.id);
    expect(diff.previousSnapshotId).toBe(older.id);
    expect(diff.currentSnapshotId).toBe(newer.id);
    expect(diff.missingExcerpts).toHaveLength(1);
    expect(diff.missingExcerpts[0]?.evidenceId).toBe(excerpt.id);
  });

  it("says there is nothing to compare when only one capture exists", async () => {
    const source = urlSource();
    const only = makeSnapshot(source.id, OLD_TEXT, "2026-10-01T00:00:00.000Z");
    const harness = buildHarness({
      source,
      snapshots: [only],
      fetch: async () => fetchedPage(OLD_TEXT)
    });
    const diff = await harness.service.getDiff(SESSION_ID, source.id);
    expect(diff.segments).toEqual([]);
    expect(diff.previousSnapshotId).toBeNull();
    expect(diff.currentSnapshotId).toBe(only.id);
  });
});

describe("SourceMonitorService: report warnings", () => {
  it("reports the open work and the versions the material is at", async () => {
    const source = urlSource();
    const stored = makeSnapshot(source.id, OLD_TEXT, "2026-10-01T00:00:00.000Z");
    const excerpt = makeExcerpt(
      source.id,
      newId(),
      "分析人士认为外部需求仍然疲软。"
    );
    const harness = buildHarness({
      source,
      snapshots: [stored],
      excerpts: [excerpt],
      fetch: async () => fetchedPage(NEW_TEXT)
    });
    await harness.service.checkSource({
      sessionId: SESSION_ID,
      sourceId: source.id,
      actor: "复核员 (reviewer)"
    });

    const warnings = await harness.service.reportWarnings(SESSION_ID);
    expect(warnings.openTaskCount).toBe(1);
    expect(warnings.changedSources).toHaveLength(1);
    expect(warnings.evidenceNeedingReconfirmation).toHaveLength(1);
    expect(warnings.affectedClaims[0]?.statement).toBe(
      harness.claims[0]!.statement
    );
    expect(warnings.sourceVersions[0]?.contentHash).toBe(hashOf(NEW_TEXT));
  });

  it("stays quiet when nothing changed", async () => {
    const source = urlSource();
    const stored = makeSnapshot(source.id, OLD_TEXT, "2026-10-01T00:00:00.000Z");
    const harness = buildHarness({
      source,
      snapshots: [stored],
      fetch: async () => fetchedPage(OLD_TEXT)
    });
    await harness.service.checkSource({
      sessionId: SESSION_ID,
      sourceId: source.id,
      actor: "复核员 (reviewer)"
    });
    const warnings = await harness.service.reportWarnings(SESSION_ID);
    expect(warnings.openTaskCount).toBe(0);
    expect(warnings.changedSources).toEqual([]);
  });
});

describe("SourceMonitorService: unknown sources", () => {
  it("refuses a source from another session as if it did not exist", async () => {
    const source = urlSource();
    const harness = buildHarness({
      source,
      fetch: async () => fetchedPage(OLD_TEXT)
    });
    await expect(
      harness.service.checkSource({
        sessionId: newId(),
        sourceId: source.id,
        actor: "复核员 (reviewer)"
      })
    ).rejects.toThrow(/not found/i);
  });
});

// The default limits are part of the contract: monitoring must not be able to
// turn into a scan, whatever a caller forgets to configure.
describe("SourceMonitorService: default limits", () => {
  it("keeps the per-source and per-session budgets bounded", () => {
    expect(DEFAULT_MONITOR_LIMITS.maxChecksPerSourcePerHour).toBeLessThanOrEqual(
      10
    );
    expect(
      DEFAULT_MONITOR_LIMITS.maxChecksPerSessionPerHour
    ).toBeGreaterThanOrEqual(DEFAULT_MONITOR_LIMITS.maxChecksPerSourcePerHour);
    expect(DEFAULT_MONITOR_LIMITS.maxFailuresPerSourcePerDay).toBeGreaterThan(0);
  });
});
