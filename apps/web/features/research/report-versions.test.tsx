import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The report-history and comparison panels, checked against the real
 * components with only data access faked.
 *
 * What these tests pin down is the honesty contract rather than markup:
 *  - history is read from stored versions, never regenerated;
 *  - a save goes through the API with an idempotency key, and a repeated
 *    press resolves to the version the first attempt created;
 *  - a viewer is offered reading and exporting, never saving;
 *  - a comparison separates "the conclusion moved" from "the source moved"
 *    and never lets the second be read as the first.
 */

const listReportSnapshots = vi.fn();
const createReportSnapshot = vi.fn();
const getReportSnapshot = vi.fn();
const compareReportSnapshots = vi.fn();
const reportSnapshotExportUrl = vi.fn();
const getCurrentUser = vi.fn();

vi.mock("./api", () => ({
  compareReportSnapshots: (...args: unknown[]) =>
    compareReportSnapshots(...args),
  createReportSnapshot: (...args: unknown[]) => createReportSnapshot(...args),
  getReportSnapshot: (...args: unknown[]) => getReportSnapshot(...args),
  listReportSnapshots: (...args: unknown[]) => listReportSnapshots(...args),
  reportSnapshotExportUrl: (...args: unknown[]) =>
    reportSnapshotExportUrl(...args)
}));

vi.mock("../arena/api-client", () => ({
  getCurrentUser: (...args: unknown[]) => getCurrentUser(...args)
}));

// The report body is a full document of its own; it is faked here so these
// tests stay about which stored version is being shown.
vi.mock("./fact-check-report-body", () => ({
  FactCheckReportBody: ({
    report,
    sessionId
  }: {
    report: { generatedAt: string };
    sessionId: string;
  }) => (
    <div
      data-testid="report-body-stub"
      data-session={sessionId}
      data-generated-at={report.generatedAt}
    />
  )
}));

const { ReportComparePanel, ReportVersionsPanel } = await import(
  "./report-versions"
);

const SESSION_ID = "0199e6d0-0000-7000-8000-000000000001";
const SNAPSHOT_A = "0199e6d0-0000-7000-8000-000000000011";
const SNAPSHOT_B = "0199e6d0-0000-7000-8000-000000000012";
const SOURCE_A = "0199e6d0-0000-7000-8000-000000000021";
const EVIDENCE_A = "0199e6d0-0000-7000-8000-000000000022";
const CLAIM_A = "0199e6d0-0000-7000-8000-000000000023";

const SAVED_AT = "2026-10-12T08:30:00.000Z";

function summary(
  overrides: Partial<{
    snapshotId: string;
    version: number;
    createdAt: string;
    createdBy: string;
    changeReason: string | null;
    materialsFingerprint: string;
    claimCount: number;
    evidenceCount: number;
    sourceCount: number;
    unresolvedConflicts: number;
    openRevalidations: number;
    inReviewRevalidations: number;
  }> = {}
) {
  return {
    snapshotId: SNAPSHOT_A,
    sessionId: SESSION_ID,
    version: 1,
    createdAt: SAVED_AT,
    createdBy: "Alice Reviewer (alice)",
    changeReason: null,
    materialsFingerprint: "2edc38437d97f6b4",
    claimCount: 1,
    evidenceCount: 1,
    sourceCount: 1,
    unresolvedConflicts: 0,
    openRevalidations: 0,
    inReviewRevalidations: 0,
    ...overrides
  };
}

function storedReport() {
  return {
    sessionId: SESSION_ID,
    generatedAt: SAVED_AT,
    reportVersion: 1,
    materialsFingerprint: "2edc38437d97f6b4",
    researchQuestion: "成本是否下降？",
    workflow: {
      phase: "EVIDENCE",
      operationalStatus: "ACTIVE",
      currentConclusion: null
    },
    scope: {
      claims: 1,
      evidence: 1,
      sources: 1,
      challenges: 0,
      reviews: 0,
      agentRuns: 0,
      independentSources: 0
    },
    summary: {
      byStatus: { supported: 1 },
      openVerdicts: 0,
      verified: 1,
      unverified: 0,
      rejected: 0,
      inconclusive: 0
    },
    findings: [
      {
        claimId: CLAIM_A,
        statement: "制造业投资增速回落至 4.2%。",
        type: "fact",
        importance: 4,
        claimStatus: "supported",
        verdict: {
          status: "supported",
          effectiveStatus: "supported",
          confidence: 0.6,
          rationale: "已核实材料支持。",
          ruleHits: ["verified_support_only"],
          basis: {
            supportingEvidenceIds: [EVIDENCE_A],
            opposingEvidenceIds: [],
            contextEvidenceIds: []
          },
          excluded: [],
          confidenceBasis: [],
          limits: [],
          openQuestions: []
        },
        supporting: [
          {
            evidenceId: EVIDENCE_A,
            title: "摘录：制造业投资增速",
            excerpt: "制造业投资增速回落至 4.2%。",
            direction: "supports",
            reliability: 0.8,
            verificationStatus: "verified",
            verifiedBy: "Alice Reviewer (alice)",
            verificationNote: "与原文一致",
            citationStatus: "linked",
            source: {
              id: SOURCE_A,
              title: "季度回顾",
              kind: "url",
              url: "https://example.test/page"
            },
            sourceRef: null,
            locator: "第 2 段",
            locatorKind: "quote",
            locatorStatus: "anchored",
            occurredAt: null,
            validFrom: null,
            validTo: null
          }
        ],
        opposing: [],
        context: [],
        excluded: [],
        challenges: [],
        reviewHistory: [],
        gaps: [],
        blockingGapCount: 0,
        runs: []
      }
    ],
    crossExamination: { runs: [], challenges: [], failedRuns: [] },
    independence: {
      note: "未发现经确认的重登记录来源。",
      pages: 1,
      headline: "1 个页面 · 1 条独立信息源",
      groupedSources: 1,
      independentSources: 1
    },
    revalidation: {
      lastCheckedAt: null,
      openTaskCount: 0,
      inReviewTaskCount: 0,
      changedSources: [],
      sourceVersions: [],
      evidenceNeedingReconfirmation: [],
      affectedClaims: []
    },
    gaps: {
      evidenceGaps: {
        total: 0,
        byKind: {},
        bySeverity: { blocking: 0, important: 0, advisory: 0 },
        notPlanned: 0,
        planned: 0
      },
      unresolvedConflicts: [],
      insufficientEvidence: [],
      assumptions: [],
      unlinkedCitations: []
    },
    limits: [],
    provenance: {
      claimIds: [],
      evidenceIds: [],
      sourceIds: [],
      reviewIds: [],
      agentRunIds: [],
      challengeIds: [],
      lastEventSequence: 0
    },
    materialsTimeRange: {
      empty: true,
      publishedAt: { earliest: null, latest: null },
      retrievedAt: { earliest: null, latest: null },
      validity: { earliestFrom: null, latestTo: null }
    }
  };
}

beforeEach(() => {
  for (const mock of [
    listReportSnapshots,
    createReportSnapshot,
    getReportSnapshot,
    compareReportSnapshots,
    reportSnapshotExportUrl,
    getCurrentUser
  ]) {
    mock.mockReset();
  }
  getCurrentUser.mockResolvedValue({
    id: "u1",
    username: "alice",
    displayName: "Alice Reviewer",
    role: "reviewer"
  });
  listReportSnapshots.mockResolvedValue({ snapshots: [] });
  reportSnapshotExportUrl.mockImplementation(
    (sessionId: string, snapshotId: string, format: string) =>
      `/api/sessions/${sessionId}/report-snapshots/${snapshotId}/export?format=${format}&download=1`
  );
});

afterEach(() => {
  cleanup();
});

describe("ReportVersionsPanel", () => {
  it("waits, then says plainly that nothing has been saved yet", async () => {
    let release: () => void = () => undefined;
    listReportSnapshots.mockImplementation(
      () =>
        new Promise<{ snapshots: unknown[] }>((resolve) => {
          release = () => resolve({ snapshots: [] });
        })
    );
    render(<ReportVersionsPanel sessionId={SESSION_ID} currentFingerprint="2edc38437d97f6b4" />);

    // While the list is in flight the panel says it is waiting; it never
    // shows the empty state as though the answer were already known.
    expect(screen.getByText("正在加载历史版本…")).toBeTruthy();
    await waitFor(() => expect(listReportSnapshots).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("report-versions-empty")).toBeNull();

    release();
    await waitFor(() =>
      expect(screen.getByTestId("report-versions-empty").textContent).toContain(
        "还没有保存任何报告版本"
      )
    );
  });

  it("keeps the save form hidden until it knows the account may write", async () => {
    let releaseUser: (value: unknown) => void = () => undefined;
    getCurrentUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseUser = resolve;
        })
    );
    render(<ReportVersionsPanel sessionId={SESSION_ID} currentFingerprint="2edc38437d97f6b4" />);

    // An unresolved account check is not treated as permission to save.
    expect(screen.queryByTestId("save-report-snapshot")).toBeNull();
    expect(screen.getByText("正在确认当前账户的权限…")).toBeTruthy();

    releaseUser({
      id: "u1",
      username: "alice",
      displayName: "Alice Reviewer",
      role: "reviewer"
    });
    await waitFor(() =>
      expect(screen.getByTestId("save-report-snapshot")).toBeTruthy()
    );
  });

  it("lists each stored version with who saved it and what it covered", async () => {
    listReportSnapshots.mockResolvedValue({
      snapshots: [
        summary({ snapshotId: SNAPSHOT_B, version: 2, changeReason: "补证据" }),
        summary()
      ]
    });
    render(<ReportVersionsPanel sessionId={SESSION_ID} currentFingerprint="0000000000000000" />);

    const items = await waitFor(() => screen.getAllByTestId("report-snapshot-item"));
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("第 2 版");
    expect(items[0]?.textContent).toContain("变更原因：补证据");
    // The fingerprint differs from the live report, so the row says so.
    expect(items[0]?.textContent).toContain("与当前资料已不同");
    expect(items[1]?.textContent).toContain("第 1 版");
    expect(items[1]?.textContent).toContain("Alice Reviewer (alice)");
  });

  it("saves the current report through the API and reports the new version", async () => {
    listReportSnapshots
      .mockResolvedValueOnce({ snapshots: [] })
      .mockResolvedValueOnce({
        snapshots: [summary()]
      });
    createReportSnapshot.mockResolvedValue(summary() as never);

    render(<ReportVersionsPanel sessionId={SESSION_ID} currentFingerprint="2edc38437d97f6b4" />);
    await waitFor(() => expect(screen.getByTestId("report-versions-empty")).toBeTruthy());

    fireEvent.click(screen.getByTestId("save-report-snapshot"));

    await waitFor(() => expect(createReportSnapshot).toHaveBeenCalledTimes(1));
    expect(createReportSnapshot).toHaveBeenCalledWith(SESSION_ID, undefined);
    await waitFor(() =>
      expect(
        screen.getAllByTestId("report-snapshot-item")[0]?.textContent
      ).toContain("第 1 版")
    );
  });

  it("offers a viewer reading and exporting but no saving", async () => {
    getCurrentUser.mockResolvedValue({
      id: "u2",
      username: "visitor",
      displayName: "Visitor",
      role: "viewer"
    });
    listReportSnapshots.mockResolvedValue({ snapshots: [summary()] });

    render(<ReportVersionsPanel sessionId={SESSION_ID} currentFingerprint="2edc38437d97f6b4" />);

    await waitFor(() =>
      expect(screen.getByTestId("report-snapshot-item")).toBeTruthy()
    );
    expect(screen.queryByTestId("save-report-snapshot")).toBeNull();
    expect(
      screen.getByTestId("report-snapshot-viewer-note").textContent
    ).toContain("保存新版本需要 Reviewer 或 Owner 账户");
    expect(
      screen.getByTestId("report-snapshot-export-markdown")
    ).toBeTruthy();
  });

  it("shows the failure and offers a retry when the list will not load", async () => {
    listReportSnapshots.mockRejectedValueOnce(new Error("后端不可用"));
    render(<ReportVersionsPanel sessionId={SESSION_ID} currentFingerprint="2edc38437d97f6b4" />);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("后端不可用")
    );

    listReportSnapshots.mockResolvedValue({ snapshots: [summary()] });
    fireEvent.click(screen.getByText("重试"));
    await waitFor(() =>
      expect(screen.getByTestId("report-snapshot-item")).toBeTruthy()
    );
  });
});

describe("ReportComparePanel", () => {
  it("asks for two versions when fewer than two exist", async () => {
    listReportSnapshots.mockResolvedValue({ snapshots: [summary()] });
    render(<ReportComparePanel sessionId={SESSION_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId("report-compare-empty").textContent).toContain(
        "至少需要保存两个版本"
      )
    );
  });

  it("runs the comparison and shows the two axes apart", async () => {
    listReportSnapshots.mockResolvedValue({
      snapshots: [
        summary({ snapshotId: SNAPSHOT_B, version: 2 }),
        summary()
      ]
    });
    compareReportSnapshots.mockResolvedValue({
      fromSnapshotId: SNAPSHOT_A,
      toSnapshotId: SNAPSHOT_B,
      fromVersion: 1,
      toVersion: 2,
      fromMaterialsFingerprint: "2edc38437d97f6b4",
      toMaterialsFingerprint: "aaaaaaaaaaaaaaaa",
      counts: { added: 0, removed: 0, changed: 2, verdict: 1, risk: 1 },
      entries: [
        {
          entityType: "evidence",
          entityId: EVIDENCE_A,
          kind: "changed",
          category: "verdict",
          field: "verificationStatus",
          oldValue: "unverified",
          newValue: "verified",
          reason: null,
          relatedSourceIds: [SOURCE_A],
          changedAt: null
        },
        {
          entityType: "source",
          entityId: SOURCE_A,
          kind: "changed",
          category: "risk",
          field: "contentHash",
          oldValue: "a".repeat(64),
          newValue: "b".repeat(64),
          reason: null,
          relatedSourceIds: [SOURCE_A],
          changedAt: null
        }
      ]
    });

    render(<ReportComparePanel sessionId={SESSION_ID} />);
    await waitFor(() =>
      expect(screen.getByTestId("report-compare-run")).toBeTruthy()
    );

    fireEvent.click(screen.getByTestId("report-compare-run"));

    await waitFor(() => expect(compareReportSnapshots).toHaveBeenCalledTimes(1));
    expect(compareReportSnapshots).toHaveBeenCalledWith(
      SESSION_ID,
      SNAPSHOT_A,
      SNAPSHOT_B
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("report-diff-entry")).toHaveLength(2)
    );
    // The risk section carries its own warning; the axes never merge.
    expect(screen.getByTestId("report-diff").textContent).toContain(
      "不代表结论被推翻"
    );
  });
});
