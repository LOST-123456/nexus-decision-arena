"use client";

import Link from "next/link";
import { AuthUserBadge } from "../../components/auth-user-badge";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import {
  createSession,
  getCurrentUser,
  getRuntimeInfo,
  startSession,
  type RuntimeInfo,
  type AuthUser,
} from "./api-client";

const initialValues = {
  name: "",
  summary: "",
  targetUsers: "",
  businessModel: "",
  expectedData: "",
  locale: "zh-CN" as const
};

type FormValues = {
  name: string;
  summary: string;
  targetUsers: string;
  businessModel: string;
  expectedData: string;
  locale: "zh-CN" | "en-US";
};

export function NewSessionForm() {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(initialValues);
  const [status, setStatus] = useState<
    "idle" | "creating" | "starting" | "opening"
  >("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null | undefined>(undefined);

  const pending = status !== "idle";
  const liveModelReady = runtimeInfo?.mode === "openai-compatible";
  const canReview = currentUser?.role === "owner" || currentUser?.role === "reviewer";

  useEffect(() => {
    getCurrentUser()
      .then(setCurrentUser)
      .catch(() => setCurrentUser(null));

    const copied = window.localStorage.getItem("nexus:project-copy");
    if (copied) {
      try {
        const parsed = JSON.parse(copied) as Partial<FormValues>;
        setValues((current) => ({ ...current, ...parsed, locale: parsed.locale ?? current.locale }));
      } finally {
        window.localStorage.removeItem("nexus:project-copy");
      }
    }

    getRuntimeInfo()
      .then((runtime) => {
        setRuntimeInfo(runtime);
        setRuntimeError(null);
      })
      .catch((error: unknown) => {
        setRuntimeError(
          error instanceof Error ? error.message : "Runtime mode unavailable"
        );
      });
  }, []);

  function updateField(
    field: keyof FormValues,
    value: FormValues[keyof FormValues]
  ): void {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) {
      return;
    }

    if (!liveModelReady) {
      setErrorMessage(
        "Mock Mode 只用于固定演示。请切换 openai-compatible 真实模型模式后再创建任意项目。"
      );
      return;
    }

    setErrorMessage(null);
    if (!canReview) {
      setErrorMessage("请先登录 Owner 或 Reviewer 账户后再创建评审。");
      return;
    }

    setCreatedSessionId(null);

    try {
      setStatus("creating");
      const created = await createSession(
        {
          project: {
            name: values.name.trim(),
            summary: values.summary.trim(),
            targetUsers: values.targetUsers.trim(),
            businessModel: values.businessModel.trim(),
            expectedData: values.expectedData.trim()
          },
          locale: values.locale
        },
        window.crypto.randomUUID()
      );
      setCreatedSessionId(created.id);

      setStatus("starting");
      await startSession(created.id, window.crypto.randomUUID());

      setStatus("opening");
      router.push(`/sessions/${created.id}`);
    } catch (error) {
      setStatus("idle");
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "新建评审失败，请稍后重试。"
      );
    }
  }

  return (
    <main className="new-session-shell">
      <header className="new-session-header">
        <Link className="brand-lockup brand-lockup-compact" href="/">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <span>
            <strong>Nexus Decision Arena</strong>
            <small>NEW DECISION REVIEW</small>
          </span>
        </Link>
        <AuthUserBadge />
        <Link className="header-secondary-link" href="/sessions/demo">
          查看固定演示
        </Link>
      </header>

      <div className="new-session-layout">
        <section className="new-session-intro">
          <p className="eyebrow">PROJECT INTAKE</p>
          <h1>创建一次新的 AI 决策评审</h1>
          <p>
            填写待评审项目。系统将创建独立 session，启动五个 AI 角色并行分析，
            随后进入交叉质询、冲突检测与人工检查点。
          </p>
          <ol>
            <li>
              <span>01</span>
              <strong>创建会话</strong>
              <small>项目资料写入 PostgreSQL</small>
            </li>
            <li>
              <span>02</span>
              <strong>启动 Arena</strong>
              <small>五角色并行形成 Claim 与 Evidence</small>
            </li>
            <li>
              <span>03</span>
              <strong>进入工作区</strong>
              <small>通过 SSE 实时查看质询和冲突</small>
            </li>
          </ol>
          <div className="new-session-note">
            <strong>运行条件</strong>
            <p>
              任意新项目必须使用真实模型模式。Mock Mode 只用于固定演示；
              当前模式：{runtimeInfo?.mode ?? "detecting"} / {runtimeInfo?.model ?? "..."}。
            </p>
            {runtimeError ? <p className="new-session-runtime-error">{runtimeError}</p> : null}
            {currentUser === null ? <p className="new-session-runtime-error">请先登录 Owner 或 Reviewer 账户。</p> : null}
          </div>
        </section>

        <form
          className="new-session-form"
          onSubmit={handleSubmit}
          aria-label="创建新的决策评审"
        >
          <div className="form-heading">
            <div>
              <p className="eyebrow">PROJECT BRIEF</p>
              <h2>项目基本信息</h2>
            </div>
            <span
              className={`form-status ${
                !runtimeInfo
                  ? "form-status-checking"
                  : liveModelReady
                    ? "form-status-ready"
                    : "form-status-blocked"
              }`}
            >
              {!runtimeInfo
                ? "CHECKING RUNTIME"
                : liveModelReady
                  ? "REAL MODEL READY"
                  : "MOCK MODE BLOCKED"}
            </span>
          </div>

          <label>
            <span>项目名称</span>
            <input
              required
              maxLength={120}
              value={values.name}
              onChange={(event) => updateField("name", event.target.value)}
              placeholder="例如：高校实验室 AI 危化品安全平台"
              disabled={pending}
            />
          </label>

          <label>
            <span>项目简介</span>
            <textarea
              required
              rows={4}
              maxLength={800}
              value={values.summary}
              onChange={(event) => updateField("summary", event.target.value)}
              placeholder="产品解决什么问题，核心方案是什么？"
              disabled={pending}
            />
          </label>

          <label>
            <span>目标用户</span>
            <textarea
              required
              rows={2}
              maxLength={400}
              value={values.targetUsers}
              onChange={(event) =>
                updateField("targetUsers", event.target.value)
              }
              placeholder="谁使用、谁采购、谁做最终决策？"
              disabled={pending}
            />
          </label>

          <label>
            <span>商业模式</span>
            <textarea
              required
              rows={2}
              maxLength={400}
              value={values.businessModel}
              onChange={(event) =>
                updateField("businessModel", event.target.value)
              }
              placeholder="收入来源、定价方式和交付模式"
              disabled={pending}
            />
          </label>

          <label>
            <span>预期数据与目标</span>
            <textarea
              required
              rows={2}
              maxLength={400}
              value={values.expectedData}
              onChange={(event) =>
                updateField("expectedData", event.target.value)
              }
              placeholder="例如：24 个月覆盖 200 家客户，ARR 1600 万元"
              disabled={pending}
            />
          </label>

          <label>
            <span>报告语言</span>
            <select
              value={values.locale}
              onChange={(event) =>
                updateField("locale", event.target.value as FormValues["locale"])
              }
              disabled={pending}
            >
              <option value="zh-CN">简体中文</option>
              <option value="en-US">English</option>
            </select>
          </label>

          {errorMessage ? (
            <div className="new-session-error" role="alert">
              <strong>创建失败</strong>
              <p>{errorMessage}</p>
              {createdSessionId ? (
                <Link href={`/sessions/${createdSessionId}`}>
                  会话已创建，尝试打开
                </Link>
              ) : null}
            </div>
          ) : null}

          <button
            className="new-session-submit"
            type="submit"
            disabled={pending || !liveModelReady || !canReview}
            data-testid="start-review"
          >
            {pending ? "正在启动评审..." : !canReview ? "需要登录 Reviewer" : liveModelReady ? "开始评审" : "需要真实模型模式"}
            <span aria-hidden="true">→</span>
          </button>
        </form>
      </div>
    </main>
  );
}
