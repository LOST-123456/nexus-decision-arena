import { createHash } from "node:crypto";
import {
  deriveClaimVerdicts,
  newId,
  REPORT_SCHEMA_VERSION,
  type ClaimVerdictForQuality,
  type CursorPage,
  type PageRequest,
  type RevalidationTask,
  type ReportSnapshotSummary,
  type ResearchPlanItem,
  type ResearchReportSnapshot,
  type ReportVersionDiff,
  type SourceSnapshot,
  summarizeIndependence
} from "@nexus/shared";
import type {
  ArenaRepository,
  Database,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  ResearchPlanRepository,
  ResearchSearchRepository,
  RevalidationTaskRepository,
  ReportSnapshotRepository,
  ReviewRepository,
  SourceIndependenceRepository,
  TranslationRepository
} from "@nexus/db";
import { ReportSnapshotSessionNotFoundError } from "@nexus/db";
import {
  buildFactCheckReport,
  type FactCheckPlanItemRef,
  type FactCheckReport
} from "./fact-check-report";
import { diffReportSnapshots, snapshotPayload } from "./report-diff";
import { renderFactCheckReportMarkdown } from "./fact-check-report-markdown";
import { renderSnapshotHtml } from "./report-snapshot-html";
import { deriveRevalidationWarnings } from "./revalidation-warnings";
import { buildIndependenceLinks } from "./source-independence";
import { projectResearchQuality } from "./research-quality-projection";
import { buildMultilingualReportBlock } from "./multilingual-report";
import { deriveWorkspaceGaps } from "./workspace-service";

/**
 * Saves, reads, compares and exports immutable versions of the fact-check
 * report.
 *
 * The consistency rule this service exists to keep: **a version is one
 * moment**. Every read that feeds a save happens inside a single
 * repeatable-read transaction, so the claims, excerpts, captures, rulings
 * and monitoring state a version records all come from the same database
 * snapshot — a save can never mix "evidence from before the update" with
 * "verdict from after it". The version number is allocated inside the same
 * transaction and the unique index on (session, version) is the backstop:
 * a concurrent double-save loses the race, retries against the committed
 * row and either takes the next number or resolves to the version the
 * idempotency key already produced.
 *
 * What a save deliberately does not do: it writes nothing but the snapshot
 * row and its audit event. No claim status, no verification status, no
 * review, no capture is created or touched — saving freezes what those rows
 * said, it does not participate in them.
 *
 * The research quality assessment rides along the same way: it is computed
 * inside the transaction from the same rows, frozen into the payload with its
 * rule version, and never recomputed for an old version. Reading a historical
 * version therefore shows the quality reading that existed when it was saved,
 * which is the only honest thing a history can do.
 */
export class ResearchReportSnapshotService {
  constructor(
    private readonly deps: {
      database: Database;
      sessions: Pick<DecisionSessionRepository, "getById">;
      arena: Pick<ArenaRepository, "getSessionArtifacts">;
      evidence: Pick<
        EvidenceRepository,
        "listEvidence" | "listSources" | "listLatestSnapshots"
      >;
      reviews: Pick<ReviewRepository, "listReviews" | "listAgentRuns">;
      events: Pick<EventRepository, "listAfter">;
      /** Absent when the research plan is not configured; nothing is invented. */
      researchPlan?: Pick<ResearchPlanRepository, "listCurrentPlanItems">;
      /** Absent when monitoring is not configured; the version then carries no risk state. */
      monitorTasks?: Pick<RevalidationTaskRepository, "listTasks">;
      /**
       * Human statements about source pairs. Read inside the save transaction
       * so the frozen quality assessment sees the same relations the live
       * independence analysis would. Absent when the analysis is off.
       */
      sourceRelations?: Pick<SourceIndependenceRepository, "listCurrentRelations">;
      /**
       * Controlled search tasks. Read inside the save transaction so the
       * frozen completeness dimension counts executions that really happened.
       * Absent when search is off.
       */
      searchTasks?: Pick<ResearchSearchRepository, "listSearchTasks">;
      /**
       * Stored translations and their reviews. Read inside the save
       * transaction so the frozen multilingual summary describes the same
       * moment as everything else. Absent when multilingual research is not
       * configured; the version then simply carries no reading-aid summary.
       */
      translations?: Pick<
        TranslationRepository,
        "listSessionTranslations" | "listSessionReviews"
      >;
      snapshots: ReportSnapshotRepository;
    }
  ) {}

  /**
   * Saves the current report as a new immutable version.
   *
   * `idempotencyKey` is what makes a double submit the same version: if a
   * version already exists for it in this session, that version is returned
   * and nothing new is written — even across a restart, because the key
   * travels with the row.
   */
  async createSnapshot(input: {
    sessionId: string;
    actor: string;
    changeReason?: string | undefined;
    idempotencyKey?: string | undefined;
  }): Promise<ResearchReportSnapshot> {
    const changeReason = input.changeReason?.trim()
      ? input.changeReason.trim()
      : null;

    const resolveByKey = async (): Promise<ResearchReportSnapshot | null> =>
      input.idempotencyKey
        ? this.deps.snapshots.findByIdempotencyKey(
            input.sessionId,
            input.idempotencyKey
          )
        : null;

    const existing = await resolveByKey();
    if (existing) return existing;

    // Bounded retry: the only expected conflict is the unique index firing
    // because another save took the number (or the key) first, and one retry
    // after seeing the committed row is enough. Anything else propagates.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.writeSnapshot({
          sessionId: input.sessionId,
          actor: input.actor,
          changeReason,
          idempotencyKey: input.idempotencyKey ?? null
        });
      } catch (error) {
        if (attempt < 3 && isRetryableConflict(error)) {
          const raced = await resolveByKey();
          if (raced) return raced;
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * One page of a session's versions, newest first, without payloads.
   *
   * The session is checked first so an unknown one answers 404 instead of an
   * empty history: "no versions saved yet" and "no such session" are
   * different answers, and only one of them invites a retry.
   */
  async listSnapshots(
    sessionId: string,
    page: PageRequest = {}
  ): Promise<CursorPage<ReportSnapshotSummary>> {
    const session = await this.deps.sessions.getById(sessionId);
    if (!session) {
      throw new ReportSnapshotSessionNotFoundError(sessionId);
    }
    return this.deps.snapshots.listSummaries(sessionId, page);
  }

  /**
   * One version, payload included.
   *
   * Always the stored payload: an old version renders what it froze, never a
   * fresh build over today's rows.
   */
  async getSnapshot(
    sessionId: string,
    snapshotId: string
  ): Promise<ResearchReportSnapshot> {
    return this.deps.snapshots.getSnapshot(sessionId, snapshotId);
  }

  /** Compares two versions of one session. */
  async compare(
    sessionId: string,
    fromSnapshotId: string,
    toSnapshotId: string
  ): Promise<ReportVersionDiff> {
    const [from, to] = await Promise.all([
      this.deps.snapshots.getSnapshot(sessionId, fromSnapshotId),
      this.deps.snapshots.getSnapshot(sessionId, toSnapshotId)
    ]);
    return diffReportSnapshots(from, to);
  }

  /**
   * Renders one stored version for download.
   *
   * Both formats come from the frozen payload and the version's own
   * metadata, so an export can never mix in material that arrived after the
   * version was saved. Markdown reuses the report renderer unchanged; the
   * version header is prepended, not merged into the payload.
   */
  async exportSnapshot(
    sessionId: string,
    snapshotId: string,
    format: "markdown" | "html"
  ): Promise<{ filename: string; contentType: string; body: string }> {
    const snapshot = await this.deps.snapshots.getSnapshot(
      sessionId,
      snapshotId
    );
    const payload = snapshotPayload(snapshot);
    const stem = `fact-check-report-v${snapshot.version}-${snapshot.snapshotHash.slice(0, 8)}`;
    if (format === "markdown") {
      return {
        filename: `${stem}.md`,
        contentType: "text/markdown; charset=utf-8",
        body: renderSnapshotMarkdown(snapshot, payload)
      };
    }
    return {
      filename: `${stem}.html`,
      contentType: "text/html; charset=utf-8",
      body: renderSnapshotHtml(snapshot, payload)
    };
  }

  /* ---------------------------------------------------------------- *
   * The one write path
   * ---------------------------------------------------------------- */

  private async writeSnapshot(input: {
    sessionId: string;
    actor: string;
    changeReason: string | null;
    idempotencyKey: string | null;
  }): Promise<ResearchReportSnapshot> {
    return this.deps.database.transaction(
      async (transaction) => {
        const session = await this.deps.sessions.getById(
          input.sessionId,
          transaction
        );
        if (!session) {
          throw new ReportSnapshotSessionNotFoundError(input.sessionId);
        }

        // One consistent read: every query below runs against the same
        // repeatable-read snapshot, so the version cannot straddle an update.
        const artifacts = await this.deps.arena.getSessionArtifacts(
          input.sessionId,
          transaction
        );
        const evidence = await this.deps.evidence.listEvidence(
          input.sessionId,
          {},
          transaction
        );
        const sources = await this.deps.evidence.listSources(
          input.sessionId,
          transaction
        );
        const latestSnapshots = await this.deps.evidence.listLatestSnapshots(
          input.sessionId,
          transaction
        );
        const reviews = await this.deps.reviews.listReviews(
          input.sessionId,
          {},
          transaction
        );
        const agentRuns = await this.deps.reviews.listAgentRuns(
          input.sessionId,
          transaction
        );
        const events = await this.deps.events.listAfter(
          input.sessionId,
          0,
          transaction
        );
        const planRows: ResearchPlanItem[] = this.deps.researchPlan
          ? await this.deps.researchPlan.listCurrentPlanItems(
              input.sessionId,
              transaction
            )
          : [];
        const planItems: FactCheckPlanItemRef[] = planRows;
        const tasks: RevalidationTask[] = this.deps.monitorTasks
          ? await this.deps.monitorTasks.listTasks(
              input.sessionId,
              {},
              transaction
            )
          : [];
        const humanRelations = this.deps.sourceRelations
          ? await this.deps.sourceRelations.listCurrentRelations(
              input.sessionId,
              transaction
            )
          : [];
        const searchRows = this.deps.searchTasks
          ? await this.deps.searchTasks.listSearchTasks(
              input.sessionId,
              transaction
            )
          : null;

        // The multilingual reading summary frozen with this version. Read
        // from the same transaction's rows as everything else, so a version
        // cannot claim a reading aid that did not exist when it was saved.
        // Only stored translations exist to read: an unavailable or failed
        // translation was never persisted, so it cannot appear in history.
        const multilingualBlock = this.deps.translations
          ? buildMultilingualReportBlock({
              translations: await this.deps.translations.listSessionTranslations(
                input.sessionId,
                transaction
              ),
              reviews: await this.deps.translations.listSessionReviews(
                input.sessionId,
                transaction
              )
            })
          : null;

        const verdicts = deriveClaimVerdicts(artifacts.claims, evidence, {
          challenges: artifacts.challenges,
          reviews
        });
        const lastEventSequence = events.reduce(
          (max, event) => Math.max(max, event.sequence),
          0
        );

        // The research quality assessment frozen with this version.
        //
        // Built from the same transaction's rows as the report itself, through
        // the same pure projection the live quality endpoint uses, so a saved
        // version and the live reading cannot disagree about the same
        // material. It is computed here rather than read from the quality
        // service because a version must not mix rows from two moments — the
        // whole point of the repeatable-read transaction. Every optional input
        // keeps its "unknown rather than guessed" behaviour: an absent
        // dependency makes the matching dimension answer insufficient_data.
        const researchQuality = projectResearchQuality({
          sessionId: input.sessionId,
          assessedAt: new Date().toISOString(),
          claims: artifacts.claims,
          evidence,
          sources,
          conflicts: artifacts.conflicts,
          challenges: artifacts.challenges,
          verdicts: verdicts.map(
            (verdict): ClaimVerdictForQuality => ({
              claimId: verdict.claimId,
              status: verdict.status,
              counts: {
                total: verdict.counts.total,
                verified: verdict.counts.verified,
                unverified: verdict.counts.unverified,
                verifiedSupporting: verdict.counts.verifiedSupporting,
                verifiedOpposing: verdict.counts.verifiedOpposing
              },
              basis: {
                supportingEvidenceIds: verdict.basis.supportingEvidenceIds,
                opposingEvidenceIds: verdict.basis.opposingEvidenceIds
              }
            })
          ),
          gaps: deriveWorkspaceGaps({
            claims: artifacts.claims,
            verdicts,
            evidence,
            sources,
            challenges: artifacts.challenges
          }),
          agentRuns,
          independence: summarizeIndependence({
            sessionId: input.sessionId,
            sources,
            links: buildIndependenceLinks({
              sources,
              snapshotBySource: new Map(
                latestSnapshots.map((snapshot) => [
                  snapshot.sourceId,
                  snapshot
                ])
              ),
              humanRelations
            })
          }),
          monitoring: this.deps.monitorTasks
            ? {
                tasks,
                warnings: deriveRevalidationWarnings({
                  tasks,
                  claims: artifacts.claims,
                  evidence,
                  sources,
                  latestSnapshots
                })
              }
            : null,
          planItems: planRows,
          searchTasks: searchRows
            ? searchRows.map((task) => ({ id: task.id, status: task.status }))
            : null
        });

        // The report is built exactly as the live route builds it — same
        // inputs, same pure function — so a saved version and the report it
        // was saved from cannot disagree.
        const report: FactCheckReport = buildFactCheckReport({
          session: {
            id: input.sessionId,
            researchQuestion: session.researchQuestion ?? null,
            phase: session.phase,
            operationalStatus: session.operationalStatus,
            currentConclusion: session.currentConclusion ?? null
          },
          claims: artifacts.claims,
          evidence,
          sources,
          challenges: artifacts.challenges,
          conflicts: artifacts.conflicts,
          verdicts,
          reviews,
          agentRuns,
          lastEventSequence,
          generatedAt: new Date().toISOString(),
          planItems,
          // Derived here from the same transaction's rows rather than read
          // again through the monitor: the risk state a version records is
          // the state at that moment, not a later one.
          ...(this.deps.monitorTasks
            ? {
                revalidation: deriveRevalidationWarnings({
                  tasks,
                  claims: artifacts.claims,
                  evidence,
                  sources,
                  latestSnapshots
                })
              }
            : {}),
          // The frozen quality assessment: computed above from the same rows.
          researchQuality,
          // The frozen multilingual reading summary, present only when
          // something was actually translated. A version with no stored
          // translation carries no block rather than an all-zero one, so a
          // reader never mistakes "nothing to report" for "not tracked".
          ...(multilingualBlock && multilingualBlock.translationCount > 0
            ? { multilingual: multilingualBlock }
            : {})
        });

        const version =
          (await this.deps.snapshots.maxVersion(
            input.sessionId,
            transaction
          )) + 1;
        const snapshotId = newId();
        const snapshotHash = hashPayload(report);

        const sourceReferences = sources.map((source) => {
          const snapshot = latestSnapshots.find(
            (item) => item.sourceId === source.id
          );
          return {
            sourceId: source.id,
            snapshotId: snapshot?.id ?? null,
            contentHash: snapshot?.contentHash ?? null,
            title: source.title,
            retrievedAt: snapshot?.retrievedAt ?? null
          };
        });

        const { snapshot } = await this.deps.snapshots.insertSnapshot(
          transaction,
          {
            snapshot: {
              id: snapshotId,
              sessionId: input.sessionId,
              version,
              createdBy: input.actor,
              researchQuestion: session.researchQuestion ?? null,
              reportSchemaVersion: REPORT_SCHEMA_VERSION,
              materialsFingerprint: report.materialsFingerprint,
              snapshotHash,
              reportPayload: report,
              sourceReferences,
              evidenceReferences: evidence.map((item) => ({
                evidenceId: item.id,
                title: item.title,
                sourceId: item.sourceId ?? null,
                verificationStatus: item.verificationStatus,
                // The row's own value, or null when it recorded none: a
                // version must not claim an anchor state that was never set.
                locatorStatus: item.locatorStatus ?? null
              })),
              claimReferences: report.findings.map((finding) => ({
                claimId: finding.claimId,
                statement: finding.statement,
                claimStatus: finding.claimStatus,
                verdictStatus: finding.verdict.status,
                verdictConfidence: finding.verdict.confidence
              })),
              reviewReferences: reviews.map((review) => ({
                reviewId: review.id,
                claimId: review.claimId,
                outcome: review.outcome,
                reviewer: review.reviewer,
                createdAt: review.createdAt
              })),
              monitoringReferences: tasks
                .filter(
                  (task) => task.status === "open" || task.status === "in_review"
                )
                .map((task) => ({
                  taskId: task.id,
                  sourceId: task.sourceId,
                  status: task.status
                })),
              changeReason: input.changeReason,
              idempotencyKey: input.idempotencyKey
            },
            event: {
              correlationId: snapshotId,
              type: "REPORT_SNAPSHOT_CREATED",
              payload: {
                snapshotId,
                version,
                materialsFingerprint: report.materialsFingerprint,
                snapshotHash,
                changeReason: input.changeReason,
                claimCount: report.scope.claims,
                evidenceCount: report.scope.evidence
              }
            }
          }
        );

        return snapshot;
      },
      { isolationLevel: "repeatable read" }
    );
  }
}

/**
 * A unique-violation or serialization-failure is a race, not a bug: another
 * save took this version number (or this idempotency key) first. Retrying
 * the whole read is safe because the write is the only side effect and it
 * lands in the same rolled-back transaction.
 */
function isRetryableConflict(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "23505" || code === "40001";
}

/**
 * sha256 over a canonical form of the payload.
 *
 * Canonical means key-sorted at every level, so the same report always
 * hashes to the same value regardless of property order — the hash is a
 * fingerprint of content, not of how the object happened to be built.
 */
export function hashPayload(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

/**
 * The version header a historical export carries before the report itself.
 *
 * The payload renders its own "报告版本" line from the version number it was
 * frozen with; this block adds what the payload cannot know — the snapshot
 * id, when it was saved, by whom, and why.
 */
/**
 * Exported so the version header can be asserted on its own: the point of the
 * header is that a historical export says where it came from.
 */
export function renderSnapshotMarkdown(
  snapshot: ResearchReportSnapshot,
  payload: FactCheckReport
): string {
  const header = [
    "> 历史版本导出",
    ">",
    `> - 快照 ID：${snapshot.snapshotId}`,
    `> - 版本：v${snapshot.version}（报告结构 v${snapshot.reportSchemaVersion}）`,
    `> - 保存时间：${snapshot.createdAt}`,
    `> - 保存人：${snapshot.createdBy}`,
    `> - 材料指纹：${snapshot.materialsFingerprint}`,
    `> - 快照哈希：${snapshot.snapshotHash}`,
    `> - 变更原因：${snapshot.changeReason ?? "（未填写）"}`,
    ">",
    "> 本导出内容来自该版本的不可变快照，不包含保存之后的任何变更。",
    ""
  ].join("\n");
  return `${header}${renderFactCheckReportMarkdown(payload)}\n`;
}
