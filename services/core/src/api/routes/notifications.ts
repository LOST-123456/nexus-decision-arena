import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import {
  buildNotificationFeed,
  newsWindowStart,
  type NotificationFeed
} from "../../notifications/notification-service";
import {
  callerOf,
  SessionAccessGuard,
  type SessionCaller
} from "../security/session-access";

const MarkReadBody = z
  .object({
    keys: z.array(z.string().min(1).max(200)).max(200)
  })
  .strict();

type NotificationDependencies = NonNullable<AppDependencies["notifications"]>;

/**
 * The notification centre.
 *
 * Deliberately tiny, because almost nothing belongs here. A card is a view of a
 * row that already exists — an invitation waiting to be accepted, a review
 * request waiting for a verdict, a comment somebody wrote, a version somebody
 * saved, a run that failed and needs a retry — so this API answers "what is
 * waiting on me" and "I have seen it", and stores nothing else.
 *
 * What it must not do is become a fourth notion of ownership. The list of
 * researches a caller may be told about comes from `readableSessionIds`, the
 * same method `SessionAccessGuard` filters the session list with, so a
 * notification can never name a research the caller would get a 404 on.
 */
export function registerNotificationRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies
): void {
  const access = new SessionAccessGuard(dependencies);

  /**
   * One derivation, used by both endpoints.
   *
   * These two used to build the feed with copy-pasted code, which meant the
   * badge and the list could drift into disagreeing about what was waiting.
   * They now share this function, so the number on the bar and the cards on the
   * page are the same answer asked twice.
   */
  async function deriveFeed(
    caller: SessionCaller,
    notifications: NotificationDependencies
  ): Promise<NotificationFeed> {
    const readable = await access.readableSessionIds(caller);
    const scope = readable === "all" ? "all" : [...readable];
    const now = new Date();
    const since = newsWindowStart(now);

    const userId = caller.kind === "user" ? caller.userId : null;

    const [invitations, reviewRequests, failedRuns, comments, versions, readKeys] =
      await Promise.all([
        // Everything addressed to an account needs an account. A deployment
        // without an identity system has nothing addressed to anyone — that is
        // an empty list, not a failure.
        userId === null
          ? Promise.resolve([])
          : notifications.listPendingInvitations(userId),
        userId === null
          ? Promise.resolve([])
          : notifications.listPendingReviewRequests(userId),
        notifications.listFailedRuns(scope),
        // "Somebody else did this" needs to know who "I" am, so these two are
        // account-only as well. In operator mode every row is readable and
        // none of them is about anyone in particular.
        userId === null
          ? Promise.resolve([])
          : notifications.listRecentComments(scope, userId, since),
        userId === null
          ? Promise.resolve([])
          : notifications.listRecentVersions(scope, userId, since),
        userId === null
          ? Promise.resolve<string[]>([])
          : notifications.listReadKeys(userId)
      ]);

    return buildNotificationFeed({
      invitations,
      reviewRequests,
      failedRuns,
      comments,
      versions,
      readKeys,
      now
    });
  }

  app.get("/api/notifications", async (request, reply) => {
    const caller = callerOf(dependencies, request);
    if (caller.kind === "anonymous") {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!dependencies.notifications) {
      return reply.code(501).send({ error: "Notification centre unavailable" });
    }

    const feed = await deriveFeed(caller, dependencies.notifications);
    return { ...feed, generatedAt: new Date().toISOString() };
  });

  /**
   * The badge's own endpoint.
   *
   * Same derivation as the list — the two cannot disagree about what is waiting
   * — but the payload is one number instead of up to a hundred cards. That is
   * the whole point: the bar is on every page, so the page should not pay for a
   * feed it will not render.
   *
   * The number counts **actions only**. A comment nobody has opened is not
   * something the reader is behind on, and mixing it in turns the dot into a
   * permanent decoration: always on, therefore never read.
   *
   * An anonymous caller gets `authenticated: false` rather than a 401. A badge
   * has no account to count for, and the honest rendering of that is *no
   * badge*, not a red dot on every page. The flag is returned so a client can
   * tell "signed out" from "nothing waiting" instead of reading `0` as both.
   */
  app.get("/api/notifications/unread-count", async (request, reply) => {
    const caller = callerOf(dependencies, request);
    if (caller.kind === "anonymous") {
      return reply.send({ unreadCount: 0, authenticated: false });
    }
    if (!dependencies.notifications) {
      return reply.code(501).send({ error: "Notification centre unavailable" });
    }

    const feed = await deriveFeed(caller, dependencies.notifications);
    return reply.send({
      unreadCount: feed.unreadActionCount,
      authenticated: true
    });
  });

  app.post<{ Body: unknown }>("/api/notifications/read", async (request, reply) => {
    const caller = callerOf(dependencies, request);
    if (caller.kind === "anonymous") {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!dependencies.notifications) {
      return reply.code(501).send({ error: "Notification centre unavailable" });
    }
    if (caller.kind !== "user") {
      // Read state belongs to an account. Saying so beats silently accepting a
      // write that would be stored against nobody.
      return reply.code(400).send({
        error: "Read state requires an account; this deployment has none"
      });
    }

    const parsed = MarkReadBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid read request" });
    }

    await dependencies.notifications.markRead(caller.userId, parsed.data.keys);
    return { marked: parsed.data.keys.length };
  });
}
