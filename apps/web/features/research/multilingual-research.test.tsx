import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rules of the multilingual surface, checked against the real component.
 *
 * Only data access is faked. What these tests pin down is the honesty contract:
 * the original text is always shown and stays the anchor; a machine translation
 * is labelled as auxiliary and never as a substitute; when no provider is
 * available the panel says so instead of fabricating a translation; and fidelity
 * findings are marked as rule-based suggestions, never proven errors.
 */

const getSourceDetail = vi.fn();
const getSourceLanguages = vi.fn();
const listTerminology = vi.fn();
const createSnapshotTranslation = vi.fn();
const upsertTerminology = vi.fn();

class TranslationFailedError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "TranslationFailedError";
  }
}

vi.mock("./api", () => ({
  getSourceDetail: (...args: unknown[]) => getSourceDetail(...args),
  getSourceLanguages: (...args: unknown[]) => getSourceLanguages(...args),
  listTerminology: (...args: unknown[]) => listTerminology(...args),
  createSnapshotTranslation: (...args: unknown[]) => createSnapshotTranslation(...args),
  upsertTerminology: (...args: unknown[]) => upsertTerminology(...args),
  TranslationFailedError
}));

const { MultilingualResearchPanel } = await import("./multilingual-research");

const SESSION_ID = "0199e6d0-0000-7000-8000-000000000001";
const SOURCE_ID = "0199e6d0-0000-7000-8000-000000000002";
const SNAPSHOT_ID = "0199e6d0-0000-7000-8000-000000000003";
const TRANSLATION_ID = "0199e6d0-0000-7000-8000-000000000004";

function detailFixture() {
  return {
    source: { id: SOURCE_ID },
    snapshots: [
      {
        id: SNAPSHOT_ID,
        content: "Revenue decreased by 12%.",
        sourceLanguage: "en"
      }
    ],
    excerpts: [],
    currentSnapshotId: SNAPSHOT_ID
  } as unknown as Awaited<ReturnType<typeof getSourceDetail>>;
}

function languageFixture() {
  return {
    sourceId: SOURCE_ID,
    sourceSnapshotId: SNAPSHOT_ID,
    detection: {
      languageCode: "en",
      confidence: "high",
      method: "heuristic",
      detectedAt: "2026-10-14T00:00:00.000Z",
      status: "detected"
    },
    storedSourceLanguage: null
  } as unknown as Awaited<ReturnType<typeof getSourceLanguages>>;
}

function completedTranslation() {
  return {
    translation: {
      translationId: TRANSLATION_ID,
      sessionId: SESSION_ID,
      sourceSnapshotId: SNAPSHOT_ID,
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      textHash: "hash",
      translatedText: "收入下降了 12%。",
      segmentMappings: [],
      provider: "deterministic-mock",
      model: "deterministic-mock-v1",
      status: "completed",
      createdAt: "2026-10-14T00:00:00.000Z"
    },
    fidelity: {
      translationId: TRANSLATION_ID,
      assessedAt: "2026-10-14T00:00:00.000Z",
      method: "rule-based",
      findings: [
        {
          dimension: "comparison",
          originalSnippet: "decreased",
          translatedSnippet: "下降",
          riskType: "direction-conflict",
          basis: "比较方向疑似反转。",
          reviewStatus: "pending",
          heuristic: true
        }
      ]
    }
  };
}

beforeEach(() => {
  getSourceDetail.mockResolvedValue(detailFixture());
  getSourceLanguages.mockResolvedValue(languageFixture());
  listTerminology.mockResolvedValue({ entries: [] });
  createSnapshotTranslation.mockReset();
  upsertTerminology.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MultilingualResearchPanel", () => {
  it("always shows the original text and the detected language", async () => {
    render(<MultilingualResearchPanel sessionId={SESSION_ID} sourceId={SOURCE_ID} />);
    await waitFor(() => expect(screen.getByTestId("ml-original")).toBeTruthy());
    expect(screen.getByTestId("ml-original").textContent).toContain("Revenue decreased by 12%.");
    expect(screen.getByTestId("ml-detection").textContent).toContain("英语");
    // No translation yet -> the auxiliary pane says so rather than inventing one.
    expect(screen.getByTestId("ml-translation").textContent).toContain("尚未翻译");
  });

  it("says the provider is unavailable instead of fabricating a translation", async () => {
    createSnapshotTranslation.mockRejectedValue(
      new TranslationFailedError("No translation provider is configured.", "provider_unavailable")
    );
    render(<MultilingualResearchPanel sessionId={SESSION_ID} sourceId={SOURCE_ID} />);
    await waitFor(() => expect(screen.getByTestId("ml-translate")).toBeTruthy());
    fireEvent.click(screen.getByTestId("ml-translate"));
    await waitFor(() => expect(screen.getByTestId("ml-unavailable")).toBeTruthy());
    // The original stays readable; no fake translation appears.
    expect(screen.getByTestId("ml-original").textContent).toContain("Revenue decreased by 12%.");
    expect(screen.getByTestId("ml-translation").textContent).toContain("尚未翻译");
  });

  it("labels a completed translation as machine-assisted and never a substitute", async () => {
    createSnapshotTranslation.mockResolvedValue(completedTranslation());
    render(<MultilingualResearchPanel sessionId={SESSION_ID} sourceId={SOURCE_ID} />);
    await waitFor(() => expect(screen.getByTestId("ml-translate")).toBeTruthy());
    fireEvent.click(screen.getByTestId("ml-translate"));
    await waitFor(() =>
      expect(screen.getByTestId("ml-translation").textContent).toContain("收入下降了 12%。")
    );
    const translationText = screen.getByTestId("ml-translation").textContent ?? "";
    expect(translationText).toContain("机器翻译");
    expect(translationText).toContain("仅供辅助理解");
    expect(translationText).toContain("不可替代原文引用");
  });

  it("marks fidelity findings as rule-based suggestions, not proven errors", async () => {
    createSnapshotTranslation.mockResolvedValue(completedTranslation());
    render(<MultilingualResearchPanel sessionId={SESSION_ID} sourceId={SOURCE_ID} />);
    await waitFor(() => expect(screen.getByTestId("ml-translate")).toBeTruthy());
    fireEvent.click(screen.getByTestId("ml-translate"));
    await waitFor(() => expect(screen.getByTestId("ml-fidelity")).toBeTruthy());
    const fidelityText = screen.getByTestId("ml-fidelity").textContent ?? "";
    expect(fidelityText).toContain("规则检测结果");
    expect(fidelityText).toContain("非已证实的翻译错误");
  });

  it("offers a read-only account everything to read and nothing to write", async () => {
    render(
      <MultilingualResearchPanel
        sessionId={SESSION_ID}
        sourceId={SOURCE_ID}
        canEdit={false}
      />
    );
    await waitFor(() => expect(screen.getByTestId("ml-translate")).toBeTruthy());
    // Reading is never withheld: the original and the detection are shown.
    expect(screen.getByTestId("ml-original").textContent).toContain(
      "Revenue decreased by 12%."
    );
    expect(screen.getByTestId("ml-detection").textContent).toContain("英语");
    // The write controls are disabled, and the panel says why instead of
    // failing a click with a server error.
    expect(screen.getByTestId("ml-translate")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("ml-readonly").textContent).toContain("只读角色");
    expect(screen.getByLabelText("原文术语")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("确认译法")).toHaveProperty("disabled", true);
    // A stored translation would still be readable here; nothing was faked.
    expect(screen.getByTestId("ml-translation").textContent).toContain("尚未翻译");
  });
});
