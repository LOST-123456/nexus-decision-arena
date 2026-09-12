import { describe, expect, it } from "vitest";
import { MockLlmProvider } from "./mock-provider";
import { OpenAiCompatibleProvider } from "./openai-compatible-provider";

describe("provider deadline enforcement", () => {
  it("cancels a pending mock handler with an AbortError", async () => {
    const never = () => new Promise<string>(() => {});
    const provider = new MockLlmProvider({ verdict: never });

    await expect(
      provider.generate(
        {
          schemaName: "verdict",
          system: "System.",
          user: "Answer.",
          correlationId: "correlation-cancel"
        },
        AbortSignal.timeout(20)
      )
    ).rejects.toThrow(DOMException);
  });

  it("bounds the OpenAI fetch signal when called directly", async () => {
    let passedSignal: AbortSignal | null = null;
    const fetchImpl = (async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      passedSignal = init?.signal ?? null;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test/v1/",
      apiKey: "test-key",
      model: "test-model",
      fetchImpl
    });

    const parent = new AbortController().signal;
    await provider.generate(
      {
        schemaName: "verdict",
        system: "System.",
        user: "Answer.",
        correlationId: "correlation-direct"
      },
      parent
    );

    expect(passedSignal).toBeInstanceOf(AbortSignal);
    expect(passedSignal).not.toBe(parent);
  });
  it("includes a bounded response body in non-2xx diagnostics", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ error: "rate limit exceeded", request_id: "req_1" }),
        {
          status: 429,
          headers: { "content-type": "application/json" }
        }
      )) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
      fetchImpl
    });

    await expect(
      provider.generate(
        {
          schemaName: "verdict",
          system: "System.",
          user: "Answer.",
          correlationId: "correlation-error"
        },
        new AbortController().signal
      )
    ).rejects.toThrow(/status 429.*rate limit exceeded/);
  });
});
