import { describe, expect, it } from "vitest";
import {
  newId,
  type TranslationRecord,
  type TranslationReview
} from "@nexus/shared";
import { buildMultilingualReportBlock } from "./multilingual-report";

/**
 * The multilingual report block is a summary of reading aids, never of facts.
 * These tests pin the counting rules: only stored translations exist, the
 * *latest* human review of a translation decides its state, and a review that
 * belongs to another translation never leaks into the counts.
 */

function translationFixture(
  overrides: Partial<TranslationRecord> = {}
): TranslationRecord {
  return {
    translationId: newId(),
    sessionId: newId(),
    sourceSnapshotId: newId(),
    sourceLanguage: "zh-Hans",
    targetLanguage: "en",
    textHash: "hash",
    translatedText: "[0] 译文",
    segmentMappings: [],
    provider: "deterministic-mock",
    model: "deterministic-mock-v1",
    status: "completed",
    createdAt: "2026-03-01T00:00:00.000Z",
    ...overrides
  };
}

function reviewFixture(
  translationId: string,
  overrides: Partial<TranslationReview> = {}
): TranslationReview {
  return {
    translationId,
    reviewedBy: "Alice Reviewer (alice)",
    action: "approve",
    reviewStatus: "approved",
    reviewedAt: "2026-03-02T00:00:00.000Z",
    ...overrides
  };
}

describe("buildMultilingualReportBlock", () => {
  it("answers with an empty, honest summary when nothing was translated", () => {
    const block = buildMultilingualReportBlock({ translations: [], reviews: [] });

    expect(block).toEqual({
      sourceLanguages: [],
      targetLanguages: [],
      translationCount: 0,
      humanReviewedCount: 0,
      approvedCount: 0,
      flaggedCount: 0
    });
  });

  it("counts stored translations and lists their languages, deduped and sorted", () => {
    const block = buildMultilingualReportBlock({
      translations: [
        translationFixture({ sourceLanguage: "en", targetLanguage: "ja" }),
        translationFixture({ sourceLanguage: "zh-Hans", targetLanguage: "en" }),
        translationFixture({ sourceLanguage: "en", targetLanguage: "en" })
      ],
      reviews: []
    });

    expect(block.sourceLanguages).toEqual(["en", "zh-Hans"]);
    expect(block.targetLanguages).toEqual(["en", "ja"]);
    expect(block.translationCount).toBe(3);
  });

  it("counts a translation as human-reviewed once its review exists, whatever the action", () => {
    const first = translationFixture();
    const second = translationFixture();
    const block = buildMultilingualReportBlock({
      translations: [first, second],
      reviews: [
        reviewFixture(first.translationId, { action: "add-correction" }),
        reviewFixture(second.translationId, { action: "flag" })
      ]
    });

    expect(block.humanReviewedCount).toBe(2);
    // A correction is neither an approval nor a flag in this summary.
    expect(block.approvedCount).toBe(0);
    expect(block.flaggedCount).toBe(1);
  });

  it("lets the latest review decide, not the first one", () => {
    const translation = translationFixture();
    const block = buildMultilingualReportBlock({
      translations: [translation],
      reviews: [
        reviewFixture(translation.translationId, {
          action: "flag",
          reviewedAt: "2026-03-02T00:00:00.000Z"
        }),
        reviewFixture(translation.translationId, {
          action: "approve",
          reviewedAt: "2026-03-03T00:00:00.000Z"
        })
      ]
    });

    expect(block.humanReviewedCount).toBe(1);
    expect(block.approvedCount).toBe(1);
    expect(block.flaggedCount).toBe(0);
  });

  it("treats a re-translation request as a flag, not an approval", () => {
    const translation = translationFixture();
    const block = buildMultilingualReportBlock({
      translations: [translation],
      reviews: [
        reviewFixture(translation.translationId, {
          action: "request-retranslation"
        })
      ]
    });

    expect(block.flaggedCount).toBe(1);
    expect(block.approvedCount).toBe(0);
  });

  it("never counts a review that belongs to another translation", () => {
    const translation = translationFixture();
    const block = buildMultilingualReportBlock({
      translations: [translation],
      reviews: [reviewFixture(newId())]
    });

    expect(block.humanReviewedCount).toBe(0);
    expect(block.approvedCount).toBe(0);
    expect(block.flaggedCount).toBe(0);
  });

  it("keeps a review whose translation was never stored out of the counts", () => {
    // An unavailable or failed translation is never persisted; a stray review
    // cannot make one appear in history.
    const block = buildMultilingualReportBlock({
      translations: [],
      reviews: [reviewFixture(newId())]
    });

    expect(block.translationCount).toBe(0);
    expect(block.humanReviewedCount).toBe(0);
  });
});
