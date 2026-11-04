import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 新建评审的「进不来」那一刻。
 *
 * 这个页面以前是产品里最安静的墙：一个人把项目名、摘要、目标用户、商业模式
 * 全填完，点提交，按钮上写着「需要登录 Reviewer」，而页面上只有一句灰字
 * 「请先登录 Owner 或 Reviewer 账户。」——没有链接，没有按钮，没有任何一处
 * 可以点。他得自己抬头去猜导航右上角那个「登录 / 团队」是干这个的。
 *
 * 现在那句话后面跟着一个真链接。这里钉住的是：链接必须在、必须指向 /login、
 * 而且只在真的没登录时出现（登录过还提示去登录，是另一种不耐烦）。
 */

const getCurrentUser = vi.fn();
const getRuntimeInfo = vi.fn();
const createSession = vi.fn();
const startSession = vi.fn();

vi.mock("./api-client", () => ({
  getCurrentUser: (...args: unknown[]) => getCurrentUser(...args),
  getRuntimeInfo: (...args: unknown[]) => getRuntimeInfo(...args),
  createSession: (...args: unknown[]) => createSession(...args),
  startSession: (...args: unknown[]) => startSession(...args)
}));

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/sessions/new"
}));

const { NewSessionForm } = await import("./new-session-form");

/**
 * 把五个必填栏填满。
 *
 * 校验现在由表单自己做（不是浏览器的 required），所以"空表单提交"会停在字段
 * 校验这一步——那些关于身份、模型、跳转顺序的用例，都得先把必填项补上，才
 * 能走到它们真正要断言的地方。
 */
function fillRequired(): void {
  fireEvent.change(screen.getByLabelText("项目名称"), {
    target: { value: "校园 AI 实验室危化品管理平台" }
  });
  fireEvent.change(screen.getByLabelText("项目简介"), {
    target: { value: "用视觉识别登记危化品用量，替代纸笔台账。" }
  });
  fireEvent.change(screen.getByLabelText("目标用户"), {
    target: { value: "高校实验室安全员与资产部门" }
  });
  fireEvent.change(screen.getByLabelText("商业模式"), {
    target: { value: "按实验室数量年费订阅" }
  });
  fireEvent.change(screen.getByLabelText("预期数据与目标"), {
    target: { value: "两年覆盖 200 家实验室，ARR 1600 万元" }
  });
}

const RUNTIME = { mode: "openai-compatible", model: "test-model" };
/**
 * 「允许跑固定样例」是一个显式状态，不是默认。
 *
 * core 只有在 LLM_MODE=mock 且 NEXUS_ALLOW_FIXTURE_RUNS=1 时才会回
 * canRunAnalysis: true；这样演示与回归测试还能走通，而一个谁都没配过模型的
 * 部署会老老实实拦住。下面那组用例描述的是"已显式允许"的那个状态。
 */
const MOCK_RUNTIME = {
  mode: "mock",
  model: "deterministic-fixtures",
  configured: false,
  canRunAnalysis: true
};

/** 谁都没配过模型：这是默认状态，也是最容易做错的那个。 */
const UNCONFIGURED_RUNTIME = {
  mode: "mock",
  model: "deterministic-fixtures",
  configured: false,
  canRunAnalysis: false
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe("NewSessionForm · 未登录时的出路", () => {
  it("没登录时给一个能点的「去登录」，而不只是一句灰字", async () => {
    getCurrentUser.mockResolvedValue(null);
    getRuntimeInfo.mockResolvedValue(RUNTIME);

    render(<NewSessionForm />);

    const link = await screen.findByRole("link", { name: "去登录" });
    expect(link.getAttribute("href")).toBe("/login");
  });

  it("登录后不再劝人去登录", async () => {
    getCurrentUser.mockResolvedValue({
      id: "u-1",
      displayName: "张三",
      role: "reviewer"
    });
    getRuntimeInfo.mockResolvedValue(RUNTIME);

    render(<NewSessionForm />);

    // Wait for the form to settle on the signed-in branch.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "开始评审" })
      ).toBeTruthy()
    );
    expect(screen.queryByRole("link", { name: "去登录" })).toBeNull();
  });

  it("查看权限的人被告知需要 Reviewer，而不是被拦在登录上", async () => {
    getCurrentUser.mockResolvedValue({
      id: "u-2",
      displayName: "李四",
      role: "viewer"
    });
    getRuntimeInfo.mockResolvedValue(RUNTIME);

    render(<NewSessionForm />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "当前账号没有创建权限" })
      ).toBeTruthy()
    );
    // Already signed in: the fix is a role, not a login.
    expect(screen.queryByRole("link", { name: "去登录" })).toBeNull();
  });

  it("运行模式读不到时说人话，不是英文兜底", async () => {
    getCurrentUser.mockResolvedValue(null);
    // A non-Error rejection is what actually reaches the fallback sentence: a
    // real Error carries its own message and that one is shown as-is.
    getRuntimeInfo.mockRejectedValue("boom");

    render(<NewSessionForm />);

    const message = await screen.findByText("无法获取运行模式");
    expect(message).toBeTruthy();
    expect(screen.queryByText("Runtime mode unavailable")).toBeNull();
  });
});

/**
 * 固定样例模式下的那块墙。
 *
 * 这个表单曾经在缺少模型时把提交按钮 `disabled` 掉——按钮上写着「需要真实
 * 模型模式」，点下去却什么都没有：disabled 的控件会吞掉点击，于是那句早就
 * 写好的解释永远没机会被读到。读者只能看着一句没有出路的提示，猜是自己哪里
 * 做错了。
 *
 * 后来又走到另一个极端：缺模型也放行，理由是"拦住就是死胡同"。结果更糟——
 * 五个角色跑完，输出的却是和用户项目毫无关系的固定样例，而用户以为自己被
 * 分析过了。
 *
 * 现在钉住三件事：
 *  1. 点下去一定有话听，而且说清楚是「被挡住」不是「创建失败」；
 *  2. 被挡住的时候**一个会话都不许创建**——半路放行比拦住更糟；
 *  3. 补救步骤是一个能点的链接（去模型设置），不是一串环境变量。
 */
describe("NewSessionForm · Mock 模式下的出路", () => {
  it("Mock 模式不再把新建堵死——按钮是活的，点了就往下走", async () => {
    getCurrentUser.mockResolvedValue({
      id: "u-3",
      displayName: "王五",
      role: "owner"
    });
    getRuntimeInfo.mockResolvedValue(MOCK_RUNTIME);
    createSession.mockResolvedValue({ id: "sess-mock-1" });
    startSession.mockResolvedValue({ id: "sess-mock-1", status: "STARTED" });

    render(<NewSessionForm />);

    const button = await screen.findByRole("button", {
      name: "开始评审（演示数据）"
    });
    // A disabled control swallows the click. That was the whole defect.
    expect(button.hasAttribute("disabled")).toBe(false);

    // jsdom does not submit a form from a button click the way a browser
    // does, so the submit event is fired directly. What the click reaches is
    // asserted above: the control is not disabled.
    fillRequired();
    fireEvent.submit(button.closest("form")!);

    await waitFor(() =>
      expect(startSession).toHaveBeenCalledWith(
        "sess-mock-1",
        expect.anything()
      )
    );
  });

  it("Mock 模式照常创建并启动会话，但页面上说清楚产出是演示", async () => {
    getCurrentUser.mockResolvedValue({
      id: "u-4",
      displayName: "赵六",
      role: "owner"
    });
    getRuntimeInfo.mockResolvedValue(MOCK_RUNTIME);
    createSession.mockResolvedValue({ id: "sess-mock-2" });
    startSession.mockResolvedValue({ id: "sess-mock-2", status: "STARTED" });

    render(<NewSessionForm />);

    const button = await screen.findByRole("button", {
      name: "开始评审（演示数据）"
    });
    fillRequired();
    fireEvent.submit(button.closest("form")!);

    await waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    expect(createSession).toHaveBeenCalledTimes(1);

    // Refusing to create was the wrong shape of honesty. Saying what the
    // output is, before the click, is the right one. 现在这句话是状态徽标上的
    // FIXTURE DEMO —— 与 core 回的 canRunAnalysis: true 相对应。
    expect(screen.getByText("FIXTURE DEMO")).toBeTruthy();
    // 补救步骤从"四个环境变量"改成了"一个能点的页面"：配置动作现在在 UI 里，
    // 不需要重启进程，所以页面上不再出现 LLM_* 变量名。
    expect(
      screen.queryByText(/LLM_API_KEY/)
    ).toBeNull();
  });

  it("按钮自己就带着解释，屏幕阅读器不用先点一下才知道", async () => {
    getCurrentUser.mockResolvedValue({
      id: "u-5",
      displayName: "钱七",
      role: "owner"
    });
    getRuntimeInfo.mockResolvedValue(MOCK_RUNTIME);

    render(<NewSessionForm />);

    const button = await screen.findByRole("button", {
      name: "开始评审（演示数据）"
    });
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBe("new-session-runtime-note");
    expect(document.getElementById(describedBy!)).toBeTruthy();
  });

  it("没登录的人先被请去登录，而不是先被讲模型模式", async () => {
    getCurrentUser.mockResolvedValue(null);
    getRuntimeInfo.mockResolvedValue(MOCK_RUNTIME);

    render(<NewSessionForm />);

    const button = await screen.findByRole("button", { name: "登录后即可创建" });
    fillRequired();
    fireEvent.submit(button.closest("form")!);

    const notice = await screen.findByTestId("new-session-notice");
    // The order matters: an account is needed before the model mode is.
    expect(notice.textContent).toContain("还没登录");
    expect(notice.textContent).not.toContain("Mock 模式");
    expect(createSession).not.toHaveBeenCalled();
  });
});

/**
 * 谁都没配过模型 —— 默认状态。
 *
 * 这一组钉的是"不许假装分析过"。core 回 canRunAnalysis: false 时，页面必须：
 *  1. 在按钮上方就说清楚为什么不能跑，而不是等用户点；
 *  2. 点下去仍然有话说（按钮不能 disabled，disabled 会吞掉点击）；
 *  3. 一个会话都不许创建 —— 否则就退回了"跑完给一段固定样例"的老毛病。
 */
describe("NewSessionForm · 没配模型时不许假装分析", () => {
  it("按钮不 disabled，点下去说明缺什么，并给出去配置模型的链接", async () => {
    getCurrentUser.mockResolvedValue({
      id: "u-9",
      displayName: "赵六",
      role: "owner"
    });
    getRuntimeInfo.mockResolvedValue(UNCONFIGURED_RUNTIME);

    render(<NewSessionForm />);

    const button = await screen.findByRole("button", { name: "先配置模型" });
    expect(button.hasAttribute("disabled")).toBe(false);

    fillRequired();
    fireEvent.submit(button.closest("form")!);

    const notice = await screen.findByTestId("new-session-notice");
    expect(notice.textContent).toContain("还没有配置模型");
    // 提示里和上方运行条件里各有一个出口，这里只关心提示里的那个。
    const link = within(notice).getByRole("link", { name: "去配置模型" });
    expect(link.getAttribute("href")).toBe("/settings/model");
    expect(createSession).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("页面上的运行条件里也留着出口，不用点一下才知道", async () => {
    getCurrentUser.mockResolvedValue({
      id: "u-10",
      displayName: "钱七",
      role: "owner"
    });
    getRuntimeInfo.mockResolvedValue(UNCONFIGURED_RUNTIME);

    render(<NewSessionForm />);

    const links = await screen.findAllByRole("link", { name: "去配置模型" });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]?.getAttribute("href")).toBe("/settings/model");
  });

  it("配好之后同一份表单就能提交了，不需要改代码也不需要重启", async () => {
    getCurrentUser.mockResolvedValue({
      id: "u-11",
      displayName: "孙八",
      role: "owner"
    });
    getRuntimeInfo.mockResolvedValue({
      mode: "openai-compatible",
      provider: "DeepSeek",
      model: "deepseek-chat",
      configured: true,
      canRunAnalysis: true
    });
    createSession.mockResolvedValue({ id: "sess-live-1" });
    startSession.mockResolvedValue({ id: "sess-live-1", status: "STARTED" });

    render(<NewSessionForm />);

    const button = await screen.findByRole("button", { name: "开始评审" });
    fillRequired();
    fireEvent.submit(button.closest("form")!);

    await waitFor(() => expect(createSession).toHaveBeenCalled());
  });
});

/**
 * 「点了开始评审，人应该被带走」。
 *
 * 上一版先 `await startSession(...)` 再跳转，而整轮分析（五个角色 + 质询）
 * 在真实模型下要跑几十秒到几分钟。结果就是：按钮按下去，页面一动不动，用户
 * 以为没生效；中途任何一次模型调用失败，还会被 catch 退回表单——会话其实
 * 已经建好了。这里钉住的是顺序：跳转不等分析跑完。
 */
describe("NewSessionForm · 点了就跳", () => {
  const OWNER = { id: "u-20", displayName: "钱七", role: "owner" };

  it("启动请求还没返回，人已经在会话页了", async () => {
    getCurrentUser.mockResolvedValue(OWNER);
    getRuntimeInfo.mockResolvedValue(MOCK_RUNTIME);
    createSession.mockResolvedValue({ id: "sess-jump-1" });
    // 永不 resolve：模拟一条跑了几分钟的分析。
    startSession.mockReturnValue(new Promise(() => {}));

    render(<NewSessionForm />);

    const button = await screen.findByRole("button", {
      name: "开始评审（演示数据）"
    });
    fillRequired();
    fireEvent.submit(button.closest("form")!);

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/sessions/sess-jump-1")
    );
    // 而且确实已经把启动请求发出去了，不是只跳不跑。
    expect(startSession).toHaveBeenCalledWith("sess-jump-1", expect.anything());
  });

  it("启动失败也不把人留在表单上", async () => {
    // 会话已经建好，退回表单等于让人再建一个重复的。
    getCurrentUser.mockResolvedValue(OWNER);
    getRuntimeInfo.mockResolvedValue(MOCK_RUNTIME);
    createSession.mockResolvedValue({ id: "sess-jump-2" });
    startSession.mockRejectedValue(new Error("Internal Server Error"));

    render(<NewSessionForm />);

    const button = await screen.findByRole("button", {
      name: "开始评审（演示数据）"
    });
    fillRequired();
    fireEvent.submit(button.closest("form")!);

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/sessions/sess-jump-2")
    );
    // 失败原因不在表单上说第二遍：会话页有「开始评审」可以重试并显示原因。
    expect(screen.queryByText(/Internal Server Error/)).toBeNull();
  });
});

/**
 * 「后面几栏写什么」是新手真正的卡点。
 *
 * 提示的要求有两条：项目名称有内容才出现（还没想好做什么的人先看名称那一栏），
 * 以及一键填空时不覆盖已经动笔的内容——把人写了一半的简介换成模板，比不给提示更糟。
 */
describe("NewSessionForm · 填写提示", () => {
  const OWNER = { id: "u-12", displayName: "周九", role: "owner" };

  it("输入项目名称之后才出现提示", async () => {
    getCurrentUser.mockResolvedValue(OWNER);
    getRuntimeInfo.mockResolvedValue(RUNTIME);

    render(<NewSessionForm />);
    await screen.findByRole("button", { name: "开始评审" });
    expect(screen.queryByLabelText("填写提示")).toBeNull();

    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "校园二手教材循环平台" }
    });

    expect(await screen.findByLabelText("填写提示")).toBeTruthy();
  });

  it("一键填空只补空栏，已经写下的内容不动", async () => {
    getCurrentUser.mockResolvedValue(OWNER);
    getRuntimeInfo.mockResolvedValue(RUNTIME);

    render(<NewSessionForm />);
    await screen.findByRole("button", { name: "开始评审" });

    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "校园二手教材循环平台" }
    });
    fireEvent.change(screen.getByLabelText("项目简介"), {
      target: { value: "我自己写的简介，别覆盖" }
    });

    fireEvent.click(screen.getByRole("button", { name: "把模板填进空着的栏" }));

    expect(
      (screen.getByLabelText("项目简介") as HTMLTextAreaElement).value
    ).toBe("我自己写的简介，别覆盖");
    expect(
      (screen.getByLabelText("目标用户") as HTMLTextAreaElement).value
    ).toContain("付费方");
    expect(
      (screen.getByLabelText("商业模式") as HTMLTextAreaElement).value
    ).toContain("计价方式");
  });
});

/**
 * 「填了半天，最后被一句话打回来」这类问题。
 *
 * 走查里看到的三个浪费：五栏全是必填却没有一处标记；只有点提交、且把五栏都
 * 填满，才听到"请先登录"；粘贴超长内容被浏览器默默截断，界面一声不响。这一组
 * 钉住修完之后的形状。
 */
describe("NewSessionForm · 字段说了算", () => {
  const OWNER_FOR_FIELDS = { id: "u-30", displayName: "郑十", role: "owner" };

  it("空表单提交：说清哪几栏没填，而且一个会话都不建", async () => {
    getCurrentUser.mockResolvedValue(OWNER_FOR_FIELDS);
    getRuntimeInfo.mockResolvedValue(RUNTIME);

    render(<NewSessionForm />);
    const button = await screen.findByRole("button", { name: "开始评审" });
    fireEvent.submit(button.closest("form")!);

    const notice = await screen.findByTestId("new-session-notice");
    expect(notice.textContent).toContain("还有 5 项没填");
    expect(notice.textContent).toContain("项目名称");
    // 每栏自己也有一条就地提示：不用回头在总结里找是哪一栏。
    expect(screen.getAllByText("请填写项目名称").length).toBeGreaterThan(0);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("每一栏都写着「必填」，不用猜也不用点一次才知道", async () => {
    getCurrentUser.mockResolvedValue(OWNER_FOR_FIELDS);
    getRuntimeInfo.mockResolvedValue(RUNTIME);

    render(<NewSessionForm />);
    await screen.findByRole("button", { name: "开始评审" });

    expect(screen.getAllByText("必填")).toHaveLength(5);
    // 带标记的是 label 的兄弟元素：label 自己的文字仍然是"项目名称"，
    // 屏幕阅读器与自动填充按这个名字认控件。
    expect(screen.getByLabelText("项目名称")).toBeTruthy();
  });

  it("字数到顶时明说多出来的会被丢弃，而不是默默截断", async () => {
    getCurrentUser.mockResolvedValue(OWNER_FOR_FIELDS);
    getRuntimeInfo.mockResolvedValue(RUNTIME);

    render(<NewSessionForm />);
    await screen.findByRole("button", { name: "开始评审" });

    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "超".repeat(120) }
    });

    expect(screen.getByText(/120\/120/)).toBeTruthy();
    expect(screen.getByText(/已达上限/)).toBeTruthy();
  });

  it("离开页面再回来，已经填的内容还在", async () => {
    getCurrentUser.mockResolvedValue(OWNER_FOR_FIELDS);
    getRuntimeInfo.mockResolvedValue(RUNTIME);

    const first = render(<NewSessionForm />);
    await screen.findByRole("button", { name: "开始评审" });
    fillRequired();
    first.unmount();

    render(<NewSessionForm />);
    await waitFor(() =>
      expect(
        (screen.getByLabelText("项目名称") as HTMLInputElement).value
      ).toContain("校园 AI 实验室")
    );
  });

  it("创建成功之后草稿被清掉，下一次是干净的表单", async () => {
    getCurrentUser.mockResolvedValue(OWNER_FOR_FIELDS);
    getRuntimeInfo.mockResolvedValue(RUNTIME);
    createSession.mockResolvedValue({ id: "sess-clean-1" });
    startSession.mockResolvedValue({ id: "sess-clean-1", status: "STARTED" });

    render(<NewSessionForm />);
    const button = await screen.findByRole("button", { name: "开始评审" });
    fillRequired();
    fireEvent.submit(button.closest("form")!);

    await waitFor(() => expect(createSession).toHaveBeenCalled());
    expect(window.sessionStorage.getItem("nexus:new-session-draft")).toBeNull();
  });

  it("没有创建权限的人看到的是只读表单，不是一个填不完的表单", async () => {
    getCurrentUser.mockResolvedValue({
      id: "u-31",
      displayName: "吴十一",
      role: "viewer"
    });
    getRuntimeInfo.mockResolvedValue(RUNTIME);

    render(<NewSessionForm />);
    const lock = await screen.findByTestId("new-session-locked");
    expect(lock.textContent).toContain("没有创建权限");
    expect((screen.getByLabelText("项目名称") as HTMLInputElement).disabled).toBe(true);
  });
});
