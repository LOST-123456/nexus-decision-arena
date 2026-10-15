import { expect, test, type Page } from "@playwright/test";

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

test("a healthy core after retry replaces the error with the workspace", async ({
  page
}) => {
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

  // The session id does not exist, so the honest answer is a readable refusal
  // — the core's own "Session not found" message, passed through verbatim by
  // the transport — not a spinner and not an empty shell.
  await expect(page.getByTestId("session-load-error")).toContainText(
    /Session not found|未找到|404/,
    { timeout: 15_000 }
  );
});
