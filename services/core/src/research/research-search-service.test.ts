import { describe, expect, it } from "vitest";
import {
  newId,
  type ResearchSearchTask,
  type ResearchSearchTaskStatus,
  type SearchCandidate,
  type Source
} from "@nexus/shared";
import type { EvidenceRepository, ResearchSearchRepository } from "@nexus/db";
import {
  ResearchSearchService,
  type SearchServiceDependencies
} from "./research-search-service";
import {
  DeterministicSearchProvider,
  SearchProviderError,
  type SearchLead,
  type SearchProvider
} from "./search-provider";
import type { NewResearchSearchTask } from "@nexus/db";

/**
 * Service-layer tests for the controlled research search, with the repositories
 * faked.
 *
 * The boundary under test, stated plainly: this service surfaces candidates and
 * — when a person approves them — copies them into `sources`. It never, under
 * any path, writes evidence or touches verification status. The negative
 * assertions below (no evidence created, no write to the evidence layer) are the
 * point of the feature, not incidental coverage.
 */

const SESSION_ID = newId();

/** A provider that always fails, to exercise the honest "search did not work" path. */
class FailingProvider implements SearchProvider {
  readonly name = "failing-controlled-search";
  constructor(private readonly reason: string) {}
  async search(): Promise<SearchLead[]> {
    throw new SearchProviderError(this.reason);
  }
}

/**
 * In-memory stand-in for `ResearchSearchRepository`. It follows the same contract
 * (every search settles a task; candidates are attached on completion) without a
 * database, so the service logic is what is exercised.
 */
class FakeSearchRepo {
  private tasks = new Map<string, ResearchSearchTask>();
  private candidates = new Map<string, SearchCandidate>();
  public planItemNotFound = false;

  private now(): string {
    return new Date().toISOString();
  }

  async createSearchTask(input: {
    sessionId: string;
    task: NewResearchSearchTask;
    event: unknown;
  }): Promise<{ task: ResearchSearchTask; event: unknown }> {
    if (this.planItemNotFound) {
      const error = new Error(
        `Research plan item not found: ${input.task.planItemId}`
      );
      error.name = "ResearchSearchPlanItemNotFoundError";
      throw error;
    }
    const stored: ResearchSearchTask = {
      ...input.task,
      createdAt: this.now(),
      updatedAt: this.now(),
      finishedAt: null
    };
    this.tasks.set(input.task.id, stored);
    return { task: stored, event: input.event };
  }

  async getSearchTask(_sessionId: string, taskId: string): Promise<ResearchSearchTask> {
    const task = this.tasks.get(taskId);
    if (!task) {
      const error = new Error(`Research search task not found: ${taskId}`);
      error.name = "ResearchSearchTaskNotFoundError";
      throw error;
    }
    return task;
  }

  async startSearch(input: { sessionId: string; taskId: string }): Promise<ResearchSearchTask> {
    const task = this.tasks.get(input.taskId)!;
    const updated: ResearchSearchTask = {
      ...task,
      status: "searching",
      updatedAt: this.now()
    };
    this.tasks.set(input.taskId, updated);
    return updated;
  }

  async completeSearch(input: {
    sessionId: string;
    taskId: string;
    candidates: SearchCandidate[];
    event: unknown;
  }): Promise<{ task: ResearchSearchTask; events: unknown[] }> {
    const task = this.tasks.get(input.taskId)!;
    for (const candidate of input.candidates) {
      this.candidates.set(candidate.id, candidate);
    }
    const updated: ResearchSearchTask = {
      ...task,
      status: "completed",
      updatedAt: this.now(),
      finishedAt: this.now()
    };
    this.tasks.set(input.taskId, updated);
    return { task: updated, events: [input.event] };
  }

  async failSearch(input: {
    sessionId: string;
    taskId: string;
    failureReason: string;
    event: unknown;
  }): Promise<{ task: ResearchSearchTask; event: unknown }> {
    const task = this.tasks.get(input.taskId)!;
    const updated: ResearchSearchTask = {
      ...task,
      status: "failed",
      failureReason: input.failureReason,
      updatedAt: this.now(),
      finishedAt: this.now()
    };
    this.tasks.set(input.taskId, updated);
    return { task: updated, event: input.event };
  }

  async rejectTask(input: {
    sessionId: string;
    taskId: string;
    actor: string;
    now: string;
  }): Promise<ResearchSearchTask> {
    const task = this.tasks.get(input.taskId)!;
    const updated: ResearchSearchTask = {
      ...task,
      rejectedAt: input.now,
      rejectedBy: input.actor,
      updatedAt: input.now
    };
    this.tasks.set(input.taskId, updated);
    return updated;
  }

  async markCandidateApproved(input: {
    candidateId: string;
    sourceId: string;
    now: string;
  }): Promise<void> {
    const candidate = this.candidates.get(input.candidateId);
    if (candidate) {
      this.candidates.set(input.candidateId, {
        ...candidate,
        approvedAt: input.now,
        registeredSourceId: input.sourceId
      });
    }
  }

  async listCandidates(_sessionId: string, taskId: string): Promise<SearchCandidate[]> {
    return [...this.candidates.values()].filter((c) => c.taskId === taskId);
  }

  async listSearchTasksWithCounts(
    _sessionId: string
  ): Promise<Array<ResearchSearchTask & { candidateCount: number }>> {
    return [...this.tasks.values()].map((task) => ({
      ...task,
      candidateCount: [...this.candidates.values()].filter((c) => c.taskId === task.id)
        .length
    }));
  }
}

/** In-memory stand-in for the evidence material layer. */
class FakeMaterial {
  public sources: Source[] = [];
  /** Honest-boundary probe: the service must never call this. */
  public createEvidenceCalls = 0;

  async listSources(_sessionId: string): Promise<Source[]> {
    return this.sources;
  }

  async createSource(source: Source): Promise<{ source: Source; event: unknown }> {
    const existing = this.sources.find((row) => row.title === source.title);
    if (existing) {
      const error = new Error(`A source named "${source.title}" already exists`);
      error.name = "SourceTitleConflictError";
      throw error;
    }
    this.sources.push(source);
    return { source, event: null };
  }
}

function dependencies(overrides: {
  search?: FakeSearchRepo;
  material?: FakeMaterial;
  provider?: SearchProvider;
}): SearchServiceDependencies {
  return {
    search: (overrides.search ?? new FakeSearchRepo()) as unknown as Pick<
      ResearchSearchRepository,
      | "createSearchTask"
      | "getSearchTask"
      | "startSearch"
      | "completeSearch"
      | "failSearch"
      | "rejectTask"
      | "markCandidateApproved"
      | "listCandidates"
      | "listSearchTasksWithCounts"
    >,
    material: (overrides.material ?? new FakeMaterial()) as unknown as Pick<
      EvidenceRepository,
      "listSources" | "createSource"
    >,
    provider: overrides.provider ?? new DeterministicSearchProvider()
  };
}

function sampleDraft(planItemId: string) {
  return {
    planItemId,
    query: "出货量同比增长多少？",
    purpose: "为「出货量」主张补充可核对的来源",
    keywords: ["出货量", "同比"]
  };
}

async function runCompleted(): Promise<{
  service: ResearchSearchService;
  search: FakeSearchRepo;
  material: FakeMaterial;
  taskId: string;
  planItemId: string;
}> {
  const search = new FakeSearchRepo();
  const material = new FakeMaterial();
  const service = new ResearchSearchService(dependencies({ search, material }));
  const planItemId = newId();
  const { task } = await service.createAndRun({
    sessionId: SESSION_ID,
    draft: sampleDraft(planItemId),
    taskId: newId(),
    actor: "研究员甲"
  });
  return { service, search, material, taskId: task.id, planItemId };
}

describe("ResearchSearchService.createAndRun", () => {
  it("creates a task, runs the controlled search, and completes with candidates", async () => {
    const { service, search, taskId } = await runCompleted();
    const task = await search.getSearchTask(SESSION_ID, taskId);
    expect(task.status).toBe<ResearchSearchTaskStatus>("completed");
    const view = await service.getSearchTask({ sessionId: SESSION_ID, taskId });
    expect(view.candidates.length).toBe(2);
    expect(view.candidates[0]!.url).toContain("example.org");
    // Every candidate carries the provenance a source needs.
    for (const candidate of view.candidates) {
      expect(candidate.publisher.length).toBeGreaterThan(0);
      expect(candidate.sourceType).toBeTruthy();
    }
  });

  it("returns a failed task (not a throw) when the provider cannot run", async () => {
    const search = new FakeSearchRepo();
    const service = new ResearchSearchService(
      dependencies({ search, provider: new FailingProvider("检索服务暂不可用") })
    );
    const { task, candidates } = await service.createAndRun({
      sessionId: SESSION_ID,
      draft: sampleDraft(newId()),
      taskId: newId(),
      actor: "研究员甲"
    });
    expect(task.status).toBe<ResearchSearchTaskStatus>("failed");
    expect(task.failureReason).toContain("检索服务");
    expect(candidates).toEqual([]);
  });

  it("maps a missing plan item to plan_item_not_found (404)", async () => {
    const search = new FakeSearchRepo();
    search.planItemNotFound = true;
    const service = new ResearchSearchService(dependencies({ search }));
    await expect(
      service.createAndRun({
        sessionId: SESSION_ID,
        draft: sampleDraft(newId()),
        taskId: newId(),
        actor: "研究员甲"
      })
    ).rejects.toMatchObject({ code: "plan_item_not_found", httpStatus: 404 });
  });
});

describe("ResearchSearchService.approve", () => {
  it("registers each candidate as a Source and never writes evidence", async () => {
    const { service, material, taskId } = await runCompleted();
    const result = await service.approve({
      sessionId: SESSION_ID,
      taskId,
      actor: "研究员甲"
    });
    expect(result.registeredSourceIds.length).toBe(2);
    expect(material.sources.length).toBe(2);
    // A candidate becomes a provenance record, attributed to the human, with a
    // kind that mirrors the candidate's source type.
    expect(material.sources[0]!.createdBy).toBe("human");
    expect(material.sources[0]!.kind).toBe("url");
    // The honest boundary: approving a task never touches the evidence layer.
    expect(material.createEvidenceCalls).toBe(0);
    // Candidates are linked to the source they became.
    const view = await service.getSearchTask({ sessionId: SESSION_ID, taskId });
    expect(view.candidates.every((c) => c.approvedAt !== null)).toBe(true);
    expect(
      view.candidates.every((c) => c.registeredSourceId !== null)
    ).toBe(true);
  });

  it("is idempotent: approving twice does not duplicate sources", async () => {
    const { service, material, taskId } = await runCompleted();
    await service.approve({ sessionId: SESSION_ID, taskId, actor: "研究员甲" });
    await service.approve({ sessionId: SESSION_ID, taskId, actor: "研究员甲" });
    expect(material.sources.length).toBe(2);
    const view = await service.getSearchTask({ sessionId: SESSION_ID, taskId });
    expect(view.candidates.every((c) => c.approvedAt !== null)).toBe(true);
  });

  it("refuses to approve a task that is not completed (invalid_transition)", async () => {
    const search = new FakeSearchRepo();
    const material = new FakeMaterial();
    const service = new ResearchSearchService(
      dependencies({ search, material, provider: new FailingProvider("x") })
    );
    const { task } = await service.createAndRun({
      sessionId: SESSION_ID,
      draft: sampleDraft(newId()),
      taskId: newId(),
      actor: "研究员甲"
    });
    expect(task.status).toBe<ResearchSearchTaskStatus>("failed");
    await expect(
      service.approve({ sessionId: SESSION_ID, taskId: task.id, actor: "研究员甲" })
    ).rejects.toMatchObject({ code: "invalid_transition", httpStatus: 409 });
    expect(material.sources.length).toBe(0);
  });
});

describe("ResearchSearchService.reject", () => {
  it("records the rejection on a completed task and creates no source", async () => {
    const { service, material, taskId } = await runCompleted();
    const { task } = await service.reject({
      sessionId: SESSION_ID,
      taskId,
      actor: "研究员甲"
    });
    expect(task.rejectedAt).not.toBeNull();
    expect(task.rejectedBy).toBe("研究员甲");
    expect(material.sources.length).toBe(0);
  });

  it("refuses to reject a failed task (invalid_transition)", async () => {
    const search = new FakeSearchRepo();
    const material = new FakeMaterial();
    const service = new ResearchSearchService(
      dependencies({ search, material, provider: new FailingProvider("x") })
    );
    const { task } = await service.createAndRun({
      sessionId: SESSION_ID,
      draft: sampleDraft(newId()),
      taskId: newId(),
      actor: "研究员甲"
    });
    await expect(
      service.reject({ sessionId: SESSION_ID, taskId: task.id, actor: "研究员甲" })
    ).rejects.toMatchObject({ code: "invalid_transition", httpStatus: 409 });
  });
});
