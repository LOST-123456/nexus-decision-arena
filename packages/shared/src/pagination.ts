/**
 * Shared pagination contract for Nexus list endpoints.
 *
 * One small, deliberately boring vocabulary so every list — execution events,
 * report history, agent runs, library sources, team activity — can speak the
 * same `limit` + `after` cursor language without each endpoint inventing its
 * own. The cursor is always a concrete field value (a sequence number, a
 * version, an id), never an offset, so pages stay stable under concurrent
 * inserts and a cursor can never be rewritten to reach another session.
 */

/** Hard ceiling on the page size a client may request. Servers clamp to this. */
export const MAX_PAGE_LIMIT = 200;

/** The page size servers use when the client asks for nothing. */
export const DEFAULT_PAGE_LIMIT = 50;

export type PageRequest = {
  /** How many items to return. Servers clamp to [1, MAX_PAGE_LIMIT]. */
  limit?: number | null;
  /** Cursor: the field value of the last item from the previous page. */
  after?: number | string | null;
};

export type CursorPage<T> = {
  items: T[];
  /** Cursor for the next page, or null when this is the last page. */
  nextCursor: number | string | null;
  /** Whether another page exists after the items returned. */
  hasNextPage: boolean;
};

/** Clamp a client-supplied limit into the legal [1, MAX_PAGE_LIMIT] range. */
export function resolvePageLimit(limit: number | null | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_PAGE_LIMIT;
  }
  if (limit < 1) return 1;
  if (limit > MAX_PAGE_LIMIT) return MAX_PAGE_LIMIT;
  return Math.floor(limit);
}
