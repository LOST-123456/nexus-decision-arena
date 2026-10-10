import { withLlmTimeout, type LlmProvider, type LlmRequest } from "@nexus/llm";

/**
 * A stand-in for a model that reads a saved page and proposes claims.
 *
 * It exists because "the analysis is unavailable" would hide the whole review
 * surface behind a credential nobody has in this environment. What it produces
 * is therefore deliberately boring: every proposed excerpt is copied verbatim
 * out of the page, which means every one of them will be found again when the
 * server checks it. It suggests nothing the text does not contain, and it is
 * labelled as fixtures rather than as a model, so a demo can never be mistaken
 * for evidence that a real model behaves this way.
 *
 * Note how it handles a page that tries to give it instructions: those lines are
 * treated like any other sentence, summarised into a candidate if they read like
 * a claim, and nothing else happens. That is the whole point of the boundary the
 * document is placed inside.
 */

const MAX_CLAIMS_PER_SEGMENT = 6;

function extractDocument(request: LlmRequest): string {
  const match = /<untrusted-document>\n?([\s\S]*?)\n?<\/untrusted-document>/.exec(
    request.user
  );
  return match && match[1] ? match[1] : "";
}

function toSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？.!?])\s*|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 8);
}

function looksLikeFragment(sentence: string): boolean {
  // Navigation chrome, headings without a verb's worth of content, and lines
  // that are only punctuation or a list marker are not claims.
  return /^[\s\-—*·#|>]+$/.test(sentence) || !/[\p{L}\p{N}]/u.test(sentence);
}

function classify(sentence: string): "fact" | "causal" | "prediction" | "opinion" {
  if (/(因为|由于|导致|从而|得益于|caused by|due to|because)/i.test(sentence)) {
    return "causal";
  }
  if (/(预计|预测|forecast|projected|will reach|有望|将会)/i.test(sentence)) {
    return "prediction";
  }
  if (/(认为|相信|建议|应该|可能不如|we believe|should|recommend)/i.test(sentence)) {
    return "opinion";
  }
  return "fact";
}

function qualifiersOf(sentence: string): string[] {
  const qualifiers: string[] = [];
  for (const match of sentence.matchAll(
    /(截至[^，。；]{0,18}|截至 \d{4}|\b(?:19|20)\d{2}\s*年|\b(?:19|20)\d{2}\b|除外|例外|仅限|仅限于|在[^，。；]{0,12}范围内|except[^,.]{0,24})/gi
  )) {
    const value = match[0]?.trim();
    if (value) qualifiers.push(value);
  }
  return [...new Set(qualifiers)].slice(0, 4);
}

function uncertaintyOf(sentence: string): string[] {
  const notes: string[] = [];
  if (/(可能|或许|大约|估计|约为|不确定|may|might|roughly|approximately)/i.test(sentence)) {
    notes.push("原文使用了不确定的措辞，数量或时间点需要另行核实。");
  }
  if (/(但未说明|未提供|没有给出|unspecified)/i.test(sentence)) {
    notes.push("原文没有给出支撑这一说法的依据。");
  }
  return notes;
}

function importanceOf(sentence: string): number {
  if (/(关键|最重要|核心|primary|decisive)/i.test(sentence)) return 5;
  if (/\d/.test(sentence)) return 3;
  return 2;
}

export class DeterministicExtractionProvider implements LlmProvider {
  readonly name = "DeterministicExtractionProvider";
  /** Reported with every run so a fixture is never presented as a model result. */
  readonly model = "clause-splitter-fixtures";

  async generate(request: LlmRequest, signal: AbortSignal): Promise<string> {
    const effectiveSignal = withLlmTimeout(signal);
    if (effectiveSignal.aborted) {
      throw new DOMException("Generation aborted", "AbortError");
    }

    const document = extractDocument(request);
    const sentences = toSentences(document).filter(
      (sentence) => !looksLikeFragment(sentence)
    );

    const claims = sentences.slice(0, MAX_CLAIMS_PER_SEGMENT).map((sentence, index) => ({
      statement: sentence,
      type: classify(sentence),
      qualifiers: qualifiersOf(sentence),
      uncertainty: uncertaintyOf(sentence),
      rationale: `取自原文片段中的第 ${index + 1} 句，按原子主张切出。`,
      importance: importanceOf(sentence),
      evidence: [
        {
          excerpt: sentence,
          title: sentence.slice(0, 24),
          direction: "supports" as const,
          rationale: "与主张逐字对应的原句。",
          uncertainty: [] as string[]
        }
      ]
    }));

    return JSON.stringify({ claims, documentNotes: [] });
  }
}
