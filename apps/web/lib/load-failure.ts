import { ApiTransportError } from "./api-transport";

/**
 * What a failed page-level read actually means.
 *
 * "This thing does not exist" (404) and "the API did not answer" look identical
 * once only the message survives: both leave the page with nothing to draw and
 * no way forward. They are not the same situation for the person reading it —
 * one is a dead link to walk away from, the other is a service worth retrying —
 * so the HTTP status travels alongside the message instead of being flattened
 * into a string. Both workspaces share this so the two surfaces cannot drift.
 */
export type LoadFailure = { status: number | null; message: string };

export function toLoadFailure(
  error: unknown,
  notFoundMessage: string,
  fallbackMessage: string
): LoadFailure {
  if (error instanceof ApiTransportError && error.status === 404) {
    return { status: 404, message: notFoundMessage };
  }
  return {
    status: error instanceof ApiTransportError ? error.status : null,
    message: error instanceof Error ? error.message : fallbackMessage
  };
}
