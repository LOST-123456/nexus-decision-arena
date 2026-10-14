import { createHash } from "node:crypto";
import {
  newId,
  type SupportedLanguageCode,
  type TranslationFidelityAssessment,
  type TranslationRecord,
  type TranslationSegmentMapping
} from "@nexus/shared";
import type { EvidenceRepository, TranslationRepository } from "@nexus/db";
import { assessTranslationFidelity } from "./translation-fidelity-service";
import {
  TranslationProviderError,
  type TranslationProvider
} from "./translation-provider";
import type { LanguageDetectionService } from "./language-detection-service";

/**
 * Orchestrates on-demand translation of a source snapshot.
 *
 * The whole service is built around one honest contract: a translation is an
 * *auxiliary* reading aid tied to a snapshot version. It is produced on demand,
 * budget-bounded, de-duplicated, and it never touches evidence, claim reviews or
 * verdicts. When no real provider is available it says so instead of inventing
 * a translation. Only successful translations are persisted; failures and
 * "unavailable" states are returned to the caller but not stored, so a retry is
 * never blocked by a cached failure.
 */

export type TranslationBudget = {
  /** Max source characters per translation call. */
  maxTextLength: number;
  /** Max segments translated in one batch. */
  maxSegments: number;
  /** Per-call wall-clock timeout in milliseconds. */
  timeoutMs: number;
};

export const DEFAULT_TRANSLATION_BUDGET: TranslationBudget = {
  maxTextLength: 20000,
  maxSegments: 200,
  timeoutMs: 45000
};

export class TranslationSnapshotNotFoundError extends Error {
  constructor() {
    super("Source snapshot not found in this research.");
    this.name = "TranslationSnapshotNotFoundError";
  }
}

export class TranslationBudgetError extends Error {
  constructor(
    readonly code: "text_too_long" | "budget_exceeded",
    message: string
  ) {
    super(message);
    this.name = "TranslationBudgetError";
  }
}

type Segment = { id: string; text: string; start: number; end: number };

function splitSegments(content: string): Segment[] {
  const segments: Segment[] = [];
  const lines = content.split("\n");
  let offset = 0;
  let index = 0;
  let buffer = "";
  let bufferStart = 0;

  const flush = () => {
    if (buffer.trim().length > 0) {
      segments.push({
        id: `seg-${index++}`,
        text: buffer.trim(),
        start: bufferStart,
        end: bufferStart + buffer.length
      });
    }
    buffer = "";
  };

  for (const line of lines) {
    if (line.trim().length === 0) {
      flush();
    } else {
      if (buffer.length === 0) {
        bufferStart = offset;
      }
      buffer += (buffer.length > 0 ? "\n" : "") + line;
    }
    offset += line.length + 1;
  }
  flush();
  return segments;
}

export type TranslateSnapshotInput = {
  sessionId: string;
  sourceSnapshotId: string;
  targetLanguage: SupportedLanguageCode;
  segmentIds?: readonly string[] | undefined;
  createdBy: string;
};

export type TranslateSnapshotResult = {
  translation: TranslationRecord;
  /**
   * Present only for a freshly completed translation. A separate axis from
   * "does this evidence support the claim": it asks whether the *translation*
   * may have misrepresented the source. Every finding is heuristic.
   */
  fidelity?: TranslationFidelityAssessment;
};

export class ResearchTranslationService {
  constructor(
    private readonly deps: {
      translations: TranslationRepository;
      evidence: EvidenceRepository;
      provider: TranslationProvider;
      language: LanguageDetectionService;
      budget?: TranslationBudget;
    }
  ) {}

  private get budget(): TranslationBudget {
    return this.deps.budget ?? DEFAULT_TRANSLATION_BUDGET;
  }

  async translateSnapshot(
    input: TranslateSnapshotInput
  ): Promise<TranslateSnapshotResult> {
    const snapshot = await this.deps.evidence.getSnapshot(
      input.sessionId,
      input.sourceSnapshotId
    );
    if (!snapshot) {
      throw new TranslationSnapshotNotFoundError();
    }

    const detected = snapshot.sourceLanguage
      ? null
      : this.deps.language.detect(snapshot.content);
    const sourceLanguage = snapshot.sourceLanguage ?? detected?.languageCode ?? "undetermined";

    if (snapshot.content.length > this.budget.maxTextLength) {
      throw new TranslationBudgetError(
        "text_too_long",
        `Source text is ${snapshot.content.length} characters; the per-call limit is ${this.budget.maxTextLength}.`
      );
    }

    const provider = this.deps.provider;
    const textHash = createHash("sha256")
      .update(
        [
          snapshot.id,
          snapshot.contentHash,
          String(sourceLanguage),
          input.targetLanguage,
          provider.kind,
          provider.model
        ].join("\u0000")
      )
      .digest("hex");

    // Reuse a previously completed translation of the exact same input.
    const cached = await this.deps.translations.findCached({
      sourceSnapshotId: snapshot.id,
      sourceLanguage: String(sourceLanguage),
      targetLanguage: input.targetLanguage,
      textHash,
      provider: provider.kind,
      model: provider.model
    });
    if (cached && cached.status === "completed") {
      return { translation: cached };
    }

    const segments = splitSegments(snapshot.content);
    const selected = input.segmentIds
      ? segments.filter((segment) => input.segmentIds!.includes(segment.id))
      : segments;
    if (selected.length === 0) {
      throw new TranslationBudgetError(
        "budget_exceeded",
        "No source segments matched the requested selection."
      );
    }
    if (selected.length > this.budget.maxSegments) {
      throw new TranslationBudgetError(
        "budget_exceeded",
        `Requested ${selected.length} segments; the per-batch limit is ${this.budget.maxSegments}.`
      );
    }

    const sourceText = selected.map((segment) => segment.text).join("\n\n");
    if (sourceText.length > this.budget.maxTextLength) {
      throw new TranslationBudgetError(
        "text_too_long",
        `Selected segments total ${sourceText.length} characters; the per-call limit is ${this.budget.maxTextLength}.`
      );
    }

    if (!provider.available) {
      return {
        translation: this.unsavedRecord(input, {
          status: "unavailable",
          failureCode: "provider_unavailable",
          failureReason: "No translation provider is configured."
        })
      };
    }

    try {
      const outcome = await this.callWithTimeout({
        text: sourceText,
        sourceLanguage: String(sourceLanguage),
        targetLanguage: input.targetLanguage,
        correlationId: input.sessionId
      });

      const translationId = newId();
      const { translation } = await this.deps.translations.createTranslation({
        translationId,
        sessionId: input.sessionId,
        sourceSnapshotId: snapshot.id,
        sourceLanguage: String(sourceLanguage),
        targetLanguage: input.targetLanguage,
        textHash,
        translatedText: outcome.translatedText,
        segmentMappings: outcome.segmentMappings,
        provider: provider.kind,
        model: provider.model,
        status: "completed",
        createdBy: input.createdBy,
        event: {
          type: "TRANSLATION_RECORDED",
          correlationId: input.sessionId,
          payload: {
            translationId,
            sourceSnapshotId: snapshot.id,
            sourceLanguage: String(sourceLanguage),
            targetLanguage: input.targetLanguage,
            provider: provider.kind,
            model: provider.model
          }
        }
      });
      return {
        translation,
        fidelity: assessTranslationFidelity({
          translationId: translation.translationId,
          original: snapshot.content,
          translated: outcome.translatedText
        })
      };
    } catch (error) {
      const providerError =
        error instanceof TranslationProviderError ? error : undefined;
      const status = providerError?.code === "provider_unavailable" ? "unavailable" : "failed";
      const code = providerError?.code ?? "internal_error";
      return {
        translation: this.unsavedRecord(input, {
          status,
          failureCode: code,
          failureReason:
            providerError?.message ?? "Translation request could not be completed."
        })
      };
    }
  }

  /** Fidelity is a separate axis: does the *translation* misrepresent the source? */
  assessFidelity(original: string, translated: string, translationId: string) {
    return assessTranslationFidelity({ translationId, original, translated });
  }

  private unsavedRecord(
    input: TranslateSnapshotInput,
    outcome: {
      status: "failed" | "unavailable";
      failureCode: string;
      failureReason: string;
    }
  ): TranslationRecord {
    const provider = this.deps.provider;
    return {
      translationId: newId(),
      sessionId: input.sessionId,
      sourceSnapshotId: input.sourceSnapshotId,
      sourceLanguage: "undetermined",
      targetLanguage: input.targetLanguage,
      textHash: "",
      translatedText: "",
      segmentMappings: [] satisfies TranslationSegmentMapping[],
      provider: provider.kind,
      model: provider.model,
      status: outcome.status,
      createdAt: new Date().toISOString(),
      failureCode: outcome.failureCode,
      failureReason: outcome.failureReason
    };
  }

  private async callWithTimeout(request: {
    text: string;
    sourceLanguage: string;
    targetLanguage: string;
    correlationId: string;
  }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.budget.timeoutMs);
    try {
      return await this.deps.provider.translate({
        ...request,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
