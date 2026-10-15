import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RouteError from "./error";
import Loading from "./loading";
import NotFound from "./not-found";

/**
 * The app-level boundaries. Before these existed an unknown path fell through
 * to Next's own English 404 and an uncaught render error fell through to a
 * bare error screen — both of which drop the operator out of the product.
 */

afterEach(() => {
  cleanup();
});

describe("路由层兜底", () => {
  it("404 页面说清页面不存在，并给出可走的出口", () => {
    render(<NotFound />);

    expect(screen.getByTestId("not-found")).toBeTruthy();
    expect(screen.getByText("页面不存在")).toBeTruthy();
    expect(screen.getByRole("link", { name: "返回首页" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "研究与事实核查" })).toBeTruthy();
  });

  it("错误边界显示原因、错误编号、重试与出口", () => {
    const reset = vi.fn();
    render(
      <RouteError
        error={Object.assign(new Error("渲染失败"), { digest: "digest-123" })}
        reset={reset}
      />
    );

    expect(screen.getByTestId("route-error")).toBeTruthy();
    expect(screen.getByText("渲染失败")).toBeTruthy();
    expect(screen.getByText(/digest-123/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("错误边界的重试按钮会调用 reset", () => {
    const reset = vi.fn();
    render(
      <RouteError error={new Error("x")} reset={reset} />
    );

    screen.getByRole("button", { name: "重试" }).click();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("加载态是 status 角色，可被读屏播报", () => {
    render(<Loading />);

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("正在载入")).toBeTruthy();
  });
});
