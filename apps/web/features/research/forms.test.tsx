import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportSourceForm } from "./forms";

/**
 * 导入来源表单的空提交。
 *
 * 以前 `if (urls.length === 0) return;` —— 点「导入」什么都不发生，也没有任何
 * 说明，看起来就是按钮坏了。现在必须把原因交回给页面。
 */
afterEach(cleanup);

describe("ImportSourceForm", () => {
  it("空提交时把缺失原因交回去，而不是静默返回", () => {
    const onSubmit = vi.fn();
    const onInvalid = vi.fn();

    render(
      <ImportSourceForm
        busy={false}
        error={null}
        onSubmit={onSubmit}
        onInvalid={onInvalid}
      />
    );

    fireEvent.submit(screen.getByTestId("import-source-form"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onInvalid).toHaveBeenCalledWith(
      expect.stringContaining("至少填写一个网页地址")
    );
  });

  it("填了地址就正常提交，不再走校验分支", () => {
    const onSubmit = vi.fn();
    const onInvalid = vi.fn();

    render(
      <ImportSourceForm
        busy={false}
        error={null}
        onSubmit={onSubmit}
        onInvalid={onInvalid}
      />
    );

    fireEvent.change(screen.getByLabelText(/网页地址/), {
      target: { value: "https://example.com/a" }
    });
    fireEvent.submit(screen.getByTestId("import-source-form"));

    expect(onInvalid).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith([{ url: "https://example.com/a" }]);
  });

  it("没有传 onInvalid 时也不崩（保持向后兼容）", () => {
    const onSubmit = vi.fn();
    render(
      <ImportSourceForm busy={false} error={null} onSubmit={onSubmit} />
    );

    expect(() =>
      fireEvent.submit(screen.getByTestId("import-source-form"))
    ).not.toThrow();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
