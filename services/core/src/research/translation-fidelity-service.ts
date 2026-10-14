import {
  type FidelityCheckDimension,
  type FidelityRiskType,
  type TranslationFidelityAssessment,
  type TranslationFidelityFinding
} from "@nexus/shared";

/**
 * Rule-based translation fidelity assessment.
 *
 * Goal: surface where a translation *might* have changed the original's
 * meaning — numbers, units, dates, negation, comparison direction, qualifiers,
 * entities and reference scope. Every finding is a **suggestion to look
 * closer**, not a proven error: it is flagged `heuristic: true` and never
 * changes any Evidence verification state. Only a person can rule on it.
 *
 * This is intentionally rule-based and network-free. A model-assisted path can
 * be layered on later; when it is, it must record its provider and model and
 * only when a real call returned.
 */

const NUMBER_RE = /-?\d+(?:[.,]\d+)?/g;
const PERCENT_RE = /-?\d+(?:[.,]\d+)?\s*%|百分之[-+]?\d+/g;
const DATE_RE =
  /\b(?:19|20)\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b|\b\d{4}年\d{1,2}月\d{1,2}日\b/gi;
const UNIT_RE =
  /%|kg|kilogram|kilogramme|km|kilomet(?:re|er)|m\b|met(?:re|er)s?|cm|mm|g\b|lb|pound|ounce|oz|usd|\$|€|£|¥|元|美元|欧元|英镑|日元|人民币/gi;
const NEGATION_WORDS =
  /\b(not|no|never|none|cannot|can't|isn't|aren't|doesn't|don't|without|neither|nor|nothing)\b|不|没|无|非|未|莫|勿/gi;
const QUALIFIER_WORDS =
  /\b(may|might|could|possibly|perhaps|likely|some|several|often|sometimes|rarely|most|few|about|approximately|around)\b|可能|也许|或许|大概|大约|一些|某些|通常|经常|有时|很少|多数|少数/gi;
const COMPARISON_WORDS =
  /\b(more|less|fewer|greater|higher|lower|increase[sd]?|decrease[sd]?|rise[n]?|fell|drop[s]?|grew|reduce[sd]?|than|compared)\b|高于|低于|增加|减少|增长|下降|多于|少于|提升/gi;
const DECREASE_DIRECTION =
  /\b(decrease[sd]?|fell|fall|drop[sd]?|reduce[sd]?|reduced|decline[sd]?|lower(?:ed)?|less|fewer)\b|下降|减少|降低|下跌|下滑/gi;
const INCREASE_DIRECTION =
  /\b(increase[sd]?|increased|rise[n]?|rose|grow|grew|growth|higher|more|gain(?:ed)?)\b|增长|增加|上升|提高|上涨|提升/gi;

function extractNumbers(text: string): string[] {
  return text.match(NUMBER_RE) ?? [];
}

function extractPercents(text: string): string[] {
  return text.match(PERCENT_RE) ?? [];
}

function extractDates(text: string): string[] {
  return text.match(DATE_RE) ?? [];
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function snippetFor(text: string, re: RegExp): string {
  const match = text.match(re);
  return match ? match[0] : text.slice(0, 40);
}

function makeFinding(
  dimension: FidelityCheckDimension,
  riskType: FidelityRiskType,
  original: string,
  translated: string,
  basis: string
): TranslationFidelityFinding {
  return {
    dimension,
    originalSnippet: original.slice(0, 80),
    translatedSnippet: translated.slice(0, 80),
    riskType,
    basis,
    reviewStatus: "pending",
    heuristic: true
  };
}

/**
 * @param original The source-language text that was translated.
 * @param translated The target-language text.
 * @param options.now Injectable clock for deterministic tests.
 * @param options.translationId Required for the assessment envelope.
 */
export function assessTranslationFidelity(input: {
  translationId: string;
  original: string;
  translated: string;
  now?: string;
}): TranslationFidelityAssessment {
  const findings: TranslationFidelityFinding[] = [];
  const original = input.original;
  const translated = input.translated;

  // Numbers: a number that exists in one but not the other may have been
  // dropped, added, or altered. Percentages are numbers with a direction, so a
  // mismatch there is the classic "decreased 12%" -> "grew 12%" trap.
  const originalNumbers = new Set(extractNumbers(original));
  const translatedNumbers = new Set(extractNumbers(translated));
  const missingNumbers = [...originalNumbers].filter(
    (value) => !translatedNumbers.has(value)
  );
  const addedNumbers = [...translatedNumbers].filter(
    (value) => !originalNumbers.has(value)
  );
  if (missingNumbers.length > 0 || addedNumbers.length > 0) {
    findings.push(
      makeFinding(
        "number",
        missingNumbers.length > 0 ? "none" : "none",
        `原文数值: ${[...originalNumbers].join(", ") || "无"}`,
        `译文数值: ${[...translatedNumbers].join(", ") || "无"}`,
        "原文与译文的数字集合不一致，可能遗漏、新增或改动了数值。"
      )
    );
  }

  // Percent direction: a *direction flip* (decrease↔increase) around a number
  // is the classic "decreased 12%" -> "grew 12%" trap. A word-count check misses
  // it (one comparison word on each side), so we compare polarity, not counts.
  const hasNumber = (t: string) =>
    extractNumbers(t).length > 0 || extractPercents(t).length > 0;
  const originalDecrease = countMatches(original, DECREASE_DIRECTION);
  const originalIncrease = countMatches(original, INCREASE_DIRECTION);
  const translatedDecrease = countMatches(translated, DECREASE_DIRECTION);
  const translatedIncrease = countMatches(translated, INCREASE_DIRECTION);
  const directionFlip =
    (originalDecrease > 0 && translatedIncrease > 0 && translatedDecrease === 0) ||
    (originalIncrease > 0 && translatedDecrease > 0 && translatedIncrease === 0);
  if (directionFlip && (hasNumber(original) || hasNumber(translated))) {
    findings.push(
      makeFinding(
        "comparison",
        "direction-conflict",
        snippetFor(original, COMPARISON_WORDS),
        snippetFor(translated, COMPARISON_WORDS),
        "比较方向疑似反转（如“下降/减少”被译为“增长/增加”）且涉及数值，可能存在方向性冲突。"
      )
    );
  }

  // Negation: a negation word on exactly one side may have flipped the meaning.
  const originalNegation = countMatches(original, NEGATION_WORDS);
  const translatedNegation = countMatches(translated, NEGATION_WORDS);
  if ((originalNegation > 0) !== (translatedNegation > 0)) {
    findings.push(
      makeFinding(
        "negation",
        "negation-changed",
        snippetFor(original, NEGATION_WORDS),
        snippetFor(translated, NEGATION_WORDS),
        "否定词只出现在一侧，否定含义可能被改变（如“并非所有人都同意”译为“所有人都同意”）。"
      )
    );
  }

  // Qualifiers / certainty: hedges that vanish can turn "may" into "will".
  const originalQualifier = countMatches(original, QUALIFIER_WORDS);
  const translatedQualifier = countMatches(translated, QUALIFIER_WORDS);
  if ((originalQualifier > 0) !== (translatedQualifier > 0)) {
    findings.push(
      makeFinding(
        "qualifier",
        "certainty-shift",
        snippetFor(original, QUALIFIER_WORDS),
        snippetFor(translated, QUALIFIER_WORDS),
        "限定/模糊词只出现在一侧，可能性与确定性可能被改写（如“may improve”译为“能够改善”）。"
      )
    );
  }

  // Dates: a date present on one side only may have been dropped or shifted.
  const originalDates = extractDates(original);
  const translatedDates = extractDates(translated);
  if (
    originalDates.length > 0 &&
    (originalDates.length !== translatedDates.length ||
      originalDates.some((value, index) => value !== translatedDates[index]))
  ) {
    findings.push(
      makeFinding(
        "date",
        "date-changed",
        originalDates.join(", "),
        translatedDates.join(", ") || "无",
        "原文与译文的日期不一致，日期可能被改写或遗漏。"
      )
    );
  }

  // Units: a unit token on one side only may have been dropped or changed.
  const originalUnits = (original.match(UNIT_RE) ?? []).length;
  const translatedUnits = (translated.match(UNIT_RE) ?? []).length;
  if (originalUnits > 0 && originalUnits !== translatedUnits) {
    findings.push(
      makeFinding(
        "unit",
        "unit-changed",
        (original.match(UNIT_RE) ?? []).join(", "),
        (translated.match(UNIT_RE) ?? []).join(", ") || "无",
        "原文与译文的计量单位数量不一致，单位可能被遗漏或改动。"
      )
    );
  }

  return {
    translationId: input.translationId,
    findings,
    assessedAt: input.now ?? new Date().toISOString(),
    method: "rule-based"
  };
}
