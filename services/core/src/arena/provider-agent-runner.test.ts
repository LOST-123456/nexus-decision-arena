import { describe, expect, it } from "vitest";
import { ClaimSchema, newId, type Claim } from "@nexus/shared";
import type { LlmProvider, LlmRequest } from "@nexus/llm";
import { DEFAULT_AGENT_ROLES } from "./default-roles";
import { ProviderAgentRunner } from "./provider-agent-runner";

/**
 * The provider path is where cancellation actually has to reach: a signal that
 * stops at the service layer leaves the HTTP request and the tokens flowing.
 * These tests hold that link in place.
 */

const ROLE = DEFAULT_AGENT_ROLES[0]!;
const CLAIM_ID = newId();
const SESSION_ID = newId();
const RUN_ID = newId();

const CLAIM: Claim = ClaimSchema.parse({
  id: CLAIM_ID,
  sessionId: SESSION_ID,
  lens: "research",
  statement: "Shipments grew 12% last quarter.",
  type: "fact",
  stance: "support",
  importance: 4,
  confidence: 0.5,
  evidenceIds: [],
  status: "proposed",
  rootClaimId: CLAIM_ID,
  revision: 1,
  relations: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
});

/** A provider that hangs until its signal is aborted, then rejects. */
function hangingProvider(): LlmProvider {
  return {
    generate: (_request: LlmRequest, signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Generation aborted", "AbortError")),
          { once: true }
        );
      })
  };
}

describe("ProviderAgentRunner · cancellation", () => {
  it("rejects instead of falling back when the run is aborted", async () => {
    const runner = new ProviderAgentRunner(hangingProvider());
    const dependencies = runner.createChallengeDependencies();
    const controller = new AbortController();

    const pending = dependencies.generateChallenge(ROLE, CLAIM, controller.signal);
    controller.abort();

    // The fallback draft is a legitimate answer to a provider *failure*. It is
    // the wrong answer to "stop": it would keep the work going after the
    // operator asked for it to end.
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("passes the caller's signal down to the provider, not a private one", async () => {
    let seen: AbortSignal | null = null;
    const provider: LlmProvider = {
      generate: (_request, signal) => {
        seen = signal;
        return Promise.reject(new Error("provider down"));
      }
    };
    const runner = new ProviderAgentRunner(provider);
    const controller = new AbortController();

    await runner
      .createChallengeDependencies()
      .generateChallenge(ROLE, CLAIM, controller.signal);

    expect(seen).not.toBeNull();
    expect(seen).toBe(controller.signal);
  });

  it("still falls back when the provider fails and nothing was cancelled", async () => {
    const provider: LlmProvider = {
      generate: () => Promise.reject(new Error("provider down"))
    };
    const runner = new ProviderAgentRunner(provider);

    const draft = await runner
      .createChallengeDependencies()
      .generateChallenge(ROLE, CLAIM);

    expect(draft.type).toBe("evidence_gap");
    expect(draft.requiredEvidence.length).toBeGreaterThan(0);
  });

  it("gives the analysis path a signal too, so no call is un-cancellable by accident", async () => {
    let seen: AbortSignal | null = null;
    const provider: LlmProvider = {
      generate: (_request, signal) => {
        seen = signal;
        return Promise.resolve(
          JSON.stringify({
            claims: [
              {
                statement: "需求证据不足",
                type: "assumption",
                stance: "oppose",
                importance: 5,
                confidence: 0.6,
                evidenceTitles: ["缺少采购记录"]
              }
            ]
          })
        );
      }
    };
    const runner = new ProviderAgentRunner(provider);

    await runner.run(ROLE, {
      sessionId: SESSION_ID,
      agentRunId: RUN_ID,
      projectInput: {}
    });

    expect(seen).not.toBeNull();
    // The analysis path has no per-run cancellation by design; what matters is
    // that it is a real signal object rather than an omitted argument.
    expect((seen as unknown as AbortSignal).aborted).toBe(false);
  });
});
