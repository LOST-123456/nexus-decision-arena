import { withLlmTimeout } from "./provider";
import type { LlmProvider, LlmRequest } from "./provider";

type OpenAiCompatibleOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
};

export class OpenAiCompatibleProvider implements LlmProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(
    request: LlmRequest,
    signal: AbortSignal
  ): Promise<string> {
    const effectiveSignal = withLlmTimeout(signal);
    const response = await this.fetchImpl(
      `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        signal: effectiveSignal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          "x-correlation-id": request.correlationId
        },
        body: JSON.stringify({
          model: this.options.model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user }
          ]
        })
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const diagnostic = body.trim().slice(0, 2_000);
      throw new Error(
        `LLM request failed with status ${response.status}${diagnostic ? `: ${diagnostic}` : ""}`
      );
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("LLM response did not contain message content");
    }
    return content;
  }
}
