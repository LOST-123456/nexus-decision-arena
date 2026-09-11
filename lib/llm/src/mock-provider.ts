import type { LlmProvider, LlmRequest } from "./provider";

type MockHandler = (request: LlmRequest) => string | Promise<string>;

export class MockLlmProvider implements LlmProvider {
  constructor(private readonly handlers: Record<string, MockHandler>) {}

  async generate(
    request: LlmRequest,
    signal: AbortSignal
  ): Promise<string> {
    if (signal.aborted) {
      throw new DOMException("Generation aborted", "AbortError");
    }

    const repairSuffix = ":repair";
    const baseSchemaName = request.schemaName.endsWith(repairSuffix)
      ? request.schemaName.slice(0, -repairSuffix.length)
      : request.schemaName;
    const handler =
      this.handlers[request.schemaName] ?? this.handlers[baseSchemaName];

    if (!handler) {
      throw new Error(`No mock response for schema: ${request.schemaName}`);
    }

    return handler(request);
  }
}
