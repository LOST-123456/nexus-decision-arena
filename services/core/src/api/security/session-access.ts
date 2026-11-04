import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  DecisionSessionRepository,
  SourceLibraryRepository,
  TeamCollaborationRepository
} from "@nexus/db";
import type { AppDependencies } from "../../app";
import type { AuthRole } from "../../auth";

/**
 * Who is asking, as far as session access is concerned.
 *
 * `operator` is the deployment without an identity system: there are no
 * accounts to authorize against, so the workspace operator sees the workspace —
 * exactly what every session-scoped route did before this guard existed, and
 * the only case where nobody is being told apart from anybody.
 */
export type SessionCaller =
  | { kind: "operator" }
  | { kind: "anonymous" }
  | { kind: "user"; userId: string; role: AuthRole };

/**
 * The answer for one session. `denied` and `unknown` are deliberately distinct
 * values that produce the same 404: a caller must not be able to tell "this
 * research exists but is not yours" from "there is no such research", or the
 * error code becomes an enumeration oracle.
 */
export type SessionAccess = "allowed" | "denied" | "unknown" | "unauthenticated";

/**
 * Why a caller can read one research.
 *
 * These are not permission levels — every value here means "readable". They are
 * the *reason*, and a list groups by them: 我创建的 and 别人共享给我的 are the
 * same permission and two different facts, and a user deciding what to open
 * cares about the second one.
 *
 * `unowned` is the odd one out on purpose. Legacy rows predate recorded
 * ownership, so the administrator sees them without having created them;
 * filing that under `owner` would print "我创建的" over research the user has
 * never touched.
 */
export type SessionRelation = "owner" | "collaborator" | "granted" | "unowned";

/**
 * The vocabulary, for validation and for error messages.
 *
 * Kept beside the type so a caller that validates a query parameter does not
 * have to restate the four names — a restated list is a list that drifts, and
 * the drift shows up as a filter the server accepts but never matches.
 */
export const SESSION_RELATIONS: readonly SessionRelation[] = [
  "owner",
  "collaborator",
  "granted",
  "unowned"
];

/**
 * When one research is readable for several reasons, report the strongest.
 * Ordering: the person who owns it, then someone who works inside it, then
 * someone it was shared with, then a row nobody owns. A weaker reason never
 * displaces a stronger one, and iteration order of the queries must not decide
 * what the user is told.
 */
const RELATION_RANK: Record<SessionRelation, number> = {
  owner: 3,
  collaborator: 2,
  granted: 1,
  unowned: 0
};

/**
 * A caller's readable research, either "everything" (the operator) or an
 * explicit set plus the reason for each. Kept as a discriminated union rather
 * than `Set | "all"` because the relation map only exists in the second case.
 */
export type ReadableSessions =
  | { kind: "all" }
  | {
      kind: "some";
      ids: ReadonlySet<string>;
      relationOf: ReadonlyMap<string, SessionRelation>;
    };

/**
 * Any RFC-4122 uuid shape. Deliberately not the seeded-id schema: the guard is
 * asked about ids that arrive from a URL, including ids that are not ours at
 * all, and a malformed one must answer "not found" rather than reach Postgres
 * and raise a cast error.
 */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidShaped(value: string): boolean {
  return UUID_SHAPE.test(value);
}

/**
 * Reading the caller from the request.
 *
 * The identity is `AuthService.userFromRequest` — the same function every
 * existing route uses, reading the same signed cookie. Nothing here looks at a
 * header, a body field or a query parameter for "who am I": an authorization
 * decision that can be influenced by the caller is not an authorization
 * decision.
 */
export function callerOf(
  dependencies: Pick<AppDependencies, "auth">,
  request: FastifyRequest
): SessionCaller {
  if (!dependencies.auth) return { kind: "operator" };
  const user = dependencies.auth.userFromRequest(request);
  if (!user) return { kind: "anonymous" };
  return { kind: "user", userId: user.id, role: user.role };
}

type AccessDependencies = {
  sessions: Pick<DecisionSessionRepository, "getById">;
  sessionHistory?: Pick<
    DecisionSessionRepository,
    "listSessionIdsForOwner" | "listOwnerlessSessionIds"
  >;
  sourceLibrary?: Pick<
    SourceLibraryRepository,
    "listGrantedSessionIds" | "hasLiveGrant"
  >;
  teamCollaboration?: Pick<
    TeamCollaborationRepository,
    "getLiveMembership" | "listSessionIdsForMember"
  >;
};

/**
 * The one place that answers "may this caller read this research?".
 *
 * The rule, in order:
 *  1. No identity system → the operator, allowed (nothing to distinguish).
 *  2. Recorded owner is the caller → allowed.
 *  3. A live share grant, direct or by role → allowed. Sharing is the
 *     sanctioned way to widen access, and its own scope rules still apply to
 *     what can be done with the material afterwards.
 *  4. A live membership (invited or accepted) → allowed. A collaborator works
 *     inside the research; refusing them here would break collaboration while
 *     leaving the collaboration routes themselves open.
 *  5. No recorded owner → the deployment administrator (`owner` role), matching
 *     what `source-library-service.mayAdministerGrants` already declares for
 *     these legacy rows. Everyone else is refused: the owner is unknown, so the
 *     safe answer is no, and the compatibility cost is recorded rather than
 *     papered over by admitting all signed-in accounts.
 *  6. Anything else → denied.
 *
 * Every branch other than (1) is decided from persisted data. No branch can be
 * satisfied by something the caller sends.
 */
export class SessionAccessGuard {
  constructor(private readonly dependencies: AccessDependencies) {}

  async decide(caller: SessionCaller, sessionId: string): Promise<SessionAccess> {
    if (caller.kind === "operator") return "allowed";
    if (caller.kind === "anonymous") return "unauthenticated";
    if (!isUuidShaped(sessionId)) return "unknown";

    const session = await this.dependencies.sessions.getById(sessionId);
    if (!session) return "unknown";

    if (session.ownerUserId !== null && session.ownerUserId === caller.userId) {
      return "allowed";
    }
    if (await this.holdsLiveGrant(caller, sessionId)) return "allowed";
    if (await this.isCollaborator(caller, sessionId)) return "allowed";
    if (session.ownerUserId === null && caller.role === "owner") return "allowed";
    return "denied";
  }

  /**
   * Every session id the caller may read, or `"all"` for the operator.
   *
   * Composed from the three persisted sources of access rather than from a
   * fourth, parallel notion of "mine". An empty set is a real answer and must
   * not turn into an unfiltered query.
   */
  async readableSessionIds(
    caller: SessionCaller
  ): Promise<ReadonlySet<string> | "all"> {
    const readable = await this.readableSessions(caller);
    return readable.kind === "all" ? "all" : readable.ids;
  }

  /**
   * The same set, with the reason each id is in it.
   *
   * `readableSessionIds` answers "may I read it"; a list also has to answer
   * "as what" before it can separate 我创建的 from 别人共享给我的. Merging the
   * three sources into one `Set` is exactly what made that impossible: once
   * merged, an owner and a grantee are indistinguishable.
   *
   * Nothing about the access decision changes here — this reads the same three
   * queries and keeps them apart. `readableSessionIds` is now a view on top of
   * it, so the guard still has one implementation of "what may be read".
   */
  async readableSessions(caller: SessionCaller): Promise<ReadableSessions> {
    if (caller.kind === "operator") return { kind: "all" };
    if (caller.kind === "anonymous") {
      return { kind: "some", ids: new Set(), relationOf: new Map() };
    }

    const { sessionHistory, sourceLibrary, teamCollaboration } = this.dependencies;
    const [owned, unowned, granted, member] = await Promise.all([
      sessionHistory
        ? sessionHistory.listSessionIdsForOwner(caller.userId)
        : Promise.resolve<string[]>([]),
      // Legacy rows have no owner to filter on; the administrator role is the
      // product's declared stand-in, so they are listed for it too. Kept apart
      // from `owned` because calling these "我创建的" would be a lie.
      sessionHistory && caller.role === "owner"
        ? sessionHistory.listOwnerlessSessionIds()
        : Promise.resolve<string[]>([]),
      sourceLibrary
        ? sourceLibrary.listGrantedSessionIds(caller.userId, caller.role)
        : Promise.resolve<string[]>([]),
      teamCollaboration
        ? teamCollaboration.listSessionIdsForMember(caller.userId)
        : Promise.resolve<string[]>([])
    ]);

    const relationOf = new Map<string, SessionRelation>();
    const note = (ids: readonly string[], relation: SessionRelation): void => {
      for (const id of ids) {
        const current = relationOf.get(id);
        if (
          current === undefined ||
          RELATION_RANK[relation] > RELATION_RANK[current]
        ) {
          relationOf.set(id, relation);
        }
      }
    };
    // Lowest rank first; a later note only wins if it is stronger.
    note(unowned, "unowned");
    note(granted, "granted");
    note(member, "collaborator");
    note(owned, "owner");

    return { kind: "some", ids: new Set(relationOf.keys()), relationOf };
  }

  /**
   * Whether the caller may *delete* the research.
   *
   * Deliberately narrower than `decide`. Reading is shared with collaborators
   * and share grantees on purpose, but erasing the whole research is not a
   * collaboration verb: a grantee who can open a source library must not be
   * able to take the research away from the person who owns it. Being able to
   * read is therefore not enough, and the check is a second question asked of
   * persisted ownership, not a relaxation of the first.
   *
   * Allowed: the recorded owner; the deployment administrator (`owner` role),
   * who retires abandoned researches and who is the declared stand-in for
   * legacy rows with no recorded owner; the operator of a deployment without an
   * identity system.
   */
  async mayDelete(
    caller: SessionCaller,
    sessionId: string
  ): Promise<SessionAccess> {
    if (caller.kind === "operator") return "allowed";
    if (caller.kind === "anonymous") return "unauthenticated";
    if (!isUuidShaped(sessionId)) return "unknown";

    const session = await this.dependencies.sessions.getById(sessionId);
    if (!session) return "unknown";

    if (session.ownerUserId !== null && session.ownerUserId === caller.userId) {
      return "allowed";
    }
    if (caller.role === "owner") return "allowed";
    return "denied";
  }

  /**
   * Whether the caller may change what the research *asks*.
   *
   * Editing is a collaboration verb, unlike deleting: the people who work
   * inside a research are exactly the people who should be able to fix a
   * question that was left blank or worded badly. So the rule follows the one
   * `team-collaboration-service` already applies to its writes — the owner, or
   * a member holding `owner`/`editor` — plus the deployment administrator,
   * who is the stand-in for a research with no recorded owner.
   */
  async mayEdit(
    caller: SessionCaller,
    sessionId: string
  ): Promise<SessionAccess> {
    if (caller.kind === "operator") return "allowed";
    if (caller.kind === "anonymous") return "unauthenticated";
    if (!isUuidShaped(sessionId)) return "unknown";

    const session = await this.dependencies.sessions.getById(sessionId);
    if (!session) return "unknown";

    if (session.ownerUserId !== null && session.ownerUserId === caller.userId) {
      return "allowed";
    }
    if (caller.role === "owner") return "allowed";
    const membership = await this.dependencies.teamCollaboration
      ?.getLiveMembership(sessionId, caller.userId);
    if (membership && (membership.role === "owner" || membership.role === "editor")) {
      return "allowed";
    }
    return "denied";
  }

  private async holdsLiveGrant(
    caller: Extract<SessionCaller, { kind: "user" }>,
    sessionId: string
  ): Promise<boolean> {
    const library = this.dependencies.sourceLibrary;
    if (!library) return false;
    return library.hasLiveGrant(sessionId, caller.userId, caller.role);
  }

  private async isCollaborator(
    caller: Extract<SessionCaller, { kind: "user" }>,
    sessionId: string
  ): Promise<boolean> {
    const collaboration = this.dependencies.teamCollaboration;
    if (!collaboration) return false;
    const membership = await collaboration.getLiveMembership(
      sessionId,
      caller.userId
    );
    return membership !== null;
  }
}

/** Paths this guard owns: every route that names a research in the URL. */
const SESSION_ROUTE_PREFIX = "/api/sessions/";

/**
 * Refuses, before any handler runs, every session-scoped request the caller
 * may not make.
 *
 * One hook rather than a check pasted into a hundred handlers: the audit that
 * started this work found the same omission repeated across the workspace, and
 * a rule that has to be remembered at each call site is a rule that will be
 * forgotten at the next one. `/api/sessions` itself (list and create) carries
 * no id and is handled in its route, where the query is.
 */
export function registerSessionAccessGuard(
  app: FastifyInstance,
  dependencies: AppDependencies
): void {
  const guard = new SessionAccessGuard(dependencies);

  app.addHook("preHandler", async (request, reply) => {
    const routeUrl = request.routeOptions?.url;
    if (typeof routeUrl !== "string" || !routeUrl.startsWith(SESSION_ROUTE_PREFIX)) {
      return;
    }
    const params = (request.params ?? {}) as Record<string, unknown>;
    // `inspector` names the parameter `sessionId`; everything else uses `id`.
    const raw = params.id ?? params.sessionId;
    if (typeof raw !== "string" || raw.length === 0) return;

    const decision = await guard.decide(callerOf(dependencies, request), raw);
    if (decision === "allowed") return;
    if (decision === "unauthenticated") {
      return reply.code(401).send({ error: "Authentication required" });
    }
    // Same answer for "not yours" and "not there", in the shape the library
    // already answers with: a client switches on `code`, and a reader of two
    // reports must not be able to tell the two cases apart either.
    return reply
      .code(404)
      .send({ error: "Session not found", code: "session_not_found" });
  });
}
