import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

/**
 * Multilingual research & cross-language evidence verification.
 *
 * Everything here is built around the Evidence-first rule: a translation is an
 * *auxiliary* reading aid. It never becomes a fact, never auto-verifies an
 * Evidence row, and never replaces the original excerpt that an Evidence points
 * at. The original SourceSnapshot text is the single source of truth.
 */

// ---------------------------------------------------------------------------
// Language identification (BCP 47, priority support set)
// ---------------------------------------------------------------------------

export const SupportedLanguageCodeSchema = z.enum([
  "zh-Hans",
  "zh-Hant",
  "en",
  "ja",
  "ko",
  "fr",
  "de",
  "es"
]);
export type SupportedLanguageCode = z.infer<typeof SupportedLanguageCodeSchema>;

/**
 * A detection result may resolve to one of the supported codes, or to a
 * non-committal value. We deliberately refuse to force a high-confidence guess
 * on short, numeric, or mixed input.
 */
export const LanguageCodeSchema = z.union([
  SupportedLanguageCodeSchema,
  z.enum(["unknown", "mixed", "undetermined"])
]);
export type LanguageCode = z.infer<typeof LanguageCodeSchema>;

/**
 * Display names for every code the domain can carry, including the
 * non-committal ones. A reader must never see a bare code standing in for a
 * language — and "未能判定" must read as an answer, not a failure.
 */
export const LANGUAGE_CODE_LABELS: Record<LanguageCode, string> = {
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  en: "英语",
  ja: "日语",
  ko: "韩语",
  fr: "法语",
  de: "德语",
  es: "西班牙语",
  unknown: "未知语言",
  mixed: "混合语言",
  undetermined: "未能判定"
};

export function languageCodeLabel(code: LanguageCode): string {
  return LANGUAGE_CODE_LABELS[code] ?? code;
}

export const LanguageDetectionStatusSchema = z.enum([
  "detected",
  "unknown",
  "mixed",
  "undetermined"
]);
export type LanguageDetectionStatus = z.infer<typeof LanguageDetectionStatusSchema>;

export const LanguageDetectionConfidenceSchema = z.enum([
  "high",
  "medium",
  "low",
  "none"
]);
export type LanguageDetectionConfidence = z.infer<
  typeof LanguageDetectionConfidenceSchema
>;

export const LanguageDetectionMethodSchema = z.enum([
  "heuristic",
  "model",
  "user-provided"
]);
export type LanguageDetectionMethod = z.infer<typeof LanguageDetectionMethodSchema>;

export const LanguageDetectionResultSchema = z.object({
  languageCode: LanguageCodeSchema,
  confidence: LanguageDetectionConfidenceSchema,
  method: LanguageDetectionMethodSchema,
  detectedAt: TimestampSchema,
  status: LanguageDetectionStatusSchema,
  /**
   * Kept distinct from the auto detection. A user-registered source language
   * must never be overwritten by a detection result, and the two must stay
   * distinguishable so the UI can show "detected X, you said Y".
   */
  userProvidedCode: LanguageCodeSchema.optional()
});
export type LanguageDetectionResult = z.infer<typeof LanguageDetectionResultSchema>;

// ---------------------------------------------------------------------------
// Translation provider & records
// ---------------------------------------------------------------------------

export const TranslationProviderKindSchema = z.enum([
  "deterministic-mock",
  "openai-compatible",
  "none"
]);
export type TranslationProviderKind = z.infer<typeof TranslationProviderKindSchema>;

export const TranslationStatusSchema = z.enum([
  "pending",
  "completed",
  "failed",
  "unavailable"
]);
export type TranslationStatus = z.infer<typeof TranslationStatusSchema>;

/**
 * Maps one original segment to one translated segment. When the target
 * segmentation does not line up with the source, `mappingStatus` must say so
 * rather than inventing coordinates that do not exist.
 */
export const TranslationSegmentMappingStatusSchema = z.enum([
  "aligned",
  "partial",
  "unmapped"
]);
export type TranslationSegmentMappingStatus = z.infer<
  typeof TranslationSegmentMappingStatusSchema
>;

export const TextRangeSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative()
});
export type TextRange = z.infer<typeof TextRangeSchema>;

export const TranslationSegmentMappingSchema = z.object({
  sourceSegmentId: z.string(),
  translatedSegmentId: z.string().optional(),
  originalTextRange: TextRangeSchema.optional(),
  translatedTextRange: TextRangeSchema.optional(),
  mappingStatus: TranslationSegmentMappingStatusSchema
});
export type TranslationSegmentMapping = z.infer<
  typeof TranslationSegmentMappingSchema
>;

export const TranslationRecordSchema = z.object({
  translationId: IdSchema,
  sessionId: IdSchema,
  sourceSnapshotId: IdSchema,
  sourceLanguage: LanguageCodeSchema,
  targetLanguage: SupportedLanguageCodeSchema,
  textHash: z.string(),
  translatedText: z.string(),
  segmentMappings: z.array(TranslationSegmentMappingSchema),
  provider: TranslationProviderKindSchema,
  model: z.string(),
  status: TranslationStatusSchema,
  createdAt: TimestampSchema,
  /** Present only when status is `failed` or `unavailable`. */
  failureReason: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.string().optional()
  ),
  failureCode: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.string().optional()
  )
});
export type TranslationRecord = z.infer<typeof TranslationRecordSchema>;

// ---------------------------------------------------------------------------
// Translation fidelity assessment (heuristic rule-based by default)
// ---------------------------------------------------------------------------

export const FidelityCheckDimensionSchema = z.enum([
  "number",
  "unit",
  "date",
  "negation",
  "comparison",
  "qualifier",
  "entity",
  "reference-scope"
]);
export type FidelityCheckDimension = z.infer<typeof FidelityCheckDimensionSchema>;

export const FidelityRiskTypeSchema = z.enum([
  "direction-conflict",
  "certainty-shift",
  "negation-changed",
  "entity-changed",
  "unit-changed",
  "date-changed",
  "comparison-changed",
  "qualifier-changed",
  "reference-scope-changed",
  "none"
]);
export type FidelityRiskType = z.infer<typeof FidelityRiskTypeSchema>;

export const FidelityReviewStatusSchema = z.enum([
  "pending",
  "approved",
  "flagged",
  "needs-retranslation",
  "corrected"
]);
export type FidelityReviewStatus = z.infer<typeof FidelityReviewStatusSchema>;

export const TranslationFidelityFindingSchema = z.object({
  dimension: FidelityCheckDimensionSchema,
  originalSnippet: z.string(),
  translatedSnippet: z.string(),
  riskType: FidelityRiskTypeSchema,
  basis: z.string(),
  reviewStatus: FidelityReviewStatusSchema,
  /**
   * True when the flag came from a heuristic rule. A heuristic flag is a
   * *suggestion to look closer* — it must never be presented as a proven
   * translation error, and it must never change an Evidence verification state.
   */
  heuristic: z.boolean()
});
export type TranslationFidelityFinding = z.infer<
  typeof TranslationFidelityFindingSchema
>;

export const TranslationFidelityAssessmentSchema = z.object({
  translationId: IdSchema,
  findings: z.array(TranslationFidelityFindingSchema),
  assessedAt: TimestampSchema,
  method: z.enum(["rule-based", "model-assisted"]),
  /**
   * Present only when `method` is `model-assisted` AND a real provider call
   * returned a result. If no real call was made, leave these off — never claim
   * an AI review "passed" without one.
   */
  provider: TranslationProviderKindSchema.optional(),
  model: z.string().optional()
});
export type TranslationFidelityAssessment = z.infer<
  typeof TranslationFidelityAssessmentSchema
>;

// ---------------------------------------------------------------------------
// Human review of a translation (never auto-applied to Evidence)
// ---------------------------------------------------------------------------

export const TranslationReviewActionSchema = z.enum([
  "approve",
  "flag",
  "request-retranslation",
  "add-correction"
]);
export type TranslationReviewAction = z.infer<typeof TranslationReviewActionSchema>;

export const TranslationReviewSchema = z.object({
  translationId: IdSchema,
  reviewedBy: z.string(),
  action: TranslationReviewActionSchema,
  reviewStatus: FidelityReviewStatusSchema,
  correctionText: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.string().optional()
  ),
  note: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.string().optional()
  ),
  reviewedAt: TimestampSchema
});
export type TranslationReview = z.infer<typeof TranslationReviewSchema>;

// ---------------------------------------------------------------------------
// Session-scoped terminology glossary
// ---------------------------------------------------------------------------

export const TerminologyEntrySchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  sourceTerm: z.string(),
  suggestedTranslation: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.string().optional()
  ),
  confirmedTranslation: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.string().optional()
  ),
  language: LanguageCodeSchema,
  context: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.string().optional()
  ),
  reviewedAt: z.preprocess(
    (value) => (value === null ? undefined : value),
    TimestampSchema.optional()
  ),
  reviewedBy: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.string().optional()
  )
});
export type TerminologyEntry = z.infer<typeof TerminologyEntrySchema>;

// ---------------------------------------------------------------------------
// Report block (frozen with a report version; auxiliary only)
// ---------------------------------------------------------------------------

/**
 * The multilingual reading state a report version freezes.
 *
 * A summary, never the translations themselves, and never a fact: it says
 * which languages the examined material was in, which translations were
 * produced as reading aids, and how many of those a person has stood behind.
 * The citation anchor stays the original excerpt — a translation can help a
 * reader understand it and can never replace or verify it.
 */
export const MultilingualReportBlockSchema = z.object({
  /** Languages the examined captures were registered in; sorted, deduped. */
  sourceLanguages: z.array(LanguageCodeSchema),
  /** Translation targets in use; sorted, deduped. */
  targetLanguages: z.array(SupportedLanguageCodeSchema),
  /** Stored (completed) translations at save time. */
  translationCount: z.number().int().min(0),
  /** Translations with at least one human review. */
  humanReviewedCount: z.number().int().min(0),
  /** Translations whose latest human review approves them. */
  approvedCount: z.number().int().min(0),
  /** Translations a human flagged or asked to be re-translated. */
  flaggedCount: z.number().int().min(0)
});
export type MultilingualReportBlock = z.infer<
  typeof MultilingualReportBlockSchema
>;

// ---------------------------------------------------------------------------
// Failure codes surfaced to clients
// ---------------------------------------------------------------------------

export const TranslationFailureCodeSchema = z.enum([
  "provider_unavailable",
  "provider_timeout",
  "provider_rate_limited",
  "text_too_long",
  "budget_exceeded",
  "request_rejected",
  "invalid_model_output"
]);
export type TranslationFailureCode = z.infer<typeof TranslationFailureCodeSchema>;
