import {
  type LanguageCode,
  type LanguageDetectionConfidence,
  type LanguageDetectionMethod,
  type LanguageDetectionResult,
  type LanguageDetectionStatus,
  type SupportedLanguageCode
} from "@nexus/shared";

/**
 * Heuristic language identification.
 *
 * The service is deliberately conservative: it refuses to emit a high-confidence
 * guess on short, numeric, or mixed input. "I cannot tell" (`undetermined`,
 * `mixed`, or `unknown` with `none`/`low` confidence) is a first-class answer,
 * not a failure. A caller may layer a model-based detector on top; that path
 * records `method: "model"`.
 *
 * Detection never overwrites a user-registered source language — the result is a
 * separate, distinguishable signal (see `LanguageDetectionResult.userProvidedCode`).
 */

const MIN_RELIABLE_LENGTH = 8;
const MIN_SCRIPT_RATIO = 0.4;

type ScriptTally = {
  han: number;
  kana: number;
  hangul: number;
  latin: number;
  letters: number;
};

function tally(text: string): ScriptTally {
  let han = 0;
  let kana = 0;
  let hangul = 0;
  let latin = 0;
  let letters = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      han += 1;
      letters += 1;
    } else if (
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff)
    ) {
      kana += 1;
      letters += 1;
    } else if (code >= 0xac00 && code <= 0xd7a3) {
      hangul += 1;
      letters += 1;
    } else if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0xc0 && code <= 0x24f)
    ) {
      latin += 1;
      letters += 1;
    }
  }
  return { han, kana, hangul, latin, letters };
}

// A small, high-precision set of characters that appear in Traditional Chinese
// but not Simplified — enough to separate zh-Hant from zh-Hans without a model.
const TRADITIONAL_ONLY = "國臺灣為學灣醫龍關";
const TRADITIONAL_SET = new Set([...TRADITIONAL_ONLY]);

const LATIN_HINTS: {
  code: SupportedLanguageCode;
  chars: string;
  words: string[];
}[] = [
  {
    code: "fr",
    chars: "àâçéèêëîïôùûüÿœæ",
    words: ["le", "la", "les", "des", "est", "une", "dans", "pour", "qui"]
  },
  {
    code: "es",
    chars: "ñ¿¡",
    words: ["el", "los", "las", "que", "pero", "como", "una", "para", "muy"]
  },
  {
    code: "de",
    chars: "äöüß",
    words: ["der", "die", "das", "und", "ist", "nicht", "mit", "für", "auch"]
  },
  {
    code: "en",
    chars: "",
    words: ["the", "of", "and", "is", "to", "in", "that", "it", "was"]
  }
];

function detectLatinScript(text: string): {
  code: LanguageCode;
  confidence: LanguageDetectionConfidence;
} {
  const lower = text.toLowerCase();
  let best: { code: SupportedLanguageCode; score: number } | null = null;
  for (const hint of LATIN_HINTS) {
    let score = 0;
    for (const char of hint.chars) {
      if (lower.includes(char)) score += 2;
    }
    for (const word of hint.words) {
      if (new RegExp(`\\b${word}\\b`).test(lower)) score += 3;
    }
    if (!best || score > best.score) {
      best = { code: hint.code, score };
    }
  }
  // Only commit when there is a real signal; otherwise stay undetermined.
  if (best && best.score >= 4) {
    return { code: best.code, confidence: best.score >= 8 ? "medium" : "low" };
  }
  return { code: "undetermined", confidence: "low" };
}

export class LanguageDetectionService {
  /**
   * @param method "heuristic" for the built-in detector; pass "model" when a
   *   caller wires an LLM-based detector on top (the caller supplies the code).
   */
  constructor(private readonly method: LanguageDetectionMethod = "heuristic") {}

  detect(
    text: string,
    options: { now?: string; userProvidedCode?: LanguageCode } = {}
  ): LanguageDetectionResult {
    const now = options.now ?? new Date().toISOString();
    const trimmed = text.trim();
    const counts = tally(trimmed);

    let status: LanguageDetectionStatus;
    let languageCode: LanguageCode;
    let confidence: LanguageDetectionConfidence;

    if (trimmed.length < MIN_RELIABLE_LENGTH) {
      status = "undetermined";
      languageCode = "undetermined";
      confidence = "none";
    } else if (counts.letters < trimmed.replace(/\s/g, "").length * MIN_SCRIPT_RATIO) {
      // Numeric / punctuation-heavy: not enough language signal to commit.
      status = "undetermined";
      languageCode = "undetermined";
      confidence = "none";
    } else {
      // Han + kana together are *one* language (Japanese); a second language is
      // a different family at a meaningful share. So bucket by family for the
      // mixed decision, then refine CJK into ja vs zh by the presence of kana.
      const families = [
        { kind: "cjk", count: counts.han + counts.kana },
        { kind: "hangul", count: counts.hangul },
        { kind: "latin", count: counts.latin }
      ]
        .filter((entry) => entry.count > 0)
        .sort((a, b) => b.count - a.count);

      const dominant = families[0]!;
      const others = families.filter(
        (entry) => entry !== dominant && entry.count >= counts.letters * 0.2
      );

      if (others.length > 0) {
        status = "mixed";
        languageCode = "mixed";
        confidence = "low";
      } else if (dominant.kind === "hangul") {
        status = "detected";
        languageCode = "ko";
        confidence = "high";
      } else if (dominant.kind === "cjk") {
        status = "detected";
        if (counts.kana > 0) {
          languageCode = "ja";
          confidence = "high";
        } else {
          const hasTraditional = [...trimmed].some((char) =>
            TRADITIONAL_SET.has(char)
          );
          languageCode = hasTraditional ? "zh-Hant" : "zh-Hans";
          confidence = "medium";
        }
      } else {
        const latin = detectLatinScript(trimmed);
        status = latin.code === "undetermined" ? "undetermined" : "detected";
        languageCode = latin.code;
        confidence = latin.confidence;
      }
    }

    return {
      languageCode,
      confidence,
      method: this.method,
      detectedAt: now,
      status,
      ...(options.userProvidedCode
        ? { userProvidedCode: options.userProvidedCode }
        : {})
    };
  }
}
