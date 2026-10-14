import type {
  MultilingualReportBlock,
  TranslationRecord,
  TranslationReview
} from "@nexus/shared";

/**
 * Builds the multilingual reading block a report version freezes.
 *
 * Pure and total: the same stored translations and reviews always produce the
 * same summary. It reads only what was persisted — a translation that was
 * never stored (provider unavailable, over budget, failed) is invisible here,
 * which is the honest outcome: nothing was produced, so nothing is reported.
 *
 * The counts describe *reading aids*, never facts:
 *   * `humanReviewedCount` — a person looked at the translation;
 *   * `approvedCount` — the latest human review of that translation approves it;
 *   * `flaggedCount` — the latest human review flags it or asks for a
 *     re-translation.
 *
 * None of these numbers verifies anything: an approved translation is still a
 * translation, and the citation anchor stays the original excerpt.
 */
export function buildMultilingualReportBlock(input: {
  translations: readonly TranslationRecord[];
  reviews: readonly TranslationReview[];
}): MultilingualReportBlock {
  const translations = input.translations;
  const reviewsByTranslation = new Map<string, TranslationReview[]>();
  for (const review of input.reviews) {
    const bucket = reviewsByTranslation.get(review.translationId);
    if (bucket) {
      bucket.push(review);
    } else {
      reviewsByTranslation.set(review.translationId, [review]);
    }
  }

  let humanReviewedCount = 0;
  let approvedCount = 0;
  let flaggedCount = 0;
  for (const translation of translations) {
    const reviews = (reviewsByTranslation.get(translation.translationId) ?? [])
      .slice()
      .sort((left, right) => left.reviewedAt.localeCompare(right.reviewedAt));
    if (reviews.length === 0) continue;
    humanReviewedCount += 1;
    const latest = reviews[reviews.length - 1]!;
    if (latest.action === "approve") {
      approvedCount += 1;
    } else if (latest.action === "flag" || latest.action === "request-retranslation") {
      flaggedCount += 1;
    }
  }

  return {
    sourceLanguages: distinctSorted(translations.map((item) => item.sourceLanguage)),
    targetLanguages: distinctSorted(
      translations.map((item) => item.targetLanguage)
    ),
    translationCount: translations.length,
    humanReviewedCount,
    approvedCount,
    flaggedCount
  };
}

function distinctSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
