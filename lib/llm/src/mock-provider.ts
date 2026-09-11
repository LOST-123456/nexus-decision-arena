import { withLlmTimeout } from "./provider";
import type { LlmProvider, LlmRequest } from "./provider";

type MockHandler = (request: LlmRequest) => string | Promise<string>;

function abortable(
  promise: Promise<string>,
  signal: AbortSignal
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Generation aborted", "AbortError"));
      return;
    }

    const onAbort = () => {
      reject(new DOMException("Generation aborted", "AbortError"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

export class MockLlmProvider implements LlmProvider {
  constructor(private readonly handlers: Record<string, MockHandler>) {}

  async generate(
    request: LlmRequest,
    signal: AbortSignal
  ): Promise<string> {
    const effectiveSignal = withLlmTimeout(signal);

    if (effectiveSignal.aborted) {
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

    return abortable(
      Promise.resolve().then(() => handler(request)),
      effectiveSignal
    );
  }
}
