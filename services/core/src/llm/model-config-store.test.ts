import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ModelConfigStore,
  ModelSettingsError,
  maskApiKey,
  validateModelSettings
} from "./model-config-store";
import { ModelNotConfiguredError, ModelRuntime, probeModelEndpoint } from "./model-runtime";

const SETTINGS = {
  providerLabel: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-abcdef0123456789",
  model: "deepseek-chat"
};

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "nexus-model-"));
  return { store: new ModelConfigStore(join(dir, "model-config.json")), dir };
}

describe("validateModelSettings", () => {
  it("去掉结尾斜杠，避免拼出 //chat/completions", () => {
    const parsed = validateModelSettings({
      ...SETTINGS,
      baseUrl: "https://api.deepseek.com/v1/"
    });
    expect(parsed.baseUrl).toBe("https://api.deepseek.com/v1");
  });

  it("拒绝把密钥写进地址——那会被回显，也会进错误信息", () => {
    expect(() =>
      validateModelSettings({
        ...SETTINGS,
        baseUrl: "https://user:sk-secret@api.deepseek.com/v1"
      })
    ).toThrow(ModelSettingsError);
  });

  it("拒绝空密钥和空模型名", () => {
    expect(() => validateModelSettings({ ...SETTINGS, apiKey: "  " })).toThrow(
      /密钥/
    );
    expect(() => validateModelSettings({ ...SETTINGS, model: "" })).toThrow(/模型/);
  });

  it("拒绝不是 URL 的地址", () => {
    expect(() => validateModelSettings({ ...SETTINGS, baseUrl: "api.deepseek.com" })).toThrow(
      /URL/
    );
  });
});

describe("ModelConfigStore", () => {
  it("没配置时说 configured:false，而不是抛错", () => {
    const { store } = tempStore();
    expect(store.get()).toBeNull();
    expect(store.describe().configured).toBe(false);
    expect(store.describe().apiKeyHint).toBeNull();
  });

  it("保存后只回末四位，明文密钥不出现在任何返回字段里", () => {
    const { store } = tempStore();
    const view = store.save(SETTINGS);
    expect(view.configured).toBe(true);
    expect(view.apiKeyHint).toBe(maskApiKey(SETTINGS.apiKey));
    expect(view.apiKeyHint).not.toBe(SETTINGS.apiKey);
    // 整个返回对象序列化后都不该含明文密钥。
    expect(JSON.stringify(view)).not.toContain(SETTINGS.apiKey);
  });

  it("密钥确实落盘了（否则重启就丢），但文件里没有别的东西", () => {
    const { store, dir } = tempStore();
    store.save(SETTINGS);
    const raw = readFileSync(join(dir, "model-config.json"), "utf8");
    expect(raw).toContain(SETTINGS.apiKey);
    // 一个新手重开进程时要能原样读回来。
    const reloaded = new ModelConfigStore(join(dir, "model-config.json"));
    expect(reloaded.get()).toEqual(SETTINGS);
  });

  it("文件坏了要报错，不能装作没配置——那会让密钥凭空消失", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-model-"));
    const path = join(dir, "model-config.json");
    writeFileSync(path, "{ not json", "utf8");
    const store = new ModelConfigStore(path);
    expect(() => store.load()).toThrow(ModelSettingsError);
  });

  it("清除之后留下的是空文件，下次启动不能把它当成损坏的配置", () => {
    const { store, dir } = tempStore();
    store.save(SETTINGS);
    store.clear();
    // clear() 把文件内容清空而不是删文件，所以重启时必须把"空"读成"未配置"。
    const reloaded = new ModelConfigStore(join(dir, "model-config.json"));
    expect(() => reloaded.load()).not.toThrow();
    expect(reloaded.get()).toBeNull();
    expect(reloaded.describe().configured).toBe(false);
  });

  it("清除之后 canRunAnalysis 的依据跟着变", () => {
    const { store } = tempStore();
    store.save(SETTINGS);
    const runtime = new ModelRuntime(store);
    expect(runtime.isConfigured()).toBe(true);
    store.clear();
    expect(new ModelRuntime(store).isConfigured()).toBe(false);
  });
});

describe("ModelRuntime", () => {
  it("没配置时抛 ModelNotConfiguredError，而不是退回固定样例", () => {
    const { store } = tempStore();
    const runtime = new ModelRuntime(store);
    expect(() => runtime.runner()).toThrow(ModelNotConfiguredError);
    expect(() => runtime.extractionDescriptor()).toThrow(ModelNotConfiguredError);
  });

  it("保存之后同一个实例立刻能用，不需要重建 runtime", () => {
    const { store } = tempStore();
    const runtime = new ModelRuntime(store);
    expect(runtime.isConfigured()).toBe(false);
    store.save(SETTINGS);
    expect(runtime.isConfigured()).toBe(true);
    expect(runtime.extractionDescriptor()).toEqual({
      name: "DeepSeek",
      model: "deepseek-chat"
    });
  });

  it("只换密钥也会重建 provider——否则旧钥匙会一直用到重启", () => {
    const { store } = tempStore();
    const runtime = new ModelRuntime(store);
    store.save(SETTINGS);
    const first = runtime.providerRunner();
    store.save({ ...SETTINGS, apiKey: "sk-rotated-0000" });
    const second = runtime.providerRunner();
    expect(second).not.toBe(first);
  });

  it("配置没变就复用同一个 provider，不重复构造", () => {
    const { store } = tempStore();
    const runtime = new ModelRuntime(store);
    store.save(SETTINGS);
    expect(runtime.providerRunner()).toBe(runtime.providerRunner());
  });
});

describe("probeModelEndpoint", () => {
  const settings = SETTINGS;

  it("2xx 算连通，并带上往返耗时", async () => {
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calledUrl = String(url);
      return new Response("{}", { status: 200 });
    });
    const result = await probeModelEndpoint(settings, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.ok).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    // 请求确实发到了 baseUrl + /chat/completions
    expect(calledUrl).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("401 说清是密钥被拒，而且不复述服务端返回体", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"error":"invalid api key sk-abcdef0123456789"}', {
          status: 401
        })
    );
    const result = await probeModelEndpoint(settings, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("密钥被拒绝");
    // 服务端返回体里可能带着密钥，所以一个字都不能透传。
    expect(result.message).not.toContain("sk-abcdef0123456789");
  });

  it("404 提示地址可能少了 /v1", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    const result = await probeModelEndpoint(settings, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.message).toContain("/v1");
  });

  it("连不上时给出可操作的原因，而不是抛异常", async () => {
    const fetchImpl = vi.fn(async () => {
      const cause = Object.assign(new Error("fetch failed"), {
        cause: { code: "ENOTFOUND" }
      });
      throw cause;
    });
    const result = await probeModelEndpoint(settings, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("域名解析失败");
  });
});
