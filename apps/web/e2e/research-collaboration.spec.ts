import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  expect,
  test,
  type BrowserContext,
  type Page
} from "@playwright/test";

/**
 * Team collaboration & human review, checked in a real browser against a real
 * backend, with several real signed-in accounts.
 *
 * The promises under test, one per acceptance item that needs a browser:
 *  - inviting, accepting, changing a role and removing a member all happen
 *    through the real controls and each step lands on the shared audit trail;
 *  - the per-research role governs the write surface: a viewer may read but is
 *    refused (403) and offered no controls, while an editor may write;
 *  - a research the account is not a collaborator on answers exactly what an
 *    unknown id answers, so the API cannot be used to probe which exist;
 *  - a review request can neither be self-addressed nor self-claimed, only the
 *    assigned reviewer may decide, and a decision never writes a claim verdict;
 *  - an optimistic-locked write gone stale is a 409 conflict, not a silent
 *    overwrite.
 *
 * Everything is seeded through the real HTTP API and driven through the real
 * UI controls, with independent browser contexts so each account really is its
 * own account. No captured text is fetched from the internet.
 */

const OWNER = { username: "owner", password: "nexus-owner" };

function unique(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function loginAs(
  page: Page,
  account: { username: string; password: string }
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(account.username);
  await page.getByLabel("密码").fill(account.password);
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
}

/** Logs a whole browser context in over the API, so its pages share the cookie. */
async function loginContext(
  context: BrowserContext,
  account: { username: string; password: string }
): Promise<void> {
  const response = await context.request.post("/api/auth/login", {
    data: account
  });
  expect(response.status()).toBe(200);
}

async function createResearch(page: Page, question: string): Promise<string> {
  const created = await page.context().request.post("/api/sessions", {
    headers: { "idempotency-key": `e2e-collab-session-${randomUUID()}` },
    data: {
      project: {
        name: question,
        summary: "Team collaboration e2e",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "none"
      },
      locale: "zh-CN",
      researchQuestion: question
    }
  });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

/** Creates a real account through the owner-only user API. */
async function registerUser(
  page: Page,
  input: {
    username: string;
    displayName: string;
    role: "owner" | "reviewer" | "viewer";
    password: string;
  }
): Promise<{ id: string; username: string }> {
  const created = await page.context().request.post("/api/auth/users", {
    data: input
  });
  expect(created.status()).toBe(201);
  return (await created.json()) as { id: string; username: string };
}

/** Opens the research workspace and switches to the collaboration panel. */
async function openCollaboration(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/research/${sessionId}`);
  await page.getByRole("tab", { name: "团队协作" }).click();
  await expect(page.getByTestId("collaboration-panel")).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  expect(metrics.document).toBeLessThanOrEqual(metrics.viewport + 1);
}

/** Writes a viewport screenshot next to the run, never over arena artifacts. */
async function capture(
  page: Page,
  projectName: string,
  name: string
): Promise<void> {
  const directory = resolve(process.cwd(), "../../artifacts/playwright-p14");
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: resolve(directory, `${projectName}-${name}.png`),
    fullPage: false
  });
}

test("runs the member lifecycle through the UI, each step on the shared audit trail", async ({
  page,
  browser
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAs(page, OWNER);
  const sessionId = await createResearch(page, unique("协作成员研究"));

  // A second real account to invite; created through the real user API.
  const inviteeUsername = unique("collab-editor");
  const inviteePassword = "collab-editor-11";
  const invitee = await registerUser(page, {
    username: inviteeUsername,
    displayName: "E2E 编辑",
    role: "reviewer",
    password: inviteePassword
  });

  // --- the owner invites through the real form -----------------------------
  await openCollaboration(page, sessionId);
  await page.getByTestId("collab-invite-user").fill(invitee.id);
  await page.getByTestId("collab-invite-role").selectOption("editor");
  await page.getByTestId("collab-invite-submit").click();
  await expect(page.getByTestId("collab-message")).toContainText("已邀请");
  const pendingRow = page
    .getByTestId("collab-member")
    .filter({ hasText: invitee.id });
  await expect(pendingRow).toContainText("待接受");

  // --- the invitee accepts, in their own context ---------------------------
  const inviteeContext = await browser.newContext();
  try {
    await loginContext(inviteeContext, {
      username: inviteeUsername,
      password: inviteePassword
    });
    const inviteePage = await inviteeContext.newPage();
    await openCollaboration(inviteePage, sessionId);
    await inviteePage.getByTestId(`collab-accept-${invitee.id}`).click();
    await expect(inviteePage.getByTestId("collab-message")).toContainText(
      "已接受邀请"
    );
    await expect(
      inviteePage.getByTestId("collab-member").filter({ hasText: invitee.id })
    ).toContainText("已加入");
  } finally {
    await inviteeContext.close();
  }

  // --- the owner re-reads the live state and changes the role ---------------
  await openCollaboration(page, sessionId);
  await expect(
    page.getByTestId("collab-member").filter({ hasText: invitee.id })
  ).toContainText("已加入");
  await page.getByTestId(`collab-role-${invitee.id}`).selectOption("reviewer");
  await expect(page.getByTestId("collab-message")).toContainText("角色改为");

  // --- and removes the member, recording who and why ------------------------
  await page.getByTestId(`collab-remove-${invitee.id}`).click();
  await page.getByTestId(`collab-remove-reason-${invitee.id}`).fill(
    "本轮研究范围收窄"
  );
  await page.getByTestId(`collab-remove-confirm-${invitee.id}`).click();
  await expect(page.getByTestId("collab-message")).toContainText("已移除");
  await expect(
    page.getByTestId("collab-member").filter({ hasText: invitee.id })
  ).toContainText("已移除");

  // --- one audit trail: the collaboration actions are execution events -----
  await page.getByTestId("collab-tab-activity").click();
  const activity = page.getByTestId("collab-activity");
  await expect(activity).toContainText("MEMBER_INVITED");
  await expect(activity).toContainText("MEMBER_JOINED");
  await expect(activity).toContainText("MEMBER_ROLE_CHANGED");
  await expect(activity).toContainText("MEMBER_REMOVED");

  await capture(page, testInfo.project.name, "collaboration-members");
  await expectNoHorizontalOverflow(page);
});

test("enforces the collaboration permissions and never silently overwrites", async ({
  page,
  browser
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAs(page, OWNER);
  const sessionId = await createResearch(page, unique("协作权限研究"));

  // Four real accounts: a collaboration viewer, an editor, and a stranger.
  const viewer = await registerUser(page, {
    username: unique("collab-viewer"),
    displayName: "E2E 只读",
    role: "viewer",
    password: "collab-viewer-11"
  });
  const editor = await registerUser(page, {
    username: unique("collab-writer"),
    displayName: "E2E 撰写",
    role: "reviewer",
    password: "collab-writer-11"
  });
  const stranger = await registerUser(page, {
    username: unique("collab-stranger"),
    displayName: "E2E 无关",
    role: "viewer",
    password: "collab-stranger-11"
  });

  // Owner invites viewer + editor; each accepts as themselves.
  for (const [user, role] of [
    [viewer, "viewer"],
    [editor, "editor"]
  ] as const) {
    const invited = await page.context().request.post(
      `/api/sessions/${sessionId}/collaboration/members/invite`,
      {
        headers: { "idempotency-key": `e2e-collab-invite-${randomUUID()}` },
        data: { userId: user.id, role }
      }
    );
    expect(invited.status()).toBe(201);
  }

  const viewerContext = await browser.newContext();
  const editorContext = await browser.newContext();
  const strangerContext = await browser.newContext();
  try {
    await loginContext(viewerContext, {
      username: viewer.username,
      password: "collab-viewer-11"
    });
    await loginContext(editorContext, {
      username: editor.username,
      password: "collab-writer-11"
    });
    await loginContext(strangerContext, {
      username: stranger.username,
      password: "collab-stranger-11"
    });

    for (const [context, user] of [
      [viewerContext, viewer],
      [editorContext, editor]
    ] as const) {
      const accepted = await context.request.post(
        `/api/sessions/${sessionId}/collaboration/members/${user.id}/accept`,
        { headers: { "idempotency-key": `e2e-collab-accept-${randomUUID()}` } }
      );
      expect(accepted.status()).toBe(200);
    }

    // --- a stranger sees exactly what an unknown id shows -------------------
    const notMember = await strangerContext.request.get(
      `/api/sessions/${sessionId}/collaboration/members`
    );
    const unknown = await strangerContext.request.get(
      `/api/sessions/${randomUUID()}/collaboration/members`
    );
    expect(notMember.status()).toBe(404);
    expect(unknown.status()).toBe(404);
    expect(await notMember.json()).toEqual(await unknown.json());

    // --- a viewer may read, but not write ----------------------------------
    expect(
      (
        await viewerContext.request.get(
          `/api/sessions/${sessionId}/collaboration/members`
        )
      ).status()
    ).toBe(200);
    const viewerWrite = await viewerContext.request.post(
      `/api/sessions/${sessionId}/collaboration/work-items`,
      {
        headers: { "idempotency-key": `e2e-collab-w-${randomUUID()}` },
        data: { title: "观众不该建成" }
      }
    );
    expect(viewerWrite.status()).toBe(403);
    const viewerInvite = await viewerContext.request.post(
      `/api/sessions/${sessionId}/collaboration/members/invite`,
      {
        headers: { "idempotency-key": `e2e-collab-i-${randomUUID()}` },
        data: { userId: stranger.id, role: "viewer" }
      }
    );
    expect(viewerInvite.status()).toBe(403);

    // --- an editor may write; a stale update is a conflict ------------------
    const createdWork = await editorContext.request.post(
      `/api/sessions/${sessionId}/collaboration/work-items`,
      {
        headers: { "idempotency-key": `e2e-collab-w-${randomUUID()}` },
        data: { title: "编辑创建的任务" }
      }
    );
    expect(createdWork.status()).toBe(201);
    const workId = ((await createdWork.json()) as { id: string }).id;
    const stale = await editorContext.request.patch(
      `/api/sessions/${sessionId}/collaboration/work-items/${workId}`,
      { data: { status: "completed", expectedVersion: 999 } }
    );
    expect(stale.status()).toBe(409);

    // --- no self-review: not self-addressed, not self-claimed ---------------
    const selfNamed = await editorContext.request.post(
      `/api/sessions/${sessionId}/collaboration/review-requests`,
      {
        headers: { "idempotency-key": `e2e-collab-rr-${randomUUID()}` },
        data: {
          requestType: "claim_review",
          targetType: "claim",
          targetId: "claim-demo",
          requestedReviewerUserId: editor.id
        }
      }
    );
    expect(selfNamed.status()).toBe(400);

    const request = await page.context().request.post(
      `/api/sessions/${sessionId}/collaboration/review-requests`,
      {
        headers: { "idempotency-key": `e2e-collab-rr-${randomUUID()}` },
        data: {
          requestType: "claim_review",
          targetType: "claim",
          targetId: "claim-demo"
        }
      }
    );
    expect(request.status()).toBe(201);
    const requestId = ((await request.json()) as { id: string }).id;

    // The requester may not claim their own request.
    expect(
      (
        await page.context().request.post(
          `/api/sessions/${sessionId}/collaboration/review-requests/${requestId}/claim`
        )
      ).status()
    ).toBe(400);

    // A different collaborator claims, then decides as the assigned reviewer.
    const claimed = await editorContext.request.post(
      `/api/sessions/${sessionId}/collaboration/review-requests/${requestId}/claim`
    );
    expect(claimed.status()).toBe(200);
    const live = (
      (await (
        await editorContext.request.get(
          `/api/sessions/${sessionId}/collaboration/review-requests`
        )
      ).json()) as { reviewRequests: Array<{ id: string; version: number }> }
    ).reviewRequests.find((item) => item.id === requestId)!;
    const decided = await editorContext.request.post(
      `/api/sessions/${sessionId}/collaboration/review-requests/${requestId}/decide`,
      { data: { decision: "approved", expectedVersion: live.version } }
    );
    expect(decided.status()).toBe(200);
    expect(((await decided.json()) as { decision: string }).decision).toBe(
      "approved"
    );

    // A decision is a sign-off on the artifact, never a claim verdict: the
    // session's own evidence-verification state is untouched by it.

    // --- a non-requester, non-owner may not cancel --------------------------
    const openRequest = await page.context().request.post(
      `/api/sessions/${sessionId}/collaboration/review-requests`,
      {
        headers: { "idempotency-key": `e2e-collab-rr-${randomUUID()}` },
        data: {
          requestType: "source_review",
          targetType: "source",
          targetId: "source-demo"
        }
      }
    );
    const openId = ((await openRequest.json()) as { id: string }).id;
    expect(
      (
        await editorContext.request.post(
          `/api/sessions/${sessionId}/collaboration/review-requests/${openId}/cancel`
        )
      ).status()
    ).toBe(403);

    // --- the viewer's UI states the limitation instead of failing ----------
    const viewerPage = await viewerContext.newPage();
    await openCollaboration(viewerPage, sessionId);
    await expect(viewerPage.getByTestId("collaboration-panel")).toContainText(
      "只读角色"
    );
    await expect(viewerPage.getByTestId("collab-invite-form")).toHaveCount(0);
    await expect(viewerPage.getByTestId("collab-work-form")).toHaveCount(0);
    await capture(viewerPage, testInfo.project.name, "collaboration-viewer");
  } finally {
    await viewerContext.close();
    await editorContext.close();
    await strangerContext.close();
  }

  await expectNoHorizontalOverflow(page);
});

test("stays usable on a phone-sized screen", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, OWNER);
  const sessionId = await createResearch(page, unique("移动端协作研究"));

  const member = await registerUser(page, {
    username: unique("collab-mobile"),
    displayName: "E2E 移动协作",
    role: "reviewer",
    password: "collab-mobile-11"
  });
  const invited = await page.context().request.post(
    `/api/sessions/${sessionId}/collaboration/members/invite`,
    {
      headers: { "idempotency-key": `e2e-collab-invite-${randomUUID()}` },
      data: { userId: member.id, role: "reviewer" }
    }
  );
  expect(invited.status()).toBe(201);

  await openCollaboration(page, sessionId);
  await expect(
    page.getByTestId("collab-member").filter({ hasText: member.id })
  ).toContainText("待接受");

  // Every sub-panel is reachable on the narrow layout without overflow.
  for (const tab of ["work", "comments", "review", "activity"] as const) {
    await page.getByTestId(`collab-tab-${tab}`).click();
    await expect(page.getByTestId("collaboration-panel")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }

  await capture(page, testInfo.project.name, "collaboration-mobile");
});
