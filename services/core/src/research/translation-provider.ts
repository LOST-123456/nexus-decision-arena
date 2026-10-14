import {
  type TranslationFailureCode,
  type TranslationProviderKind,
  type TranslationSegmentMapping
} from "@nexus/shared";

/**
 * A swappable translation provider.
 *
 * Mirrors the search provider shape: an interface plus a couple of concrete
 * implementations that the server wires at startup. The provider never decides
 * whether a translation is trustworthy — it only turns source text into
 * auxiliary target text. Whether anyone stands behind it is a separate, human
 * decision recorded elsewhere.
 */

export type TranslationRequest = {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  correlationId: string;
  signal?: AbortSignal;
};

export type ProviderTranslationOutcome = {
  translatedText: string;
  segmentMappings: readonly TranslationSegmentMapping[];
};

/** Raised by a provider when it could not produce a translation. */
export class TranslationProviderError extends Error {
  constructor(
    readonly code: TranslationFailureCode,
    message: string
  ) {
    super(message);
    this.name = "TranslationProviderError";
  }
}

export interface TranslationProvider {
  readonly kind: TranslationProviderKind;
  readonly model: string;
  /** False when the provider is not configured (e.g. no credentials). */
  readonly available: boolean;
  translate(request: TranslationRequest): Promise<ProviderTranslationOutcome>;
}

/**
 * The honest production default when no real translation provider is
 * configured: it never fabricates output, it reports itself unavailable. The
 * service persists an `unavailable` record and the UI says "尚未翻译".
 */
export class UnavailableTranslationProvider implements TranslationProvider {
  readonly kind = "none" as const;
  readonly model = "none";
  readonly available = false;

  async translate(_request: TranslationRequest): Promise<ProviderTranslationOutcome> {
    throw new TranslationProviderError(
      "provider_unavailable",
      "No translation provider is configured."
    );
  }
}

/**
 * A deterministic, network-free provider used to exercise the interface and
 * business logic in tests. It is explicitly labelled `deterministic-mock`; its
 * output is a clearly synthetic placeholder, never a real translation, and any
 * record it produces carries that provider id so the UI can say so.
 */
export class DeterministicTranslationProvider implements TranslationProvider {
  readonly kind = "deterministic-mock" as const;
  readonly model = "deterministic-mock-v1";
  readonly available = true;

  async translate(request: TranslationRequest): Promise<ProviderTranslationOutcome> {
    const segments = request.text.split(/\n{2,}|\n/).filter((s) => s.trim().length > 0);
    const segmentMappings: TranslationSegmentMapping[] = segments.map((_, index) => ({
      sourceSegmentId: `seg-${index}`,
      translatedSegmentId: `t-seg-${index}`,
      mappingStatus: "aligned"
    }));
    const translatedText = segments
      .map((segment, index) => `[${index}] ${segment}`)
      .join("\n");
    return { translatedText, segmentMappings };
  }
}

/**
 * A real provider that calls an OpenAI-compatible chat-completions endpoint.
 * Credentials and base URL are supplied from the environment (never hard-coded)
 * and only wired when present. The base URL is operator-configured, not user
 * input, so it is not an SSRF vector the way a caller-supplied URL would be.
 */
export type OpenAiCompatibleTranslationProviderOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
};

export class OpenAiCompatibleTranslationProvider implements TranslationProvider {
  readonly kind = "openai-compatible" as const;
  readonly available = true;

  constructor(
    private readonly options: OpenAiCompatibleTranslationProviderOptions,
    readonly model: string = options.model
  ) {}

  async translate(request: TranslationRequest): Promise<ProviderTranslationOutcome> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [
          {
            role: "system",
            content:
              "You are a translation engine. Translate the user text faithfully. " +
              "Preserve numbers, dates, negation and qualifiers exactly. Output only the translation."
          },
          {
            role: "user",
            content: request.text
          }
        ],
        temperature: 0
      }),
      // Spread rather than assign: with exactOptionalPropertyTypes an
      // explicit `signal: undefined` is not the same as an absent key.
      ...(request.signal ? { signal: request.signal } : {})
    });

    if (!response.ok) {
      const code: TranslationFailureCode =
        response.status === 429
          ? "provider_rate_limited"
          : response.status >= 500
            ? "provider_unavailable"
            : "invalid_model_output";
      throw new TranslationProviderError(
        code,
        `Translation provider responded ${response.status}.`
      );
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const translatedText = payload.choices?.[0]?.message?.content;
    if (typeof translatedText !== "string" || translatedText.length === 0) {
      throw new TranslationProviderError(
        "invalid_model_output",
        "Translation provider returned no text."
      );
    }

    // A model-assisted translation does not come with reliable segment
    // coordinates; record the mapping as partial rather than inventing offsets.
    const segmentMappings: TranslationSegmentMapping[] = request.text
      .split(/\n{2,}|\n/)
      .filter((s) => s.trim().length > 0)
      .map((_, index) => ({
        sourceSegmentId: `seg-${index}`,
        mappingStatus: "partial"
      }));
    return { translatedText, segmentMappings };
  }
}
