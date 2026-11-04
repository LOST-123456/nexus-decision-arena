import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { OWNER_PASSWORD } from "./support/credentials";

/**
 * P26 — retry lineage, seen from the browser.
 *
 * Everything downstream of the failure is real: the retry is a real HTTP call,
 * it opens its generation with the real `startRetryGeneration` transaction, the
 * real executor runs, and the panel renders only what the server answered.
 *
 * Only the *starting point* is a fixture. A cross-review run is created and
 * settled inside one request, so a browser can never observe a failed one: with
 * the deterministic provider the engine simply succeeds. Fabricating a failed
 * run through the UI is therefore impossible, and inventing one inside the
 * client would prove nothing. Instead one `failed` row is inserted straight
 * into the E2E database — the same row the executor would have written had the
 * provider failed — and the retry from there is genuine. This is the controlled
 * fixture the task allows, and it is stated here rather than hidden.
 *
 * What this file deliberately does NOT prove: that a real provider failure
 * produces that row. No model is called (`LLM_MODE=mock`), so "provider really
 * failed, run really failed, retry really recovered it" stays NOT RUN and is
 * reported as such.
 */

const DB_URL =
  process.env.DATABASE_URL ?? "postgres://nexus:nexus@127.0.0.1:5433/nexus_test_e2e";

/**
 * The container's name is whatever Docker Desktop decided to call it: it comes
 * from the compose project, which follows the directory the stack was started
 * in. Hard-coding `nexus-p0-worktree-postgres-1` meant this file only ran on
 * the machine that name was copied from — everywhere else `docker exec` failed
 * and four specs went red for a reason that had nothing to do with retries.
 *
 * So: ask Docker which container publishes the port this database is on.
 */
function resolveContainer(): string {
  const explicit = process.env.E2E_PG_CONTAINER?.trim();
  if (explicit) return explicit;

  const port = new URL(DB_URL).port || "5432";
  let listing = "";
  try {
    listing = execFileSync(
      "docker",
      ["ps", "--format", "{{.Names}}\t{{.Ports}}"],
      { encoding: "utf8" }
    );
  } catch (error) {
    throw new Error(
      `无法列出 docker 容器，请确认 Docker 在运行（或设置 E2E_PG_CONTAINER 指定容器名）：${error instanceof Error ? error.message : String(error)}`
    );
  }

  const rows = listing
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ports = ""] = line.split("\t");
      return { name: name ?? "", ports };
    })
    .filter((row) => /postgres/i.test(row.name));

  // 端口匹配的那一个才是这套 E2E 的库；同名多开时按端口区分。
  const byPort = rows.find((row) => row.ports.includes(`:${port}->`));
  if (byPort) return byPort.name;
  if (rows.length === 1) return rows[0]!.name;

  throw new Error(
    rows.length === 0
      ? `没有找到名字含 "postgres" 的容器。请启动数据库，或设置 E2E_PG_CONTAINER。`
      : `有多个 PostgreSQL 容器，但没有一个发布 ${port} 端口：${rows
          .map((row) => `${row.name}(${row.ports})`)
          .join(", ")}。请设置 E2E_PG_CONTAINER 指定用哪个。`
  );
}

const PG_CONTAINER = resolveContainer();

/** The database this spec reads, for the error messages below. */
function databaseName(): string {
  return decodeURIComponent(new URL(DB_URL).pathname.replace(/^\//, ""));
}

/** Runs one statement in the E2E database and returns its trimmed output. */
function sql(statement: string): string {
  const url = new URL(DB_URL);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return execFileSync(
    "docker",
    [
      "exec",
      PG_CONTAINER,
      "psql",
      "-U",
      decodeURIComponent(url.username),
      "-d",
      database,
      "-t",
      "-A",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      statement
    ],
    { encoding: "utf8" }
  ).trim();
}

async function loginAsOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("owner");
  await page.getByLabel("密码").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1
      )
    )
    .toBe(true);
}

/** A real session with at least one real claim, produced by the real pipeline. */
async function seedSessionWithClaim(page: Page): Promise<{
  sessionId: string;
  claimId: string;
}> {
  const created = await page.context().request.post("/api/sessions", {
    headers: { "idempotency-key": `e2e-retry-create-${randomUUID()}` },
    data: {
      project: {
        name: "Agent retry e2e",
        summary: "Retry lineage surface of the agent operations center",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "none"
      },
      locale: "zh-CN",
      researchQuestion: "该结论在 12 个月内是否仍然成立？"
    }
  });
  expect(created.status()).toBe(201);
  const { id: sessionId } = (await created.json()) as { id: string };

  const started = await page.context().request.post(
    `/api/sessions/${sessionId}/start`,
    {
      headers: { "idempotency-key": `e2e-retry-start-${randomUUID()}` },
      data: {}
    }
  );
  expect(started.status()).toBe(202);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const view = await page.context().request.get(
      `/api/sessions/${sessionId}/research`
    );
    if (view.ok()) {
      const body = (await view.json()) as { claims: Array<{ id: string }> };
      if (body.claims.length > 0) {
        return { sessionId, claimId: body.claims[0]!.id };
      }
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("the orchestration run produced no claims in time");
}

/**
 * Writes the one row the UI cannot otherwise reach: a cross-review run that
 * failed. `attempt` is 1 and there is no parent — exactly what a first
 * generation looks like after the provider gave up.
 */
function insertFailedRun(sessionId: string, claimId: string): string {
  const runId = randomUUID();
  const [roleId, promptVersionId] = sql(
    "SELECT id || ' ' || prompt_version_id FROM agent_roles ORDER BY key LIMIT 1"
  ).split(" ");
  /*
   * Empty here means one of two things, and they are worth telling apart:
   * the pipeline never ran (no session ever reached orchestration in this
   * database), or core is writing to a different database than this spec is
   * reading. Both used to surface as the same useless sentence.
   */
  expect(
    roleId,
    `在库 ${databaseName()} 里没有 agent role。要么这条流水线从没在这个库里跑过，` +
      `要么 core 连的不是这个库（它默认连 nexus，本文件默认 nexus_test_e2e）。` +
      `两边必须同一个库；设置 DATABASE_URL 让二者一致后重跑。`
  ).toBeTruthy();
  expect(promptVersionId, "the role must carry a prompt version").toBeTruthy();

  sql(
    `INSERT INTO agent_runs
       (id, session_id, role_id, prompt_version_id, status, error, error_code,
        task_type, attempt, parent_run_id, input, started_at, completed_at)
     VALUES
       ('${runId}', '${sessionId}', '${roleId}', '${promptVersionId}', 'failed',
        '受控 E2E fixture：提供方不可用（非真实模型失败）', 'provider_unavailable',
        'cross_review', 1, NULL,
        '{"kind":"cross_review","targetClaimId":"${claimId}","requestedBy":"e2e fixture"}'::jsonb,
        now() - interval '6 minutes', now() - interval '5 minutes')`
  );
  return runId;
}

test.describe("agent retry", () => {
  test("a failed run opens the next attempt with its lineage already written", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsOwner(page);
    const { sessionId, claimId } = await seedSessionWithClaim(page);
    const failedRunId = insertFailedRun(sessionId, claimId);

    await page.goto(`/research/${sessionId}`);
    await expect(page.getByTestId("research-body")).toBeVisible();
    await page.getByRole("tab", { name: "运行中心" }).click();

    const panel = page.getByTestId("agent-ops-panel");
    await expect(panel).toBeVisible();
    // The fixture row is read back through the real list endpoint.
    const row = panel.locator(`[data-run-id="${failedRunId}"]`);
    await expect(row).toContainText("交叉审查");
    await expect(row).toContainText("已失败");
    await row.getByRole("button", { name: "详情" }).click();

    // Attempt 1, no parent: the honest starting point.
    await expect(page.getByTestId("agent-run-attempt")).toContainText("第 1 次");
    await expect(page.getByTestId("agent-run-open-parent")).toHaveCount(0);

    const retry = page.getByTestId("agent-run-retry");
    await expect(retry).toBeEnabled();
    await expect(page.getByTestId("agent-run-retry-reason")).toHaveCount(0);
    await retry.click();

    // The server's answer, not the button's optimism: the lineage that was
    // written *before* the executor ran.
    const state = page.getByTestId("agent-run-retry-state");
    await expect(state).toBeVisible();
    await expect(state).toHaveAttribute("data-retry-attempt", "2");
    await expect(state).toContainText("已创建第 2 次尝试");
    // "Created" is not dressed up as "finished".
    await expect(state).toContainText("执行结果以各运行的当前状态为准");
    await expect(page.getByTestId("agent-run-retry-refusal")).toHaveCount(0);

    // The database is the authority: every child of this run carries attempt 2
    // and points back at it. A retry opens one *generation*, which is one run
    // per challenger — the count is the roster's, not this test's.
    const children = sql(
      `SELECT id FROM agent_runs WHERE parent_run_id = '${failedRunId}' ORDER BY id`
    )
      .split("\n")
      .filter(Boolean);
    expect(children.length).toBeGreaterThan(0);
    await expect(state).toContainText(`${children.length} 个新运行`);
    expect(
      sql(
        `SELECT count(*) FROM agent_runs
           WHERE parent_run_id = '${failedRunId}' AND attempt = 2`
      )
    ).toBe(String(children.length));
    expect(
      sql(
        `SELECT count(*) FROM agent_runs WHERE session_id = '${sessionId}' AND attempt > 2`
      )
    ).toBe("0");

    // The failed run itself was not rewritten by the retry.
    expect(
      sql(
        `SELECT status || '|' || attempt || '|' || coalesce(parent_run_id::text, '-')
           FROM agent_runs WHERE id = '${failedRunId}'`
      )
    ).toBe("failed|1|-");

    // The chain is visible from both ends.
    await page
      .locator(`[data-run-id="${children[0]}"]`)
      .getByRole("button", { name: "详情" })
      .click();
    await expect(page.getByTestId("agent-run-attempt")).toContainText("第 2 次");
    const openParent = page.getByTestId("agent-run-open-parent");
    await expect(openParent).toBeVisible();
    await openParent.click();
    await expect(page.getByTestId("agent-run-attempt")).toContainText("第 1 次");
    await expect(page.getByTestId("agent-run-retry-children")).toBeVisible();

    await expectNoHorizontalOverflow(page);
  });

  test("the retry chain survives a page reload", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsOwner(page);
    const { sessionId, claimId } = await seedSessionWithClaim(page);
    const failedRunId = insertFailedRun(sessionId, claimId);

    // Retry through the API, so this test is about persistence rather than the
    // button. Same endpoint, same idempotency contract as the UI uses.
    const retried = await page.context().request.post(
      `/api/sessions/${sessionId}/agent-runs/${failedRunId}/retry`,
      { headers: { "idempotency-key": `e2e-retry-api-${randomUUID()}` }, data: {} }
    );
    expect(retried.status()).toBe(201);
    const body = (await retried.json()) as {
      retry: { attempt: number; runIds: string[] };
    };
    expect(body.retry.attempt).toBe(2);
    expect(body.retry.runIds.length).toBeGreaterThan(0);

    await page.goto(`/research/${sessionId}`);
    await page.getByRole("tab", { name: "运行中心" }).click();
    const panel = page.getByTestId("agent-ops-panel");
    await panel
      .locator(`[data-run-id="${failedRunId}"]`)
      .getByRole("button", { name: "详情" })
      .click();

    // Nothing is remembered in the client: a fresh page load still knows the
    // child, because the child is a row.
    const children = page.getByTestId("agent-run-retry-children");
    await expect(children).toBeVisible();
    for (const runId of body.retry.runIds) {
      await expect(children).toContainText(runId.slice(0, 8));
    }
    await expectNoHorizontalOverflow(page);
  });

  test("a finished run offers no retry, and the server agrees", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsOwner(page);
    const { sessionId, claimId } = await seedSessionWithClaim(page);

    // A real cross-review: the engine really runs, the run really completes.
    const review = await page.context().request.post(
      `/api/sessions/${sessionId}/claims/${claimId}/cross-review`,
      { headers: { "idempotency-key": `e2e-retry-review-${randomUUID()}` }, data: {} }
    );
    expect(review.status()).toBe(201);

    const before = sql(
      `SELECT count(*) FROM agent_runs WHERE session_id = '${sessionId}'`
    );

    await page.goto(`/research/${sessionId}`);
    await page.getByRole("tab", { name: "运行中心" }).click();
    const panel = page.getByTestId("agent-ops-panel");
    await panel
      .getByTestId("agent-run-row")
      .first()
      .getByRole("button", { name: "详情" })
      .click();

    const retry = page.getByTestId("agent-run-retry");
    await expect(retry).toBeDisabled();
    await expect(page.getByTestId("agent-run-retry-reason")).toContainText(
      "该运行已结束"
    );
    await expect(page.getByTestId("agent-run-retry-state")).toHaveCount(0);

    // The button is not the gate: the server refuses on its own.
    const runId = await panel
      .getByTestId("agent-run-row")
      .first()
      .getAttribute("data-run-id");
    const refused = await page.context().request.post(
      `/api/sessions/${sessionId}/agent-runs/${runId}/retry`,
      { headers: { "idempotency-key": `e2e-retry-refused-${randomUUID()}` }, data: {} }
    );
    expect(refused.status()).toBe(409);
    expect((await refused.json()) as { code: string }).toMatchObject({
      code: "run_not_retryable"
    });

    // A refusal writes nothing.
    expect(
      sql(`SELECT count(*) FROM agent_runs WHERE session_id = '${sessionId}'`)
    ).toBe(before);
  });

  test("a phone keeps the retry control readable and the reason in text", async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsOwner(page);
    const { sessionId, claimId } = await seedSessionWithClaim(page);
    const failedRunId = insertFailedRun(sessionId, claimId);

    await page.goto(`/research/${sessionId}`);
    await expect(page.getByTestId("research-body")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByRole("tab", { name: "运行中心" }).click();
    const panel = page.getByTestId("agent-ops-panel");
    await expect(panel).toBeVisible();
    await panel
      .locator(`[data-run-id="${failedRunId}"]`)
      .getByRole("button", { name: "详情" })
      .click();

    const retry = page.getByTestId("agent-run-retry");
    await expect(retry).toBeVisible();
    // A 24px minimum target, per the platform's touch rule.
    const box = await retry.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);

    await retry.click();
    const state = page.getByTestId("agent-run-retry-state");
    await expect(state).toHaveAttribute("data-retry-attempt", "2");
    // The lineage is named on a phone too — the new run ids are text, not a
    // hover detail — and the child really is a row in the list below.
    const children = sql(
      `SELECT id FROM agent_runs WHERE parent_run_id = '${failedRunId}' ORDER BY id`
    )
      .split("\n")
      .filter(Boolean);
    expect(children.length).toBeGreaterThan(0);
    await expect(state).toContainText(children[0]!.slice(0, 8));
    await expect(
      panel.locator(`[data-run-id="${children[0]}"]`)
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
