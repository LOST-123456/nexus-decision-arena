import { inArray, sql } from "drizzle-orm";
import { EMPTY_OVERSIGHT_COUNTS, type OversightCounts } from "@nexus/shared";
import type { Database } from "../client";
import { agentRuns, conflicts, decisionSessions, humanDecisions } from "../schema";

/**
 * The counts behind the governance panel, read straight off the rows that
 * already exist.
 *
 * Four queries and no new table: a conflict knows whether it needed a person, a
 * human decision knows which way it went, and a run knows whether it finished.
 * Storing a "metrics" copy would mean a number that keeps claiming after the
 * row behind it was retried, resolved or deleted.
 *
 * `sessionIds` is the caller's readable set, computed by the same guard that
 * filters the research list. `undefined` means no restriction (a deployment
 * with no identity system); an **empty array means nothing is readable** and
 * returns at once — `IN ()` is not valid SQL, and scanning every table to prove
 * a caller may see none of it is work nobody asked for.
 */
export async function loadOversightCounts(
  database: Database,
  sessionIds?: readonly string[]
): Promise<OversightCounts> {
  if (sessionIds !== undefined && sessionIds.length === 0) {
    return EMPTY_OVERSIGHT_COUNTS;
  }

  // A JS array is never expanded into parameters by the `sql` template, so the
  // id list has to go through `inArray` (see the report's Drizzle section —
  // this is the shape that produced the most 500s in this codebase).
  const withinSessions = (column: Parameters<typeof inArray>[0]) =>
    sessionIds === undefined ? undefined : inArray(column, [...sessionIds]);

  const [conflictRow] = await database
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      requiringHuman:
        sql<number>`count(*) filter (where ${conflicts.humanDecisionRequired})`.mapWith(
          Number
        ),
      awaitingHuman:
        sql<number>`count(*) filter (where ${conflicts.humanDecisionRequired} and ${conflicts.status} <> 'resolved')`.mapWith(
          Number
        ),
      resolved:
        sql<number>`count(*) filter (where ${conflicts.status} = 'resolved')`.mapWith(
          Number
        )
    })
    .from(conflicts)
    .where(withinSessions(conflicts.sessionId));

  const [decisionRow] = await database
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      acceptChallenge:
        sql<number>`count(*) filter (where ${humanDecisions.action} = 'accept_challenge')`.mapWith(
          Number
        ),
      upholdClaim:
        sql<number>`count(*) filter (where ${humanDecisions.action} = 'uphold_claim')`.mapWith(
          Number
        ),
      requestMoreAnalysis:
        sql<number>`count(*) filter (where ${humanDecisions.action} = 'request_more_analysis')`.mapWith(
          Number
        )
    })
    .from(humanDecisions)
    .where(withinSessions(humanDecisions.sessionId));

  const [runRow] = await database
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      completed:
        sql<number>`count(*) filter (where ${agentRuns.status} = 'completed')`.mapWith(
          Number
        ),
      failed:
        sql<number>`count(*) filter (where ${agentRuns.status} = 'failed')`.mapWith(
          Number
        ),
      timedOut:
        sql<number>`count(*) filter (where ${agentRuns.status} = 'timed_out')`.mapWith(
          Number
        ),
      cancelled:
        sql<number>`count(*) filter (where ${agentRuns.status} = 'cancelled')`.mapWith(
          Number
        ),
      // Retries open a new row with a higher attempt, so this counts the rows
      // that exist *because* an earlier one did not do the job.
      retried: sql<number>`count(*) filter (where ${agentRuns.attempt} > 1)`.mapWith(
        Number
      )
    })
    .from(agentRuns)
    .where(withinSessions(agentRuns.sessionId));

  const [sessionRow] = await database
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(decisionSessions)
    .where(withinSessions(decisionSessions.id));

  return {
    sessionCount: sessionRow?.total ?? 0,
    conflicts: {
      total: conflictRow?.total ?? 0,
      requiringHuman: conflictRow?.requiringHuman ?? 0,
      awaitingHuman: conflictRow?.awaitingHuman ?? 0,
      resolved: conflictRow?.resolved ?? 0
    },
    decisions: {
      total: decisionRow?.total ?? 0,
      acceptChallenge: decisionRow?.acceptChallenge ?? 0,
      upholdClaim: decisionRow?.upholdClaim ?? 0,
      requestMoreAnalysis: decisionRow?.requestMoreAnalysis ?? 0
    },
    runs: {
      total: runRow?.total ?? 0,
      completed: runRow?.completed ?? 0,
      failed: runRow?.failed ?? 0,
      timedOut: runRow?.timedOut ?? 0,
      cancelled: runRow?.cancelled ?? 0,
      retried: runRow?.retried ?? 0
    }
  };
}
