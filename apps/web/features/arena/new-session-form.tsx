"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createSession,
  getCurrentUser,
  getRuntimeInfo,
  startSession,
  type RuntimeInfo,
  type AuthUser,
} from "./api-client";
import { ProjectBriefHints } from "./project-brief-hints";

const initialValues = {
  name: "",
  summary: "",
  targetUsers: "",
  businessModel: "",
  expectedData: "",
  locale: "zh-CN" as const
};

/**
 * 每个字段的上限，和输入框上的 maxLength 用同一份数字。
 *
 * 分开写两份的下场是它们会走散：输入框悄悄截断，而计数器还在说"没到顶"。
 */
const FIELD_LIMITS = {
  name: 120,
  summary: 800,
  targetUsers: 400,
  businessModel: 400,
  expectedData: 400
} as const;

const FIELD_LABELS: Record<keyof typeof FIELD_LIMITS, string> = {
  name: "项目名称",
  summary: "项目简介",
  targetUsers: "目标用户",
  businessModel: "商业模式",
  expectedData: "预期数据与目标"
};

const TEXT_FIELDS = Object.keys(FIELD_LIMITS) as Array<keyof typeof FIELD_LIMITS>;

/**
 * 草稿存在 sessionStorage，不是 localStorage。
 *
 * 理由：这是"这一个标签页里正在写的东西"，换标签页应该是干净的；而
 * localStorage 会让一个人在别的窗口"新建评审"时莫名带上上一次的内容。
 * sessionStorage 又恰好扛得住后退和刷新——那两种正是会丢字的场景。
 */
const DRAFT_KEY = "nexus:new-session-draft";

/**
 * Why this account cannot create a review — or `null` when we do not know yet.
 *
 * Three states, not two: not signed in, signed in without the role, and still
 * finding out. Telling a signed-in viewer that they need to "log in" is
 * wrong — the fix for them is a different account, not a new session.
 */
function reviewerBlockReason(
  user: AuthUser | null | undefined
): string | null {
  if (user === undefined) return null;
  if (user === null) {
    return "还没登录。先登录 Owner 或 Reviewer 账户，再回来创建评审。";
  }
  return `已经登录，但${user.displayName}（${user.role}）没有创建评审的权限——创建评审需要 Owner 或 Reviewer 账户。`;
}

type FormValues = {
  name: string;
  summary: string;
  targetUsers: string;
  businessModel: string;
  expectedData: string;
  locale: "zh-CN" | "en-US";
};

/**
 * 字段校验，自己做。
 *
 * 原来靠 `required` 让浏览器拦。问题不在拦，在于**它抢话**：一个没登录的人
 * 点提交，先看到五个"请填写此字段"，而真正的原因（你连账号都没有）根本没机会
 * 显示；而且气泡语言跟着浏览器走，中文站点里会弹一句英文。校验顺序应该由业务
 * 决定——身份 → 模型 → 字段——不该由 DOM 属性决定。
 */
function validateFields(
  values: FormValues
): Partial<Record<keyof FormValues, string>> {
  const errors: Partial<Record<keyof FormValues, string>> = {};
  for (const field of TEXT_FIELDS) {
    if (!values[field].trim()) {
      errors[field] = `请填写${FIELD_LABELS[field]}`;
    }
  }
  return errors;
}

/**
 * 字段下面的那行小字：已用字数 + 校验错误。
 *
 * 字数提示不是装饰。输入框上写着 maxLength，粘贴超长内容时浏览器**默默截断**，
 * 界面一声不响——用户以为自己贴进去了，其实后半段已经不在了。把用掉的字数摆在
 * 眼前，到顶时再明说一句，这类"我的字去哪了"就不会再有人问。
 */
function FieldMeta({
  value,
  limit,
  error,
  errorId
}: {
  value: string;
  limit: number;
  error?: string;
  errorId?: string;
}) {
  const used = value.length;
  const full = used >= limit;
  return (
    <>
      <div className="field-meta">
        <small
          className={`field-counter${full ? " field-counter-full" : ""}`}
        >
          {used}/{limit}
          {full ? " · 已达上限，多出的部分会被丢弃" : ""}
        </small>
      </div>
      {error ? (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/**
 * 一个字段：标题行（名称 + 必填标记）、控件、字数与错误。
 *
 * 必填标记放在 label **外面**是有意的：`getByLabelText("项目名称")`、屏幕阅读器
 * 报读的控件名、浏览器自动填充，靠的都是 label 自己的文字。把"必填"塞进去，
 * 它们会一起变成"项目名称必填"。
 */
function TextField({
  field,
  label,
  limit,
  value,
  onChange,
  placeholder,
  rows,
  disabled,
  error
}: {
  field: keyof typeof FIELD_LIMITS;
  label: string;
  limit: number;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows?: number;
  disabled: boolean;
  error?: string;
}) {
  const id = `new-session-${field}`;
  const errorId = `field-error-${field}`;
  const shared = {
    id,
    name: field,
    maxLength: limit,
    value,
    placeholder,
    disabled,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    "aria-invalid": error ? (true as const) : undefined,
    "aria-describedby": error ? errorId : undefined
  };
  return (
    <div className="new-session-field">
      <div className="field-head">
        <label htmlFor={id}>{label}</label>
        <i className="field-required" aria-hidden="true">
          必填
        </i>
      </div>
      {rows === undefined ? (
        <input {...shared} />
      ) : (
        <textarea {...shared} rows={rows} />
      )}
      <FieldMeta
        value={value}
        limit={limit}
        {...(error ? { error, errorId } : {})}
      />
    </div>
  );
}

export function NewSessionForm() {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(initialValues);
  const [status, setStatus] = useState<
    "idle" | "creating" | "starting" | "opening"
  >("idle");
  const [notice, setNotice] = useState<{
    kind: "blocked" | "failed";
    message: string;
    /** 拦住之后去哪儿解决。只写地址，不写"点击这里"——链接本身就是出口。 */
    actionHref?: string;
    actionLabel?: string;
  } | null>(null);
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null | undefined>(undefined);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof FormValues, string>>
  >({});
  const formRef = useRef<HTMLFormElement>(null);
  /**
   * 只有第一轮渲染才去读草稿。
   *
   * 不设这个闸门的话，用户清空一个字段、页面重渲染，effect 又跑一遍把
   * sessionStorage 里的旧值填回去——输入框会"自己长回来"。
   */
  const draftLoaded = useRef(false);

  const pending = status !== "idle";
  const liveModelReady = runtimeInfo?.mode === "openai-compatible";
  /**
   * Whether analysis is allowed to run at all.
   *
   * `undefined` means the core is older than this page and did not say; in that
   * case fall back to the old signal so a rolling deploy does not brick the
   * form. Anything explicit wins, including an explicit `false`.
   */
  const canRunAnalysis =
    runtimeInfo === null
      ? false
      : runtimeInfo.canRunAnalysis ?? liveModelReady;
  const canReview = currentUser?.role === "owner" || currentUser?.role === "reviewer";
  /**
   * Still resolving. Saying "you are not allowed" before we know who you are
   * would be answering a question nobody asked.
   */
  const resolving = currentUser === undefined || runtimeInfo === null;

  /**
   * 身份已经确定、而且这个人不能创建 → 整张表只读。
   *
   * 让一个没有权限的人把五栏认真填完、再告诉他不行，是最没必要的一次消耗。
   * 只读 + 顶部说明，比"能填但交不上去"诚实得多。
   */
  const formLocked = currentUser !== undefined && !canReview;

  /**
   * Why the form cannot be submitted yet — said in words, and said **before**
   * the click rather than only after it.
   *
   * The button used to be `disabled` in these states, which is why clicking it
   * did nothing at all: a disabled control swallows the click, so the sentence
   * that was already written for exactly this moment never got a chance to be
   * read. A blocked form is allowed to be blocked. It is not allowed to be mute.
   */
  const reviewerBlockedMessage = reviewerBlockReason(currentUser);

  useEffect(() => {
    getCurrentUser()
      .then(setCurrentUser)
      .catch(() => setCurrentUser(null));

    /*
     * 先把上一次没提交完的草稿接回来。
     *
     * 顺序在"复制来的项目简介"之前：那份是用户刚刚明确点的动作，应该覆盖草稿，
     * 而不是被草稿覆盖。
     */
    try {
      const draft = window.sessionStorage.getItem(DRAFT_KEY);
      if (draft) {
        const parsed = JSON.parse(draft) as Partial<FormValues>;
        setValues((current) => ({
          ...current,
          ...parsed,
          locale: parsed.locale === "en-US" ? "en-US" : "zh-CN"
        }));
      }
    } catch {
      /* 草稿坏了就当没有，不值得为它拦住一整个页面 */
    } finally {
      draftLoaded.current = true;
    }

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
          error instanceof Error ? error.message : "无法获取运行模式"
        );
      });
  }, []);

  /*
   * 每改一个字就存一次草稿。
   *
   * 不防抖是刻意的：这里要防的场景是"点了提交、跳走了、又按后退"，那种情况下
   * 最后一次输入和跳转之间可能只隔几十毫秒，防抖会把最后一段字丢掉。
   */
  useEffect(() => {
    if (!draftLoaded.current) return;
    try {
      window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(values));
    } catch {
      /* 隐私模式/配额满：存不下就存不下，不影响填表 */
    }
  }, [values]);

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

    if (resolving) {
      setNotice({
        kind: "blocked",
        message: "正在确认运行模式与登录状态，请稍候再试。"
      });
      return;
    }

    // The order matters. A visitor who is not signed in has to hear that
    // first: telling them about the model mode before they have an account
    // answers a question they did not ask.
    if (!canReview) {
      setNotice({
        kind: "blocked",
        message:
          reviewerBlockedMessage ??
          "请先登录 Owner 或 Reviewer 账户后再创建评审。",
        // 出口：没登录的去登录，登录错账号的去换账号。没有出口的拦截等于死胡同。
        ...(currentUser === null
          ? { actionHref: "/login", actionLabel: "去登录" }
          : { actionHref: "/login", actionLabel: "切换账号" })
      });
      return;
    }
    /*
     * 没有模型就拒绝，并且说清为什么、去哪儿解决。
     *
     * 这条规则和上一版相反，所以留个记号免得被改回去：上一版允许在没有
     * provider 的情况下创建，理由是"拦住会让整个入口变成死胡同"。真正的问题
     * 从来不在拦，而在拦得不出声。固定 fixture 会给出一个跟用户项目毫无关系的
     * 结论——用户以为模型分析过了，其实一个字都没进去。那比拦住更糟。
     *
     * 所以现在拦住，但把原因和出口放在按钮上方，不需要点一下才知道。
     */
    if (!canRunAnalysis) {
      setNotice({
        kind: "blocked",
        message:
          "还没有配置模型。请先到「模型设置」填入你自己的服务商、接口地址、API 密钥和模型名称；保存后这里立刻可用，不用重启。",
        actionHref: "/settings/model",
        actionLabel: "去配置模型"
      });
      return;
    }

    /*
     * 字段校验排在最后。
     *
     * 这一步以前是浏览器替我们做的，于是它永远第一个开口。现在身份和模型都
     * 确认过了，才轮到"哪一栏没填"——那时候这句话才是用户真正需要的那一句。
     */
    const errors = validateFields(values);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      const missing = TEXT_FIELDS.filter((field) => errors[field]);
      setNotice({
        kind: "blocked",
        message: `还有 ${missing.length} 项没填：${missing
          .map((field) => FIELD_LABELS[field])
          .join("、")}。`
      });
      const first = missing[0];
      const target = formRef.current?.querySelector<HTMLElement>(
        `[name="${first}"]`
      );
      target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      target?.focus();
      return;
    }
    setFieldErrors({});

    setNotice(null);

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

      /*
       * 先把人送到会话页，再让分析在后台跑。
       *
       * 上一版是 `await startSession(...)` 之后才 push，于是整轮五角色分析
       * （真实模型下几十秒到几分钟）全压在这个按钮上：页面一动不动，用户看到
       * 的就是「点了没反应」。更糟的是只要中间有一次模型调用失败，catch 会把
       * 状态退回 idle，人还停在新建表单上——而会话其实已经建好了。
       *
       * 现在顺序反过来：跳转是确定的，进度在会话页看（那里有阶段、计时、事件
       * 流）。万一启动真的失败，会话页的「开始评审」按钮可以重试，并显示原因。
       */
      setStatus("opening");
      // 会话已经落地，草稿不该再把人拽回上一次的项目。
      try {
        window.sessionStorage.removeItem(DRAFT_KEY);
      } catch {
        /* 清不掉不影响已经创建好的会话 */
      }
      const started = startSession(created.id, window.crypto.randomUUID());
      router.push(`/sessions/${created.id}`);
      // 不 await：错误由会话页兜底，不在这里挡住跳转。
      void started.catch(() => {});
    } catch (error) {
      setStatus("idle");
      setNotice({
        kind: "failed",
        message:
          error instanceof Error
            ? error.message
            : "新建评审失败，请稍后重试。"
      });
    }
  }

  return (
    <main id="main" tabIndex={-1} className="new-session-shell">
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
              <small>项目资料写入数据库</small>
            </li>
            <li>
              <span>02</span>
              <strong>启动竞技场</strong>
              <small>五个角色并行形成主张与证据</small>
            </li>
            <li>
              <span>03</span>
              <strong>进入工作区</strong>
              <small>实时查看质询和冲突</small>
            </li>
          </ol>
          <div className="new-session-note" id="new-session-runtime-note">
            <strong>运行条件</strong>
            <p>
              当前模式：{runtimeInfo?.provider ?? runtimeInfo?.mode ?? "detecting"} /{" "}
              {runtimeInfo?.model ?? "..."}。
              {formLocked
                ? "当前账号没有创建权限，这份表单是只读的，填了也交不上去。"
                : canRunAnalysis
                  ? "五个 AI 角色会真实分析你填写的项目资料。"
                  : "还没有可用模型，下面这个表单现在提交不了。"}
            </p>
            {canRunAnalysis ? null : (
              <p>
                先到「模型设置」填一次你自己的模型接口和密钥。密钥只保存在这台机器上，
                页面只显示末四位；没有它，产品不会假装分析过你的项目。
                <br />
                <Link className="new-session-runtime-error-link" href="/settings/model">
                  去配置模型
                </Link>
              </p>
            )}
            {runtimeError ? <p className="new-session-runtime-error">{runtimeError}</p> : null}
            {/*
              这里不再重复"请先登录"。表单顶部那块只读挡板已经说了同一件事，
              而且带着出口；同一页面上两个"去登录"只会让人多点一次。
            */}
          </div>
        </section>

        <form
          ref={formRef}
          className="new-session-form"
          onSubmit={handleSubmit}
          aria-label="创建新的决策评审"
          /*
           * 关掉浏览器原生校验。
           *
           * 它会在"你还没登录"之前抢着说"请填写此字段"，而且用的是浏览器语言。
           * 校验顺序改由 handleSubmit 决定：身份 → 模型 → 字段。
           */
          noValidate
        >
          <div className="form-heading">
            <div>
              <p className="eyebrow">PROJECT BRIEF</p>
              <h2>项目基本信息</h2>
              <p className="form-required-note">
                带「必填」标记的字段都要填；每栏下方显示已用字数。
              </p>
            </div>
            <span
              className={`form-status ${
                !runtimeInfo
                  ? "form-status-checking"
                  : canRunAnalysis && liveModelReady
                    ? "form-status-ready"
                    : "form-status-blocked"
              }`}
            >
              {!runtimeInfo
                ? "CHECKING RUNTIME"
                : canRunAnalysis && liveModelReady
                  ? "REAL MODEL READY"
                  : canRunAnalysis
                    ? "FIXTURE DEMO"
                    : "MODEL NOT CONFIGURED"}
            </span>
          </div>

          {formLocked ? (
            <div className="new-session-lock" role="status" data-testid="new-session-locked">
              <strong>
                {currentUser === null ? "还不能创建：请先登录" : "当前账号没有创建权限"}
              </strong>
              <p>
                {currentUser === null
                  ? "创建评审需要 Owner 或 Reviewer 账户。这份表单先设为只读，登录后回来可以直接填。"
                  : `你已经登录为 ${currentUser?.displayName ?? "?"}（${currentUser?.role ?? "?"}）。创建评审需要 Owner 或 Reviewer 账户，换一个账号再回来。`}
              </p>
              <Link href="/login">
                {currentUser === null ? "去登录" : "切换账号"}
              </Link>
            </div>
          ) : null}

          <TextField
            field="name"
            label="项目名称"
            limit={FIELD_LIMITS.name}
            value={values.name}
            onChange={(value) => updateField("name", value)}
            placeholder="例如：高校实验室 AI 危化品安全平台"
            disabled={pending || formLocked}
            {...(fieldErrors.name ? { error: fieldErrors.name } : {})}
          />

          {/*
            名称一有内容就出现：这时用户已经知道要做什么，卡点转移到"后面几栏
            写到什么颗粒度"。提示可复制、可折叠，且只填空栏。
          */}
          <ProjectBriefHints
            projectName={values.name}
            onFillEmpty={(templates) =>
              setValues((current) => ({
                ...current,
                summary: current.summary.trim() ? current.summary : templates.summary,
                targetUsers: current.targetUsers.trim()
                  ? current.targetUsers
                  : templates.targetUsers,
                businessModel: current.businessModel.trim()
                  ? current.businessModel
                  : templates.businessModel,
                expectedData: current.expectedData.trim()
                  ? current.expectedData
                  : templates.expectedData
              }))
            }
          />

          <TextField
            field="summary"
            label="项目简介"
            limit={FIELD_LIMITS.summary}
            value={values.summary}
            onChange={(value) => updateField("summary", value)}
            placeholder="产品解决什么问题，核心方案是什么？"
            rows={4}
            disabled={pending || formLocked}
            {...(fieldErrors.summary ? { error: fieldErrors.summary } : {})}
          />

          <TextField
            field="targetUsers"
            label="目标用户"
            limit={FIELD_LIMITS.targetUsers}
            value={values.targetUsers}
            onChange={(value) => updateField("targetUsers", value)}
            placeholder="谁使用、谁采购、谁做最终决策？"
            rows={2}
            disabled={pending || formLocked}
            {...(fieldErrors.targetUsers
              ? { error: fieldErrors.targetUsers }
              : {})}
          />

          <TextField
            field="businessModel"
            label="商业模式"
            limit={FIELD_LIMITS.businessModel}
            value={values.businessModel}
            onChange={(value) => updateField("businessModel", value)}
            placeholder="收入来源、定价方式和交付模式"
            rows={2}
            disabled={pending || formLocked}
            {...(fieldErrors.businessModel
              ? { error: fieldErrors.businessModel }
              : {})}
          />

          <TextField
            field="expectedData"
            label="预期数据与目标"
            limit={FIELD_LIMITS.expectedData}
            value={values.expectedData}
            onChange={(value) => updateField("expectedData", value)}
            placeholder="例如：24 个月覆盖 200 家客户，ARR 1600 万元"
            rows={2}
            disabled={pending || formLocked}
            {...(fieldErrors.expectedData
              ? { error: fieldErrors.expectedData }
              : {})}
          />

          <label>
            <span>报告语言</span>
            <select
              value={values.locale}
              onChange={(event) =>
                updateField("locale", event.target.value as FormValues["locale"])
              }
              disabled={pending || formLocked}
            >
              <option value="zh-CN">简体中文</option>
              <option value="en-US">English</option>
            </select>
          </label>

          {notice ? (
            <div
              className={
                notice.kind === "blocked"
                  ? "new-session-error new-session-error-blocked"
                  : "new-session-error"
              }
              role="alert"
              data-testid="new-session-notice"
            >
              <strong>
                {notice.kind === "blocked" ? "还不能创建" : "创建失败"}
              </strong>
              <p>{notice.message}</p>
              {notice.actionHref ? (
                <Link href={notice.actionHref}>
                  {notice.actionLabel ?? "去处理"}
                </Link>
              ) : null}
              {createdSessionId ? (
                <Link href={`/sessions/${createdSessionId}`}>
                  会话已创建，尝试打开
                </Link>
              ) : null}
            </div>
          ) : null}

          {/*
            The button is disabled only while it is actually working. It used
            to be disabled whenever a prerequisite was missing, which meant the
            click was swallowed and the sentence explaining why — already
            written, right below — never appeared. `aria-describedby` points
            at that note, so a screen reader hears the reason from the button
            itself.
          */}
          <button
            className="new-session-submit"
            type="submit"
            disabled={pending}
            aria-describedby="new-session-runtime-note"
            data-testid="start-review"
          >
            {pending
              ? "正在启动评审..."
              : resolving
                ? "正在确认运行模式..."
                : !canReview
                  ? currentUser === null
                    ? "登录后即可创建"
                    : "当前账号没有创建权限"
                  : !canRunAnalysis
                    ? "先配置模型"
                    : liveModelReady
                      ? "开始评审"
                      : "开始评审（演示数据）"}
            <span aria-hidden="true">→</span>
          </button>
        </form>
      </div>
    </main>
  );
}
