import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { newId, type ResearchPlanItem } from "@nexus/shared";
import { runMigrations } from "../migrate";
import {
  assertDisposableDatabaseName,
  createTestAdminDatabase,
  createTestDatabaseForUrl,
  resolveTestDatabaseUrl
} from "../testing/test-database";
import {
  ResearchPlanClaimNotFoundError,
  ResearchPlanRepository
} from "./research-plan-repository";

/**
 * The research plan, proved against a real PostgreSQL.
 *
 *  1. The migration lands closed value sets and the invariants that make
 *     dishonest states unwritable: 'completed' without an outcome, 'failed'
 *     without a reason, 'closed' without a decider.
 *  2. Adding a gap twice is idempotent, not a second task.
 *  3. A transition is a new row; the previous one is never rewritten.
 *  4. Nothing here writes `claims` or `evidence` — finding material is not
 *     verifying it.
 */

const databaseUrl = resolveTestDatabaseUrl().toString();
const admin = createTestAdminDatabase();
const createdDatabases: string[] = [];

const tempDatabaseUrl = (databaseName: string) => {
  assertDisposableDatabaseName(databaseName);
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

afterAll(async () => {
  for (const databaseName of createdDatabases) {
    await admin.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  }
  await admin.end();
});

type TestDatabase = ReturnType<typeof createTestDatabaseForUrl>;

async function statements(file: string): Promise<string[]> {
  const contents = await readFile(
    resolve("migrations", ...file.split("/")),
    "utf8"
  );
  return contents
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function tableExists(
  database: TestDatabase,
  table: string
): Promise<boolean> {
  const rows = (await database.execute(
    sql.raw(`select to_regclass('public.${table}') as found`)
  )) as unknown as Array<{ found: string | null }>;
  return rows[0]?.found != null;
}

async function ledger(database: TestDatabase): Promise<string[]> {
  const rows = (await database.execute(
    sql.raw("select filename from schema_migrations order by filename")
  )) as unknown as Array<{ filename: string }>;
  return rows.map((row) => row.filename);
}

async function rollbackMigrationsAfter(
  database: TestDatabase,
  filename: string
): Promise<void> {
  const rows = (await database.execute(
    sql.raw(
      `select filename from schema_migrations where filename > '${filename}' order by filename desc`
    )
  )) as unknown as Array<{ filename: string }>;
  for (const row of rows) {
    const downFile = `rollback/${row.filename.replace(/\.sql$/, ".down.sql")}`;
    for (const statement of await statements(downFile)) {
      await database.execute(sql.raw(statement));
    }
  }
}

async function freshMigratedDatabase(): Promise<{ database: TestDatabase }> {
  const databaseName = `nexus_migration_${newId().replaceAll("-", "")}`;
  await admin.execute(`CREATE DATABASE "${databaseName}"`);
  createdDatabases.push(databaseName);
  const database = createTestDatabaseForUrl(tempDatabaseUrl(databaseName));
  const applied = (await runMigrations(database, resolve("migrations"))).applied;
  expect(applied).toContain("0011_research_plan.sql");
  return { database };
}

type Seeded = { sessionId: string; claimId: string };

async function seed(database: TestDatabase): Promise<Seeded> {
  const projectId = newId();
  const sessionId = newId();
  const claimId = newId();
  const now = new Date().toISOString();

  await database.execute(
    sql.raw(
      `INSERT INTO projects (id, name, input) VALUES ('${projectId}', 'research-plan', '{}'::jsonb)`
    )
  );
  await database.execute(
    sql.raw(`
      INSERT INTO decision_sessions (id, project_id, locale, phase, operational_status, next_event_sequence)
      VALUES ('${sessionId}', '${projectId}', 'zh-CN', 'CREATED', 'ACTIVE', 1)
    `)
  );
  await database.execute(
    sql.raw(`
      INSERT INTO claims (id, session_id, lens, statement, type, stance, importance, confidence,
                          evidence_ids, status, root_claim_id, revision, relations, created_at, updated_at)
      VALUES ('${claimId}', '${sessionId}', 'research', '出口连续三个季度下滑。', 'fact', 'support',
              3, 0.5, '[]'::jsonb, 'proposed', '${claimId}', 1, '[]'::jsonb, '${now}', '${now}')
    `)
  );

  return { sessionId, claimId };
}

const GAP_ID = "no_verified_support:claim-1";

function itemInput(input: {
  sessionId: string;
  claimId: string;
  gapId?: string;
  status?: ResearchPlanItem["status"];
}): Parameters<ResearchPlanRepository["addPlanItem"]>[0]["item"] {
  return {
    id: newId(),
    sessionId: input.sessionId,
    gapId: input.gapId ?? GAP_ID,
    claimId: input.claimId,
    gapKind: "no_verified_support",
    severity: "blocking",
    priority: 1,
    title: "尚无已核实的直接支持证据。",
    question: "哪一份可核对的原始材料能直接支持这条表述？",
    whyInsufficient: ["关联材料 2 条，其中已核实 0 条。"],
    query: {
      neededEvidenceKind: "能直接支持该表述的一手材料或原始数据",
      sourceTypes: ["原始报告"],
      terms: ["出口连续三个季度下滑。"],
      timeRange: null,
      notes: null
    },
    status: input.status ?? "queued",
    outcome: null,
    decisionReason: null,
    decidedBy: null,
    failureReason: null
  };
}

describe("0011 research plan migration", () => {
  it("creates the table, closes the value sets, and can be rolled back", async () => {
    const { database } = await freshMigratedDatabase();
    expect(await tableExists(database, "research_plan_items")).toBe(true);

    await rollbackMigrationsAfter(database, "0011_research_plan.sql");
    for (const statement of await statements(
      "rollback/0011_research_plan.down.sql"
    )) {
      await database.execute(sql.raw(statement));
    }
    expect(await tableExists(database, "research_plan_items")).toBe(false);
    expect(await ledger(database)).not.toContain("0011_research_plan.sql");

    const reapplied = (await runMigrations(database, resolve("migrations")))
      .applied;
    expect(reapplied).toContain("0011_research_plan.sql");
  });

  it("refuses a status outside the closed set", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    await expect(
      database.execute(
        sql.raw(`
          INSERT INTO research_plan_items
            (id, session_id, claim_id, gap_id, gap_kind, severity, priority, title, question, query, status)
          VALUES ('${newId()}', '${seeded.sessionId}', '${seeded.claimId}', 'g1',
                  'no_verified_support', 'blocking', 1, 't', 'q', '{}'::jsonb, 'done_by_ai')
        `)
      )
    ).rejects.toThrow();
  });

  it("refuses a completed item that records no result", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    await expect(
      database.execute(
        sql.raw(`
          INSERT INTO research_plan_items
            (id, session_id, claim_id, gap_id, gap_kind, severity, priority, title, question, query, status, outcome)
          VALUES ('${newId()}', '${seeded.sessionId}', '${seeded.claimId}', 'g1',
                  'no_verified_support', 'blocking', 1, 't', 'q', '{}'::jsonb, 'completed', NULL)
        `)
      )
    ).rejects.toThrow(/research_plan_items_completed_has_outcome_check/);
  });

  it("refuses to close an item without a stated reason and a decider", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    await expect(
      database.execute(
        sql.raw(`
          INSERT INTO research_plan_items
            (id, session_id, claim_id, gap_id, gap_kind, severity, priority, title, question, query, status)
          VALUES ('${newId()}', '${seeded.sessionId}', '${seeded.claimId}', 'g1',
                  'no_verified_support', 'blocking', 1, 't', 'q', '{}'::jsonb, 'closed')
        `)
      )
    ).rejects.toThrow(/research_plan_items_decision_check/);
  });

  it("allows only one current item per gap", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    const insert = () =>
      database.execute(
        sql.raw(`
          INSERT INTO research_plan_items
            (id, session_id, claim_id, gap_id, gap_kind, severity, priority, title, question, query, status, is_current)
          VALUES ('${newId()}', '${seeded.sessionId}', '${seeded.claimId}', 'g1',
                  'no_verified_support', 'blocking', 1, 't', 'q', '{}'::jsonb, 'queued', true)
        `)
      );

    await insert();
    await expect(insert()).rejects.toThrow(/research_plan_items_current_idx/);
  });
});

describe("ResearchPlanRepository", () => {
  it("adds a gap as queued and appends the event", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    const repository = new ResearchPlanRepository(database);

    const result = await repository.addPlanItem({
      sessionId: seeded.sessionId,
      item: itemInput(seeded),
      event: {
        correlationId: newId(),
        type: "RESEARCH_PLAN_ITEM_ADDED",
        payload: { gapId: GAP_ID }
      }
    });

    expect(result.alreadyPlanned).toBe(false);
    expect(result.item.status).toBe("queued");
    expect(result.item.outcome).toBeNull();
    expect(result.event?.type).toBe("RESEARCH_PLAN_ITEM_ADDED");

    const list = await repository.listCurrentPlanItems(seeded.sessionId);
    expect(list).toHaveLength(1);
    expect(list[0]?.gapId).toBe(GAP_ID);
    expect(list[0]?.whyInsufficient).toEqual([
      "关联材料 2 条，其中已核实 0 条。"
    ]);
  });

  it("returns the existing item when the same gap is added again", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    const repository = new ResearchPlanRepository(database);
    const input = {
      sessionId: seeded.sessionId,
      item: itemInput(seeded),
      event: {
        correlationId: newId(),
        type: "RESEARCH_PLAN_ITEM_ADDED" as const,
        payload: { gapId: GAP_ID }
      }
    };

    const first = await repository.addPlanItem(input);
    const second = await repository.addPlanItem(input);

    expect(second.alreadyPlanned).toBe(true);
    expect(second.item.id).toBe(first.item.id);
    // A repeat must not emit a second event: the audit trail must not be able
    // to look like two people started the same work.
    expect(second.event).toBeNull();
    expect(await repository.listCurrentPlanItems(seeded.sessionId)).toHaveLength(1);
  });

  it("supersedes on a transition and keeps the previous row readable", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    const repository = new ResearchPlanRepository(database);
    const added = await repository.addPlanItem({
      sessionId: seeded.sessionId,
      item: itemInput(seeded),
      event: {
        correlationId: newId(),
        type: "RESEARCH_PLAN_ITEM_ADDED",
        payload: {}
      }
    });

    const actor = "Reviewer Two (reviewer)";
    const completed = await repository.replacePlanItem({
      sessionId: seeded.sessionId,
      itemId: added.item.id,
      item: {
        ...itemInput({
          sessionId: seeded.sessionId,
          claimId: seeded.claimId,
          status: "completed"
        }),
        id: newId(),
        status: "completed",
        outcome: {
          summary: "在统计公报中找到 2025 年 1-6 月原始数据。",
          sourceIds: [],
          evidenceIds: [],
          recordedBy: actor,
          recordedAt: new Date().toISOString()
        }
      },
      event: {
        correlationId: newId(),
        type: "RESEARCH_PLAN_OUTCOME_RECORDED",
        payload: {}
      }
    });

    expect(completed.item.status).toBe("completed");
    expect(completed.item.supersedesId).toBe(added.item.id);

    const history = await repository.listPlanItemHistory(
      seeded.sessionId,
      GAP_ID
    );
    expect(history).toHaveLength(2);
    const superseded = history.find((entry) => entry.id === added.item.id);
    expect(superseded?.isCurrent).toBe(false);
    expect(superseded?.status).toBe("queued");
    expect(superseded?.createdAt).toBe(added.item.createdAt);

    // Only the new one is current.
    expect(
      (await repository.listCurrentPlanItems(seeded.sessionId)).map(
        (entry) => entry.id
      )
    ).toEqual([completed.item.id]);
  });

  it("refuses a claim from another research task", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    const otherSession = await seed(database);
    const repository = new ResearchPlanRepository(database);

    await expect(
      repository.addPlanItem({
        sessionId: seeded.sessionId,
        item: itemInput({
          sessionId: seeded.sessionId,
          claimId: otherSession.claimId
        }),
        event: {
          correlationId: newId(),
          type: "RESEARCH_PLAN_ITEM_ADDED",
          payload: {}
        }
      })
    ).rejects.toBeInstanceOf(ResearchPlanClaimNotFoundError);
  });

  it("does not touch claims while planning", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    const repository = new ResearchPlanRepository(database);

    await repository.addPlanItem({
      sessionId: seeded.sessionId,
      item: itemInput(seeded),
      event: {
        correlationId: newId(),
        type: "RESEARCH_PLAN_ITEM_ADDED",
        payload: {}
      }
    });

    const rows = (await database.execute(
      sql.raw(
        `select status, evidence_ids, revision from claims where id = '${seeded.claimId}'`
      )
    )) as unknown as Array<{
      status: string;
      evidence_ids: unknown;
      revision: number;
    }>;
    expect(rows[0]?.status).toBe("proposed");
    expect(rows[0]?.revision).toBe(1);
  });
});
