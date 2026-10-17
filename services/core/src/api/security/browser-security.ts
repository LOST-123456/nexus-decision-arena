/**
 * Browser-facing request security, in one place: CORS (who may *read* our
 * responses) and CSRF (who may *change* our state).
 *
 * The two are registered together because they must share one authority. Two
 * separate origin lists is how a deployment ends up allowing a write that the
 * other layer would have refused — and, worse, how someone concludes that
 * "CORS is on, so CSRF is handled". It is not: CORS is enforced by the browser
 * when *reading* a response, so a simple cross-site `POST` still reaches the
 * handler and still changes state. The guard below is what stops that.
 *
 * Order inside the hook matters:
 *  - The decision comes first and the CORS headers are written afterwards, so a
 *    refused request never carries `access-control-allow-origin`. A browser
 *    must not be able to read a refusal — or anything else — from an untrusted
 *    page, and "refused but readable" is a worse answer than "refused".
 *  - The origin check runs on `onRequest`, before the body is parsed and before
 *    any handler executes. A refused request therefore cannot have written
 *    anything: no idempotency lease, no row, no event.
 *
 * Scope of the check: unsafe requests that carry the session cookie, plus the
 * two endpoints that set or clear that cookie, and only when the request shows
 * a browser's provenance signals. That is precisely the set of requests where
 * CSRF is possible — CSRF is an attack on *ambient* credentials, so a request
 * with no cookie has no credential another site could borrow, and the route's
 * own 401 is the correct answer for it. Widening the rule to every unsafe
 * request would add no protection and would break every non-browser client that
 * speaks to this API. `presentsBrowserSignals` explains the last condition, and
 * why it is not a hole.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { SESSION_COOKIE_NAME } from "../../auth";
import {
  CSRF_REJECTION_BODY,
  evaluateOrigin,
  isUnsafeMethod,
  normalizeOrigin,
  type OriginPolicy
} from "./origin-policy";

/**
 * Methods this API actually exposes. `PATCH` matters: team roles and evidence
 * are patched, and a preflight that omits it makes a legitimate cross-origin
 * client fail in a way that looks like a server bug.
 */
export const ALLOWED_CORS_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";

/** Request headers a real client sends. Nothing else is advertised. */
export const ALLOWED_CORS_HEADERS =
  "content-type, idempotency-key, last-event-id";

/**
 * The two endpoints that establish or destroy the credential itself.
 *
 * Every other write is authenticated by the session cookie, so "does this
 * request carry a cookie" already tells us whether a browser attached ambient
 * credentials to it. Login and logout are the exception: a browser logging in
 * usually has no cookie yet, and a browser logging out is changing state with
 * the credential it still holds. Both are state changes, so both are checked by
 * name rather than by cookie.
 */
const AUTH_COOKIE_ENDPOINTS: ReadonlySet<string> = new Set([
  "/api/auth/login",
  "/api/auth/logout"
]);

/**
 * Whether this request is riding ambient credentials — i.e. whether CSRF is
 * even the right question. A request with no session cookie has no credential
 * for another site to borrow: it is either anonymous (and gets 401 from the
 * route) or a deliberate client that chose to send no credentials.
 */
export function carriesSessionCookie(cookieHeader: string | undefined): boolean {
  if (typeof cookieHeader !== "string" || cookieHeader === "") return false;
  return cookieHeader
    .split(";")
    .some((part) => part.trim().startsWith(`${SESSION_COOKIE_NAME}=`));
}

function pathnameOf(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/**
 * Whether this request could have been produced by a browser at all.
 *
 * The rule that follows from it deserves to be stated plainly, because it is
 * the one place in this module where a missing header is not a refusal.
 *
 * Every cross-site request a page can make carries `Origin`. That has been true
 * of every browser that implements CORS — that is, every browser that can make
 * a cross-site request — and it is the whole basis of the check above. A
 * browser also sends `Sec-Fetch-*` on every request it originates, so a request
 * with neither is not a page's doing: it is curl, a script, or this project's
 * own test client, all of which hold the cookie deliberately rather than
 * ambiently. An attacker does not gain anything there — a client that already
 * has the cookie has the session, and CSRF is specifically the attack on
 * credentials a page borrows without being able to read the answer.
 *
 * So the two cases are kept apart:
 *  - browser signals present, no `Origin` → refused (`origin_missing`). This is
 *    the state a browser should never produce; if one does, fail closed.
 *  - no browser signals at all → the origin check has nothing to decide, and
 *    the route's own authentication answers. This is not "a missing Origin is
 *    trusted": it is a request for which the question does not arise.
 *
 * The residual case is a pre-2019 browser that sends `Origin` cross-site but
 * omits it on a *same-origin* POST. Such a request would land in the second
 * branch — but it is also one no other site can cause, so it is not an attack.
 */
export function presentsBrowserSignals(headers: {
  origin?: string | string[] | undefined;
  "sec-fetch-site"?: string | string[] | undefined;
  "sec-fetch-mode"?: string | string[] | undefined;
  "sec-fetch-dest"?: string | string[] | undefined;
}): boolean {
  if (typeof headers.origin === "string") return true;
  for (const name of ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"] as const) {
    if (typeof headers[name] === "string") return true;
  }
  return false;
}

export type BrowserSecurityOptions = {
  /**
   * Set false only for a process that never serves browsers. `server.ts` always
   * leaves it true; there is no environment variable that turns it off.
   */
  enforce?: boolean;
};

/**
 * Installs the CORS policy and the CSRF origin guard.
 *
 * Exported separately from `createApp` so a test can build a real app with a
 * known policy and drive it over HTTP without going through a database.
 */
export function registerBrowserSecurity(
  app: FastifyInstance,
  policy: OriginPolicy,
  options: BrowserSecurityOptions = {}
): void {
  const enforce = options.enforce !== false;

  /**
   * Grants read access to one origin. Only ever called with an origin already
   * matched against the policy, so the value is never a reflection of whatever
   * the request happened to send.
   */
  const grantCors = (reply: FastifyReply, origin: string): void => {
    reply.header("access-control-allow-origin", origin);
    reply.header("access-control-allow-credentials", "true");
    reply.header("access-control-allow-methods", ALLOWED_CORS_METHODS);
    reply.header("access-control-allow-headers", ALLOWED_CORS_HEADERS);
    reply.header("access-control-max-age", "600");
  };

  app.addHook("onRequest", async (request, reply) => {
    const rawOrigin =
      typeof request.headers.origin === "string"
        ? request.headers.origin
        : undefined;
    const presented = rawOrigin ? normalizeOrigin(rawOrigin) : null;
    const trusted = presented !== null && policy.allowed.has(presented);

    // `Vary` is set on every response, trusted or not: the body of a rejected
    // answer differs from an accepted one, and a shared cache must not hand one
    // to the other.
    reply.header("vary", "Origin");

    if (request.method === "OPTIONS") {
      // A preflight from an origin we do not trust must not look successful:
      // answering 204 with no allow headers leaves the browser to fail it, but
      // a 403 says the same thing to anyone reading the wire, and to a human
      // debugging a misconfigured deployment.
      if (rawOrigin && !trusted) {
        return reply.code(403).send(CSRF_REJECTION_BODY);
      }
      if (trusted && presented !== null) grantCors(reply, presented);
      return reply.code(204).send();
    }

    if (enforce && isUnsafeMethod(request.method)) {
      const carriesCredential = carriesSessionCookie(request.headers.cookie);
      const isCookieEndpoint = AUTH_COOKIE_ENDPOINTS.has(pathnameOf(request.url));
      if (
        (carriesCredential || isCookieEndpoint) &&
        presentsBrowserSignals(request.headers)
      ) {
        // Decided *before* any CORS header is written, so the refusal below is
        // guaranteed to carry no read grant. A trusted-looking `Origin` paired
        // with `Sec-Fetch-Site: cross-site` is exactly such a refusal: the two
        // headers disagree, so one of them was forged.
        const verdict = evaluateOrigin({
          origin: rawOrigin,
          secFetchSite:
            typeof request.headers["sec-fetch-site"] === "string"
              ? request.headers["sec-fetch-site"]
              : undefined,
          policy
        });
        if (!verdict.allowed) {
          // Recorded for operators, uniform for callers. The refusal names its
          // class in the log but the response never echoes the origin, the
          // allowlist or the route's existence.
          request.log.warn(
            {
              csrf: verdict.reason,
              method: request.method,
              route: request.url,
              origin: rawOrigin ?? null
            },
            "refused a state-changing request from an untrusted origin"
          );
          return reply.code(403).send(CSRF_REJECTION_BODY);
        }
      }
      // else: nothing to borrow, or nothing that could have borrowed it. The
      // route's own authentication decides, and it answers 401 for anything
      // that needs a user. See `presentsBrowserSignals` for the second case.
    }

    // Reached only by requests that were not refused: safe methods, writes with
    // no ambient credential, and writes from a trusted origin.
    if (trusted && presented !== null) grantCors(reply, presented);
  });
}
