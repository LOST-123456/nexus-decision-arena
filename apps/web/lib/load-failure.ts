import { ApiTransportError } from "./api-transport";

/**
 * What a failed page-level read actually means.
 *
 * "This thing does not exist" (404), "you are not signed in" (401) and "the API
 * did not answer" all look identical once only the message survives: each
 * leaves the page with nothing to draw and no obvious way forward. They are not
 * the same situation for the person reading it — one is a dead link to walk
 * away from, one needs a login, the other is a service worth retrying — so the
 * HTTP status travels alongside the message instead of being flattened into a
 * string, and the panel branches on a `kind` rather than re-deriving the
 * meaning from it.
 *
 * The 401 case is the one that made this necessary: research reads are
 * owner-scoped, so an unauthenticated visitor now gets 401 instead of 404. Told
 * "服务不可用,请确认核心 API 正在运行", that visitor would go and check a process
 * that is running perfectly well. Both workspaces share this module so the two
 * surfaces cannot drift.
 */
export type LoadFailureKind = "not-found" | "sign-in" | "unavailable";

export type LoadFailure = {
  status: number | null;
  kind: LoadFailureKind;
  message: string;
};

export function toLoadFailure(
  error: unknown,
  notFoundMessage: string,
  fallbackMessage: string,
  signInMessage = "请先登录。"
): LoadFailure {
  if (error instanceof ApiTransportError && error.status === 404) {
    return { status: 404, kind: "not-found", message: notFoundMessage };
  }
  if (error instanceof ApiTransportError && error.status === 401) {
    return { status: 401, kind: "sign-in", message: signInMessage };
  }
  return {
    status: error instanceof ApiTransportError ? error.status : null,
    kind: "unavailable",
    message: error instanceof Error ? error.message : fallbackMessage
  };
}
