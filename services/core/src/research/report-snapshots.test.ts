import { describe, expect, it } from "vitest";
import {
  ClaimSchema,
  deriveClaimVerdicts,
  EvidenceSchema,
  newId,
  REPORT_SCHEMA_VERSION,
  SourceSchema,
  type Claim,
  type Evidence,
  type Source
} from "@nexus/shared";
import type {
  ResearchReportSnapshot,
  ReportClaimReference,
  ReportEvidenceReference,
  ReportReviewReference,
  ReportSourceReference
} from "@nexus/shared";
import {
  diffReportSnapshots,
  ReportPayloadFormatError,
  snapshotPayload
} from "./report-diff";
import { hashPayload, renderSnapshotMarkdown } from "./report-snapshot-service";
import { renderSnapshotHtml } from "./report-snapshot-html";
import { buildFactCheckReport, type FactCheckReport } from "./fact-check-report";

/**
 * Report-version comparison and export, without a database.
 *
 * These are the rules that have to hold for a comparison to be worth
 * reading:
 *
 * 1. Entities are matched **by id**. Two claims with the same wording but
 *    different ids are two claims, and the diff says so – it never decides
 *    from resemblance.
 * 2. Every entry is categorised. `verdict` covers what the material
 *    supports; `risk` covers whether that material is still current. A page
 *    moving must land in `risk` and never be presented as a conclusion
 *    that changed.
 * 3. Additions and removals are labelled as such, with the value on the
 *    side it belongs to.
 * 4. A historical export says what it is: which version, saved when, by
 *    whom, and that nothing after the save leaked into it.
 */

const NOW_ISO = "2026-02-01T00:00:00.000Z";
const NOW = new Date(NOW_ISO);

const SESSION_ID = newId();
const CLAIM_A = newId();
const CLAIM_B = newId();
const EVIDENCE_A = newId();
const SOURCE_A = newId();
const REVIEW_A = newId();
const CONFLICT_A = newId();
const TASK_A = newId();
/** One capture per source, stable across fixtures so "unchanged" means it. */
const SNAPSHOT_A = newId();

function claim(
  claimId: string,
  overrides: Partial<ReportClaimReference> = {}
): ReportClaimReference {
  return {
    claimId,
    statement: "该方案在第二季度节省了 12% 成本",
    claimStatus: "supported",
    verdictStatus: "insufficient_evidence",
    verdictConfidence: 0.4,
    ...overrides
  };
}

function evidence(
  evidenceId: string,
  overrides: Partial<ReportEvidenceReference> = {}
): ReportEvidenceReference {
  return {
    evidenceId,
    title: "季度报告节选",
    sourceId: SOURCE_A,
    verificationStatus: "unverified",
    locatorStatus: "anchored",
    ...overrides
  };
}

function source(
  sourceId: string,
  overrides: Partial<ReportSourceReference> = {}
): ReportSourceReference {
  return {
    sourceId,
    snapshotId: SNAPSHOT_A,
    contentHash: "a".repeat(64),
    title: "季度报告",
    retrievedAt: "2026-01-01T00:00:00.000Z",
    present: true,
    ...overrides
  };
}

function review(
  reviewId: string,
  overrides: Partial<ReportReviewReference> = {}
): ReportReviewReference {
  return {
    reviewId,
    claimId: CLAIM_A,
    outcome: "confirmed",
    reviewer: "human:reviewer",
    createdAt: "2026-01-02T00:00:00.000Z",
    ...overrides
  };
}

/** The minimal payload fragments the diff reads. */
function payload(
  overrides: {
    findings?: Array<{ claimId: string; verdict: { rationale: string } }>;
    unresolvedConflicts?: Array<{ conflictId: string }>;
  } = {}
) {
  return {
    sessionId: SESSION_ID,
    materialsFingerprint: "a".repeat(16),
    findings: overrides.findings ?? [],
    gaps: { unresolvedConflicts: overrides.unresolvedConflicts ?? [] }
  };
}

function build(
  overrides: Partial<ResearchReportSnapshot> & {
    reportPayload?: unknown;
  } = {}
): ResearchReportSnapshot {
  return {
    snapshotId: newId(),
    sessionId: SESSION_ID,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "reviewer (alice)",
    researchQuestion: "成本是否下降？",
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    materialsFingerprint: "a".repeat(16),
    snapshotHash: "b".repeat(64),
    reportPayload: payload(),
    sourceReferences: [],
    evidenceReferences: [],
    claimReferences: [],
    reviewReferences: [],
    monitoringReferences: [],
    changeReason: null,
    ...overrides
  };
}

function entriesOf(from: ResearchReportSnapshot, to: ResearchReportSnapshot) {
  return diffReportSnapshots(from, to);
}

describe("report version diff", () => {
  it("reports nothing when two versions hold the same entities", () => {
    const snapshot = build({
      claimReferences: [claim(CLAIM_A)],
      evidenceReferences: [evidence(EVIDENCE_A)],
      sourceReferences: [source(SOURCE_A)]
    });
    const other = build({
      snapshotId: newId(),
      version: 2,
      claimReferences: [claim(CLAIM_A)],
      evidenceReferences: [evidence(EVIDENCE_A)],
      sourceReferences: [source(SOURCE_A)]
    });

    const diff = entriesOf(snapshot, other);
    expect(diff.entries).toEqual([]);
    expect(diff.counts).toEqual({
      added: 0,
      removed: 0,
      changed: 0,
      verdict: 0,
      risk: 0
    });
    expect(diff.fromVersion).toBe(1);
    expect(diff.toVersion).toBe(2);
    expect(diff.fromMaterialsFingerprint).toBe("a".repeat(16));
  });

  it("places an added entity's value on the new side only", () => {
    const from = build();
    const to = build({
      version: 2,
      claimReferences: [claim(CLAIM_A)]
    });

    const diff = entriesOf(from, to);
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]).toMatchObject({
      entityType: "claim",
      entityId: CLAIM_A,
      kind: "added",
      category: "verdict",
      field: null,
      oldValue: null,
      newValue: {
        statement: "该方案在第二季度节省了 12% 成本",
        claimStatus: "supported",
        verdictStatus: "insufficient_evidence",
        verdictConfidence: 0.4
      }
    });
  });

  it("places a removed entity's value on the old side only", () => {
    const from = build({ claimReferences: [claim(CLAIM_A)] });
    const to = build({ version: 2 });

    const diff = entriesOf(from, to);
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]).toMatchObject({
      kind: "removed",
      category: "verdict",
      oldValue: {
        statement: "该方案在第二季度节省了 12% 成本",
        claimStatus: "supported",
        verdictStatus: "insufficient_evidence",
        verdictConfidence: 0.4
      },
      newValue: null
    });
  });

  /**
   * The rule the whole feature is built on: identity is an id.
   *
   * The same sentence recorded twice is two rows, so the comparison must
   * say one disappeared and one appeared. Any "these look alike" logic
   * would quietly turn a removal plus an addition into an edit.
   */
  it("matches by id, never by how alike two statements look", () => {
    const from = build({ claimReferences: [claim(CLAIM_A)] });
    const to = build({
      version: 2,
      claimReferences: [
        claim(CLAIM_B, {
          statement: "该方案在第二季度节省了 12% 成本"
        })
      ]
    });

    const diff = entriesOf(from, to);
    expect(diff.entries.map((entry) => [entry.kind, entry.entityId])).toEqual([
      ["removed", CLAIM_A],
      ["added", CLAIM_B]
    ]);
    expect(diff.entries.every((entry) => entry.kind !== "changed")).toBe(true);
    expect(diff.counts.removed).toBe(1);
    expect(diff.counts.added).toBe(1);
  });

  it("treats a changed verdict as a conclusion change and carries the stored rationale", () => {
    const from = build({
      claimReferences: [claim(CLAIM_A)]
    });
    const to = build({
      version: 2,
      claimReferences: [claim(CLAIM_A, { verdictStatus: "supported", verdictConfidence: 0.8 })],
      reportPayload: payload({
        findings: [
          {
            claimId: CLAIM_A,
            verdict: { rationale: "新增两条已核实支持材料" }
          }
        ]
      })
    });

    const diff = entriesOf(from, to);
    expect(diff.entries).toHaveLength(2);
    const statuses = diff.entries.filter((entry) => entry.field === "verdictStatus");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      entityType: "claim",
      kind: "changed",
      category: "verdict",
      oldValue: "insufficient_evidence",
      newValue: "supported",
      reason: "新增两条已核实支持材料"
    });
    expect(
      diff.entries.filter((entry) => entry.field === "verdictConfidence")
    ).toHaveLength(1);
    expect(diff.counts.verdict).toBe(2);
    expect(diff.counts.risk).toBe(0);
  });

  it("reports verification changes as conclusions and locator changes as currency risk", () => {
    const from = build({ evidenceReferences: [evidence(EVIDENCE_A)] });
    const to = build({
      version: 2,
      evidenceReferences: [
        evidence(EVIDENCE_A, {
          verificationStatus: "verified",
          locatorStatus: "missing"
        })
      ]
    });

    const diff = entriesOf(from, to);
    const verification = diff.entries.find(
      (entry) => entry.field === "verificationStatus"
    );
    const locator = diff.entries.find((entry) => entry.field === "locatorStatus");
    expect(verification?.category).toBe("verdict");
    expect(verification?.oldValue).toBe("unverified");
    expect(verification?.newValue).toBe("verified");
    // Where the quote sits is a re-reading matter, never a re-deciding one.
    expect(locator?.category).toBe("risk");
    expect(locator?.relatedSourceIds).toEqual([SOURCE_A]);
  });

  /**
   * The rule that keeps a moved page from reading like an overturned finding.
   *
   * A source version changing is recorded as `risk` with no reason attached,
   * and produces no `verdict` entry at all: what the new text says is a
   * question for a person, not something a comparison may imply.
   */
  it("never turns a source capture changing into a conclusion changing", () => {
    const oldHash = "a".repeat(64);
    const newHash = "c".repeat(64);
    const from = build({
      materialsFingerprint: "a".repeat(16),
      sourceReferences: [source(SOURCE_A, { contentHash: oldHash })]
    });
    const to = build({
      version: 2,
      materialsFingerprint: "b".repeat(16),
      sourceReferences: [
        source(SOURCE_A, { contentHash: newHash, snapshotId: newId() })
      ]
    });

    const diff = entriesOf(from, to);
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]).toMatchObject({
      entityType: "source",
      entityId: SOURCE_A,
      kind: "changed",
      category: "risk",
      field: "contentHash",
      oldValue: oldHash,
      newValue: newHash,
      reason: null
    });
    expect(diff.counts.verdict).toBe(0);
    expect(diff.counts.risk).toBe(1);
  });

  it("labels a new human ruling and a changed one as conclusion entries", () => {
    const from = build({ reviewReferences: [review(REVIEW_A)] });
    const to = build({
      version: 2,
      reviewReferences: [
        review(REVIEW_A, { outcome: "needs_more_evidence" }),
        review(newId(), {
          outcome: "confirmed",
          createdAt: "2026-01-03T00:00:00.000Z"
        })
      ]
    });

    const diff = entriesOf(from, to);
    const changed = diff.entries.filter((entry) => entry.field === "outcome");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.oldValue).toBe("confirmed");
    expect(changed[0]?.newValue).toBe("needs_more_evidence");
    expect(changed[0]?.changedAt).toBe("2026-01-02T00:00:00.000Z");

    const added = diff.entries.filter((entry) => entry.kind === "added");
    expect(added).toHaveLength(1);
    expect(added[0]?.category).toBe("verdict");
    expect(added[0]?.changedAt).toBe("2026-01-03T00:00:00.000Z");
  });

  it("says only what snapshots can tell about a conflict leaving the open set", () => {
    const from = build({
      reportPayload: payload({
        unresolvedConflicts: [{ conflictId: CONFLICT_A }]
      })
    });
    const to = build({ version: 2 });

    const diff = entriesOf(from, to);
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]).toMatchObject({
      entityType: "conflict",
      entityId: CONFLICT_A,
      category: "verdict",
      field: "awaitingHumanDecision",
      oldValue: true,
      newValue: false
    });
    // The reason names the limit instead of guessing which closure it was.
    expect(diff.entries[0]?.reason).toContain("快照无法进一步区分");
  });

  it("keeps monitoring task changes on the risk axis", () => {
    const from = build({
      monitoringReferences: [{ taskId: TASK_A, sourceId: SOURCE_A, status: "open" }]
    });
    const to = build({
      version: 2,
      monitoringReferences: [
        { taskId: TASK_A, sourceId: SOURCE_A, status: "in_review" },
        { taskId: newId(), sourceId: SOURCE_A, status: "open" }
      ]
    });

    const diff = entriesOf(from, to);
    expect(diff.entries).toHaveLength(2);
    expect(diff.entries.every((entry) => entry.category === "risk")).toBe(true);
    expect(diff.counts.risk).toBe(2);
    expect(diff.counts.verdict).toBe(0);
  });

  it("leaves both versions untouched", () => {
    const from = build({ claimReferences: [claim(CLAIM_A)] });
    const to = build({ version: 2 });
    const before = JSON.stringify({ from, to });

    diffReportSnapshots(from, to);

    expect(JSON.stringify({ from, to })).toBe(before);
  });

  it("orders entries by entity kind, then entity id, then field", () => {
    const from = build({
      claimReferences: [claim(CLAIM_B), claim(CLAIM_A)],
      evidenceReferences: [evidence(EVIDENCE_A)],
      monitoringReferences: [{ taskId: TASK_A, sourceId: SOURCE_A, status: "open" }]
    });
    const to = build({ version: 2 });

    const kinds = diffReportSnapshots(from, to).entries.map(
      (entry) => entry.entityType
    );
    // Grouped by entity kind so a reader sees all claim changes together.
    expect(kinds).toEqual(["claim", "claim", "evidence", "revalidation"]);
  });
});

describe("snapshot payload guard", () => {
  it("refuses a payload written by another report structure version", () => {
    const snapshot = build({
      reportSchemaVersion: REPORT_SCHEMA_VERSION + 1
    });

    expect(() => snapshotPayload(snapshot)).toThrow(ReportPayloadFormatError);
    expect(() => snapshotPayload(snapshot)).toThrow(
      /report schema v2; this build reads v1/
    );
  });

  it("refuses a payload that is not a fact-check report at all", () => {
    expect(() => snapshotPayload(build({ reportPayload: { hello: "there" } }))).toThrow(
      /does not hold a fact-check report payload/
    );
    expect(() => snapshotPayload(build({ reportPayload: null }))).toThrow(
      ReportPayloadFormatError
    );
  });

  it("returns the stored report when the structure matches", () => {
    const snapshot = build({
      reportPayload: payload({
        findings: [{ claimId: CLAIM_A, verdict: { rationale: "理由" } }]
      })
    });

    expect(snapshotPayload(snapshot).sessionId).toBe(SESSION_ID);
    expect(snapshotPayload(snapshot).findings).toHaveLength(1);
  });
});

describe("snapshot hash", () => {
  it("ignores property order at every level", () => {
    const left = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } };
    const right = { a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 };

    expect(hashPayload(left)).toBe(hashPayload(right));
    expect(hashPayload(left)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the content changes", () => {
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });

  it("does not treat an absent optional value as a difference", () => {
    expect(hashPayload({ a: 1, b: undefined })).toBe(hashPayload({ a: 1 }));
  });
});

/**
 * A report built the way the live route builds one, so what the export
 * renders is a real report object rather than a hand-made stand-in.
 */
function liveReport(): FactCheckReport {
  const claim: Claim = ClaimSchema.parse({
    id: CLAIM_A,
    sessionId: SESSION_ID,
    lens: "research",
    statement: "该方案在第二季度节省了 12% 成本",
    type: "fact",
    stance: "support",
    importance: 4,
    confidence: 0.5,
    evidenceIds: [EVIDENCE_A],
    status: "supported",
    rootClaimId: CLAIM_A,
    revision: 1,
    relations: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  });
  const evidence: Evidence = EvidenceSchema.parse({
    id: EVIDENCE_A,
    sessionId: SESSION_ID,
    claimIds: [CLAIM_A],
    kind: "external_reference",
    title: "季度报告节选",
    content: "成本较上季度下降 12%。",
    description: "供应商提供的季度数据。",
    sourceId: SOURCE_A,
    direction: "supports",
    reliability: 0.7,
    verificationStatus: "verified",
    verifiedBy: "Owner (owner)",
    verifiedAt: NOW_ISO,
    verificationNote: "与第 14 页核对一致。",
    retrievedAt: NOW_ISO,
    locatorStatus: "anchored",
    createdBy: "human"
  });
  const source: Source = SourceSchema.parse({
    id: SOURCE_A,
    sessionId: SESSION_ID,
    title: "季度报告",
    kind: "document",
    url: "https://example.org/q4.pdf",
    publisher: "示例统计局",
    createdBy: "human",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  });
  const verdicts = deriveClaimVerdicts([claim], [evidence], { now: NOW });
  return buildFactCheckReport({
    session: {
      id: SESSION_ID,
      researchQuestion: "成本是否下降？",
      phase: "ANALYZING",
      operationalStatus: "ACTIVE",
      currentConclusion: null
    },
    claims: [claim],
    evidence: [evidence],
    sources: [source],
    challenges: [],
    conflicts: [],
    verdicts,
    reviews: [],
    agentRuns: [],
    lastEventSequence: 7,
    generatedAt: NOW_ISO
  });
}

describe("historical export", () => {
  it("carries the version header and says the content is frozen", () => {
    const report = liveReport();
    const snapshot = build({
      version: 3,
      createdBy: "reviewer (alice)",
      changeReason: "补充证据后定稿",
      reportPayload: report
    });
    const markdown = renderSnapshotMarkdown(snapshot, report);

    expect(markdown).toContain("> 历史版本导出");
    expect(markdown).toContain(`> - 快照 ID：${snapshot.snapshotId}`);
    expect(markdown).toContain("> - 版本：v3（报告结构 v1）");
    expect(markdown).toContain(`> - 保存时间：${snapshot.createdAt}`);
    expect(markdown).toContain("> - 保存人：reviewer (alice)");
    expect(markdown).toContain(`> - 材料指纹：${snapshot.materialsFingerprint}`);
    expect(markdown).toContain(`> - 快照哈希：${snapshot.snapshotHash}`);
    expect(markdown).toContain("> - 变更原因：补充证据后定稿");
    expect(markdown).toContain("不包含保存之后的任何变更");
    // The header sits before the report, never merged into it.
    expect(markdown.indexOf("历史版本导出")).toBeLessThan(
      markdown.indexOf("# 事实核查报告")
    );
  });

  it("renders a printable html document that escapes captured text", () => {
    const report = liveReport();
    const snapshot = build({ version: 2, reportPayload: report });
    const html = renderSnapshotHtml(snapshot, report);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("@media print");
    expect(html).toContain("版本 v2");
    expect(html).toContain(snapshot.snapshotHash);
    expect(html).toContain("不包含保存之后的任何变更");
    expect(html).not.toContain("<script>");
  });

  it("produces the same export every time for the same version", () => {
    const report = liveReport();
    const snapshot = build({ version: 4, reportPayload: report });

    expect(renderSnapshotMarkdown(snapshot, report)).toBe(
      renderSnapshotMarkdown(snapshot, report)
    );
    expect(renderSnapshotHtml(snapshot, report)).toBe(
      renderSnapshotHtml(snapshot, report)
    );
  });

  /**
   * Excerpt text comes from a page or a file, so it is untrusted: it must be
   * escaped rather than allowed to become part of the exported document.
   */
  it("escapes captured text instead of letting it become markup", () => {
    const report = liveReport();
    const finding = report.findings[0]!;
    const citation = finding.supporting[0]!;
    const hostile = {
      ...report,
      findings: [
        {
          ...finding,
          supporting: [
            { ...citation, excerpt: "<img src=x onerror=alert(1)>" }
          ]
        }
      ]
    } as FactCheckReport;
    const snapshot = build({ version: 5, reportPayload: hostile });
    const html = renderSnapshotHtml(snapshot, hostile);

    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img");
  });
});
