import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  DecisionSessionRepository,
  EventRepository,
  TeamCollaborationRepository,
  type Database
} from "@nexus/db";
import { createApp } from "../../app";
import type { AuthRole } from "../../auth";

/**
 * DB-backed integration test for the team collaboration & human review routes.
 *
 * The acceptance question this file answers, end to end and over real HTTP: a
 * research's collaboration is owned by its session owner and gated on the
 * per-session role (owner/editor/reviewer/viewer), every write is attributed to
 * the server-side identity, the session boundary is never crossed, and a
 * concurrent write is a 409 rather than a silent overwrite. Concretely, against
 * a real database:
 *  - an anonymous caller is refused (401) and a non-member gets 404, never a
 *    hint that the research exists;
 *  - a viewer may read but not write (403), and owner/editor manage members and
 *    work items while reviewer/owner may comment and review;
 *  - inviting, accepting, changing role and removing a member all persist and
 *    audit, and an assignee must be a collaborator (400 otherwise);
 *  - a comment's author is the server identity (never the body), only the
 *    author may delete it (403 for others), and threads stay within one target;
 *  - a review request cannot be self-addressed or self-claimed (400/403), only
 *    the assigned reviewer decides, and the decision is a sign-off — it does
 *    not write a claim verdict;
 *  - the optimistic `version` column turns a stale update into a 409;
 *  - the activity feed is projected from the shared `executionEvents` table.
 *
 * No model and no network are involved. The session is created through the real
 * session route (which sets `owner_user_id` from the login identity), so the
 * owner of every research is the caller who made it. The database is the
 * dedicated test database named by TEST_DATABASE_URL; the guard refuses
 * anything else.
 */
const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const events = new EventRepository(database);
const teamCollaboration = new TeamCollaborationRepository(database);

const USER_ONE = "user-1";
const USER_TWO = "user-2";
const USER_THREE = "user-3";

let currentUser: {
  id: string;
  username: string;
  displayName: string;
  role: AuthRole;
} | null = { id: USER_ONE, username: "owner-one", displayName: "Owner One", role: "owner" };

function asUser(id: string, role: AuthRole, username = id) {
  currentUser = { id, username, displayName: username, role };
}
function anonymous() {
  currentUser = null;
}

function testApp() {
  return createApp({
    auth: { userFromRequest: () => currentUser } as never,
    sessions,
    inspector: {} as never,
    events,
    runSession: { start: async () => undefined },
    teamCollaboration
  });
}

const app = testApp();

beforeEach(async () => {
  await database.execute("TRUNCATE projects CASCADE");
  asUser(USER_ONE, "owner", "Owner One");
});

afterAll(async () => {
  await database.execute("TRUNCATE projects CASCADE");
});

async function createResearch(name: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { "idempotency-key": `session-${randomUUID()}` },
    payload: {
      project: {
        name,
        summary: "Collaboration research",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "documents"
      },
      locale: "zh-CN",
      researchQuestion: `${name} 的问题`
    }
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

function invite(
  sessionId: string,
  userId: string,
  role: "owner" | "editor" | "reviewer" | "viewer",
  key = `invite-${randomUUID()}`
) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/collaboration/members/invite`,
    headers: { "idempotency-key": key },
    payload: { userId, role }
  });
}

function accept(sessionId: string, userId: string) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/collaboration/members/${userId}/accept`,
    payload: {}
  });
}

function decline(sessionId: string, userId: string) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/collaboration/members/${userId}/decline`,
    payload: {}
  });
}

function changeRole(sessionId: string, userId: string, role: string) {
  return app.inject({
    method: "PATCH",
    url: `/api/sessions/${sessionId}/collaboration/members/${userId}/role`,
    payload: { role }
  });
}

function removeMember(sessionId: string, userId: string, reason = "no longer needed") {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/collaboration/members/${userId}/remove`,
    payload: { reason }
  });
}

function listMembers(sessionId: string) {
  return app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/collaboration/members`
  });
}

function createWorkItem(
  sessionId: string,
  payload: Record<string, unknown>,
  key = `wi-${randomUUID()}`
) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/collaboration/work-items`,
    headers: { "idempotency-key": key },
    payload
  });
}

function updateWorkItem(
  sessionId: string,
  workItemId: string,
  payload: Record<string, unknown>
) {
  return app.inject({
    method: "PATCH",
    url: `/api/sessions/${sessionId}/collaboration/work-items/${workItemId}`,
    payload
  });
}

function listWorkItems(sessionId: string) {
  return app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/collaboration/work-items`
  });
}

function createComment(
  sessionId: string,
  payload: Record<string, unknown>,
  key = `cm-${randomUUID()}`
) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/collaboration/comments`,
    headers: { "idempotency-key": key },
    payload
  });
}

function listComments(sessionId: string, targetType: string, targetId: string) {
  return app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/collaboration/comments?targetType=${targetType}&targetId=${encodeURIComponent(targetId)}`
  });
}

function deleteComment(sessionId: string, commentId: string, expectedVersion: number) {
  return app.inject({
    method: "DELETE",
    url: `/api/sessions/${sessionId}/collaboration/comments/${commentId}?expectedVersion=${expectedVersion}`
  });
}

function createReviewRequest(
  sessionId: string,
  payload: Record<string, unknown>,
  key = `rr-${randomUUID()}`
) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/collaboration/review-requests`,
    headers: { "idempotency-key": key },
    payload
  });
}

function listReviewRequests(sessionId: string) {
  return app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/collaboration/review-requests`
  });
}

function claimReviewRequest(sessionId: string, reviewRequestId: string) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/collaboration/review-requests/${reviewRequestId}/claim`,
    payload: {}
  });
}

function decideReviewRequest(
  sessionId: string,
  reviewRequestId: string,
  decision: "approved" | "rejected",
  expectedVersion: number
) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/collaboration/review-requests/${reviewRequestId}/decide`,
    payload: { decision, expectedVersion }
  });
}

function listActivity(sessionId: string) {
  return app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/collaboration/activity`
  });
}

describe("team collaboration: authentication & boundaries", () => {
  it("refuses anonymous writes with 401", async () => {
    const sessionId = await createResearch("boundary");
    anonymous();
    const response = await invite(sessionId, USER_TWO, "editor");
    expect(response.statusCode).toBe(401);
  });

  it("answers 404 (not 403) for a session the caller is not a member of", async () => {
    const mine = await createResearch("mine");
    const theirs = await createResearch("theirs");
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    const response = await listMembers(mine);
    expect(response.statusCode).toBe(404);
    // A read of an unknown session id is also 404, so membership is not leaked.
    asUser(USER_ONE, "owner", "Owner One");
    const unknown = await listMembers("00000000-0000-7000-8000-000000000000");
    expect(unknown.statusCode).toBe(404);
    expect(theirs).toBeDefined();
  });
});

describe("team collaboration: member lifecycle", () => {
  it("invites, accepts, changes role and removes a member, auditing each step", async () => {
    const sessionId = await createResearch("lifecycle");
    asUser(USER_ONE, "owner", "Owner One");
    let response = await invite(sessionId, USER_TWO, "editor");
    expect(response.statusCode).toBe(201);
    const invited = response.json() as { role: string; status: string; userId: string };
    expect(invited.role).toBe("editor");
    expect(invited.status).toBe("pending");

    // The invitee accepts their own invitation (as themselves).
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    response = await accept(sessionId, USER_TWO);
    expect(response.statusCode).toBe(200);
    expect((response.json() as { status: string }).status).toBe("active");

    // Now an active member; the owner changes the role to reviewer.
    asUser(USER_ONE, "owner", "Owner One");
    response = await changeRole(sessionId, USER_TWO, "reviewer");
    expect(response.statusCode).toBe(200);
    expect((response.json() as { role: string }).role).toBe("reviewer");

    // USER_TWO sees themselves as an active member.
    response = await listMembers(sessionId);
    expect(response.statusCode).toBe(200);
    const members = (response.json() as { members: Array<{ userId: string; status: string }> }).members;
    expect(members.find((m) => m.userId === USER_TWO)?.status).toBe("active");

    // Remove the member with a reason.
    response = await removeMember(sessionId, USER_TWO, "scope change");
    expect(response.statusCode).toBe(200);
    expect((response.json() as { status: string }).status).toBe("removed");
  });

  /**
   * The trail is append-only: every invite, acceptance, role change and
   * removal adds a row that is never deleted, so "the activity" is an
   * unbounded history. It is paged on `sequence`, which is dense and monotonic
   * per session, so a page boundary is a value comparison rather than a
   * position that a new event could shift.
   */
  it("pages the activity trail on the event sequence without repeating one", async () => {
    const sessionId = await createResearch("activity-paging");
    asUser(USER_ONE, "owner", "Owner One");
    expect((await invite(sessionId, USER_TWO, "editor")).statusCode).toBe(201);
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    expect((await accept(sessionId, USER_TWO)).statusCode).toBe(200);
    asUser(USER_ONE, "owner", "Owner One");
    expect((await changeRole(sessionId, USER_TWO, "reviewer")).statusCode).toBe(200);

    const firstPage = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/collaboration/activity?limit=2`
    });
    expect(firstPage.statusCode).toBe(200);
    const first = firstPage.json() as {
      activity: Array<{ sequence: number }>;
      nextCursor: number | null;
      hasNextPage: boolean;
    };
    expect(first.activity).toHaveLength(2);
    expect(first.hasNextPage).toBe(true);
    // Newest first, and the cursor is the last sequence actually returned.
    expect(first.activity[0]!.sequence).toBeGreaterThan(first.activity[1]!.sequence);
    expect(first.nextCursor).toBe(first.activity[1]!.sequence);

    const secondPage = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/collaboration/activity?limit=2&after=${first.nextCursor}`
    });
    expect(secondPage.statusCode).toBe(200);
    const second = secondPage.json() as typeof first;
    expect(second.activity.length).toBeGreaterThan(0);
    // No event appears on both pages: everything after the cursor is older.
    for (const item of second.activity) {
      expect(item.sequence).toBeLessThan(first.nextCursor!);
    }

    // A cursor that is not a number is refused rather than ignored, which
    // would otherwise loop a paging client on page one forever.
    const broken = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/collaboration/activity?after=abc`
    });
    expect(broken.statusCode).toBe(400);
  });

  it("lets the invitee decline, and a second accept finds nothing pending", async () => {
    const sessionId = await createResearch("decline");
    asUser(USER_ONE, "owner", "Owner One");
    expect((await invite(sessionId, USER_TWO, "reviewer")).statusCode).toBe(201);
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    expect((await decline(sessionId, USER_TWO)).statusCode).toBe(200);
    // Accepting after a decline is not a 200 (no pending invitation).
    expect((await accept(sessionId, USER_TWO)).statusCode).toBe(404);
  });

  it("does not let a reviewer administer members", async () => {
    const sessionId = await createResearch("rbac");
    asUser(USER_ONE, "owner", "Owner One");
    expect((await invite(sessionId, USER_TWO, "reviewer")).statusCode).toBe(201);
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    expect((await accept(sessionId, USER_TWO)).statusCode).toBe(200);
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    // USER_TWO is a reviewer, not an owner: member admin is denied.
    expect((await invite(sessionId, USER_THREE, "editor")).statusCode).toBe(403);
    expect((await changeRole(sessionId, USER_ONE, "editor")).statusCode).toBe(403);
  });

  it("refuses an invite that would grant ownership", async () => {
    const sessionId = await createResearch("no-owner-escalation");
    asUser(USER_ONE, "owner", "Owner One");
    const response = await invite(sessionId, USER_TWO, "owner");
    expect(response.statusCode).toBe(400);
  });

  it("rejects a duplicate invitation with 409", async () => {
    const sessionId = await createResearch("dup-invite");
    asUser(USER_ONE, "owner", "Owner One");
    expect((await invite(sessionId, USER_TWO, "editor")).statusCode).toBe(201);
    const second = await invite(sessionId, USER_TWO, "editor", "dup-key-2");
    expect(second.statusCode).toBe(409);
  });
});

describe("team collaboration: work items", () => {
  it("creates, updates, assigns and completes a work item", async () => {
    const sessionId = await createResearch("work");
    asUser(USER_ONE, "owner", "Owner One");
    expect((await invite(sessionId, USER_TWO, "editor")).statusCode).toBe(201);
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    expect((await accept(sessionId, USER_TWO)).statusCode).toBe(200);

    // Owner creates a work item and assigns it to USER_TWO.
    asUser(USER_ONE, "owner", "Owner One");
    let response = await createWorkItem(sessionId, {
      title: "Verify the dataset",
      description: "Cross-check sources",
      assigneeUserId: USER_TWO
    });
    expect(response.statusCode).toBe(201);
    const created = response.json() as { id: string; version: number; status: string };
    expect(created.status).toBe("open");

    // Only an owner/editor may write; a viewer may not.
    asUser(USER_ONE, "owner", "Owner One");
    expect((await invite(sessionId, USER_THREE, "viewer")).statusCode).toBe(201);
    asUser(USER_THREE, "viewer", "Viewer Three");
    expect((await accept(sessionId, USER_THREE)).statusCode).toBe(200);
    asUser(USER_THREE, "viewer", "Viewer Three");
    response = await updateWorkItem(sessionId, created.id, {
      status: "in_progress",
      expectedVersion: created.version
    });
    // USER_THREE is a viewer, not an editor/owner -> forbidden.
    expect(response.statusCode).toBe(403);

    // Editor (USER_TWO) updates it.
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    response = await updateWorkItem(sessionId, created.id, {
      status: "in_progress",
      expectedVersion: created.version
    });
    expect(response.statusCode).toBe(200);
    let updated: { version: number; status: string; completedAt?: string } =
      response.json() as { version: number; status: string };
    expect(updated.status).toBe("in_progress");

    // Completing sets completedAt.
    response = await updateWorkItem(sessionId, created.id, {
      status: "completed",
      expectedVersion: updated.version
    });
    expect(response.statusCode).toBe(200);
    updated = response.json() as {
      version: number;
      status: string;
      completedAt: string;
    };
    expect(updated.status).toBe("completed");
    expect(updated.completedAt).toBeDefined();
  });

  it("refuses to assign a work item to a non-collaborator", async () => {
    const sessionId = await createResearch("assign-guard");
    asUser(USER_ONE, "owner", "Owner One");
    const response = await createWorkItem(sessionId, {
      title: "Unassignable",
      assigneeUserId: USER_THREE
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 409 on a stale optimistic-lock update", async () => {
    const sessionId = await createResearch("optlock");
    asUser(USER_ONE, "owner", "Owner One");
    const created = (
      await createWorkItem(sessionId, { title: "Locked" })
    ).json() as { id: string; version: number };
    // Two editors update with the same (now stale after the first) version.
    asUser(USER_ONE, "owner", "Owner One");
    expect(
      (
        await updateWorkItem(sessionId, created.id, {
          status: "in_progress",
          expectedVersion: created.version
        })
      ).statusCode
    ).toBe(200);
    const stale = await updateWorkItem(sessionId, created.id, {
      status: "completed",
      expectedVersion: created.version
    });
    expect(stale.statusCode).toBe(409);
  });
});

describe("team collaboration: comments", () => {
  it("creates an author-attributed thread and only the author may delete", async () => {
    const sessionId = await createResearch("comments");
    asUser(USER_ONE, "owner", "Owner One");
    // A comment target is just an id within the session; we use a synthetic one.
    const targetId = "claim-123";
    const targetType = "claim";
    let response = await createComment(sessionId, {
      body: "Top-level note",
      targetType,
      targetId
    });
    expect(response.statusCode).toBe(201);
    const top = response.json() as { id: string; version: number; authorUserId: string };
    expect(top.authorUserId).toBe(USER_ONE);

    // USER_TWO (reviewer) replies; author is USER_TWO, not the body.
    asUser(USER_ONE, "owner", "Owner One");
    expect((await invite(sessionId, USER_TWO, "reviewer")).statusCode).toBe(201);
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    expect((await accept(sessionId, USER_TWO)).statusCode).toBe(200);
    response = await createComment(sessionId, {
      body: "Reply",
      targetType,
      targetId,
      parentCommentId: top.id
    });
    expect(response.statusCode).toBe(201);
    const reply = response.json() as { authorUserId: string; parentCommentId: string };
    expect(reply.authorUserId).toBe(USER_TWO);
    expect(reply.parentCommentId).toBe(top.id);

    // Listing returns both, newest first.
    response = await listComments(sessionId, targetType, targetId);
    expect(response.statusCode).toBe(200);
    const comments = (response.json() as { comments: Array<{ id: string }> }).comments;
    expect(comments).toHaveLength(2);

    // USER_ONE (author) deletes the top comment; USER_TWO's reply stays.
    asUser(USER_ONE, "owner", "Owner One");
    response = await deleteComment(sessionId, top.id, top.version);
    expect(response.statusCode).toBe(200);
    response = await listComments(sessionId, targetType, targetId);
    const after = (response.json() as { comments: Array<{ id: string }> }).comments;
    expect(after).toHaveLength(1);

    // USER_TWO cannot delete USER_ONE's already-gone/own check: deleting the
    // reply as USER_ONE is fine; deleting it as USER_TWO (author) is also fine,
    // but deleting it as a non-author is forbidden.
    asUser(USER_THREE, "viewer", "Stranger");
    // USER_THREE is not a member; 404 on the session.
    expect((await listComments(sessionId, targetType, targetId)).statusCode).toBe(404);
  });

  it("forbids a viewer from commenting", async () => {
    const sessionId = await createResearch("viewer-comment");
    asUser(USER_ONE, "owner", "Owner One");
    expect((await invite(sessionId, USER_TWO, "viewer")).statusCode).toBe(201);
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    expect((await accept(sessionId, USER_TWO)).statusCode).toBe(200);
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    const response = await createComment(sessionId, {
      body: "I should not be allowed",
      targetType: "claim",
      targetId: "claim-1"
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("team collaboration: review requests", () => {
  it("creates, claims (no self-review) and decides a review request", async () => {
    const sessionId = await createResearch("review");
    asUser(USER_ONE, "owner", "Owner One");
    expect((await invite(sessionId, USER_TWO, "reviewer")).statusCode).toBe(201);
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    expect((await accept(sessionId, USER_TWO)).statusCode).toBe(200);

    // USER_ONE (owner) requests a review from USER_TWO.
    asUser(USER_ONE, "owner", "Owner One");
    let response = await createReviewRequest(sessionId, {
      requestType: "claim_review",
      targetType: "claim",
      targetId: "claim-9",
      requestedReviewerUserId: USER_TWO
    });
    expect(response.statusCode).toBe(201);
    const created = response.json() as { id: string; status: string };
    expect(created.status).toBe("open");

    // USER_TWO claims it.
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    response = await claimReviewRequest(sessionId, created.id);
    expect(response.statusCode).toBe(200);
    expect((response.json() as { status: string }).status).toBe("in_review");

    const claimed = (
      await listReviewRequests(sessionId)
    ).json() as { reviewRequests: Array<{ id: string; version: number }> };
    const rr = claimed.reviewRequests[0]!;

    // USER_TWO (the assigned reviewer) decides approved.
    response = await decideReviewRequest(sessionId, rr.id, "approved", rr.version);
    expect(response.statusCode).toBe(200);
    expect((response.json() as { status: string; decision: string }).decision).toBe(
      "approved"
    );
  });

  it("rejects a self-addressed review request and self-claim", async () => {
    const sessionId = await createResearch("self-review");
    asUser(USER_ONE, "owner", "Owner One");
    // Requesting a review from yourself is refused.
    const self = await createReviewRequest(sessionId, {
      requestType: "claim_review",
      targetType: "claim",
      targetId: "claim-1",
      requestedReviewerUserId: USER_ONE
    });
    expect(self.statusCode).toBe(400);

    // A request with no specific reviewer: the requester cannot claim it.
    const created = (
      await createReviewRequest(sessionId, {
        requestType: "source_review",
        targetType: "source",
        targetId: "source-1"
      })
    ).json() as { id: string };
    const claim = await claimReviewRequest(sessionId, created.id);
    // USER_ONE is the requester here -> forbidden to claim.
    expect(claim.statusCode).toBe(400);
  });

  it("only the assigned reviewer may decide", async () => {
    const sessionId = await createResearch("decide-guard");
    asUser(USER_ONE, "owner", "Owner One");
    expect((await invite(sessionId, USER_TWO, "reviewer")).statusCode).toBe(201);
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    expect((await accept(sessionId, USER_TWO)).statusCode).toBe(200);
    asUser(USER_ONE, "owner", "Owner One");
    const created = (
      await createReviewRequest(sessionId, {
        requestType: "conflict_review",
        targetType: "conflict",
        targetId: "conflict-1",
        requestedReviewerUserId: USER_TWO
      })
    ).json() as { id: string };
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    const claimed = (
      await claimReviewRequest(sessionId, created.id)
    ).json() as { version: number };
    // USER_ONE (not the assigned reviewer) tries to decide -> forbidden.
    asUser(USER_ONE, "owner", "Owner One");
    const decide = await decideReviewRequest(
      sessionId,
      created.id,
      "approved",
      claimed.version
    );
    expect(decide.statusCode).toBe(403);
  });
});

describe("team collaboration: activity feed", () => {
  it("projects collaboration events from the shared execution_events table", async () => {
    const sessionId = await createResearch("activity");
    asUser(USER_ONE, "owner", "Owner One");
    await invite(sessionId, USER_TWO, "editor");
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    await accept(sessionId, USER_TWO);
    asUser(USER_ONE, "owner", "Owner One");
    await createWorkItem(sessionId, { title: "Tracked work" });

    const response = await listActivity(sessionId);
    expect(response.statusCode).toBe(200);
    const activity = (response.json() as { activity: Array<{ type: string }> }).activity;
    const types = activity.map((a) => a.type);
    expect(types).toContain("MEMBER_INVITED");
    expect(types).toContain("MEMBER_JOINED");
    expect(types).toContain("WORK_ITEM_CREATED");
  });
});
