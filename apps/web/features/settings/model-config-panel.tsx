"use client";

import { useCallback, useEffect, useState } from "react";
import {
  MODEL_PRESETS,
  ModelConfigRequestError,
  clearModelConfig,
  getModelConfig,
  saveModelConfig,
  testModelConfig,
  type ModelConfigView,
  type ProbeResult
} from "./model-config-api";

/**
 * 模型配置面板。
 *
 * 三条产品规则写在这个组件的注释里，因为它们决定了界面上每个字：
 *
 *  1. **没有密钥就不许分析。** 保存成功后 `canRunAnalysis` 才为 true，新建评审和
 *     提炼主张才会放行。之前的行为是"没配置也照跑，只是吐固定样例"——那是把
 *     配置缺失伪装成功能可用，比直接报错更糟。
 *  2. **密钥不回显。** 保存后输入框清空，状态区只显示末四位。服务端根本不会把
 *     明文还给浏览器，所以这里也没有"显示密码"按钮——不是隐藏，是拿不到。
 *  3. **落盘是明文，必须说清楚。** 见下方隐私声明。产品不会把密钥发到别处，但
 *     能读这台机器文件的人仍然读得到。把它写成"只有你能看到"就是在骗人。
 */

type Status = "idle" | "loading" | "saving" | "testing" | "clearing";

const EMPTY_FORM = { providerLabel: "", baseUrl: "", apiKey: "", model: "" };

export function ModelConfigPanel() {
  const [view, setView] = useState<ModelConfigView | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const next = await getModelConfig();
      setView(next);
      setForbidden(false);
      // 只在没有配置时预填一套默认值，避免覆盖已有配置的展示。
      const preset = MODEL_PRESETS[0];
      if (!next.configured && preset) {
        setForm({
          providerLabel: preset.label,
          baseUrl: preset.baseUrl,
          apiKey: "",
          model: preset.model
        });
      }
    } catch (cause) {
      if (cause instanceof ModelConfigRequestError && cause.status === 403) {
        setForbidden(true);
      } else {
        setError(cause instanceof Error ? cause.message : "读取模型配置失败。");
      }
    } finally {
      setStatus("idle");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const applyPreset = (label: string) => {
    const preset = MODEL_PRESETS.find((item) => item.label === label);
    if (!preset) {
      return;
    }
    setForm((current) => ({
      ...current,
      providerLabel: preset.label,
      baseUrl: preset.baseUrl,
      model: preset.model
    }));
    setProbe(null);
    setError(null);
    setNotice(null);
  };

  const input = () => ({
    providerLabel: form.providerLabel.trim(),
    baseUrl: form.baseUrl.trim(),
    apiKey: form.apiKey.trim(),
    model: form.model.trim()
  });

  const runTest = async () => {
    const payload = input();
    // 空提交不能静默返回：按钮看起来可用，点下去什么都不发生，就是"点了没反应"。
    if (!payload.providerLabel) {
      setError("请选择或填写服务商名称。");
      return;
    }
    if (!payload.baseUrl) {
      setError("请填写接口地址，例如 https://api.deepseek.com/v1 。");
      return;
    }
    if (!payload.apiKey) {
      setError("请填写 API 密钥。测试连接需要用真实密钥发一次最小请求。");
      return;
    }
    if (!payload.model) {
      setError("请填写模型名称，例如 deepseek-chat 。");
      return;
    }
    setStatus("testing");
    setError(null);
    setNotice(null);
    setProbe(null);
    try {
      const result = await testModelConfig(payload);
      setProbe(result);
    } catch (cause) {
      if (cause instanceof ModelConfigRequestError) {
        setError(cause.message);
        if (cause.probe) {
          setProbe(cause.probe);
        }
      } else {
        setError(cause instanceof Error ? cause.message : "测试连接失败。");
      }
    } finally {
      setStatus("idle");
    }
  };

  const save = async (verify: boolean) => {
    const payload = input();
    if (!payload.providerLabel || !payload.baseUrl || !payload.apiKey || !payload.model) {
      setError("四项都要填：服务商、接口地址、API 密钥、模型名称。");
      return;
    }
    setStatus("saving");
    setError(null);
    setNotice(null);
    try {
      const next = await saveModelConfig(payload, { verify });
      setView(next);
      setProbe(null);
      setForm((current) => ({ ...current, apiKey: "" }));
      setNotice(
        verify
          ? "已保存并启用。下一轮评审会直接用这个模型，不需要重启。"
          : "已保存，但跳过了连通性检查。第一次真实评审时如果失败，原因会显示在会话页。"
      );
    } catch (cause) {
      if (cause instanceof ModelConfigRequestError) {
        setError(cause.message);
        if (cause.probe) {
          setProbe(cause.probe);
        }
      } else {
        setError(cause instanceof Error ? cause.message : "保存模型配置失败。");
      }
    } finally {
      setStatus("idle");
    }
  };

  const clear = async () => {
    // 清除会立刻让两个功能变成不可用，所以必须确认，而且要说清后果。
    const confirmed =
      typeof window !== "undefined" &&
      window.confirm(
        "清除后，新建评审和提炼主张会立刻不可用（已有的会话和报告不受影响）。确定清除吗？"
      );
    if (!confirmed) {
      return;
    }
    setStatus("clearing");
    setError(null);
    setNotice(null);
    try {
      const next = await clearModelConfig();
      setView(next);
      setForm(EMPTY_FORM);
      setProbe(null);
      setNotice("已清除模型配置。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "清除模型配置失败。");
    } finally {
      setStatus("idle");
    }
  };

  if (forbidden) {
    return (
      <p className="model-config-forbidden" role="alert">
        只有 Owner 账号能配置模型。模型地址决定了五个角色把项目资料发到哪里，
        这个权限比"发起评审"更大，所以不开放给 Reviewer 和 Viewer。
      </p>
    );
  }

  const busy = status !== "idle";
  const configured = view?.configured === true;

  return (
    <section className="model-config" aria-labelledby="model-config-title">
      <header className="model-config-head">
        <p className="model-config-eyebrow">MODEL SETTINGS</p>
        <h1 id="model-config-title">模型设置</h1>
        <p className="model-config-lede">
          这个产品不内置模型，也不替任何人垫付调用费用。要发起评审或提炼主张，
          必须先在这里填入你自己的模型接口和密钥。
        </p>
      </header>

      {view === null ? (
        /**
         * 还没读到配置时不要先说"尚未配置"。页面是静态渲染的，这一块在客户端
         * 取回数据前会先出现；如果那时写"尚未配置"，一个已经配好模型的部署会
         * 在被读到的第一秒里说谎。
         */
        <div className="model-config-state">
          <p className="model-config-state-title">正在读取当前配置…</p>
        </div>
      ) : (
        <div className={`model-config-state ${configured ? "is-ready" : "is-empty"}`}>
          <p className="model-config-state-title">
            {configured ? "已配置，可以开始分析" : "尚未配置，分析功能不可用"}
          </p>
          {configured ? (
            <dl className="model-config-deflist">
              <div>
                <dt>服务商</dt>
                <dd>{view.providerLabel}</dd>
              </div>
              <div>
                <dt>模型</dt>
                <dd>{view.model}</dd>
              </div>
              <div>
                <dt>接口地址</dt>
                <dd>{view.baseUrl}</dd>
              </div>
              <div>
                <dt>密钥</dt>
                <dd>{view.apiKeyHint}（只显示末四位）</dd>
              </div>
              <div>
                <dt>更新时间</dt>
                <dd>{view.updatedAt?.replace("T", " ").slice(0, 19)}</dd>
              </div>
            </dl>
          ) : (
            <p className="model-config-state-body">
              现在点「开始评审」或「提炼主张」不会产生任何分析。之前那种"照常跑完、
              但内容来自固定样例"的行为已经去掉——与其给一个假结论，不如直接说不能跑。
            </p>
          )}
        </div>
      )}

      <form
        className="model-config-form"
        data-testid="model-config-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save(true);
        }}
      >
        <div className="model-config-presets">
          <span className="model-config-presets-label">常见服务商</span>
          {MODEL_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="model-config-preset"
              onClick={() => applyPreset(preset.label)}
              disabled={busy}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <label className="model-config-field">
          <span>服务商名称</span>
          <input
            name="providerLabel"
            value={form.providerLabel}
            onChange={(event) =>
              setForm((current) => ({ ...current, providerLabel: event.target.value }))
            }
            placeholder="例如 DeepSeek"
            autoComplete="off"
            disabled={busy}
          />
          <small>只用于显示和记录，随便填。</small>
        </label>

        <label className="model-config-field">
          <span>接口地址</span>
          <input
            name="baseUrl"
            value={form.baseUrl}
            onChange={(event) =>
              setForm((current) => ({ ...current, baseUrl: event.target.value }))
            }
            placeholder="https://api.deepseek.com/v1"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <small>OpenAI 兼容地址，通常以 /v1 结尾。系统会请求它下面的 /chat/completions。</small>
        </label>

        <label className="model-config-field">
          <span>API 密钥</span>
          <input
            name="apiKey"
            type="password"
            value={form.apiKey}
            onChange={(event) =>
              setForm((current) => ({ ...current, apiKey: event.target.value }))
            }
            placeholder={configured ? "已保存，留空则不修改" : "sk-…"}
            autoComplete="new-password"
            spellCheck={false}
            disabled={busy}
          />
          <small>
            {configured
              ? "已经有一把密钥了。只在要更换时填写；留空表示沿用现有的。"
              : "你自己的密钥。保存后页面上只会显示末四位。"}
          </small>
        </label>

        <label className="model-config-field">
          <span>模型名称</span>
          <input
            name="model"
            value={form.model}
            onChange={(event) =>
              setForm((current) => ({ ...current, model: event.target.value }))
            }
            placeholder="deepseek-chat"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <small>必须和服务商文档里的模型标识完全一致。</small>
        </label>

        {error ? (
          <p className="model-config-error" role="alert">
            {error}
          </p>
        ) : null}
        {probe && !error ? (
          <p className={probe.ok ? "model-config-ok" : "model-config-error"} role="status">
            {probe.ok
              ? `连接成功，往返 ${probe.elapsedMs} 毫秒。`
              : `连接失败：${probe.message}`}
          </p>
        ) : null}
        {notice ? (
          <p className="model-config-notice" role="status">
            {notice}
          </p>
        ) : null}

        <div className="model-config-actions">
          <button type="submit" className="model-config-primary" disabled={busy}>
            {status === "saving" ? "正在保存…" : "保存并启用"}
          </button>
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={busy}
            data-testid="model-config-test"
          >
            {status === "testing" ? "正在测试…" : "测试连接"}
          </button>
          {configured ? (
            <>
              <button
                type="button"
                onClick={() => void save(false)}
                disabled={busy}
                data-testid="model-config-save-unverified"
              >
                跳过检查直接保存
              </button>
              <button
                type="button"
                className="model-config-danger"
                onClick={() => void clear()}
                disabled={busy}
                data-testid="model-config-clear"
              >
                清除配置
              </button>
            </>
          ) : null}
        </div>

        <p className="model-config-hint">
          保存时默认先发一次最小请求验证密钥。如果服务商不支持小样本请求而被误判，
          可以点「跳过检查直接保存」，失败原因会在第一次真实评审时显示。
        </p>
      </form>

      <section className="model-config-privacy" aria-labelledby="model-privacy-title">
        <h2 id="model-privacy-title">密钥去了哪里</h2>
        <ul>
          <li>
            <strong>只写在这台机器上。</strong>保存后落在项目目录的
            <code>.data/model-config.json</code>，文件权限 600（仅当前用户可读写）。
          </li>
          <li>
            <strong>不会回传到浏览器。</strong>接口只返回末四位；页面上的输入框在保存后清空。
            没有"显示密钥"按钮，因为服务端根本不会把明文发出来。
          </li>
          <li>
            <strong>不会进日志、报告、审计包。</strong>导出 Markdown、打印 PDF、下载审计包
            都不包含密钥；请求失败时的错误信息也只说状态码，不复述服务端返回体。
          </li>
          <li>
            <strong>只会发给你自己填的那个地址。</strong>系统唯一使用它的地方，
            就是向这个接口地址发 <code>chat/completions</code> 请求。
          </li>
          <li>
            <strong>它不是托管密钥，落盘是明文。</strong>说得准确一点：产品不会把它发到别处，
            但能登录这台机器并读到那个文件的人（例如服务器运维）仍然看得到。
            如果你不接受这一点，就不要在这台机器上填真实密钥。
          </li>
        </ul>
      </section>
    </section>
  );
}
