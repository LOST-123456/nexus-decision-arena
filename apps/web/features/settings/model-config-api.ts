/** 模型配置：读写、试连、清除。所有调用都是 Owner 权限，服务端会拒绝其他角色。 */

export type ModelConfigView = {
  configured: boolean;
  providerLabel: string | null;
  baseUrl: string | null;
  model: string | null;
  /** 只有末四位，用来分辨两把钥匙，不足以当钥匙用。 */
  apiKeyHint: string | null;
  updatedAt: string | null;
  /** 没配置时前端拿它决定主按钮是否可点。 */
  canRunAnalysis: boolean;
};

export type ModelConfigInput = {
  providerLabel: string;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type ProbeResult = {
  ok: boolean;
  status: number | null;
  message: string;
  elapsedMs: number;
};

export class ModelConfigRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 服务端给的机器可读原因，例如 PROBE_FAILED。 */
    readonly code?: string,
    readonly probe?: ProbeResult
  ) {
    super(message);
    this.name = "ModelConfigRequestError";
  }
}

async function readError(
  response: Response,
  fallback: string
): Promise<ModelConfigRequestError> {
  const payload = (await response.json().catch(() => null)) as
    | { message?: string; error?: string; code?: string; probe?: ProbeResult }
    | null;
  // core 的错误体里 `error` 恒为套话，真正的原因在 `message`。
  return new ModelConfigRequestError(
    payload?.message ?? payload?.error ?? fallback,
    response.status,
    payload?.code,
    payload?.probe
  );
}

export async function getModelConfig(): Promise<ModelConfigView> {
  const response = await fetch("/api/model-config", { cache: "no-store" });
  if (!response.ok) {
    throw await readError(response, `读取模型配置失败（${response.status}）`);
  }
  return (await response.json()) as ModelConfigView;
}

/** `verify` 为 false 时后端直接保存，不做连通性检查；默认是检查。 */
export async function saveModelConfig(
  input: ModelConfigInput,
  options: { verify: boolean }
): Promise<ModelConfigView> {
  const response = await fetch("/api/model-config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, verify: options.verify })
  });
  if (!response.ok) {
    throw await readError(response, `保存模型配置失败（${response.status}）`);
  }
  return (await response.json()) as ModelConfigView;
}

export async function testModelConfig(
  input: ModelConfigInput
): Promise<ProbeResult> {
  const response = await fetch("/api/model-config/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const payload = (await response.json().catch(() => null)) as
    | (ProbeResult & { message?: string })
    | null;
  if (!response.ok) {
    throw await readError(response, `测试连接失败（${response.status}）`);
  }
  return payload as ProbeResult;
}

export async function clearModelConfig(): Promise<ModelConfigView> {
  const response = await fetch("/api/model-config", { method: "DELETE" });
  if (!response.ok) {
    throw await readError(response, `清除模型配置失败（${response.status}）`);
  }
  return (await response.json()) as ModelConfigView;
}

/**
 * 常见服务商的默认值。只做填写提示，不代替用户的判断：地址和模型名都可以改。
 * 本机 Ollama 那一项故意放在最后——它不是"云端服务商"，填错密钥也没关系。
 */
export const MODEL_PRESETS: ReadonlyArray<{
  label: string;
  baseUrl: string;
  model: string;
  note: string;
}> = [
  {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    note: "国内直连，价格低。密钥在 platform.deepseek.com 申请。"
  },
  {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    note: "需要能访问 api.openai.com。"
  },
  {
    label: "通义千问（阿里云百炼）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    note: "用百炼的兼容模式地址，模型名以控制台为准。"
  },
  {
    label: "本机 Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:3b",
    note: "需要先 ollama pull 对应模型。密钥随便填，本机不校验。"
  }
];
