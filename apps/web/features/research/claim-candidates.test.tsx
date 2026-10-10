import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClaimCandidate,
  ClaimExtractionResult,
  EvidenceCandidate
} from "./api";

/**
 * The rules of the review surface, checked against the real component.
 *
 * Only the data access is faked; the component, its state and the exact
 * endpoints it calls are the real thing. What these tests pin down is the part
 * that would be easy to get wrong and hard to notice: that an edited statement
 * is what actually gets written, that acceptance goes through the ordinary claim
 * and evidence endpoints, and that rejection writes nothing at all.
 */

const extractClaims = vi.fn();
const listExtractionRuns = vi.fn();
const getExtractionRun = vi.fn();
const getSourceDetail = vi.fn();
const recordCandidateDecisions = vi.fn();
const acceptClaimCandidate = vi.fn();

vi.mock("./api", () => ({
  // `AnalysisFailedError` has to come through: the component branches on
  // `instanceof` it to keep the machine-readable failure code. A mock that
  // leaves it undefined would turn every failure into a TypeError.
  AnalysisFailedError: class AnalysisFailedError extends Error {
    constructor(
      message: string,
      readonly code?: string
    ) {
      super(message);
      this.name = "AnalysisFailedError";
    }
  },
  acceptEvidenceCandidate: vi.fn(),
  extractClaims: (...args: unknown[]) => extractClaims(...args),
  listExtractionRuns: (...args: unknown[]) => listExtractionRuns(...args),
  getExtractionRun: (...args: unknown[]) => getExtractionRun(...args),
  getSourceDetail: (...args: unknown[]) => getSourceDetail(...args),
  recordCandidateDecisions: (...args: unknown[]) =>
    recordCandidateDecisions(...args),
  acceptClaimCandidate: (...args: unknown[]) => acceptClaimCandidate(...args)
}));

const { ClaimCandidatesPanel } = await import("./claim-candidates");

const SESSION_ID = "0199e6d0-0000-7000-8000-000000000001";
const SOURCE_ID = "0199e6d0-0000-7000-8000-000000000002";
const RUN_ID = "0199e6d0-0000-7000-8000-000000000003";
const CLAIM_CANDIDATE_ID = "0199e6d0-0000-7000-8000-000000000004";
const EVIDENCE_CANDIDATE_ID = "0199e6d0-0000-7000-8000-000000000005";
const PAGE_TEXT = "Shipments grew 12% year over year in this quarter.";

function candidate(): ClaimCandidate {
  return {
    id: CLAIM_CANDIDATE_ID,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    sourceId: SOURCE_ID,
    snapshotId: "0199e6d0-0000-7000-8000-000000000006",
    segmentIndex: 0,
    statement: "Shipments grew 12% year over year.",
    type: "fact",
    qualifiers: ["year over year"],
    uncertainty: [],
    rationale: "Stated plainly in the page.",
    suggestedImportance: 3,
    status: "proposed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function evidenceCandidate(): EvidenceCandidate {
  return {
    id: EVIDENCE_CANDIDATE_ID,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    sourceId: SOURCE_ID,
    snapshotId: "0199e6d0-0000-7000-8000-000000000006",
    segmentIndex: 0,
    claimCandidateId: CLAIM_CANDIDATE_ID,
    excerpt: PAGE_TEXT,
    title: "Growth",
    direction: "supports",
    locatorKind: "quote",
    locatorStatus: "anchored",
    locator: "第 1 段 · 第 1 句",
    anchorText: PAGE_TEXT,
    sourceContentHash: "hash-1",
    suggestedReliability: 0.5,
    rationale: "Same sentence.",
    uncertainty: [],
    status: "proposed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function result(): ClaimExtractionResult {
  return {
    run: {
      id: RUN_ID,
      sessionId: SESSION_ID,
      sourceId: SOURCE_ID,
      snapshotId: "0199e6d0-0000-7000-8000-000000000006",
      status: "succeeded",
      provider: "DeterministicExtractionProvider",
      model: "clause-splitter-fixtures",
      inputHash: "hash-in",
      promptVersion: "claim-extraction-v1",
      segmentationVersion: "paragraph-v1",
      charCount: PAGE_TEXT.length,
      segmentCount: 1,
      candidateClaimCount: 1,
      candidateEvidenceCount: 1,
      anchorMatched: 1,
      anchorMissing: 0,
      attempt: 1,
      correlationId: RUN_ID,
      createdBy: "Owner (owner)",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    claimCandidates: [candidate()],
    evidenceCandidates: [evidenceCandidate()],
    reused: false
  };
}

function mount() {
  return render(
    <ClaimCandidatesPanel
      sessionId={SESSION_ID}
      sourceId={SOURCE_ID}
      sourceTitle="Quarterly report"
      claims={[]}
      canEdit
      onClose={() => undefined}
      onChanged={async () => undefined}
    />
  );
}

// Vitest runs this project without globals, so testing-library's automatic
// cleanup never registers — without this, every test would see the previous
// one's DOM too.
afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
  getSourceDetail.mockResolvedValue({
    source: { id: SOURCE_ID, title: "Quarterly report" },
    snapshots: [
      {
        id: "0199e6d0-0000-7000-8000-000000000006",
        content: PAGE_TEXT,
        contentHash: "hash-1",
        charCount: PAGE_TEXT.length
      }
    ],
    excerpts: [],
    currentSnapshotId: "0199e6d0-0000-7000-8000-000000000006"
  } as never);
  // An analysis already exists, so the panel loads it on mount the way a
  // revisit or a refresh would.
  listExtractionRuns.mockResolvedValue({ runs: [result().run] });
  extractClaims.mockResolvedValue(result());
  getExtractionRun.mockResolvedValue(result());
  recordCandidateDecisions.mockResolvedValue(result());
  acceptClaimCandidate.mockResolvedValue({
    claimId: "0199e6d0-0000-7000-8000-000000000007",
    evidenceIds: ["0199e6d0-0000-7000-8000-000000000008"],
    verificationStatuses: ["unverified"]
  } as never);
});

describe("ClaimCandidatesPanel", () => {
  it("states the contract before anything can be accepted", async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("claim-candidates")).toBeTruthy()
    );
    expect(screen.getByTestId("claim-candidates").textContent).toContain(
      "候选不会进入任何结论或统计"
    );
    expect(screen.getByTestId("claim-candidates").textContent).toContain(
      "仍然是未核实"
    );
  });

  it("writes the statement the researcher edited, not the one proposed", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("candidate-list")).toBeTruthy());

    fireEvent.click(screen.getByTestId("analyze-source"));
    await waitFor(() =>
      expect(screen.getByTestId("candidate-list")).toBeTruthy()
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const textarea = screen.getByLabelText("编辑主张内容");
    fireEvent.change(textarea, {
      target: { value: "Shipments grew 12%, but only in Europe." }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() =>
      expect(screen.getByTestId("candidate-list").textContent).toContain(
        "Shipments grew 12%, but only in Europe."
      )
    );

    fireEvent.click(screen.getByTestId("accept-candidate"));
    await waitFor(() => expect(acceptClaimCandidate).toHaveBeenCalledTimes(1));

    // The whole point of editing: the qualifier the researcher added is what
    // reaches the domain, not the sentence the model first proposed.
    expect(acceptClaimCandidate.mock.calls[0]![0]).toMatchObject({
      statement: "Shipments grew 12%, but only in Europe."
    });
  });

  it("sends acceptance through the ordinary claim and evidence endpoints", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("candidate-list")).toBeTruthy());
    fireEvent.click(screen.getByTestId("accept-candidate"));

    await waitFor(() => expect(acceptClaimCandidate).toHaveBeenCalledTimes(1));
    // The ruling is recorded only after the rows exist, and only as a link.
    await waitFor(() => expect(recordCandidateDecisions).toHaveBeenCalledTimes(1));
    const [, , decisions] = recordCandidateDecisions.mock.calls[0] as unknown as [
      string,
      string,
      Array<Record<string, unknown>>
    ];
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "claim", status: "accepted" }),
        expect.objectContaining({ kind: "evidence", status: "accepted" })
      ])
    );
  });

  it("rejects without creating anything, and says so", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("candidate-list")).toBeTruthy());
    fireEvent.click(screen.getByTestId("reject-candidate"));

    await waitFor(() => expect(recordCandidateDecisions).toHaveBeenCalledTimes(1));
    expect(acceptClaimCandidate).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("candidate-notice").textContent).toContain(
        "没有写入任何主张或证据"
      )
    );
  });

  it("reports a failure with something to do next", async () => {
    const { AnalysisFailedError } = await import("./api");
    extractClaims.mockRejectedValue(
      new AnalysisFailedError("模型响应超时", "timeout")
    );
    mount();
    await waitFor(() => expect(screen.getByTestId("candidate-list")).toBeTruthy());
    fireEvent.click(screen.getByTestId("analyze-source"));

    await waitFor(() =>
      expect(screen.getByTestId("analysis-error").textContent).toContain(
        "模型响应超时"
      )
    );
    // A timeout is retryable, so the retry has to be offered rather than
    // leaving the researcher at a dead end.
    expect(screen.getByTestId("retry-analysis")).toBeTruthy();
  });

  it("highlights the proposed excerpt inside the stored page text", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("candidate-list")).toBeTruthy());
    const compare = screen.getByTestId("candidate-source-compare");
    expect(compare.querySelector("mark")).not.toBeNull();
    expect(compare.textContent).toContain("Shipments grew 12%");
  });

  it("tells the researcher the engine is fixtures, not a model", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("candidate-list")).toBeTruthy());
    expect(screen.getByTestId("analysis-provider-note").textContent).toContain(
      "不是真实模型"
    );
  });
});
