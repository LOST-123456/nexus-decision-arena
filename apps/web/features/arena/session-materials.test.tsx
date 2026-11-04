import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const listMaterials = vi.fn();
const addMaterial = vi.fn();

vi.mock("./api-client", () => ({
  listMaterials: (...args: unknown[]) => listMaterials(...args),
  addMaterial: (...args: unknown[]) => addMaterial(...args)
}));

const { SessionMaterials } = await import("./session-materials");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const EXISTING = {
  id: "mat-1",
  sessionId: "s-1",
  title: "三校合作意向书",
  content: "2026-03 与 A/B/C 三校后勤处签意向书。",
  addedBy: "owner-1",
  round: 1,
  createdAt: "2026-03-01T10:00:00.000Z"
};

describe("SessionMaterials", () => {
  it("列出已登记的材料，带上轮次和时间", async () => {
    listMaterials.mockResolvedValue({ materials: [EXISTING] });

    render(<SessionMaterials sessionId="s-1" canWrite roundLabel="第 2 轮" />);

    expect(await screen.findByText("三校合作意向书")).toBeTruthy();
    expect(screen.getByText("已登记 1 份")).toBeTruthy();
    expect(screen.getByText(/第 1 轮前/)).toBeTruthy();
  });

  it("没有材料时说清下一步做什么", async () => {
    listMaterials.mockResolvedValue({ materials: [] });

    render(<SessionMaterials sessionId="s-1" canWrite />);

    expect(
      await screen.findByText(/还没有补充材料/)
    ).toBeTruthy();
  });

  it("提交后把新材料加进列表，并说明本轮结论不会自动重算", async () => {
    listMaterials.mockResolvedValue({ materials: [] });
    addMaterial.mockResolvedValue({
      material: { ...EXISTING, id: "mat-2", title: "试点数据", round: 2 }
    });

    render(<SessionMaterials sessionId="s-1" canWrite />);
    await screen.findByText(/还没有补充材料/);

    fireEvent.change(
      screen.getByPlaceholderText(/三所高校后勤处的合作意向/),
      { target: { value: "试点数据" } }
    );
    fireEvent.change(screen.getByPlaceholderText(/写清来源与关键数字/), {
      target: { value: "两周试点 GMV 3.2 万元" }
    });
    fireEvent.click(screen.getByRole("button", { name: "登记这份材料" }));

    expect(await screen.findByText("试点数据")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "本轮结论不会自动重算"
    );
  });

  it("内容没填时按钮是灰的，并且说明为什么", async () => {
    listMaterials.mockResolvedValue({ materials: [] });

    render(<SessionMaterials sessionId="s-1" canWrite />);
    await screen.findByText(/还没有补充材料/);

    const submit = screen.getByRole("button", {
      name: "登记这份材料"
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute("title")).toContain("标题和内容都填了才能提交");
    // 灰按钮必须自己解释，否则用户只会重复点。
    expect(screen.getByText("标题和内容都填上才能提交。")).toBeTruthy();
  });

  it("只读账户看不到提交表单", async () => {
    listMaterials.mockResolvedValue({ materials: [EXISTING] });

    render(<SessionMaterials sessionId="s-1" canWrite={false} />);
    await screen.findByText("三校合作意向书");

    expect(screen.queryByRole("button", { name: "登记这份材料" })).toBeNull();
    expect(screen.getByText(/只读账户可以查看材料/)).toBeTruthy();
  });

  it("提交失败时把原因显示出来，而不是静默丢掉", async () => {
    listMaterials.mockResolvedValue({ materials: [] });
    addMaterial.mockRejectedValue(new Error("需要 Reviewer 权限"));

    render(<SessionMaterials sessionId="s-1" canWrite />);
    await screen.findByText(/还没有补充材料/);

    fireEvent.change(
      screen.getByPlaceholderText(/三所高校后勤处的合作意向/),
      { target: { value: "标题" } }
    );
    fireEvent.change(screen.getByPlaceholderText(/写清来源与关键数字/), {
      target: { value: "内容" }
    });
    fireEvent.click(screen.getByRole("button", { name: "登记这份材料" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("需要 Reviewer 权限")
    );
  });
});

/**
 * 候选来源：能看见、能采用、采用之后也不代表核实。
 *
 * 这一块最容易做坏的地方，是让它看起来像"系统替我找到证据了"。所以文案与
 * 行为都要钉住：采用只是把它变成一条待核实材料，不改变任何结论。
 */
describe("SessionMaterials · 检索候选来源", () => {
  const CANDIDATE = {
    url: "https://example.edu/procurement/2025",
    title: "某高校 2025 年教材采购公告",
    snippet: "预算 120 万元，服务期 2 年",
    challengeId: "c-1",
    query: "教材采购"
  };

  it("列出来源，并写明它未核实、只是去哪儿找", async () => {
    listMaterials.mockResolvedValue({ materials: [] });

    render(
      <SessionMaterials
        sessionId="s-1"
        canWrite
        candidates={[CANDIDATE]}
      />
    );

    const block = await screen.findByLabelText("检索到的候选来源");
    expect(block.textContent).toContain("未核实");
    expect(block.textContent).toContain("某高校 2025 年教材采购公告");
    expect(block.textContent).toContain("120 万元");
  });

  it("点「采用为材料」把它登记成材料，正文里带来源地址", async () => {
    listMaterials.mockResolvedValue({ materials: [] });
    addMaterial.mockResolvedValue({
      material: {
        id: "mat-9",
        sessionId: "s-1",
        title: CANDIDATE.title,
        content: `${CANDIDATE.url}\n${CANDIDATE.snippet}`,
        addedBy: "owner-1",
        round: 1,
        createdAt: "2026-03-02T00:00:00.000Z"
      }
    });

    render(
      <SessionMaterials sessionId="s-1" canWrite candidates={[CANDIDATE]} />
    );

    fireEvent.click(await screen.findByRole("button", { name: "采用为材料" }));

    await waitFor(() =>
      expect(addMaterial).toHaveBeenCalledWith(
        "s-1",
        {
          title: CANDIDATE.title,
          content: `${CANDIDATE.url}\n${CANDIDATE.snippet}`
        },
        expect.anything()
      )
    );
    // 采用之后必须说清两件事：结论不会自动重算，也没有任何主张变成已核实。
    const notice = await screen.findByText(/不会自己重算/);
    expect(notice.textContent).toContain("已核实");
    expect(
      screen.getByRole("button", { name: "已采用" }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("只读账户能看到来源，但按钮不可用", async () => {
    listMaterials.mockResolvedValue({ materials: [] });

    render(
      <SessionMaterials
        sessionId="s-1"
        canWrite={false}
        candidates={[CANDIDATE]}
      />
    );

    const button = await screen.findByRole("button", { name: "采用为材料" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toContain("只读");
  });
});

describe("SessionMaterials · 候选来源的收尾", () => {
  const A = {
    url: "https://example.edu/a",
    title: "A 校采购公告",
    snippet: "预算 120 万",
    challengeId: "c-1",
    query: "采购"
  };
  const B = {
    url: "https://example.edu/b",
    title: "B 校采购公告",
    snippet: "预算 80 万",
    challengeId: "c-2",
    query: "采购"
  };

  it("忽略之后这条来源从列表消失，其余不动", async () => {
    listMaterials.mockResolvedValue({ materials: [] });
    window.localStorage.clear();

    render(
      <SessionMaterials sessionId="s-9" canWrite candidates={[A, B]} />
    );

    const block = await screen.findByLabelText("检索到的候选来源");
    expect(block.textContent).toContain("A 校采购公告");

    fireEvent.click(screen.getAllByRole("button", { name: "忽略" })[0]!);

    await waitFor(() =>
      expect(
        screen.getByLabelText("检索到的候选来源").textContent
      ).not.toContain("A 校采购公告")
    );
    expect(
      screen.getByLabelText("检索到的候选来源").textContent
    ).toContain("B 校采购公告");
  });

  it("忽略只收起视图，不会替用户登记材料", async () => {
    listMaterials.mockResolvedValue({ materials: [] });
    window.localStorage.clear();

    render(<SessionMaterials sessionId="s-10" canWrite candidates={[A]} />);
    fireEvent.click(await screen.findByRole("button", { name: "忽略" }));

    expect(addMaterial).not.toHaveBeenCalled();
    // 下一次进来仍然记得（本地存储），但材料列表没有多出东西。
    expect(window.localStorage.getItem("nexus:web-sources:ignored:s-10")).toContain(
      "https://example.edu/a"
    );
  });

  it("采用之后告诉用户去哪儿让它生效", async () => {
    listMaterials.mockResolvedValue({ materials: [] });
    window.localStorage.clear();
    addMaterial.mockResolvedValue({
      material: {
        id: "mat-11",
        sessionId: "s-11",
        title: A.title,
        content: `${A.url}\n${A.snippet}`,
        addedBy: "owner-1",
        round: 1,
        createdAt: "2026-03-03T00:00:00.000Z"
      }
    });

    render(<SessionMaterials sessionId="s-11" canWrite candidates={[A]} />);
    fireEvent.click(await screen.findByRole("button", { name: "采用为材料" }));

    // 只说"已登记"不够：用户会以为下一轮自动带着它跑。
    expect(await screen.findByText(/要求补充分析/)).toBeTruthy();
  });
});
