import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { newId, type SourceProvenanceKind, type SourceRelationKind } from "@nexus/shared";
import { runMigrations } from "../migrate";
import {
  assertDisposableDatabaseName,
  createTestAdminDatabase,
  createTestDatabaseForUrl,
  resolveTestDatabaseUrl
} from "../testing/test-database";
import { SourceIndependenceRepository } from "./source-independence-repository";

/**
 * The independence tables, proved against a real PostgreSQL.
 *
 *  1. The migration lands closed value sets and a partial unique index that
 *     enforces "one current statement per pair" in the database, not by
 *     agreement between callers; and the down script clears the ledger so it
 *     can really be re-applied.
 *  2. A correction adds a record. The superseded row keeps its kind, author and
 *     timestamp — an assertion cannot be rewritten.
 *  3. None of this writes to `sources` or `evidence`. Independence informs a
 *     reader; it never promotes a source or an excerpt.
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
  const contents = await readFile(resolve("migrations", ...file.split("/")), "utf8");
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

async function countRows(database: TestDatabase, table: string): Promise<number> {
  const rows = (await database.execute(
    sql.raw(`select count(*)::int as total from public.${table}`)
  )) as unknown as Array<{ total: number }>;
  return rows[0]?.total ?? -1;
}

/**
 * Rolls back every migration applied after `filename`, newest first, so the
 * 0010 down script is exercised while 0010 is the head. The list comes from the
 * ledger, so adding a later migration does not silently invalidate this test.
 */
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
  expect(applied).toContain("0010_source_independence.sql");
  return { database };
}

type Seeded = {
  sessionId: string;
  firstSourceId: string;
  secondSourceId: string;
  evidenceId: string;
};

async function seed(database: TestDatabase): Promise<Seeded> {
  const projectId = newId();
  const sessionId = newId();
  const firstSourceId = newId();
  const secondSourceId = newId();
  const claimId = newId();
  const evidenceId = newId();
  const now = new Date().toISOString();

  await database.execute(
    sql.raw(
      `INSERT INTO projects (id, name, input) VALUES ('${projectId}', 'independence', '{}'::jsonb)`
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
      INSERT INTO sources (id, session_id, title, kind, url, canonical_url, created_by)
      VALUES
        ('${firstSourceId}', '${sessionId}', 'Original', 'url', 'https://origin.test/a',
         'https://origin.test/a', 'human'),
        ('${secondSourceId}', '${sessionId}', 'Mirror', 'url', 'https://mirror.test/b',
         'https://mirror.test/b', 'human')
    `)
  );
  await database.execute(
    sql.raw(`
      INSERT INTO claims (id, session_id, lens, statement, type, stance, importance, confidence,
                          evidence_ids, status, root_claim_id, revision, relations, created_at, updated_at)
      VALUES ('${claimId}', '${sessionId}', 'research', 'Shipments grew 12%.', 'fact', 'support',
              3, 0.5, '[]'::jsonb, 'proposed', '${claimId}', 1, '[]'::jsonb, '${now}', '${now}')
    `)
  );
  await database.execute(
    sql.raw(`
      INSERT INTO evidence
        (id, session_id, claim_ids, kind, title, content, description, source_id,
         direction, reliability, verification_status, retrieved_at, created_by)
      VALUES ('${evidenceId}', '${sessionId}', '["${claimId}"]'::jsonb, 'external_reference',
              'Annual report', 'Shipments grew 12%.', 'quoted', '${firstSourceId}',
              'supports', 0.8, 'unverified', '${now}', 'human')
    `)
  );

  return { sessionId, firstSourceId, secondSourceId, evidenceId };
}

function relationInput(input: {
  sessionId: string;
  fromSourceId: string;
  toSourceId: string;
  kind: SourceRelationKind;
  actor?: string;
}) {
  return {
    id: newId(),
    sessionId: input.sessionId,
    fromSourceId: input.fromSourceId,
    toSourceId: input.toSourceId,
    kind: input.kind,
    basis: "human_assertion" as const,
    similarity: null,
    reason: `Editor says these are ${input.kind}.`,
    origin: "human" as const,
    actor: input.actor ?? "Researcher One (researcher)"
  };
}

describe("0010 source independence migration", () => {
  it("creates the tables, closes the value sets, and can be rolled back", async () => {
    const { database } = await freshMigratedDatabase();
    expect(await tableExists(database, "source_relations")).toBe(true);
    expect(await tableExists(database, "source_profile_overrides")).toBe(true);

    await rollbackMigrationsAfter(database, "0010_source_independence.sql");
    for (const statement of await statements(
      "rollback/0010_source_independence.down.sql"
    )) {
      await database.execute(sql.raw(statement));
    }
    expect(await tableExists(database, "source_relations")).toBe(false);
    expect(await tableExists(database, "source_profile_overrides")).toBe(false);
    expect(await ledger(database)).not.toContain("0010_source_independence.sql");

    const reapplied = (await runMigrations(database, resolve("migrations")))
      .applied;
    expect(reapplied).toContain("0010_source_independence.sql");
  });

  it("refuses a relation kind outside the closed set", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    await expect(
      database.execute(
        sql.raw(`
          INSERT INTO source_relations
            (id, session_id, from_source_id, to_source_id, kind, basis, reason, origin, actor)
          VALUES ('${newId()}', '${seeded.sessionId}', '${seeded.firstSourceId}',
                  '${seeded.secondSourceId}', 'plagiarised', 'human_assertion',
                  'invented state', 'human', 'human')
        `)
      )
    ).rejects.toThrow();
  });

  it("refuses a source related to itself", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    await expect(
      database.execute(
        sql.raw(`
          INSERT INTO source_relations
            (id, session_id, from_source_id, to_source_id, kind, basis, reason, origin, actor)
          VALUES ('${newId()}', '${seeded.sessionId}', '${seeded.firstSourceId}',
                  '${seeded.firstSourceId}', 'same_page', 'canonical_url',
                  'self link', 'system', 'human')
        `)
      )
    ).rejects.toThrow();
  });

  it("allows only one current relation per pair", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    const insert = (kind: SourceRelationKind) =>
      database.execute(
        sql.raw(`
          INSERT INTO source_relations
            (id, session_id, from_source_id, to_source_id, kind, basis, reason, origin, actor, is_current)
          VALUES ('${newId()}', '${seeded.sessionId}', '${seeded.firstSourceId}',
                  '${seeded.secondSourceId}', '${kind}', 'human_assertion', 'why',
                  'human', 'human', true)
        `)
      );

    await insert("reprint");
    // A second "current" statement for the same pair is rejected by the partial
    // unique index, not merely by agreement between callers.
    await expect(insert("unrelated")).rejects.toThrow();
    expect(await countRows(database, "source_relations")).toBe(1);
  });
});

describe("SourceIndependenceRepository", () => {
  it("treats a reversed assertion as the same pair, keeping direction", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    const repository = new SourceIndependenceRepository(database);

    const first = await repository.recordRelation({
      sessionId: seeded.sessionId,
      relation: relationInput({
        sessionId: seeded.sessionId,
        fromSourceId: seeded.firstSourceId,
        toSourceId: seeded.secondSourceId,
        kind: "reprint"
      }),
      event: {
        correlationId: newId(),
        type: "SOURCE_RELATION_RECORDED",
        payload: { kind: "reprint" }
      }
    });
    expect(first.relation.isCurrent).toBe(true);

    // The same pair, asserted the other way round: that is a correction of the
    // same statement, not a second independent one.
    const second = await repository.recordRelation({
      sessionId: seeded.sessionId,
      relation: relationInput({
        sessionId: seeded.sessionId,
        fromSourceId: seeded.secondSourceId,
        toSourceId: seeded.firstSourceId,
        kind: "unrelated",
        actor: "Reviewer Two (reviewer)"
      }),
      event: {
        correlationId: newId(),
        type: "SOURCE_RELATION_RECORDED",
        payload: { kind: "unrelated" }
      }
    });
    expect(second.relation.supersedesId).toBe(first.relation.id);
    // Direction survives: the replacement says b -> a, and that is what is
    // stored, because a reprint/quote chain has to be readable.
    expect(second.relation.fromSourceId).toBe(seeded.secondSourceId);
    expect(second.relation.toSourceId).toBe(seeded.firstSourceId);

    const current = await repository.listCurrentRelations(seeded.sessionId);
    expect(current).toHaveLength(1);
    expect(current[0]!.kind).toBe("unrelated");

    const history = await repository.listRelationHistory(
      seeded.sessionId,
      seeded.firstSourceId,
      seeded.secondSourceId
    );
    expect(history).toHaveLength(2);
    const superseded = history.find((item) => item.id === first.relation.id)!;
    // Nothing about the earlier statement moved except its pointer.
    expect(superseded.kind).toBe("reprint");
    expect(superseded.actor).toBe("Researcher One (researcher)");
    expect(superseded.isCurrent).toBe(false);
  });

  it("refuses to relate a source from another session", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    const repository = new SourceIndependenceRepository(database);
    await expect(
      repository.recordRelation({
        sessionId: seeded.sessionId,
        relation: relationInput({
          sessionId: seeded.sessionId,
          fromSourceId: seeded.firstSourceId,
          toSourceId: newId(),
          kind: "reprint"
        }),
        event: {
          correlationId: newId(),
          type: "SOURCE_RELATION_RECORDED",
          payload: {}
        }
      })
    ).rejects.toThrow();
  });

  it("keeps the earlier override when a profile kind is corrected", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    const repository = new SourceIndependenceRepository(database);

    const override = (kind: SourceProvenanceKind, actor: string) => ({
      id: newId(),
      sessionId: seeded.sessionId,
      sourceId: seeded.firstSourceId,
      provenanceKind: kind,
      note: `Editor ruled it ${kind}.`,
      origin: "human" as const,
      actor
    });

    const first = await repository.recordProfileOverride({
      sessionId: seeded.sessionId,
      override: override("primary", "Researcher One (researcher)"),
      event: {
        correlationId: newId(),
        type: "SOURCE_PROFILE_OVERRIDDEN",
        payload: {}
      }
    });
    const second = await repository.recordProfileOverride({
      sessionId: seeded.sessionId,
      override: override("secondary", "Reviewer Two (reviewer)"),
      event: {
        correlationId: newId(),
        type: "SOURCE_PROFILE_OVERRIDDEN",
        payload: {}
      }
    });
    expect(second.override.supersedesId).toBe(first.override.id);

    const current = await repository.listCurrentProfileOverrides(seeded.sessionId);
    expect(current).toHaveLength(1);
    expect(current[0]!.provenanceKind).toBe("secondary");

    const history = await repository.listProfileOverrideHistory(
      seeded.sessionId,
      seeded.firstSourceId
    );
    expect(history).toHaveLength(2);
    expect(history.find((item) => item.id === first.override.id)!.provenanceKind).toBe(
      "primary"
    );
  });

  it("never changes the source or evidence rows it is describing", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    const repository = new SourceIndependenceRepository(database);

    const before = (await database.execute(
      sql.raw(
        `select retrieval_status, content_hash from sources where id = '${seeded.firstSourceId}'`
      )
    )) as unknown as Array<{ retrieval_status: string; content_hash: string | null }>;
    const evidenceBefore = (await database.execute(
      sql.raw(
        `select verification_status from evidence where id = '${seeded.evidenceId}'`
      )
    )) as unknown as Array<{ verification_status: string }>;

    await repository.recordRelation({
      sessionId: seeded.sessionId,
      relation: relationInput({
        sessionId: seeded.sessionId,
        fromSourceId: seeded.firstSourceId,
        toSourceId: seeded.secondSourceId,
        kind: "same_origin"
      }),
      event: {
        correlationId: newId(),
        type: "SOURCE_RELATION_RECORDED",
        payload: {}
      }
    });
    await repository.recordProfileOverride({
      sessionId: seeded.sessionId,
      override: {
        id: newId(),
        sessionId: seeded.sessionId,
        sourceId: seeded.firstSourceId,
        provenanceKind: "unknown",
        note: "Cannot determine.",
        origin: "human",
        actor: "Researcher One (researcher)"
      },
      event: {
        correlationId: newId(),
        type: "SOURCE_PROFILE_OVERRIDDEN",
        payload: {}
      }
    });

    const after = (await database.execute(
      sql.raw(
        `select retrieval_status, content_hash from sources where id = '${seeded.firstSourceId}'`
      )
    )) as unknown as Array<{ retrieval_status: string; content_hash: string | null }>;
    const evidenceAfter = (await database.execute(
      sql.raw(
        `select verification_status from evidence where id = '${seeded.evidenceId}'`
      )
    )) as unknown as Array<{ verification_status: string }>;

    expect(after).toEqual(before);
    expect(evidenceAfter).toEqual(evidenceBefore);
    expect(evidenceAfter[0]!.verification_status).toBe("unverified");
  });
});
