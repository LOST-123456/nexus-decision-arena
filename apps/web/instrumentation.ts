import type { Instrumentation } from "next";

/**
 * Server-side observability hook.
 *
 * The client already has somewhere to complain: `app/error.tsx` and
 * `app/global-error.tsx` catch a render failure in the browser and show the
 * operator a readable panel. The server had nothing. A failure inside a server
 * component, a route handler or an action was reported (or swallowed) entirely
 * by Next's defaults, so there was no single line tying "something failed" to
 * the route it failed on.
 *
 * This file is that missing place. It is the server half of the same idea the
 * P16/P17 work applied to the client: a failure should be attributable, not
 * invisible.
 */

/**
 * Runs once when the server starts. Kept to a single line on purpose — it is a
 * boot marker that makes it obvious in a log which runtime and mode is serving,
 * not a place to build application state.
 */
export async function register(): Promise<void> {
  // Only the Node.js runtime has a process worth describing. The edge runtime
  // starts many short-lived isolates; logging each boot would be noise.
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  console.info(
    `[nexus] server runtime ready (${process.env.NODE_ENV ?? "unknown"})`
  );
}

/**
 * Called for every uncaught error on the server. We keep four things — where
 * the request was routed, how it was dispatched, the HTTP method and path, and
 * the digest Next hands the client — because those are exactly the fields a
 * report from a user ("I got error abc123 on this page") needs to be matched
 * back to a log line. The stack is left to the runtime's own reporter so it is
 * not printed twice.
 *
 * Note the request here is Next's own descriptor (`{ path, method, headers }`),
 * not the web `Request` — there is no `.url` to parse.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context
) => {
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? (error as { digest?: unknown }).digest
      : undefined;

  const scope = `${context.routerKind}/${context.routeType} ${context.routePath}`;
  const suffix = digest ? ` [digest ${String(digest)}]` : "";

  console.error(
    `[nexus] server request failed: ${request.method} ${request.path} (${
      scope || "unrouted"
    })${suffix}`,
    error
  );
};
