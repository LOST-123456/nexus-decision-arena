export type LlmRequest = {
  schemaName: string;
  system: string;
  user: string;
  correlationId: string;
};

export interface LlmProvider {
  generate(request: LlmRequest, signal: AbortSignal): Promise<string>;
}

export function withLlmTimeout(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(45_000);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
