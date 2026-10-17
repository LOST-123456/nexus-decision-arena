import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * CSRF and origin handling, exercised by a real browser against the real app.
 *
 * The point of this file is that a browser test can lie in two ways, and both
 * are avoided here:
 *
 *  1. "The page could not read the response, so the attack must have failed."
 *     A cross-origin `fetch` rejects whether the server refused the write or
 *     performed it — the browser blocks the *reading*, not the request. So the
 *     status is read from Playwright's own view of the network, which sees the
 *     real `403`, and the database is checked afterwards to prove nothing was
 *     written.
 *  2. "The write was refused, so CSRF is handled." A refusal only means
 *     something if the legitimate write still goes through. Every surface this
 *     change could plausibly break — research creation, team roles, library
 *     grants, file import, run control — is exercised from the app's own
 *     origin in the same file.
 *
 * The attacker page is served from a *different port on the same host*, which
 * makes it a different origin but the same site. That is deliberate: it is the
 * case `SameSite=Lax` does not cover, so the cookie really is attached and the
 * server-side check is the only thing standing between the page and the write.
 *
 * Screenshots land in `artifacts/playwright-p27`, which is separate from the
 * tracked `artifacts/playwright` set.
 */

const CREDENTIALS = { username: "owner", password: "nexus-owner" };
const CSRF_BODY = { error: "Request origin rejected", code: "csrf_origin_rejected" };

async function loginAsOwner(page: Page): Promise<void> {
  // The login page asks the API who the caller is as soon as it mounts, so that
  // request is a reliable hydration signal. Without waiting for it, a click on
  // a not-yet-hydrated form falls through to a native GET submit and the URL
  // becomes `/login?` — a race that has nothing to do with what is under test.
  const hydrated = page
    .waitForResponse((response) => response.url().includes("/api/auth/me"), {
      timeout: 30_000
    })
    .catch(() => undefined);
  await page.goto("/login");
  await hydrated;

  await page.getByLabel("用户名").fill(CREDENTIALS.username);
  await page.getByLabel("密码").fill(CREDENTIALS.password);
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page).toHaveURL(/\/$/);
}

type FetchResult<T> = { status: number; body: T };

/**
 * Performs a write from the application's own origin, in the browser.
 *
 * Chromium attaches the real `Origin` and `Sec-Fetch-*` headers, so this is the
 * legitimate-client path rather than a stand-in for it.
 */
async function appWrite<T>(
  page: Page,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: string }
): Promise<FetchResult<T>> {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, {
        method: init.method,
        ...(init.headers === undefined ? {} : { headers: init.headers }),
        ...(init.body === undefined ? {} : { body: init.body })
      });
      const text = await response.text();
      return {
        status: response.status,
        body: (text ? JSON.parse(text) : null) as never
      };
    },
    { path, init }
  ) as Promise<FetchResult<T>>;
}

async function appRead<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (path) => {
    const response = await fetch(path);
    return (await response.json()) as never;
  }, path);
}

async function createResearch(page: Page, name: string): Promise<string> {
  const created = await appWrite<{ id: string }>(page, "/api/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `p27-create-${randomUUID()}`
    },
    body: JSON.stringify({
      project: {
        name,
        summary: "CSRF origin verification",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "none"
      },
      locale: "zh-CN",
      researchQuestion: "该结论是否成立？"
    })
  });
  expect(created.status).toBe(201);
  return created.body.id;
}

async function inviteReviewer(page: Page, sessionId: string, userId: string): Promise<void> {
  const invited = await appWrite(page, `/api/sessions/${sessionId}/collaboration/members/invite`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `p27-invite-${randomUUID()}`
    },
    body: JSON.stringify({ userId, role: "reviewer" })
  });
  expect(invited.status).toBe(201);
}

type MemberRow = { userId: string; role: string };
async function roleOf(page: Page, sessionId: string, userId: string): Promise<string | null> {
  const listed = await appRead<{ members: MemberRow[] }>(
    page,
    `/api/sessions/${sessionId}/collaboration/members`
  );
  return listed.members.find((member) => member.userId === userId)?.role ?? null;
}

type AttackerPage = { origin: string; close: () => Promise<void> };

/**
 * A page on another origin of the same site.
 *
 * It serves nothing but a document: the cross-origin requests are issued from
 * inside that document by `attack`, so they carry the page's own `Origin` and
 * the browser's cookie jar rather than anything the test fabricated.
 */
async function startAttackerPage(): Promise<AttackerPage> {
  const html = `<!doctype html><meta charset="utf-8"><title>attacker</title>
<body><p id="hello">attacker page</p></body>`;

  const server: Server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
    void request;
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      })
  };
}

/**
 * Submits a cross-origin form from whatever page is currently loaded.
 *
 * A form is the vector a cross-site attacker actually has without a preflight:
 * `fetch` with a JSON body triggers one, `enctype="text/plain"` does not. The
 * submission navigates a hidden iframe, which is why Playwright can see the real
 * status and read the refusal — a `fetch` whose response carries no CORS grant
 * is reported as `net::ERR_FAILED` instead, and the status would be invisible.
 *
 * The body is not valid JSON on purpose: the refusal must come from the origin
 * check, before any parsing, or a malformed body could be what stopped it.
 */
async function crossSiteFormPost(
  page: Page,
  action: string,
  body?: string
): Promise<void> {
  await page.evaluate(
    ({ action, body }) => {
      const sink = `sink-${Math.random().toString(36).slice(2)}`;
      const iframe = document.createElement("iframe");
      iframe.name = sink;
      iframe.style.display = "none";
      document.body.appendChild(iframe);

      const form = document.createElement("form");
      form.method = "POST";
      form.action = action;
      form.enctype = "text/plain";
      form.target = sink;
      if (body !== undefined) {
        const field = document.createElement("input");
        field.name = "";
        field.value = body;
        form.appendChild(field);
      }
      document.body.appendChild(form);
      form.submit();
    },
    { action, body }
  );
}

/**
 * Runs one `fetch` from whatever page is currently loaded, and reports what that
 * page can observe. Used for the JSON case, where the browser sends a preflight
 * first and the page only ever sees a rejected promise.
 */
async function crossSiteFetch(
  page: Page,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string }
): Promise<{ ok: boolean; status?: number; error?: string }> {
  return page.evaluate(
    async ({ url, init }) => {
      try {
        const response = await fetch(url, {
          credentials: "include",
          method: init.method,
          ...(init.headers === undefined ? {} : { headers: init.headers }),
          ...(init.body === undefined ? {} : { body: init.body })
        });
        return { ok: true, status: response.status };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
    { url, init }
  );
}

const SCREENSHOT_DIR = resolve(process.cwd(), "../../artifacts/playwright-p27");

async function capture(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  // Let entrance animations settle before the frame is taken.
  await page.waitForTimeout(360);
  await page.screenshot({
    path: resolve(SCREENSHOT_DIR, `${name}.png`),
    fullPage: false
  });
}

test.describe("CSRF and origin handling in a real browser", () => {
  test("a legitimate browser session can still write everywhere it needs to", async ({ page }) => {
    await loginAsOwner(page);
    const sessionId = await createResearch(page, "P27 合法写入");

    // Team roles: invite, then change the role.
    await inviteReviewer(page, sessionId, "user-2");
    expect(await roleOf(page, sessionId, "user-2")).toBe("reviewer");

    const changed = await appWrite(page, `/api/sessions/${sessionId}/collaboration/members/user-2/role`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "editor" })
    });
    expect(changed.status).toBe(200);
    expect(await roleOf(page, sessionId, "user-2")).toBe("editor");

    // Library grants: create and revoke. The subject must be a real account —
    // the route resolves it rather than trusting an arbitrary id.
    const directory = await appRead<unknown>(page, "/api/auth/users");
    const accounts = (Array.isArray(directory)
      ? directory
      : ((directory as { users?: unknown[] }).users ?? [])) as Array<{
      id: string;
      role: string;
    }>;
    const subject = accounts.find((account) => account.role !== "owner") ?? accounts[0];
    if (!subject) {
      // Loud, not silent: the seeded user file always has a second account, so
      // an empty directory means the fixture is wrong, not that the test is
      // inapplicable.
      throw new Error("expected the seeded user file to contain a second account");
    }

    const granted = await appWrite<{ id: string }>(page, "/api/library/grants", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `p27-grant-${randomUUID()}`
      },
      body: JSON.stringify({
        sessionId,
        subjectType: "user",
        subjectId: subject.id,
        scope: "read"
      })
    });
    expect(granted.status).toBe(201);

    const revoked = await appWrite(page, `/api/library/grants/${granted.body.id}/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `p27-revoke-${randomUUID()}`
      },
      body: JSON.stringify({ reason: "P27 verification" })
    });
    expect(revoked.status).toBe(200);

    // File import: raw bytes with the name in a header.
    const uploaded = await page.evaluate(
      async (sessionId) => {
        const bytes = new Blob(["Costs rose by 12%.\n"], { type: "application/octet-stream" });
        const response = await fetch(`/api/sessions/${sessionId}/files`, {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "x-file-name": encodeURIComponent("p27-costs.txt"),
            "idempotency-key": `p27-upload-${crypto.randomUUID()}`
          },
          body: bytes
        });
        return { status: response.status };
      },
      sessionId
    );
    expect([200, 201]).toContain(uploaded.status);

    // Run control: an unknown run is a 404, which proves the request was not
    // refused at the origin boundary (that would be a 403).
    const cancel = await appWrite(page, `/api/sessions/${sessionId}/agent-runs/${randomUUID()}/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `p27-cancel-${randomUUID()}`
      },
      body: JSON.stringify({ reason: "P27 verification" })
    });
    expect(cancel.status).toBe(404);

    await page.goto(`/sessions/${sessionId}`);
    await capture(page, `legit-writes-${test.info().project.name}`);
  });

  test("a page on another origin cannot escalate a team role, and the 403 is real", async ({
    page,
    context
  }) => {
    await loginAsOwner(page);
    const sessionId = await createResearch(page, "P27 跨站提权");
    await inviteReviewer(page, sessionId, "user-2");
    expect(await roleOf(page, sessionId, "user-2")).toBe("reviewer");

    // The credential that is about to be borrowed really exists, and it is a
    // cookie: that is what makes this a CSRF attempt rather than a request the
    // page had no rights to make in the first place.
    const cookies = await context.cookies();
    expect(cookies.some((cookie) => cookie.name === "nexus_session")).toBe(true);

    const attacker = await startAttackerPage();
    try {
      await page.goto(attacker.origin);
      await expect(page.getByText("attacker page")).toBeVisible();

      // Registered before the attempt. A form submission is a navigation, so
      // the refusal is a real response the test can read rather than an opaque
      // network error.
      const answered = page.waitForResponse(
        (response) =>
          response.url().includes("/collaboration/members/user-2/role") &&
          response.request().method() === "POST",
        { timeout: 15_000 }
      );

      await crossSiteFormPost(
        page,
        `http://127.0.0.1:3000/api/sessions/${sessionId}/collaboration/members/user-2/role`,
        `{"role":"owner"}`
      );

      const response = await answered;
      expect(response.status()).toBe(403);
      expect(JSON.parse(await response.text())).toEqual(CSRF_BODY);
      // The origin on the wire is the attacker's, not ours.
      expect(response.request().headers()["origin"]).toBe(attacker.origin);
      // A 403 here can only come from the credential rule: without a cookie the
      // route would have answered 401, and the role endpoint is not one of the
      // two checked by name. So the browser did attach the session to a
      // same-site, different-origin request — the case `SameSite=Lax` does not
      // cover, and the reason a server-side check is required.

      await capture(page, `attacker-refused-${test.info().project.name}`);
    } finally {
      await attacker.close();
    }

    // Zero side effect: read the membership from the app's own origin.
    await page.goto(`/sessions/${sessionId}`);
    expect(await roleOf(page, sessionId, "user-2")).toBe("reviewer");
  });

  test("a cross-site JSON write is refused and creates nothing", async ({ page }) => {
    await loginAsOwner(page);
    const sessionId = await createResearch(page, "P27 跨源 JSON 写入");

    const attacker = await startAttackerPage();
    try {
      await page.goto(attacker.origin);

      // A JSON body makes this a non-simple request, so the browser has to ask
      // permission before it can send the write. Whether the refusal surfaces
      // as a failed preflight or as a refused request, the page cannot read the
      // answer either way — which is exactly why the database is checked
      // afterwards rather than trusting what the page observed.
      const attempt = await crossSiteFetch(
        page,
        `http://127.0.0.1:3000/api/sessions/${sessionId}/collaboration/members/invite`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: "user-9", role: "owner" })
        }
      );

      expect(attempt.ok).toBe(false);
    } finally {
      await attacker.close();
    }

    // Back on the application's own origin before reading: the relative path
    // would otherwise resolve against the attacker page, which no longer exists.
    await page.goto(`/sessions/${sessionId}`);
    // No member was added by the attempt.
    expect(await roleOf(page, sessionId, "user-9")).toBeNull();
  });

  test("logout CSRF is refused, and the session survives it", async ({ page }) => {
    await loginAsOwner(page);

    const attacker = await startAttackerPage();
    try {
      await page.goto(attacker.origin);
      const answered = page.waitForResponse(
        (response) =>
          response.url().includes("/api/auth/logout") &&
          response.request().method() === "POST",
        { timeout: 15_000 }
      );

      await crossSiteFormPost(page, "http://127.0.0.1:3000/api/auth/logout");

      const response = await answered;
      expect(response.status()).toBe(403);
      expect(JSON.parse(await response.text())).toEqual(CSRF_BODY);
    } finally {
      await attacker.close();
    }

    // Still signed in: the crafted logout did not take effect.
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    const stillAuthed = await page.evaluate(async () => {
      const response = await fetch("/api/auth/me");
      return response.status;
    });
    expect(stillAuthed).toBe(200);
  });

  test("login CSRF is refused, so no forged session can be planted", async ({ page }) => {
    const attacker = await startAttackerPage();
    try {
      await page.goto(attacker.origin);
      const answered = page.waitForResponse(
        (response) =>
          response.url().includes("/api/auth/login") &&
          response.request().method() === "POST",
        { timeout: 15_000 }
      );

      await crossSiteFormPost(
        page,
        "http://127.0.0.1:3000/api/auth/login",
        `{"username":"attacker","password":"attacker"}`
      );

      const response = await answered;
      expect(response.status()).toBe(403);
      expect(JSON.parse(await response.text())).toEqual(CSRF_BODY);
      // Nothing was issued that could plant a session.
      expect(response.headers()["set-cookie"]).toBeUndefined();
    } finally {
      await attacker.close();
    }

    // Nothing was planted: the browser is still anonymous.
    await page.goto("/login");
    await expect(page.getByLabel("用户名")).toBeVisible();
  });

  test("a non-browser client that forges a trusted origin is still refused", async ({ page }) => {
    await loginAsOwner(page);
    const sessionId = await createResearch(page, "P27 伪造来源");

    // The request context shares the session cookie but sends no Origin, which
    // places it outside the browser path entirely. Claiming a hostile origin
    // must not help it either.
    const forged = await page.context().request.post(
      `/api/sessions/${sessionId}/collaboration/members/invite`,
      {
        headers: {
          origin: "https://attacker.test",
          "idempotency-key": `p27-forged-${randomUUID()}`
        },
        data: { userId: "user-8", role: "owner" }
      }
    );
    expect(forged.status()).toBe(403);
    expect(await forged.json()).toEqual(CSRF_BODY);
  });
});
