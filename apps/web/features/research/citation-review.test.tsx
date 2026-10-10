import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Evidence } from "@nexus/shared";

/**
 * The rules of the citation review surface, checked against the real component.
 *
 * Only the data access is faked. What these tests pin down is the part that
 * would be easy to get wrong and hard to notice: that "原文定位" and "是否支持"
 * are rendered as two independent states, that a support reading is never
 * presented as verification, that an unlocated fragment is called out, and that
 * a correction is sent as a correction rather than an edit.
 */

const getCitationReview = vi.fn();
const checkCitations = vi.fn();
const assessClaimSupport = vi.fn();
const correctCitation = vi.fn();
const getCitationHistory = vi.fn();

class CitationReviewFailedError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "CitationReviewFailedError";
  }
}

vi.mock("./api", () => ({
  // The component branches on `instanceof`, so the class has to be real here.
  CitationReviewFailedError,
  getCitationReview: (...args: unknown[]) => getCitationReview(...args),
  checkCitations: (...args: unknown[]) => checkCitations(...args),
  assessClaimSupport: (...args: unknown[]) => assessClaimSupport(...args),
  correctCitation: (...args: unknown[]) => correctCitation(...args),
  getCitationHistory: (...args: unknown[]) => getCitationHistory(...args)
}));

const { CitationReviewPanel } = await import("./citation-review");

const SESSION_ID = "0199e6d0-0000-7000-8000-000000000001";
const EVIDENCE_ID = "0199e6d0-0000-7000-8000-000000000002";
const CLAIM_ID = "0199e6d0-0000-7000-8000-000000000003";
const CHECK_ID = "0199e6d0-0000-7000-8000-000000000004";
const ASSESSMENT_ID = "0199e6d0-0000-7000-8000-000000000005";
const SOURCE_ID = "0199e6d0-0000-7000-8000-000000000006";
const PAGE_TEXT = "Shipments grew 12% year over year.";

function evidence(): Evidence {
  return {
    id: EVIDENCE_ID,
    sessionId: SESSION_ID,
    claimIds: [CLAIM_ID],
    kind: "external_reference",
    title: "Annual report",
    content: PAGE_TEXT,
    description: "quoted",
    sourceId: SOURCE_ID,
    locator: "第 1 段",
    locatorKind: "quote",
    locatorStatus: "anchored",
    anchorText: PAGE_TEXT,
    sourceContentHash: "hash-1",
    direction: "supports",
    reliability: 0.8,
    verificationStatus: "unverified",
    retrievedAt: "2026-10-01T00:00:00.000Z",
    createdBy: "human"
  } as Evidence;
}

function snapshot() {
  return {
    checks: [
      {
        id: CHECK_ID,
        sessionId: SESSION_ID,
        evidenceId: EVIDENCE_ID,
        sourceId: SOURCE_ID,
        snapshotId: "0199e6d0-0000-7000-8000-000000000007",
        status: "stale" as const,
        matchKind: "exact" as const,
        anchorText: PAGE_TEXT,
        expectedContentHash: "hash-0",
        snapshotContentHash: "hash-1",
        matchedText: PAGE_TEXT,
        contextText: `… ${PAGE_TEXT} …`,
        reason: "摘录仍能在当前原文中找到，但快照版本已变化。",
        origin: "system" as const,
        actor: "Researcher One (researcher)",
        supersedesId: null,
        isCurrent: true,
        createdAt: "2026-10-01T00:00:00.000Z"
      }
    ],
    assessments: [
      {
        id: ASSESSMENT_ID,
        sessionId: SESSION_ID,
        claimId: CLAIM_ID,
        evidenceId: EVIDENCE_ID,
        status: "oppose" as const,
        confidence: 0.55,
        rationale: "The excerpt quotes a different period.",
        matchedExcerpt: "Shipments grew 12% year over year.",
        matchedExcerptLocated: false,
        signals: ["日期不一致"],
        provider: "FakeProvider",
        model: "fake-model",
        promptVersion: "citation-review-v1",
        origin: "model" as const,
        actor: "Researcher One (researcher)",
        supersedesId: null,
        isCurrent: true,
        createdAt: "2026-10-01T00:00:00.000Z"
      }
    ],
    summaries: [
      {
        claimId: CLAIM_ID,
        status: "oppose" as const,
        counts: {
          support: 0,
          oppose: 1,
          context: 0,
          insufficient: 0,
          ambiguous: 0
        },
        unlocatedCount: 1,
        note: "1 条摘录与该主张相反。",
        assessmentIds: [ASSESSMENT_ID]
      }
    ]
  };
}

function renderPanel() {
  return render(
    <CitationReviewPanel
      sessionId={SESSION_ID}
      evidence={[evidence()]}
      claims={[{ id: CLAIM_ID, statement: PAGE_TEXT }]}
      sourcesById={new Map([[SOURCE_ID, { id: SOURCE_ID, title: "Annual report" }]])}
      canEdit
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getCitationReview.mockResolvedValue(snapshot());
  checkCitations.mockResolvedValue({ checks: snapshot().checks, event: {} });
  assessClaimSupport.mockResolvedValue({
    assessments: snapshot().assessments,
    summary: snapshot().summaries[0],
    event: {}
  });
  correctCitation.mockResolvedValue({ event: {} });
  getCitationHistory.mockResolvedValue({ kind: "integrity", items: [] });
});

afterEach(() => {
  cleanup();
});

describe("CitationReviewPanel", () => {
  it("shows the two states as separate pills", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("citation-review")).toBeTruthy()
    );

    // Layer A: where the quote stands as text.
    expect(screen.getByTestId(`integrity-pill-${EVIDENCE_ID}`).textContent).toContain(
      "原文定位"
    );
    expect(screen.getByTestId(`integrity-pill-${EVIDENCE_ID}`).textContent).toContain(
      "快照版本已变，需重确认"
    );
    // Layer B: whether it bears on the claim.
    expect(screen.getByTestId(`support-pill-${EVIDENCE_ID}`).textContent).toContain(
      "是否支持"
    );
    expect(screen.getByTestId(`support-pill-${EVIDENCE_ID}`).textContent).toContain(
      "反对该主张"
    );
  });

  it("keeps the excerpt's own verification state out of the assessment", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("citation-review")).toBeTruthy());
    const row = screen.getAllByTestId("citation-row")[0]!;
    // The excerpt is `unverified`, and nothing the model said changes that.
    expect(row.textContent).toContain("待核实");
    expect(row.textContent).not.toContain("已核实");
  });

  it("calls out a fragment the server could not locate", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("citation-review")).toBeTruthy());
    const row = screen.getAllByTestId("citation-row")[0]!;
    expect(row.textContent).toContain("服务端未能在原文中找到");
  });

  it("says that a support assessment is advice, not verification", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("citation-review")).toBeTruthy());
    expect(screen.getByTestId("citation-review").textContent).toContain(
      "它不会把任何摘录标记为已核实"
    );
  });

  it("sends a correction as a correction, with the target and the reason", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("citation-review")).toBeTruthy());

    fireEvent.click(screen.getByTestId(`correct-integrity-${EVIDENCE_ID}`));
    fireEvent.change(screen.getByTestId("correction-status"), {
      target: { value: "anchored" }
    });
    fireEvent.change(screen.getByTestId("correction-rationale"), {
      target: { value: "I re-read the live page and the wording is unchanged." }
    });
    fireEvent.click(screen.getByTestId("correction-submit"));

    await waitFor(() => expect(correctCitation).toHaveBeenCalledTimes(1));
    expect(correctCitation).toHaveBeenCalledWith(SESSION_ID, {
      kind: "integrity",
      targetId: CHECK_ID,
      status: "anchored",
      rationale: "I re-read the live page and the wording is unchanged."
    });
  });

  it("refuses a correction without a reason long enough to audit", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("citation-review")).toBeTruthy());

    fireEvent.click(screen.getByTestId(`correct-integrity-${EVIDENCE_ID}`));
    fireEvent.change(screen.getByTestId("correction-rationale"), {
      target: { value: "fixed" }
    });
    fireEvent.click(screen.getByTestId("correction-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("citation-notice").textContent).toContain(
        "至少 10 个字"
      )
    );
    expect(correctCitation).not.toHaveBeenCalled();
  });

  it("offers support statuses only when correcting a support assessment", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("citation-review")).toBeTruthy());

    fireEvent.click(screen.getByTestId(`correct-support-${ASSESSMENT_ID}`));
    const options = Array.from(
      screen.getByTestId("correction-status").querySelectorAll("option")
    ).map((option) => option.textContent);
    expect(options).toContain("支持该主张");
    expect(options).not.toContain("原文可定位");
  });

  it("shows the failure code when the model is unavailable", async () => {
    assessClaimSupport.mockRejectedValueOnce(
      new CitationReviewFailedError("no provider", "provider_unavailable")
    );
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("citation-review")).toBeTruthy());

    fireEvent.click(screen.getByTestId(`assess-support-${CLAIM_ID}`));
    await waitFor(() =>
      expect(screen.getByTestId("citation-error").textContent).toContain(
        "模型不可用"
      )
    );
  });

  it("does not offer to change anything to a viewer", async () => {
    render(
      <CitationReviewPanel
        sessionId={SESSION_ID}
        evidence={[evidence()]}
        claims={[{ id: CLAIM_ID, statement: PAGE_TEXT }]}
        sourcesById={new Map()}
        canEdit={false}
      />
    );
    await waitFor(() => expect(screen.getByTestId("citation-review")).toBeTruthy());
    expect(screen.queryByTestId("check-citations")).toBeNull();
    expect(screen.queryByTestId(`correct-integrity-${EVIDENCE_ID}`)).toBeNull();
  });
});
