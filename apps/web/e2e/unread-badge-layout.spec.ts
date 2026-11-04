import { expect, test, type Page } from "@playwright/test";
import { OWNER_PASSWORD } from "./support/credentials";

/**
 * 未读角标把导航条撑破了吗？
 *
 * `p29-responsive` 会在五个宽度下扫十个路由，但它跑在真实数据上：没有任何
 * 待处理事项时角标根本**不渲染**（`null` 与 `0` 都不画）。也就是说，那一遍
 * 扫的是「没有角标的导航条」——它永远不可能回答这个文件要问的问题。
 *
 * 所以这里把计数在**网络层**钉死，让角标必然出现，再去量布局。测两种最坏
 * 情况：一个普通的两位数，和 `99+`（最宽的一种显示）。
 *
 * 这不重复 `unread-count-badge.test.tsx`：那个用 jsdom 测逻辑（渲染/不渲染、
 * 文案、aria），这个测的是**真实排版**——jsdom 没有排版引擎，溢出它看不见。
 *
 * 还有一处只在真实浏览器里才暴露的差异：**低于 768px 时桌面链接条是
 * `display:none`，角标只活在抽屉里**。抽屉没打开，角标就不在视口内——所以
 * 窄屏那几档必须先开抽屉，量的也是抽屉里的那一个。这一条 jsdom 永远测不到。
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
  await page.getByLabel("密码").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Pin the badge count so it is always on, whatever the fixture data holds. */
async function pinUnread(page: Page, unreadCount: number): Promise<void> {
  await page.route("**/api/notifications/unread-count", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ unreadCount, authenticated: true })
    })
  );
}

/**
 * The badge actually on screen at this width: the bar from 768 up, the drawer
 * below it (opened first, because a closed drawer has no visible badge).
 */
async function visibleBadge(page: Page, width: number) {
  if (width < 768) {
    await page.getByTestId("app-nav-menu-button").click();
    const drawer = page.getByRole("dialog", { name: "导航" });
    await expect(drawer).toBeVisible();
    return drawer.getByTestId("notifications-badge");
  }
  return page.getByTestId("app-nav").getByTestId("notifications-badge");
}

test.describe("未读角标的布局", () => {
  test("五个宽度下角标都在容器里，且不把页面撑出横向滚动", async ({
    page
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-1440x900",
      "the sweep sets its own viewports"
    );
    test.setTimeout(180_000);

    await loginAsOwner(page);
    await pinUnread(page, 12);

    for (const viewport of WIDTHS) {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height
      });
      await page.goto("/notifications");

      const badge = await visibleBadge(page, viewport.width);
      await expect(
        badge,
        `${viewport.label}: 角标应当出现（计数已被钉为 12）`
      ).toBeVisible();
      await expect(badge).toHaveText("12");

      // Nothing on the page may push the document wider than the viewport.
      // A widened badge is the only new thing here worth suspecting.
      await expect
        .poll(
          async () => {
            const metrics = await page.evaluate(() => ({
              documentWidth: document.documentElement.scrollWidth,
              viewportWidth: window.innerWidth
            }));
            return metrics.documentWidth <= metrics.viewportWidth + 1;
          },
          { message: `${viewport.label}: 页面横向溢出` }
        )
        .toBe(true);

      // And the badge itself must fit inside the viewport.
      const box = await badge.boundingBox();
      expect(box, `${viewport.label}: 角标没有 box`).not.toBeNull();
      expect(
        box!.x + box!.width,
        `${viewport.label}: 角标右边缘超出视口`
      ).toBeLessThanOrEqual(viewport.width + 1);
    }
  });

  test("99+ 是最宽的一种显示，也不能撑破", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-1440x900",
      "the sweep sets its own viewports"
    );
    test.setTimeout(180_000);

    await loginAsOwner(page);
    await pinUnread(page, 150);

    for (const viewport of WIDTHS) {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height
      });
      await page.goto("/notifications");

      const badge = await visibleBadge(page, viewport.width);
      await expect(badge, `${viewport.label}: 角标应当出现`).toBeVisible();
      await expect(badge, `${viewport.label}: 应显示 99+`).toHaveText("99+");

      await expect
        .poll(
          async () =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth + 1
            ),
          { message: `${viewport.label}: 99+ 撑出了横向滚动` }
        )
        .toBe(true);
    }
  });
});
