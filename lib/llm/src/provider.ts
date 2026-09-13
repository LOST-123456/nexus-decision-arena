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
  const configured = Number(process.env.LLM_TIMEOUT_MS ?? 45_000);
  const timeoutMs =
    Number.isFinite(configured) && configured > 0 ? configured : 45_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
