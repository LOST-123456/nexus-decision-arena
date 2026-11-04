import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Where the model credentials live.
 *
 * Three rules this file exists to enforce:
 *
 *  1. **The key never leaves this machine.** It is written to a file next to
 *     `.data/users.json` and is never sent anywhere except the model endpoint
 *     the operator themselves typed in.
 *  2. **The key is never read back out.** `describe()` — the only shape the API
 *     returns — carries a masked tail, never the value. Nothing here ever puts
 *     the key in a log line, an error message, or a run record.
 *  3. **A half-written file must not silently wipe the configuration.** Writes
 *     go through a temp file and a rename, the same discipline `AuthService`
 *     uses for accounts.
 *
 * The snapshot is held in memory so callers on a request path can read the
 * current settings synchronously. Saving replaces the snapshot, which is what
 * makes a new key take effect without restarting the process.
 */

export type ModelSettings = {
  /** Human label the operator picked, e.g. "deepseek". Free-form, display only. */
  providerLabel: string;
  /** OpenAI-compatible base URL, e.g. https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type ModelSettingsView = {
  configured: boolean;
  providerLabel: string | null;
  baseUrl: string | null;
  model: string | null;
  /** Last four characters only. Enough to tell two keys apart, useless as a key. */
  apiKeyHint: string | null;
  updatedAt: string | null;
};

export class ModelSettingsError extends Error {
  constructor(
    /** Machine-readable reason. The UI maps these to sentences. */
    readonly code:
      | "invalid_base_url"
      | "invalid_api_key"
      | "invalid_model"
      | "invalid_provider"
      | "unreadable_file",
    message: string
  ) {
    super(message);
    this.name = "ModelSettingsError";
  }
}

const FILE_VERSION = 1;

type StoredFile = {
  version: number;
  providerLabel: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  updatedAt: string;
};

/**
 * Only the tail is shown. A four-character tail of a 32+ character key says
 * which key it is without being enough to authenticate with.
 */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 4) {
    return "…";
  }
  return `…${trimmed.slice(-4)}`;
}

export function validateModelSettings(input: unknown): ModelSettings {
  if (typeof input !== "object" || input === null) {
    throw new ModelSettingsError("invalid_provider", "模型配置必须是一个对象。");
  }
  const record = input as Record<string, unknown>;

  const providerLabel = String(record.providerLabel ?? "").trim();
  if (providerLabel.length === 0) {
    throw new ModelSettingsError("invalid_provider", "请选择模型服务商。");
  }
  if (providerLabel.length > 60) {
    throw new ModelSettingsError("invalid_provider", "服务商名称过长。");
  }

  const rawBaseUrl = String(record.baseUrl ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new ModelSettingsError(
      "invalid_base_url",
      "接口地址必须是一个完整的 URL，例如 https://api.deepseek.com/v1 。"
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ModelSettingsError("invalid_base_url", "接口地址只支持 http 或 https。");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    // Credentials in the URL would be echoed back by `describe()` and would
    // also end up in the error text of a failed request. Keys belong in the
    // header, which is the only place that never gets rendered anywhere.
    throw new ModelSettingsError(
      "invalid_base_url",
      "请不要把密钥写进接口地址，密钥请填在下面的密钥框里。"
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new ModelSettingsError(
      "invalid_base_url",
      "接口地址不要带查询参数或锚点。"
    );
  }

  const apiKey = String(record.apiKey ?? "").trim();
  if (apiKey.length === 0) {
    throw new ModelSettingsError("invalid_api_key", "请填写 API 密钥。");
  }
  if (apiKey.length > 4096) {
    throw new ModelSettingsError("invalid_api_key", "API 密钥过长。");
  }
  // A pasted key often arrives wrapped in quotes or with a trailing newline.
  // Newlines are caught by trim; quotes are not.
  if (/[\r\n]/.test(apiKey)) {
    throw new ModelSettingsError("invalid_api_key", "API 密钥里含有换行，请重新复制。");
  }

  const model = String(record.model ?? "").trim();
  if (model.length === 0) {
    throw new ModelSettingsError("invalid_model", "请填写模型名称，例如 deepseek-chat。");
  }
  if (model.length > 200) {
    throw new ModelSettingsError("invalid_model", "模型名称过长。");
  }

  return {
    providerLabel,
    baseUrl: rawBaseUrl.replace(/\/+$/, ""),
    apiKey,
    model
  };
}

export class ModelConfigStore {
  #snapshot: { settings: ModelSettings; updatedAt: string } | null = null;
  #loaded = false;

  constructor(private readonly filePath: string) {}

  static defaultPath(root: string): string {
    return join(root, ".data", "model-config.json");
  }

  /**
   * Reads the file once. A missing file is not an error — it means "not
   * configured yet", which the UI has to render differently from "broken".
   * A file that exists but cannot be parsed *is* an error: silently treating a
   * corrupted file as "no configuration" would make an operator's key
   * disappear with no explanation.
   */
  load(): void {
    if (this.#loaded) {
      return;
    }
    this.#loaded = true;
    if (!existsSync(this.filePath)) {
      this.#snapshot = null;
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (cause) {
      throw new ModelSettingsError(
        "unreadable_file",
        `无法读取模型配置文件 ${this.filePath}：${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    /*
     * 空文件 = 没配置。`clear()` 故意把内容写成空串而不是删除文件（Windows 上
     * 删文件可能被别的句柄挡住，留一把真密钥在那里更糟），所以这里必须把"空"
     * 当成"未配置"，否则清除一次之后下次启动就会因为 parse 失败而拒绝启动。
     */
    if (raw.trim().length === 0) {
      this.#snapshot = null;
      return;
    }
    let parsed: StoredFile;
    try {
      parsed = JSON.parse(raw) as StoredFile;
    } catch {
      throw new ModelSettingsError(
        "unreadable_file",
        `模型配置文件 ${this.filePath} 不是合法 JSON。请修正或删除它后重新配置。`
      );
    }
    if (
      typeof parsed?.baseUrl !== "string" ||
      typeof parsed?.apiKey !== "string" ||
      typeof parsed?.model !== "string"
    ) {
      throw new ModelSettingsError(
        "unreadable_file",
        `模型配置文件 ${this.filePath} 缺少必要字段。请修正或删除它后重新配置。`
      );
    }
    this.#snapshot = {
      settings: {
        providerLabel: typeof parsed.providerLabel === "string" ? parsed.providerLabel : "custom",
        baseUrl: parsed.baseUrl,
        apiKey: parsed.apiKey,
        model: parsed.model
      },
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString()
    };
  }

  /** Current settings, or null when nothing has been configured. */
  get(): ModelSettings | null {
    this.load();
    return this.#snapshot?.settings ?? null;
  }

  /**
   * Everything the API is allowed to return. Deliberately has no `apiKey`
   * field at any point — the masked tail is computed here, so no caller can
   * accidentally serialise the real value.
   */
  describe(): ModelSettingsView {
    this.load();
    if (!this.#snapshot) {
      return {
        configured: false,
        providerLabel: null,
        baseUrl: null,
        model: null,
        apiKeyHint: null,
        updatedAt: null
      };
    }
    const { settings, updatedAt } = this.#snapshot;
    return {
      configured: true,
      providerLabel: settings.providerLabel,
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiKeyHint: maskApiKey(settings.apiKey),
      updatedAt
    };
  }

  save(settings: ModelSettings): ModelSettingsView {
    const updatedAt = new Date().toISOString();
    const payload: StoredFile = {
      version: FILE_VERSION,
      providerLabel: settings.providerLabel,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      updatedAt
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(temp, 0o600);
    } catch {
      // Windows has no POSIX mode bits worth arguing about. The file is inside
      // the project's own .data directory either way.
    }
    renameSync(temp, this.filePath);
    this.#loaded = true;
    this.#snapshot = { settings, updatedAt };
    return this.describe();
  }

  clear(): void {
    this.#loaded = true;
    this.#snapshot = null;
    if (existsSync(this.filePath)) {
      // Overwrite rather than unlink: on Windows an unlink can fail while a
      // backup tool holds a handle, and a leftover key file would be worse
      // than an empty one.
      writeFileSync(this.filePath, "", "utf8");
    }
  }
}
