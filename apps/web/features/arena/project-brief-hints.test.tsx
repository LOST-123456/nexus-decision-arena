import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBriefTemplates, ProjectBriefHints } from "./project-brief-hints";

afterEach(cleanup);

describe("ProjectBriefHints", () => {
  it("stays out of the way until there is a project name", () => {
    render(<ProjectBriefHints projectName="  " onFillEmpty={vi.fn()} />);
    expect(screen.queryByLabelText("填写提示")).toBeNull();
  });

  it("explains every remaining field once the name is known", () => {
    render(<ProjectBriefHints projectName="校园二手教材循环平台" onFillEmpty={vi.fn()} />);

    for (const label of ["项目简介", "目标用户", "商业模式", "预期数据与目标"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("builds templates from the project name, so copying is not a blank fill", () => {
    const templates = buildBriefTemplates("校园二手教材循环平台");
    expect(templates.summary).toContain("校园二手教材循环平台");
    // 骨架用尖括号标出要替换的位置，复制后一眼能看出哪里要改。
    expect(templates.summary).toContain("<谁>");
    expect(templates.expectedData).toContain("<N>");
  });

  it("copies a field template and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    render(<ProjectBriefHints projectName="校园二手教材循环平台" onFillEmpty={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("复制项目简介模板"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toContain("校园二手教材循环平台");
    expect(await screen.findByText("已复制")).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it("hands the templates back so the form can fill only the empty fields", () => {
    const onFillEmpty = vi.fn();
    render(
      <ProjectBriefHints projectName="校园二手教材循环平台" onFillEmpty={onFillEmpty} />
    );

    fireEvent.click(screen.getByRole("button", { name: "把模板填进空着的栏" }));

    expect(onFillEmpty).toHaveBeenCalledTimes(1);
    expect(onFillEmpty.mock.calls[0]![0].businessModel).toContain("计价方式");
  });

  it("can be collapsed without losing the form", () => {
    render(<ProjectBriefHints projectName="校园二手教材循环平台" onFillEmpty={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "收起提示" }));
    expect(screen.queryByText("项目简介")).toBeNull();
    expect(screen.getByRole("button", { name: "看看怎么写" })).toBeTruthy();
  });
});
