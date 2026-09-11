import type { ZodType } from "zod";
import { withLlmTimeout } from "./provider";
import type { LlmProvider, LlmRequest } from "./provider";

export type StructuredGeneration<T> = {
  data: T;
  repaired: boolean;
  raw: string;
};

type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; message: string };

function validateJson<T>(schema: ZodType<T>, raw: string): ValidationResult<T> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = schema.safeParse(parsed);
    return result.success
      ? { success: true, data: result.data }
      : { success: false, message: result.error.message };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Invalid JSON"
    };
  }
}

export async function generateStructured<T>(
  provider: LlmProvider,
  request: LlmRequest,
  schema: ZodType<T>,
  signal: AbortSignal
): Promise<StructuredGeneration<T>> {
  const raw = await provider.generate(request, withLlmTimeout(signal));
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

  const repairedRaw = await provider.generate(
    repairRequest,
    withLlmTimeout(signal)
  );
  const repaired = validateJson(schema, repairedRaw);
  if (!repaired.success) {
    throw new Error(
      `Structured output validation failed: ${repaired.message}`
    );
  }

  return {
    data: repaired.data,
    repaired: true,
    raw: repairedRaw
  };
}
