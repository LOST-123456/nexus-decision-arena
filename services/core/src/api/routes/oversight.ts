import type { FastifyInstance } from "fastify";
import { OversightCountsSchema } from "@nexus/shared";
import type { AppDependencies } from "../../app";
import { callerOf, SessionAccessGuard } from "../security/session-access";

/**
 * `GET /api/oversight` — the counts behind the governance page.
 *
 * The interesting part is what this route does *not* do: it does not decide
 * which researches to count. That answer comes from `readableSessionIds`, the
 * same call that filters the research list and the notification centre. A
 * second implementation here would eventually disagree with the first, and the
 * way it would disagree is by counting somebody else's research — which is why
 * the two are not allowed to be written independently.
 *
 * Anonymous callers get 401 rather than zeros. An aggregate that answers "0
 * conflicts" to a signed-out visitor is a lie about a workspace that may be
 * full of them, and the signed-in version of the same screen would then look
 * like it disagreed with itself.
 */
export function registerOversightRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies
): void {
  const access = new SessionAccessGuard(dependencies);

  app.get("/api/oversight", async (request, reply) => {
    // Both halves are required, for the same reason the list route requires
    // them: without the readable-set lookup every signed-in caller would be
    // answered zeroes, i.e. "nothing has ever happened here".
    if (!dependencies.oversight || !dependencies.sessionHistory) {
      return reply.code(501).send({ error: "Oversight metrics unavailable" });
    }

    const caller = callerOf(dependencies, request);
    if (caller.kind === "anonymous") {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const readable = await access.readableSessionIds(caller);
    const sessionIds = readable === "all" ? undefined : [...readable];
    const counts = await dependencies.oversight.loadCounts(sessionIds);

    // Parsed on the way out so a repository that returns an unexpected shape
    // fails here rather than in a chart. The client then renders validated
    // numbers or an error, never a half-built panel.
    return OversightCountsSchema.parse(counts);
  });
}
