import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

/**
 * 任务书第十八节点名了五个宽度。运行时套件只有两个 project（1440×900 与
 * 390×844），这里把五个宽度都真的设一遍，并在每个宽度下走完整的一条路由
 * 清单：页面整体不得横向溢出（复杂表格允许在自己的容器里滚动，那不算页面
 * 溢出），手机宽度下抽屉必须能开、能关、且不出屏。
 *
 * 测量用 `expect.poll`：CSS 过渡与图片解码会让首帧的 scrollWidth 偏大，
 * 一次采样会把过渡态当成布局缺陷。
 */

const WIDTHS = [
  { width: 1440, height: 900, label: "桌面 1440×900" },
  { width: 1280, height: 800, label: "笔记本 1280×800" },
  { width: 768, height: 1024, label: "平板 768×1024" },
  { width: 390, height: 844, label: "移动 390×844" },
  { width: 320, height: 700, label: "移动 320×700" }
];

async function loginAsOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("owner");
  await page.getByLabel("密码").fill("nexus-owner");
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function createResearch(page: Page): Promise<string> {
  const created = await page.context().request.post("/api/sessions", {
    headers: { "idempotency-key": `p29-responsive-${randomUUID()}` },
    data: {
      project: {
        name: "P29 responsive",
        summary: "Viewport sweep fixture",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "none"
      },
      locale: "zh-CN",
      researchQuestion: "五个宽度下页面是否都站得住？"
    }
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  return id;
}

test("every declared width holds every route without horizontal overflow", async ({
  page
}, testInfo) => {
  // The sweep sets its own five viewports, so a second project would repeat
  // the identical work; and 5 widths × 10 routes cannot fit in the default
  // 30s budget, which is about one page, not about this test.
  test.skip(
    testInfo.project.name !== "desktop-1440x900",
    "the sweep sets its own viewports"
  );
  test.setTimeout(240_000);

  await loginAsOwner(page);
  const sessionId = await createResearch(page);

  const routes = [
    "/",
    "/history",
    "/research",
    `/research/${sessionId}`,
    `/research/${sessionId}/evidence`,
    "/research/library",
    "/security",
    "/sessions/demo",
    "/sessions/new",
    "/login"
  ];

  for (const viewport of WIDTHS) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height
    });

    // 手机宽度：抽屉必须真的能开、能关，且不超出视口。
    if (viewport.width < 768) {
      await page.goto("/");
      await page.getByTestId("app-nav-menu-button").click();
      const drawer = page.getByRole("dialog", { name: "导航" });
      await expect(drawer).toBeVisible();
      const box = await drawer.boundingBox();
      expect(box, `${viewport.label}: drawer has no box`).not.toBeNull();
      expect(box!.width, `${viewport.label}: drawer wider than viewport`).toBeLessThanOrEqual(
        viewport.width
      );

      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
    }

    for (const route of routes) {
      await page.goto(route);

      await expect
        .poll(
          async () => {
            const metrics = await page.evaluate(() => ({
              documentWidth: document.documentElement.scrollWidth,
              viewportWidth: window.innerWidth
            }));
            return metrics.documentWidth <= metrics.viewportWidth + 1;
          },
          { message: `${route} overflows at ${viewport.label}`, timeout: 10_000 }
        )
        .toBe(true);
    }
  }
});
