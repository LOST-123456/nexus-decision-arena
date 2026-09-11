import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MockLlmProvider } from "./mock-provider";
import { generateStructured } from "./structured-output";

const ResultSchema = z.object({ answer: z.number().int() });

describe("structured generation", () => {
  it("parses a valid provider response", async () => {
    const provider = new MockLlmProvider({
      verdict: () => JSON.stringify({ answer: 42 })
    });

    const result = await generateStructured(
      provider,
      {
        schemaName: "verdict",
        system: "Return JSON.",
        user: "Answer.",
        correlationId: "correlation-1"
      },
      ResultSchema,
      new AbortController().signal
    );

    expect(result.data.answer).toBe(42);
    expect(result.repaired).toBe(false);
  });

  it("uses one repair prompt after invalid JSON", async () => {
    const next = vi
      .fn()
      .mockResolvedValueOnce('{"answer":"wrong"}')
      .mockResolvedValueOnce('{"answer":42}');
    const provider = new MockLlmProvider({ verdict: next });

    const result = await generateStructured(
      provider,
      {
        schemaName: "verdict",
        system: "Return JSON.",
        user: "Answer.",
        correlationId: "correlation-2"
      },
      ResultSchema,
      new AbortController().signal
    );

    expect(result.data.answer).toBe(42);
    expect(result.repaired).toBe(true);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("uses one repair prompt after malformed JSON", async () => {
    const next = vi
      .fn()
      .mockResolvedValueOnce("not-json")
      .mockResolvedValueOnce('{"answer":42}');
    const provider = new MockLlmProvider({ verdict: next });

    const result = await generateStructured(
      provider,
      {
        schemaName: "verdict",
        system: "Return JSON.",
        user: "Answer.",
        correlationId: "correlation-4"
      },
      ResultSchema,
      new AbortController().signal
    );

    expect(result.data.answer).toBe(42);
    expect(result.repaired).toBe(true);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("fails clearly after the repair attempt", async () => {
    const provider = new MockLlmProvider({
      verdict: () => '{"answer":"still-wrong"}'
    });

    await expect(
      generateStructured(
        provider,
        {
          schemaName: "verdict",
          system: "Return JSON.",
          user: "Answer.",
          correlationId: "correlation-3"
        },
        ResultSchema,
        new AbortController().signal
      )
    ).rejects.toThrow("Structured output validation failed");
  });
});
