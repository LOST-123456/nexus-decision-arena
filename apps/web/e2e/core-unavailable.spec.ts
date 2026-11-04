import { expect, test, type Page } from "@playwright/test";
import { OWNER_PASSWORD } from "./support/credentials";

/**
 * What the operator sees when the core API cannot be reached.
 *
 * This is the scenario behind the "核心 API 暂时不可用" screenshot: the page
 * used to render an *empty* workspace — no agents, no claims, no timeline —
 * which reads as "this session is empty" instead of "I could not read this
 * session". Those are very different facts, and only one of them is true.
 *
 * The refusal is simulated at the network layer (`route.abort` /
 * `route.fulfill`) so the test does not need the real service to be down, and
 * so it covers both shapes a dead core takes: a refused connection, and a 500
 * from the proxy in front of it.
 */

const MISSING_SESSION = "00000000-0000-4000-8000-000000000000";

/**
 * Signs in as the local demo owner.
 *
 * Needed since reads became owner-scoped: 404 ("this id does not exist") is an
 * answer only a caller who is *allowed to ask* ever receives. A signed-out
 * visitor gets 401 for every id, real or not, so the not-found panel can only
 * be reached — and only honestly asserted — from a signed-in account.
 */
async function loginAsOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("owner");
  await page.getByLabel("密码").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function blockCore(page: Page): Promise<void> {
  await page.route("**/api/**", (route) => route.abort());
}

async function failCore(page: Page, status: number, body: string): Promise<void> {
  await page.route("**/api/**", (route) =>
    route.fulfill({ status, contentType: "text/plain", body })
  );
}

test("a refused core shows an actionable session error, not an empty workspace", async ({
  page
}) => {
  await blockCore(page);
  await page.goto(`/sessions/${MISSING_SESSION}`);

  const panel = page.getByTestId("session-load-error");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "无法加载会话" })).toBeVisible();
  await expect(panel).toContainText("无法连接到核心 API");
  await expect(panel).toContainText("4100");
  await expect(panel.getByRole("button", { name: "重新加载" })).toBeVisible();

  // The empty shell must not be standing in for the failure.
  await expect(page.getByLabel("Decision workspace")).toHaveCount(0);
});

test("a 500 from the core explains itself instead of showing a bare status", async ({
  page
}) => {
  await failCore(page, 500, "Internal Server Error");
  await page.goto(`/sessions/${MISSING_SESSION}`);

  const panel = page.getByTestId("session-load-error");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("核心 API 返回 500 错误");
  await expect(panel).not.toContainText("Internal Server Error");
});

test("retry actually re-reads the session", async ({ page }) => {
  let apiCalls = 0;
  await page.route("**/api/**", async (route) => {
    apiCalls += 1;
    await route.abort();
  });
  await page.goto(`/sessions/${MISSING_SESSION}`);

  const panel = page.getByTestId("session-load-error");
  await expect(panel).toBeVisible();
  const callsAfterLoad = apiCalls;
  expect(callsAfterLoad).toBeGreaterThan(0);

  await panel.getByRole("button", { name: "重新加载" }).click();

  // The service is still down, so the panel comes back — but only after the
  // browser really asked again, which is what makes the button worth having.
  await expect(panel).toBeVisible();
  await expect.poll(() => apiCalls).toBeGreaterThan(callsAfterLoad);
});

test("a healthy core after retry replaces the error with the honest not-found panel", async ({
  page
}) => {
  await loginAsOwner(page);

  let healthy = false;
  await page.route("**/api/**", async (route) => {
    if (healthy) {
      await route.continue();
      return;
    }
    await route.abort();
  });
  await page.goto(`/sessions/${MISSING_SESSION}`);

  const panel = page.getByTestId("session-load-error");
  await expect(panel).toBeVisible();

  healthy = true;
  await panel.getByRole("button", { name: "重新加载" }).click();

  // The session id really is absent, so once the core answers the page must
  // stop blaming the service: the outage panel becomes a "not found" panel
  // with a way out, not a retry button whose only outcome is failing again.
  const notFound = page.getByTestId("session-not-found");
  await expect(notFound).toBeVisible({ timeout: 15_000 });
  await expect(notFound).toContainText("会话不存在");
  await expect(notFound.getByRole("button", { name: "重新加载" })).toHaveCount(0);
  await expect(notFound.getByRole("link", { name: "返回最近会话" })).toBeVisible();
  // The server's developer-facing English must never reach the operator.
  await expect(notFound).not.toContainText("Session not found");
});

/**
 * The fourth state, and the one that used to be mislabelled.
 *
 * Research reads are owner-scoped, so a signed-out visitor is answered 401 for
 * every id — real or not. The page must say "sign in", not "check that the core
 * is running on 4100": the second sentence describes a problem the visitor does
 * not have and sends them to inspect a healthy process.
 */
test("a signed-out visitor is asked to sign in, not told to check the core", async ({
  page
}) => {
  await page.goto(`/sessions/${MISSING_SESSION}`);

  const panel = page.getByTestId("session-sign-in-required");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toContainText("需要登录");
  await expect(panel.getByRole("link", { name: "去登录" })).toBeVisible();
  // Neither of the other two stories may be told instead.
  await expect(page.getByTestId("session-not-found")).toHaveCount(0);
  await expect(page.getByTestId("session-load-error")).toHaveCount(0);
  await expect(panel).not.toContainText("4100");
  await expect(panel).not.toContainText("Authentication required");
});

/**
 * 同一个病，第三、第四个出口。
 *
 * 详情页早就分清了「你没登录」和「服务挂了」。两个**列表页**没有：它们把
 * 所有异常压成一句 message，于是未登录的访客在 `/research` 上读到「请确认
 * 核心 API 正在运行（默认 4100 端口）」，旁边还挂着一个「重新加载」——一个
 * 只会再得 401 的按钮。
 *
 * 这两条守的是同一个契约：401 只说登录，且必须给出去登录的路。
 */
test("未登录打开 /research 会被请去登录，而不是被叫去查端口", async ({
  page
}) => {
  await page.goto("/research");

  const panel = page.getByTestId("research-list-error");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toContainText("需要登录");
  await expect(panel.getByRole("link", { name: "去登录" })).toHaveAttribute(
    "href",
    "/login"
  );

  // The old sentence must not survive in any of its forms.
  await expect(panel).not.toContainText("4100");
  await expect(panel).not.toContainText("核心 API");
  await expect(panel).not.toContainText("Authentication required");

  // And no retry: without signing in it can only fail again.
  await expect(panel.getByRole("button", { name: "重新加载" })).toHaveCount(0);

  // Nor may the empty state stand in for the 401 — "you have no research" is
  // a different, and false, statement.
  await expect(page.getByTestId("research-list-empty")).toHaveCount(0);
});

test("未登录打开 /history 会被请去登录，而不是报「操作失败」", async ({
  page
}) => {
  await page.goto("/history");

  const panel = page.getByTestId("history-load-error");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toContainText("需要登录");
  await expect(panel.getByRole("link", { name: "去登录" })).toBeVisible();

  await expect(panel).not.toContainText("Authentication required");
  await expect(panel).not.toContainText("操作失败");
  await expect(panel).not.toContainText("4100");

  // A failed read must not print a count: "共 0 项" would be the length of a
  // list nobody managed to fetch.
  await expect(page.getByText("共 0 项")).toHaveCount(0);
});
