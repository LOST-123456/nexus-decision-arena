/**
 * Wire-level tests for the CORS policy and the CSRF origin guard.
 *
 * Every case here goes over a real TCP socket with hand-written headers, not
 * through a unit call. Two reasons:
 *  - `Origin`, `Sec-Fetch-Site` and `Cookie` are exactly the headers a test
 *    helper would be tempted to normalize away. Sending them literally is the
 *    only way to know what the server does with a malformed one.
 *  - The claim being tested is "the handler never ran", which is only
 *    believable when the request actually reached a server that had a handler
 *    to run.
 *
 * No database is involved; side-effect assertions for real routes live in
 * `security.integration.test.ts`.
 */
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ALLOWED_CORS_HEADERS,
  ALLOWED_CORS_METHODS,
  carriesSessionCookie,
  registerBrowserSecurity,
  type BrowserSecurityOptions
} from "./browser-security";
import {
  CSRF_REJECTION_BODY,
  normalizeOrigin,
  type OriginPolicy
} from "./origin-policy";

type HttpResult = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

type Harness = {
  base: string;
  /** Labels of handlers that actually executed, in order. */
  calls: string[];
  app: FastifyInstance;
};

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  while (openApps.length > 0) {
    const app = openApps.pop();
    if (app) await app.close();
  }
});

function policyOf(...origins: string[]): OriginPolicy {
  return {
    allowed: new Set(origins.map((origin) => normalizeOrigin(origin)!)),
    source: "environment",
    empty: origins.length === 0
  };
}

/**
 * Boots a real server carrying the guard plus one handler per route shape the
 * product actually exposes. The routes are registered so that a request which
 * slips past the guard is visible as a `calls` entry rather than as a 404 that
 * would hide the failure.
 */
async function boot(
  policy: OriginPolicy,
  options: BrowserSecurityOptions = {}
): Promise<Harness> {
  const app = Fastify({ logger: false });
  const calls: string[] = [];
  registerBrowserSecurity(app, policy, options);

  app.get("/api/sessions", async () => {
    calls.push("list-sessions");
    return { sessions: [] };
  });
  app.post("/api/auth/login", async () => {
    calls.push("login");
    return { ok: true };
  });
  app.post("/api/auth/logout", async () => {
    calls.push("logout");
    return { ok: true };
  });
  app.post("/api/sessions/:sessionId/agent-runs/:runId/cancel", async () => {
    calls.push("cancel-run");
    return { ok: true };
  });
  app.post("/api/sessions/:sessionId/agent-runs/:runId/retry", async () => {
    calls.push("retry-run");
    return { ok: true };
  });
  app.patch(
    "/api/sessions/:sessionId/collaboration/members/:userId/role",
    async () => {
      calls.push("patch-member-role");
      return { ok: true };
    }
  );
  app.delete(
    "/api/sessions/:sessionId/collaboration/comments/:commentId",
    async () => {
      calls.push("delete-comment");
      return { ok: true };
    }
  );
  app.post("/api/files", async () => {
    calls.push("upload-file");
    return { ok: true };
  });
  app.post("/api/library/grants/:grantId/revoke", async () => {
    calls.push("revoke-grant");
    return { ok: true };
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  openApps.push(app);

  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, calls, app };
}

function send(
  base: string,
  init: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(init.path, base);
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.body !== undefined) {
      headers["content-length"] = String(Buffer.byteLength(init.body));
    }
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init.method,
        headers
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body
          });
        });
      }
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

const TRUSTED = "https://nexus.example";
const SESSION = "nexus_session=payload.signature";
const JSON_HEADERS = { "content-type": "application/json" };

/** A refusal: uniform status, uniform body, no CORS grant, cache-safe. */
function expectRefused(result: HttpResult): void {
  expect(result.status).toBe(403);
  expect(JSON.parse(result.body)).toEqual(CSRF_REJECTION_BODY);
  expect(result.headers["access-control-allow-origin"]).toBeUndefined();
  expect(result.headers["access-control-allow-credentials"]).toBeUndefined();
  // Never `*`, in any branch.
  expect(result.headers["access-control-allow-origin"]).not.toBe("*");
  // A shared cache must not serve an accepted body where a refusal belongs.
  expect(result.headers["vary"]).toBe("Origin");
}

function expectAccepted(result: HttpResult, label: string, calls: string[]): void {
  expect(result.status).toBe(200);
  expect(calls).toEqual([label]);
}

describe("cookie detection", () => {
  it("finds the session cookie among others", () => {
    expect(carriesSessionCookie("theme=dark; nexus_session=abc.def")).toBe(true);
  });

  it("ignores cookies whose name merely starts with the session cookie name", () => {
    expect(carriesSessionCookie("nexus_session_backup=abc")).toBe(false);
    expect(carriesSessionCookie("nexus_session=abc")).toBe(true);
  });

  it("reports nothing for a missing or empty header", () => {
    expect(carriesSessionCookie(undefined)).toBe(false);
    expect(carriesSessionCookie("")).toBe(false);
  });
});

describe("state-changing requests that carry ambient credentials", () => {
  it("lets a same-origin write through and grants CORS on the answer", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED));

    const result = await send(base, {
      method: "POST",
      path: "/api/sessions/s1/agent-runs/r1/cancel",
      headers: { origin: TRUSTED, cookie: SESSION, ...JSON_HEADERS },
      body: JSON.stringify({ reason: "user" })
    });

    expectAccepted(result, "cancel-run", calls);
    expect(result.headers["access-control-allow-origin"]).toBe(TRUSTED);
    expect(result.headers["access-control-allow-credentials"]).toBe("true");
    expect(result.headers["vary"]).toBe("Origin");
  });

  it("refuses a write from an origin that was never configured", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED));

    const result = await send(base, {
      method: "POST",
      path: "/api/sessions/s1/agent-runs/r1/cancel",
      headers: {
        origin: "https://attacker.test",
        cookie: SESSION,
        ...JSON_HEADERS
      },
      body: JSON.stringify({ reason: "user" })
    });

    expectRefused(result);
    expect(calls).toEqual([]);
  });

  it("refuses a cookie-bearing write that is browser-shaped but presents no origin", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED));

    // A browser always sends Origin on unsafe requests. If it sends Fetch
    // Metadata and no Origin, something is wrong — fail closed rather than
    // guess.
    for (const header of [
      "sec-fetch-site",
      "sec-fetch-mode",
      "sec-fetch-dest"
    ] as const) {
      const result = await send(base, {
        method: "POST",
        path: "/api/sessions/s1/agent-runs/r1/cancel",
        headers: {
          [header]: header === "sec-fetch-site" ? "same-origin" : "empty",
          cookie: SESSION,
          ...JSON_HEADERS
        },
        body: "{}"
      });
      expectRefused(result);
    }
    expect(calls).toEqual([]);
  });

  it("refuses Origin: null, which names no origin", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED));

    for (const value of ["null", "NULL", " Null "]) {
      const result = await send(base, {
        method: "POST",
        path: "/api/sessions/s1/agent-runs/r1/retry",
        headers: { origin: value, cookie: SESSION, ...JSON_HEADERS },
        body: "{}"
      });
      expectRefused(result);
    }
    expect(calls).toEqual([]);
  });

  it("refuses an origin that is not a bare http(s) origin", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED));

    const malformed = [
      "not-a-url",
      "nexus.example",
      "ftp://nexus.example",
      "file://nexus.example",
      "javascript:alert(1)",
      // A path, query or fragment means something rewrote the header.
      "https://nexus.example/api",
      "https://nexus.example/?next=1",
      "https://nexus.example/#top",
      // Duplicate headers get joined into one value by the runtime.
      "https://nexus.example, https://attacker.test",
      // A wildcard is never a client-supplied origin.
      "*",
      // Credentials in the authority indicate a forged value.
      "https://nexus.example@attacker.test",
      // A trailing dot resolves to the same host but is a different string.
      "https://nexus.example."
    ];

    for (const origin of malformed) {
      const result = await send(base, {
        method: "PATCH",
        path: "/api/sessions/s1/collaboration/members/u1/role",
        headers: { origin, cookie: SESSION, ...JSON_HEADERS },
        body: JSON.stringify({ role: "viewer" })
      });
      expectRefused(result);
    }
    expect(calls).toEqual([]);
  });

  it("refuses lookalike hosts: suffix, prefix, subdomain and sibling", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED));

    const lookalikes = [
      "https://evil-nexus.example",
      "https://nexus.example.attacker.test",
      "https://app.nexus.example",
      "https://nexus.example.co",
      "https://nexus-example.test",
      "https://xnexus.example"
    ];

    for (const origin of lookalikes) {
      const result = await send(base, {
        method: "POST",
        path: "/api/library/grants/g1/revoke",
        headers: { origin, cookie: SESSION }
      });
      expectRefused(result);
    }
    expect(calls).toEqual([]);
  });

  it("refuses a plain-http downgrade of a trusted https origin", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED));

    const result = await send(base, {
      method: "POST",
      path: "/api/files",
      headers: { origin: "http://nexus.example", cookie: SESSION, ...JSON_HEADERS },
      body: "{}"
    });

    expectRefused(result);
    expect(calls).toEqual([]);
  });

  it("refuses a port that is not the trusted one", async () => {
    const local = await boot(policyOf("http://localhost:3000"));

    for (const origin of [
      "http://localhost:4100",
      "http://localhost:3001",
      "http://localhost",
      "https://localhost:3000"
    ]) {
      const result = await send(local.base, {
        method: "POST",
        path: "/api/files",
        headers: { origin, cookie: SESSION, ...JSON_HEADERS },
        body: "{}"
      });
      expectRefused(result);
    }
    expect(local.calls).toEqual([]);
  });

  it("treats a default port as the same origin and a non-default one as different", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED));

    const result = await send(base, {
      method: "POST",
      path: "/api/files",
      headers: {
        origin: "https://nexus.example:443",
        cookie: SESSION,
        ...JSON_HEADERS
      },
      body: "{}"
    });
    expectAccepted(result, "upload-file", calls);

    const other = await send(base, {
      method: "POST",
      path: "/api/files",
      headers: {
        origin: "https://nexus.example:8443",
        cookie: SESSION,
        ...JSON_HEADERS
      },
      body: "{}"
    });
    expectRefused(other);
  });

  it("matches an internationalized host regardless of which spelling was configured", async () => {
    // An operator writes the readable form into WEB_ORIGINS; the browser
    // serializes the same host to punycode in the header. Both sides go through
    // the URL parser, so the comparison happens on one canonical spelling.
    const { base, calls } = await boot(policyOf("https://bücher.example"));

    const result = await send(base, {
      method: "POST",
      path: "/api/files",
      headers: {
        origin: "https://xn--bcher-kva.example",
        cookie: SESSION,
        ...JSON_HEADERS
      },
      body: "{}"
    });

    expectAccepted(result, "upload-file", calls);
    expect(result.headers["access-control-allow-origin"]).toBe(
      "https://xn--bcher-kva.example"
    );
  });

  it("refuses on Sec-Fetch-Site: cross-site even when the origin looks trusted", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED));

    const result = await send(base, {
      method: "POST",
      path: "/api/sessions/s1/agent-runs/r1/cancel",
      headers: {
        origin: TRUSTED,
        "sec-fetch-site": "cross-site",
        cookie: SESSION,
        ...JSON_HEADERS
      },
      body: "{}"
    });

    expectRefused(result);
    expect(calls).toEqual([]);
  });

  it("does not treat missing Fetch Metadata as permission", async () => {
    // An old browser sends no Sec-Fetch-Site. It must still be decided by
    // Origin — accepted here, and refused in the case above.
    const { base, calls } = await boot(policyOf(TRUSTED));

    const result = await send(base, {
      method: "POST",
      path: "/api/sessions/s1/agent-runs/r1/cancel",
      headers: { origin: TRUSTED, cookie: SESSION, ...JSON_HEADERS },
      body: "{}"
    });

    expectAccepted(result, "cancel-run", calls);
  });

  it("accepts same-origin and same-site Fetch Metadata from a trusted origin", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED));

    for (const site of ["same-origin", "same-site", "none"]) {
      const result = await send(base, {
        method: "POST",
        path: "/api/files",
        headers: {
          origin: TRUSTED,
          "sec-fetch-site": site,
          cookie: SESSION,
          ...JSON_HEADERS
        },
        body: "{}"
      });
      expect(result.status).toBe(200);
    }
    expect(calls).toEqual(["upload-file", "upload-file", "upload-file"]);
  });

  it("refuses every unsafe method, not just POST", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED));

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const result = await send(base, {
        method,
        path: "/api/sessions/s1/collaboration/members/u1/role",
        headers: { origin: "https://attacker.test", cookie: SESSION, ...JSON_HEADERS },
        ...(method === "DELETE" ? {} : { body: "{}" })
      });
      expectRefused(result);
    }
    expect(calls).toEqual([]);
  });

  it("refuses a body-bearing form post before the body is consumed", async () => {
    // `text/plain` and urlencoded forms are the shapes a cross-site HTML form
    // can actually produce without a preflight.
    const { base, calls } = await boot(policyOf(TRUSTED));

    for (const contentType of [
      "application/x-www-form-urlencoded",
      "text/plain",
      "multipart/form-data; boundary=----x"
    ]) {
      const result = await send(base, {
        method: "POST",
        path: "/api/auth/login",
        headers: {
          origin: "https://attacker.test",
          "content-type": contentType
        },
        body: "username=a&password=b"
      });
      expectRefused(result);
    }
    expect(calls).toEqual([]);
  });
});

describe("requests without ambient credentials", () => {
  it("lets an unauthenticated write reach the route, which answers for itself", async () => {
    // No cookie, no Origin: a CLI or a service worker. CSRF has nothing to
    // borrow here, so the guard stays out of the way and the route's own 401
    // is the answer. Blocking this would break every non-browser client for
    // no security gain.
    const { base, calls } = await boot(policyOf(TRUSTED));

    const result = await send(base, {
      method: "POST",
      path: "/api/sessions/s1/agent-runs/r1/cancel",
      headers: JSON_HEADERS,
      body: "{}"
    });

    expectAccepted(result, "cancel-run", calls);
  });

  it("lets a non-browser client with a cookie through, because no page can look like that", async () => {
    // The documented exemption: no Origin and no Fetch Metadata. A cross-site
    // page cannot produce this shape — it would always send Origin — so there
    // is no ambient-credential attack to refuse here. The route still decides
    // who the caller is.
    const { base, calls } = await boot(policyOf(TRUSTED));

    const result = await send(base, {
      method: "POST",
      path: "/api/sessions/s1/agent-runs/r1/cancel",
      headers: { cookie: SESSION, ...JSON_HEADERS },
      body: "{}"
    });

    expectAccepted(result, "cancel-run", calls);
  });

  it("guards the credential endpoints without waiting for a cookie to exist", async () => {
    // Login is checked by name, not by cookie: a browser logging in has no
    // session yet, and that is exactly when a forged login would be planted.
    const { base, calls } = await boot(policyOf(TRUSTED));

    for (const path of ["/api/auth/login", "/api/auth/logout"]) {
      const crossSite = await send(base, {
        method: "POST",
        path,
        headers: { origin: "https://attacker.test", ...JSON_HEADERS },
        body: "{}"
      });
      expectRefused(crossSite);

      const noOrigin = await send(base, {
        method: "POST",
        path,
        headers: { "sec-fetch-site": "same-origin", ...JSON_HEADERS },
        body: "{}"
      });
      expectRefused(noOrigin);
    }
    expect(calls).toEqual([]);
  });

  it("does not mistake a similarly named cookie for the session", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED));

    const result = await send(base, {
      method: "POST",
      path: "/api/files",
      headers: {
        origin: "https://attacker.test",
        cookie: "nexus_session_backup=abc; theme=dark",
        ...JSON_HEADERS
      },
      body: "{}"
    });

    expectAccepted(result, "upload-file", calls);
  });

  it("still guards login, which establishes the credential before any cookie exists", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED));

    const crossSite = await send(base, {
      method: "POST",
      path: "/api/auth/login",
      headers: { origin: "https://attacker.test", ...JSON_HEADERS },
      body: JSON.stringify({ username: "a", password: "b" })
    });
    expectRefused(crossSite);

    const noOrigin = await send(base, {
      method: "POST",
      path: "/api/auth/login",
      headers: { "sec-fetch-site": "same-origin", ...JSON_HEADERS },
      body: JSON.stringify({ username: "a", password: "b" })
    });
    expectRefused(noOrigin);

    const sameOrigin = await send(base, {
      method: "POST",
      path: "/api/auth/login",
      headers: { origin: TRUSTED, ...JSON_HEADERS },
      body: JSON.stringify({ username: "a", password: "b" })
    });
    expectAccepted(sameOrigin, "login", calls);
    expect(calls).toEqual(["login"]);
  });

  it("guards login even behind a query string", async () => {
    const { base } = await boot(policyOf(TRUSTED));

    const result = await send(base, {
      method: "POST",
      path: "/api/auth/login?next=/sessions",
      headers: { origin: "https://attacker.test", ...JSON_HEADERS },
      body: "{}"
    });
    expectRefused(result);
  });

  it("guards logout, which destroys state with the credential still attached", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED));

    const crossSite = await send(base, {
      method: "POST",
      path: "/api/auth/logout",
      headers: { origin: "https://attacker.test", cookie: SESSION }
    });
    expectRefused(crossSite);

    const sameOrigin = await send(base, {
      method: "POST",
      path: "/api/auth/logout",
      headers: { origin: TRUSTED, cookie: SESSION }
    });
    expectAccepted(sameOrigin, "logout", calls);
  });

  it("leaves safe methods to CORS, which is what governs reading", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED));

    const result = await send(base, {
      method: "GET",
      path: "/api/sessions",
      headers: { origin: "https://attacker.test", "sec-fetch-site": "cross-site", cookie: SESSION }
    });

    // The read happened; the browser cannot see it, because no CORS grant is
    // attached. A GET changes nothing, so there is nothing for CSRF to protect.
    expect(result.status).toBe(200);
    expect(calls).toEqual(["list-sessions"]);
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
    expect(result.headers["vary"]).toBe("Origin");
  });
});

describe("preflight", () => {
  it("answers a trusted preflight with the methods and headers clients actually use", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED));

    const result = await send(base, {
      method: "OPTIONS",
      path: "/api/sessions/s1/collaboration/members/u1/role",
      headers: {
        origin: TRUSTED,
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "content-type, idempotency-key"
      }
    });

    expect(result.status).toBe(204);
    expect(result.headers["access-control-allow-origin"]).toBe(TRUSTED);
    expect(result.headers["access-control-allow-credentials"]).toBe("true");
    expect(result.headers["access-control-allow-methods"]).toBe(
      ALLOWED_CORS_METHODS
    );
    // PATCH is a real route (member roles, evidence) and must be advertised.
    expect(ALLOWED_CORS_METHODS).toContain("PATCH");
    expect(result.headers["access-control-allow-headers"]).toBe(
      ALLOWED_CORS_HEADERS
    );
    expect(ALLOWED_CORS_HEADERS).toContain("idempotency-key");
    expect(result.headers["vary"]).toBe("Origin");
    // A preflight is not a state change.
    expect(calls).toEqual([]);
  });

  it("refuses a preflight from an untrusted origin without granting anything", async () => {
    const { base } = await boot(policyOf(TRUSTED));

    const result = await send(base, {
      method: "OPTIONS",
      path: "/api/sessions/s1/collaboration/members/u1/role",
      headers: {
        origin: "https://attacker.test",
        "access-control-request-method": "PATCH"
      }
    });

    expectRefused(result);
  });

  it("answers a preflight with no origin at all, since it names no site", async () => {
    const { base } = await boot(policyOf(TRUSTED));

    const result = await send(base, {
      method: "OPTIONS",
      path: "/api/files"
    });

    expect(result.status).toBe(204);
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
    expect(result.headers["vary"]).toBe("Origin");
  });
});

describe("CORS and CSRF share one authority", () => {
  it("grants reads and accepts writes for exactly the same origin", async () => {
    const policy = policyOf(TRUSTED);
    const { base, calls } = await boot(policy);

    const read = await send(base, {
      method: "GET",
      path: "/api/sessions",
      headers: { origin: TRUSTED, cookie: SESSION }
    });
    expect(read.headers["access-control-allow-origin"]).toBe(TRUSTED);

    const write = await send(base, {
      method: "POST",
      path: "/api/files",
      headers: { origin: TRUSTED, cookie: SESSION, ...JSON_HEADERS },
      body: "{}"
    });
    expect(write.status).toBe(200);
    expect(calls).toContain("upload-file");
  });

  it("withholds both for an origin in neither role", async () => {
    const { base } = await boot(policyOf(TRUSTED));

    const read = await send(base, {
      method: "GET",
      path: "/api/sessions",
      headers: { origin: "https://attacker.test" }
    });
    expect(read.headers["access-control-allow-origin"]).toBeUndefined();

    const write = await send(base, {
      method: "POST",
      path: "/api/files",
      headers: { origin: "https://attacker.test", cookie: SESSION, ...JSON_HEADERS },
      body: "{}"
    });
    expectRefused(write);
  });

  it("never answers with a wildcard or reflects an unruly origin", async () => {
    const { base } = await boot(policyOf(TRUSTED));

    for (const origin of ["*", "https://attacker.test", "null"]) {
      const result = await send(base, {
        method: "GET",
        path: "/api/sessions",
        headers: { origin }
      });
      expect(result.headers["access-control-allow-origin"]).toBeUndefined();
      expect(result.headers["vary"]).toBe("Origin");
    }
  });

  it("does not echo the refused origin or the allowlist back to the caller", async () => {
    const { base } = await boot(policyOf(TRUSTED));

    const result = await send(base, {
      method: "POST",
      path: "/api/files",
      headers: { origin: "https://attacker.test", cookie: SESSION, ...JSON_HEADERS },
      body: "{}"
    });

    expect(result.body).not.toContain("attacker.test");
    expect(result.body).not.toContain("nexus.example");
    // Nor does it confirm which route was addressed.
    expect(result.body).not.toContain("/api/files");
  });

  it("keeps CORS headers when enforcement is disabled for a non-browser process", async () => {
    const { base, calls } = await boot(policyOf(TRUSTED), { enforce: false });

    const refusedNormally = await send(base, {
      method: "POST",
      path: "/api/files",
      headers: { origin: "https://attacker.test", cookie: SESSION, ...JSON_HEADERS },
      body: "{}"
    });
    // Enforcement off does not mean CORS off.
    expect(refusedNormally.status).toBe(200);
    expect(refusedNormally.headers["access-control-allow-origin"]).toBeUndefined();
    expect(calls).toEqual(["upload-file"]);
  });
});

describe("an empty policy", () => {
  it("refuses every unsafe request that carries credentials", async () => {
    const { base, calls } = await boot(policyOf());

    const result = await send(base, {
      method: "POST",
      path: "/api/files",
      headers: { origin: TRUSTED, cookie: SESSION, ...JSON_HEADERS },
      body: "{}"
    });

    expectRefused(result);
    expect(calls).toEqual([]);
  });
});

describe("trusted origins in a multi-origin deployment", () => {
  it("accepts each configured origin and refuses the neighbours", async () => {
    const { base, calls } = await boot(
      policyOf("https://app.nexus.example", "https://admin.nexus.example")
    );

    for (const origin of ["https://app.nexus.example", "https://admin.nexus.example"]) {
      const result = await send(base, {
        method: "POST",
        path: "/api/files",
        headers: { origin, cookie: SESSION, ...JSON_HEADERS },
        body: "{}"
      });
      expect(result.status).toBe(200);
      expect(result.headers["access-control-allow-origin"]).toBe(origin);
    }
    expect(calls).toEqual(["upload-file", "upload-file"]);

    const neighbour = await send(base, {
      method: "POST",
      path: "/api/files",
      headers: {
        origin: "https://staging.nexus.example",
        cookie: SESSION,
        ...JSON_HEADERS
      },
      body: "{}"
    });
    expectRefused(neighbour);
    expect(calls).toEqual(["upload-file", "upload-file"]);
  });
});
