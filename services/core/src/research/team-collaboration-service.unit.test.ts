import { describe, expect, it } from "vitest";
import {
  type CollaborationActivity,
  type CollaborationRole,
  type Comment,
  type MembershipStatus,
  type ReviewRequest,
  type TeamMember,
  type WorkItem
} from "@nexus/shared";
import { MembershipExistsError } from "@nexus/db";
import {
  CollaborationForbiddenError,
  CollaborationConflictError,
  CollaborationBadRequestError,
  CollaborationSessionNotFoundError,
  TeamCollaborationService,
  type CollaborationCaller
} from "./team-collaboration-service";

/**
 * Unit test for the collaboration authorization matrix, using an in-memory
 * repository double. The DB-backed integration test exercises the routes over
 * real HTTP; this file isolates the *decision* logic — effective-role
 * derivation, the owner/editor/reviewer/viewer capability split, the last-owner
 * guard, self-review avoidance, assignee validation and author-only deletion —
 * which is easier to assert precisely without a database. The stub mirrors the
 * repository's semantics closely enough that the service runs unchanged.
 */

type Membership = TeamMember & { status: MembershipStatus };
type WI = WorkItem;
type C = Comment;
type RR = ReviewRequest;

class StubRepo {
  ownerUserId: string | null;
  memberships: Membership[] = [];
  workItems: WI[] = [];
  comments: C[] = [];
  reviewRequests: RR[] = [];
  events: CollaborationActivity[] = [];
  sessionExistsFlag = true;
  private seq = 1;

  constructor(ownerUserId: string | null) {
    this.ownerUserId = ownerUserId;
  }

  async getSessionOwnerUserId() {
    return this.ownerUserId;
  }
  async sessionExists() {
    return this.sessionExistsFlag;
  }
  async getLiveMembership(_s: string, userId: string) {
    return (
      this.memberships.find(
        (m) => m.userId === userId && (m.status === "active" || m.status === "pending")
      ) ?? null
    );
  }
  async getMembershipById(id: string) {
    return this.memberships.find((m) => m.id === id) ?? null;
  }
  async listMemberships(_s: string) {
    return [...this.memberships];
  }
  async listActiveMembersByRole(_s: string, role: CollaborationRole) {
    return this.memberships.filter((m) => m.status === "active" && m.role === role);
  }
  private record(event: { correlationId: string; type: string; payload: Record<string, unknown> }) {
    this.events.push({
      id: `ev-${this.seq}`,
      sessionId: "s",
      sequence: this.seq++,
      correlationId: event.correlationId,
      type: event.type,
      payload: event.payload,
      occurredAt: new Date().toISOString()
    });
  }
  async createMembership(input: {
    sessionId: string;
    userId: string;
    role: CollaborationRole;
    invitedBy: string;
    event: { correlationId: string; type: string; payload: Record<string, unknown> };
  }) {
    if (await this.getLiveMembership(input.sessionId, input.userId)) {
      throw new MembershipExistsError();
    }
    const m: Membership = {
      id: `m-${this.memberships.length + 1}`,
      sessionId: input.sessionId,
      userId: input.userId,
      role: input.role,
      status: "pending",
      invitedBy: input.invitedBy,
      invitedAt: new Date().toISOString(),
      statusChangedAt: new Date().toISOString(),
      version: 1,
      createdAt: new Date().toISOString()
    };
    this.memberships.push(m);
    this.record(input.event);
    return m;
  }
  async acceptMembership(_s: string, userId: string) {
    const m = this.memberships.find((x) => x.userId === userId && x.status === "pending");
    if (!m) return null;
    m.status = "active";
    m.joinedAt = new Date().toISOString();
    m.statusChangedAt = new Date().toISOString();
    m.version += 1;
    return m;
  }
  async declineMembership(_s: string, userId: string) {
    const m = this.memberships.find((x) => x.userId === userId && x.status === "pending");
    if (!m) return null;
    m.status = "declined";
    m.version += 1;
    return m;
  }
  async changeRole(_s: string, userId: string, role: CollaborationRole, version: number) {
    const m = this.memberships.find((x) => x.userId === userId);
    if (!m || m.version !== version) return null;
    m.role = role;
    m.version += 1;
    return m;
  }
  async removeMembership(
    _s: string,
    userId: string,
    removedBy: string,
    reason: string,
    version: number
  ) {
    const m = this.memberships.find((x) => x.userId === userId);
    if (!m || m.version !== version) return null;
    m.status = "removed";
    m.removedBy = removedBy;
    m.removeReason = reason;
    m.version += 1;
    return m;
  }
  async createWorkItem(input: {
    sessionId: string;
    draft: { title: string; description?: string; assigneeUserId?: string };
    createdBy: string;
    event: { correlationId: string; type: string; payload: Record<string, unknown> };
  }) {
    const wi: WI = {
      id: `w-${this.workItems.length + 1}`,
      sessionId: input.sessionId,
      title: input.draft.title,
      ...(input.draft.description ? { description: input.draft.description } : {}),
      status: "open",
      ...(input.draft.assigneeUserId ? { assigneeUserId: input.draft.assigneeUserId } : {}),
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    };
    this.workItems.push(wi);
    this.record(input.event);
    return wi;
  }
  async getWorkItem(id: string) {
    return this.workItems.find((w) => w.id === id) ?? null;
  }
  async listWorkItems() {
    return [...this.workItems];
  }
  async updateWorkItem(input: {
    workItemId: string;
    changes: { status?: string; assigneeUserId?: string; description?: string };
    expectedVersion: number;
  }) {
    const wi = this.workItems.find((w) => w.id === input.workItemId);
    if (!wi || wi.version !== input.expectedVersion) return null;
    if (input.changes.status !== undefined) {
      wi.status = input.changes.status as WI["status"];
      wi.completedAt =
        input.changes.status === "completed" ? new Date().toISOString() : undefined;
    }
    if (input.changes.assigneeUserId !== undefined)
      wi.assigneeUserId = input.changes.assigneeUserId;
    wi.version += 1;
    return wi;
  }
  async createComment(input: {
    sessionId: string;
    draft: { body: string; targetType: string; targetId: string };
    authorUserId: string;
    event: { correlationId: string; type: string; payload: Record<string, unknown> };
  }) {
    const c: C = {
      id: `c-${this.comments.length + 1}`,
      sessionId: input.sessionId,
      authorUserId: input.authorUserId,
      body: input.draft.body,
      targetType: input.draft.targetType as C["targetType"],
      targetId: input.draft.targetId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    };
    this.comments.push(c);
    this.record(input.event);
    return c;
  }
  async getComment(id: string) {
    return this.comments.find((c) => c.id === id && !c.deletedAt) ?? null;
  }
  async listComments() {
    return this.comments.filter((c) => !c.deletedAt);
  }
  async softDeleteComment(id: string, version: number) {
    const c = this.comments.find((x) => x.id === id && !x.deletedAt);
    if (!c || c.version !== version) return null;
    c.deletedAt = new Date().toISOString();
    c.version += 1;
    return c;
  }
  async createReviewRequest(input: {
    sessionId: string;
    draft: {
      requestType: string;
      targetType: string;
      targetId: string;
      requestedReviewerUserId?: string;
    };
    requestedBy: string;
    event: { correlationId: string; type: string; payload: Record<string, unknown> };
  }) {
    const rr: RR = {
      id: `r-${this.reviewRequests.length + 1}`,
      sessionId: input.sessionId,
      requestType: input.draft.requestType as RR["requestType"],
      targetType: input.draft.targetType as RR["targetType"],
      targetId: input.draft.targetId,
      requestedBy: input.requestedBy,
      ...(input.draft.requestedReviewerUserId
        ? { requestedReviewerUserId: input.draft.requestedReviewerUserId }
        : {}),
      status: "open",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    };
    this.reviewRequests.push(rr);
    this.record(input.event);
    return rr;
  }
  async getReviewRequest(id: string) {
    return this.reviewRequests.find((r) => r.id === id) ?? null;
  }
  async listReviewRequests() {
    return [...this.reviewRequests];
  }
  async claimReviewRequest(id: string, reviewer: string, version: number) {
    const rr = this.reviewRequests.find((r) => r.id === id);
    if (!rr || rr.status !== "open" || rr.version !== version) return null;
    rr.status = "in_review";
    rr.assignedReviewerUserId = reviewer;
    rr.version += 1;
    return rr;
  }
  async decideReviewRequest(id: string, decision: string, by: string, version: number) {
    const rr = this.reviewRequests.find((r) => r.id === id);
    if (!rr || rr.status !== "in_review" || rr.version !== version) return null;
    rr.status = "completed";
    rr.decision = decision as RR["decision"];
    rr.decidedBy = by;
    rr.decidedAt = new Date().toISOString();
    rr.version += 1;
    return rr;
  }
  async cancelReviewRequest(id: string, version: number) {
    const rr = this.reviewRequests.find((r) => r.id === id);
    if (!rr || rr.status !== "open" || rr.version !== version) return null;
    rr.status = "cancelled";
    rr.version += 1;
    return rr;
  }
  async listActivity(_s: string) {
    return [...this.events];
  }
}

const OWNER: CollaborationCaller = {
  userId: "owner-1",
  role: "owner",
  name: "Owner"
};
const EDITOR: CollaborationCaller = { userId: "editor-1", role: "editor", name: "Editor" };
const REVIEWER: CollaborationCaller = {
  userId: "reviewer-1",
  role: "reviewer",
  name: "Reviewer"
};
const VIEWER: CollaborationCaller = { userId: "viewer-1", role: "viewer", name: "Viewer" };

function withMembers(repo: StubRepo, members: Array<[string, CollaborationRole]>) {
  for (const [userId, role] of members) {
    repo.memberships.push({
      id: `seed-${userId}`,
      sessionId: "s",
      userId,
      role,
      status: "active",
      invitedBy: "owner-1",
      invitedAt: new Date().toISOString(),
      statusChangedAt: new Date().toISOString(),
      joinedAt: new Date().toISOString(),
      version: 1,
      createdAt: new Date().toISOString()
    });
  }
}

describe("collaboration service: read access & 404 boundary", () => {
  it("refuses a non-member with 404 (does not reveal the session exists)", async () => {
    const repo = new StubRepo("owner-1");
    const service = new TeamCollaborationService(repo as never);
    await expect(service.listMembers(REVIEWER, "s")).rejects.toBeInstanceOf(
      CollaborationSessionNotFoundError
    );
  });
});

describe("collaboration service: capability matrix", () => {
  it("a viewer may read but not write a work item (403)", async () => {
    const repo = new StubRepo("owner-1");
    withMembers(repo, [["viewer-1", "viewer"]]);
    const service = new TeamCollaborationService(repo as never);
    await expect(
      service.createWorkItem(VIEWER, {
        sessionId: "s",
        title: "x",
        description: undefined,
        assigneeUserId: undefined,
        targetType: undefined,
        targetId: undefined,
        dueAt: undefined
      })
    ).rejects.toBeInstanceOf(CollaborationForbiddenError);
    await expect(service.listWorkItems(VIEWER, "s")).resolves.toBeDefined();
  });

  it("a reviewer may comment and request review but not administer members", async () => {
    const repo = new StubRepo("owner-1");
    withMembers(repo, [["reviewer-1", "reviewer"]]);
    const service = new TeamCollaborationService(repo as never);
    await expect(
      service.changeMemberRole(REVIEWER, {
        sessionId: "s",
        userId: "viewer-1",
        role: "editor"
      })
    ).rejects.toBeInstanceOf(CollaborationForbiddenError);
    // Reviewers may create a review request.
    await expect(
      service.createReviewRequest(REVIEWER, {
        sessionId: "s",
        requestType: "claim_review",
        targetType: "claim",
        targetId: "c-1"
      })
    ).resolves.toBeDefined();
  });

  it("only the owner may remove a member", async () => {
    const repo = new StubRepo("owner-1");
    withMembers(repo, [["editor-1", "editor"]]);
    const service = new TeamCollaborationService(repo as never);
    await expect(
      service.removeMember(EDITOR, {
        sessionId: "s",
        userId: "editor-1",
        reason: "x"
      })
    ).rejects.toBeInstanceOf(CollaborationForbiddenError);
    await expect(
      service.removeMember(OWNER, { sessionId: "s", userId: "editor-1", reason: "x" })
    ).resolves.toBeDefined();
  });
});

describe("collaboration service: last-owner guard", () => {
  it("refuses to remove the only owner in a legacy session (no platform owner)", async () => {
    const repo = new StubRepo(null);
    withMembers(repo, [["owner-1", "owner"]]);
    const service = new TeamCollaborationService(repo as never);
    await expect(
      service.removeMember(OWNER, { sessionId: "s", userId: "owner-1", reason: "x" })
    ).rejects.toBeInstanceOf(CollaborationConflictError);
  });

  it("allows removing the only owner when a platform owner exists", async () => {
    const repo = new StubRepo("owner-1");
    withMembers(repo, [["owner-1", "owner"]]);
    const service = new TeamCollaborationService(repo as never);
    await expect(
      service.removeMember(OWNER, { sessionId: "s", userId: "owner-1", reason: "x" })
    ).resolves.toBeDefined();
  });

  it("refuses to downgrade the only owner to a lower role", async () => {
    const repo = new StubRepo(null);
    withMembers(repo, [["owner-1", "owner"]]);
    const service = new TeamCollaborationService(repo as never);
    await expect(
      service.changeMemberRole(OWNER, { sessionId: "s", userId: "owner-1", role: "editor" })
    ).rejects.toBeInstanceOf(CollaborationConflictError);
  });
});

describe("collaboration service: self-review avoidance", () => {
  it("refuses a review request addressed to the requester", async () => {
    const repo = new StubRepo("owner-1");
    const service = new TeamCollaborationService(repo as never);
    await expect(
      service.createReviewRequest(OWNER, {
        sessionId: "s",
        requestType: "claim_review",
        targetType: "claim",
        targetId: "c-1",
        requestedReviewerUserId: "owner-1"
      })
    ).rejects.toBeInstanceOf(CollaborationBadRequestError);
  });

  it("refuses the requester from claiming their own open request", async () => {
    const repo = new StubRepo("owner-1");
    const service = new TeamCollaborationService(repo as never);
    const rr = await service.createReviewRequest(OWNER, {
      sessionId: "s",
      requestType: "claim_review",
      targetType: "claim",
      targetId: "c-1"
    });
    await expect(
      service.claimReviewRequest(OWNER, "s", rr.id)
    ).rejects.toBeInstanceOf(CollaborationBadRequestError);
  });

  it("only the assigned reviewer may decide", async () => {
    const repo = new StubRepo("owner-1");
    withMembers(repo, [["reviewer-1", "reviewer"]]);
    const service = new TeamCollaborationService(repo as never);
    const rr = await service.createReviewRequest(OWNER, {
      sessionId: "s",
      requestType: "claim_review",
      targetType: "claim",
      targetId: "c-1",
      requestedReviewerUserId: "reviewer-1"
    });
    const claimed = await service.claimReviewRequest(REVIEWER, "s", rr.id);
    // OWNER (not the assigned reviewer) tries to decide -> forbidden.
    await expect(
      service.decideReviewRequest(OWNER, {
        sessionId: "s",
        reviewRequestId: rr.id,
        decision: "approved",
        expectedVersion: claimed.version
      })
    ).rejects.toBeInstanceOf(CollaborationForbiddenError);
  });
});

describe("collaboration service: assignee & author guards", () => {
  it("refuses to assign a work item to a non-collaborator", async () => {
    const repo = new StubRepo("owner-1");
    const service = new TeamCollaborationService(repo as never);
    await expect(
      service.createWorkItem(OWNER, {
        sessionId: "s",
        title: "x",
        assigneeUserId: "stranger"
      })
    ).rejects.toBeInstanceOf(CollaborationBadRequestError);
  });

  it("only the author may delete their comment", async () => {
    const repo = new StubRepo("owner-1");
    withMembers(repo, [["reviewer-1", "reviewer"]]);
    const service = new TeamCollaborationService(repo as never);
    const comment = await service.createComment(OWNER, {
      sessionId: "s",
      body: "note",
      targetType: "claim",
      targetId: "c-1"
    });
    // REVIEWER (not the author) deletes -> forbidden.
    await expect(
      service.deleteComment(REVIEWER, "s", comment.id, comment.version)
    ).rejects.toBeInstanceOf(CollaborationForbiddenError);
    await expect(
      service.deleteComment(OWNER, "s", comment.id, comment.version)
    ).resolves.toBeDefined();
  });

  it("an invitation can only be accepted by the invitee", async () => {
    const repo = new StubRepo("owner-1");
    const service = new TeamCollaborationService(repo as never);
    await service.inviteMember(OWNER, { sessionId: "s", userId: "editor-1", role: "editor" });
    await expect(
      service.acceptInvitation(REVIEWER, "s", "editor-1")
    ).rejects.toBeInstanceOf(CollaborationForbiddenError);
  });
});
