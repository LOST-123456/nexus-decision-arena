import type { ZodType } from "zod";
import type { LlmProvider, LlmRequest } from "./provider";

export type StructuredGeneration<T> = {
  data: T;
  repaired: boolean;
  raw: string;
};

/**
 * Thrown when an answer could not be trusted even after the repair pass.
 *
 * It carries the last answer and why it was rejected, so a caller can tell
 * apart "the model did not answer in JSON" from "the model answered JSON in
 * the wrong shape" — two failures that ask for different things from whoever
 * is looking at them.
 */
export class StructuredOutputError extends Error {
  constructor(
    message: string,
    options: {
      /** The last thing the provider returned, verbatim. */
      raw: string;
      /** True when `JSON.parse` itself failed, so the answer was not JSON at all. */
      unparseable: boolean;
      /** True when the repair pass had already been tried. */
      repaired: boolean;
    }
  ) {
    super(message);
    this.name = "StructuredOutputError";
    this.raw = options.raw;
    this.unparseable = options.unparseable;
    this.repaired = options.repaired;
  }

  readonly raw: string;
  readonly unparseable: boolean;
  readonly repaired: boolean;
}

type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; message: string; unparseable: boolean };

function validateJson<T>(schema: ZodType<T>, raw: string): ValidationResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Invalid JSON",
      unparseable: true
    };
  }

  const result = schema.safeParse(parsed);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, message: result.error.message, unparseable: false };
}

export async function generateStructured<T>(
  provider: LlmProvider,
  request: LlmRequest,
  schema: ZodType<T>,
  signal: AbortSignal
): Promise<StructuredGeneration<T>> {
  const raw = await provider.generate(request, signal);
  const first = validateJson(schema, raw);
  if (first.success) {
    return { data: first.data, repaired: false, raw };
  }

  const repairRequest: LlmRequest = {
    ...request,
    schemaName: `${request.schemaName}:repair`,
    user: [
      request.user,
      "The first response failed schema validation.",
      `Validation error: ${first.message}`,
      `Invalid response: ${raw}`,
      "Return only corrected JSON."
    ].join("\n")
  };

  const repairedRaw = await provider.generate(repairRequest, signal);
  const repaired = validateJson(schema, repairedRaw);
  if (!repaired.success) {
    throw new StructuredOutputError(
      `Structured output validation failed: ${repaired.message}`,
      { raw: repairedRaw, unparseable: repaired.unparseable, repaired: true }
    );
  }

  return {
    data: repaired.data,
    repaired: true,
    raw: repairedRaw
  };
}
