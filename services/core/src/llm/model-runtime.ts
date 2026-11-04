import { OpenAiCompatibleProvider } from "@nexus/llm";
import type { LlmProvider } from "@nexus/llm";
import { CrossExaminationService } from "../arena/cross-examination";
import { ProviderAgentRunner } from "../arena/provider-agent-runner";
import type { WebSearchProvider } from "../arena/web-search";
import type { AgentRunner } from "../arena/agent-runner";
import type { ModelConfigStore, ModelSettings } from "./model-config-store";

/**
 * Turns whatever is currently configured into the objects the arena needs.
 *
 * Everything here is rebuilt from `ModelConfigStore` on demand and cached by
 * the configuration's fingerprint. That is what makes a key typed into the
 * settings page take effect on the next run instead of on the next restart:
 * the arena holds one delegating runner forever, and the runner asks this class
 * which concrete provider to use *now*.
 *
 * When nothing is configured, every accessor throws `ModelNotConfiguredError`
 * rather than falling back to fixtures. A silent fallback is how a product ends
 * up reporting a made-up conclusion about a project the model never saw.
 */

export class ModelNotConfiguredError extends Error {
  readonly code = "MODEL_NOT_CONFIGURED";
  readonly httpStatus = 409;

  constructor() {
    super(
      "还没有配置模型。请先在「模型设置」里填写服务商、接口地址、API 密钥和模型名称，之后再发起评审或提炼主张。"
    );
    this.name = "ModelNotConfiguredError";
  }
}

type Built = {
  fingerprint: string;
  settings: ModelSettings;
  provider: LlmProvider;
  runner: ProviderAgentRunner;
};

function fingerprintOf(settings: ModelSettings): string {
  // The key is part of the fingerprint on purpose: changing only the key must
  // rebuild the provider, otherwise a rotated key would keep failing with the
  // old one until the process restarted.
  return [settings.baseUrl, settings.apiKey, settings.model].join("\u0000");
}

export class ModelRuntime {
  #built: Built | null = null;

  constructor(
    private readonly store: ModelConfigStore,
    /**
     * 读某个会话已登记的人工材料。换模型不该丢掉这条能力，所以它跟着
     * runtime 走，而不是挂在某一次构建出来的 provider 上。
     */
    private readonly readMaterials?: (
      sessionId: string
    ) => Promise<
      readonly { title: string; content: string; round: number }[]
    >,
    /**
     * 外部检索。没配就是 null，runner 里连"来源"两个字都不会出现。
     * 它和 readMaterials 一样跟着 runtime 走：换模型不该把检索丢掉。
     */
    private readonly search?: WebSearchProvider | null
  ) {}

  settings(): ModelSettings | null {
    return this.store.get();
  }

  isConfigured(): boolean {
    const settings = this.store.get();
    return settings !== null && settings.apiKey.length > 0;
  }

  #build(): Built {
    const settings = this.store.get();
    if (!settings) {
      throw new ModelNotConfiguredError();
    }
    const fingerprint = fingerprintOf(settings);
    if (this.#built && this.#built.fingerprint === fingerprint) {
      return this.#built;
    }
    const provider = new OpenAiCompatibleProvider({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model
    });
    this.#built = {
      fingerprint,
      settings,
      provider,
      runner: new ProviderAgentRunner(
        provider,
        this.readMaterials,
        this.search
      )
    };
    return this.#built;
  }

  runner(): AgentRunner {
    return this.#build().runner;
  }

  /**
   * The challenger half of the arena needs the concrete provider runner (it
   * creates one agent run per challenger), not the `AgentRunner` interface.
   */
  providerRunner(): ProviderAgentRunner {
    return this.#build().runner;
  }

  createCrossExamination(): CrossExaminationService {
    const runner = this.#build().runner;
    return new CrossExaminationService(runner.createChallengeDependencies());
  }

  createChallengePlans(
    ...args: Parameters<ProviderAgentRunner["createChallengePlans"]>
  ): ReturnType<ProviderAgentRunner["createChallengePlans"]> {
    return this.#build().runner.createChallengePlans(...args);
  }

  /**
   * Claim extraction and citation review capture their provider at construction
   * time, so they get this stable wrapper instead of a concrete instance. Its
   * `generate()` resolves the current provider on every call, which means those
   * two services keep working across a key change without being rebuilt.
   */
  extractionProvider(): LlmProvider {
    const runtime = this;
    return {
      async generate(request, signal) {
        return runtime.#build().provider.generate(request, signal);
      }
    };
  }

  /** Name and model recorded with an extraction run, so a result is traceable. */
  extractionDescriptor(): { name: string; model: string } {
    const settings = this.store.get();
    if (!settings) {
      throw new ModelNotConfiguredError();
    }
    return { name: settings.providerLabel, model: settings.model };
  }
}

export type ProbeResult = {
  ok: boolean;
  /** HTTP status from the endpoint, or null when the request never completed. */
  status: number | null;
  /** Operator-facing reason when `ok` is false. Never contains the key. */
  message: string;
  /** Round-trip in milliseconds. */
  elapsedMs: number;
};

/**
 * Sends the smallest possible completion request to prove a configuration
 * works, before the operator commits it.
 *
 * It is deliberately not "save then try": a wrong key saved silently would only
 * surface later, in the middle of a five-role run, after the first two claims
 * had already been written.
 */
export async function probeModelEndpoint(
  settings: ModelSettings,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify({
          model: settings.model,
          max_tokens: 8,
          temperature: 0,
          messages: [{ role: "user", content: "reply with the single word: ok" }]
        })
      }
    );
    const elapsedMs = Date.now() - startedAt;
    if (response.ok) {
      return { ok: true, status: response.status, message: "连接成功。", elapsedMs };
    }
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      message: explainProbeFailure(response.status, body, settings),
      elapsedMs
    };
  } catch (cause) {
    const elapsedMs = Date.now() - startedAt;
    const aborted =
      controller.signal.aborted ||
      (cause instanceof DOMException && cause.name === "AbortError");
    return {
      ok: false,
      status: null,
      message: aborted
        ? `在 ${Math.round(timeoutMs / 1000)} 秒内没有收到响应。检查接口地址是否可达，或换一个更快的服务商。`
        : `无法连接这个地址：${describeNetworkError(cause)}`,
      elapsedMs
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turns an upstream error into something an operator can act on, without
 * echoing anything the endpoint sent back verbatim — an error body from a
 * misrouted request can contain the request headers, and the request headers
 * contain the key.
 */
function explainProbeFailure(
  status: number,
  body: string,
  settings: ModelSettings
): string {
  const suffix =
    body.length > 0 ? `（服务端返回了 ${body.length} 字节内容，未在此显示）` : "";
  if (status === 401 || status === 403) {
    return `密钥被拒绝（${status}）。请确认这个密钥属于 ${settings.providerLabel}，并且有调用 ${settings.model} 的权限。`;
  }
  if (status === 404) {
    return `找不到接口（404）。接口地址通常需要以 /v1 结尾，例如 https://api.deepseek.com/v1 。${suffix}`;
  }
  if (status === 429) {
    return "被限流（429）。密钥本身有效，但当前额度或频率已到上限。";
  }
  if (status >= 500) {
    return `服务商侧故障（${status}）。密钥大概率没问题，稍后重试。${suffix}`;
  }
  return `请求被拒绝（${status}）。${suffix}`;
}

function describeNetworkError(cause: unknown): string {
  if (!(cause instanceof Error)) {
    return String(cause);
  }
  const code = (cause as { cause?: { code?: string } }).cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "域名解析失败，检查地址里的域名是否拼错。";
  }
  if (code === "ECONNREFUSED") {
    return "目标端口拒绝连接。如果这是本机模型，确认它已经启动。";
  }
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return "TLS 证书有问题，检查地址或代理。";
  }
  return cause.message;
}
