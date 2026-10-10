import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { newId, type CitationIntegrityStatus } from "@nexus/shared";
import { runMigrations } from "../migrate";
import {
  assertDisposableDatabaseName,
  createTestAdminDatabase,
  createTestDatabaseForUrl,
  resolveTestDatabaseUrl
} from "../testing/test-database";
import { CitationReviewRepository } from "./citation-review-repository";

/**
 * The citation tables, proved against a real PostgreSQL.
 *
 * Three claims are being made:
 *  1. The migration lands closed value sets, one current row per subject
 *     (enforced by a partial unique index, not by convention), and a down
 *     script that clears the ledger so it can really be re-applied.
 *  2. A correction adds a record. The superseded row keeps its status, its
 *     author and its timestamp — the audit trail cannot be rewritten.
 *  3. None of this writes to `evidence`. A support assessment is advice: the
 *     excerpt's own verification status is untouched by anything here.
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

async function freshMigratedDatabase(): Promise<{ database: TestDatabase }> {
  const databaseName = `nexus_migration_${newId().replaceAll("-", "")}`;
  await admin.execute(`CREATE DATABASE "${databaseName}"`);
  createdDatabases.push(databaseName);
  const database = createTestDatabaseForUrl(tempDatabaseUrl(databaseName));
  const applied = (await runMigrations(database, resolve("migrations"))).applied;
  expect(applied).toContain("0009_citation_review.sql");
  return { database };
}

type Seeded = {
  sessionId: string;
  sourceId: string;
  snapshotId: string;
  claimId: string;
  evidenceId: string;
};

async function seed(database: TestDatabase): Promise<Seeded> {
  const projectId = newId();
  const sessionId = newId();
  const sourceId = newId();
  const snapshotId = newId();
  const claimId = newId();
  const evidenceId = newId();
  const now = new Date().toISOString();

  await database.execute(
    sql.raw(
      `INSERT INTO projects (id, name, input) VALUES ('${projectId}', 'citation', '{}'::jsonb)`
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
      VALUES ('${sourceId}', '${sessionId}', 'Report', 'url', 'https://example.test/a',
              'https://example.test/a', 'human')
    `)
  );
  await database.execute(
    sql.raw(`
      INSERT INTO source_snapshots
        (id, session_id, source_id, canonical_url, content_hash, content_type, content, content_bytes, char_count, retrieved_at)
      VALUES ('${snapshotId}', '${sessionId}', '${sourceId}', 'https://example.test/a',
              'hash-1', 'text/plain', 'Shipments grew 12%.', 100, 20, now())
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
         locator, locator_kind, locator_status, anchor_text, source_content_hash,
         direction, reliability, verification_status, retrieved_at, created_by)
      VALUES ('${evidenceId}', '${sessionId}', '["${claimId}"]'::jsonb, 'external_reference',
              'Annual report', 'Shipments grew 12%.', 'quoted', '${sourceId}',
              '第 1 段', 'quote', 'anchored', 'Shipments grew 12%.', 'hash-1',
              'supports', 0.8, 'unverified', '${now}', 'human')
    `)
  );

  return { sessionId, sourceId, snapshotId, claimId, evidenceId };
}

function integrityCheck(input: {
  evidenceId: string;
  status: CitationIntegrityStatus;
  sourceId: string;
  snapshotId: string;
}) {
  return {
    id: newId(),
    evidenceId: input.evidenceId,
    sourceId: input.sourceId,
    snapshotId: input.snapshotId,
    status: input.status,
    matchKind: "exact" as const,
    anchorText: "Shipments grew 12%.",
    expectedContentHash: "hash-1",
    snapshotContentHash: "hash-1",
    matchedText: "Shipments grew 12%.",
    contextText: "… Shipments grew 12%. …",
    reason: `check says ${input.status}`,
    origin: "system" as const,
    actor: "Researcher One (researcher)"
  };
}

describe("0009 citation review migration", () => {
  it("creates the tables, closes the value sets, and can be rolled back", async () => {
    const { database } = await freshMigratedDatabase();
    expect(await tableExists(database, "citation_integrity_checks")).toBe(true);
    expect(await tableExists(database, "claim_support_assessments")).toBe(true);

    for (const statement of await statements(
      "rollback/0009_citation_review.down.sql"
    )) {
      await database.execute(sql.raw(statement));
    }
    expect(await tableExists(database, "citation_integrity_checks")).toBe(false);
    expect(await tableExists(database, "claim_support_assessments")).toBe(false);
    expect(await ledger(database)).not.toContain("0009_citation_review.sql");

    const reapplied = (await runMigrations(database, resolve("migrations")))
      .applied;
    expect(reapplied).toContain("0009_citation_review.sql");
  });

  it("refuses an integrity status outside the closed set", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    await expect(
      database.execute(
        sql.raw(`
          INSERT INTO citation_integrity_checks
            (id, session_id, evidence_id, status, reason, origin, actor)
          VALUES ('${newId()}', '${seeded.sessionId}', '${seeded.evidenceId}',
                  'probably-fine', 'invented state', 'system', 'human')
        `)
      )
    ).rejects.toThrow();
  });

  it("refuses an assessment status outside the closed set", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    await expect(
      database.execute(
        sql.raw(`
          INSERT INTO claim_support_assessments
            (id, session_id, claim_id, evidence_id, status, rationale, prompt_version, origin, actor)
          VALUES ('${newId()}', '${seeded.sessionId}', '${seeded.claimId}', '${seeded.evidenceId}',
                  'verified', 'model tried to verify', 'v1', 'model', 'human')
        `)
      )
    ).rejects.toThrow();
  });

  it("allows only one current check per excerpt", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    const insert = (status: CitationIntegrityStatus) =>
      database.execute(
        sql.raw(`
          INSERT INTO citation_integrity_checks
            (id, session_id, evidence_id, status, reason, origin, actor, is_current)
          VALUES ('${newId()}', '${seeded.sessionId}', '${seeded.evidenceId}',
                  '${status}', 'why', 'system', 'human', true)
        `)
      );

    await insert("anchored");
    // A second "current" answer for the same excerpt is rejected by the partial
    // unique index, not merely by agreement between callers.
    await expect(insert("missing")).rejects.toThrow();
    const total = await countRows(database, "citation_integrity_checks");
    expect(total).toBe(1);
  });
});

describe("CitationReviewRepository", () => {
  it("keeps the earlier conclusion when a correction arrives", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    const repository = new CitationReviewRepository(database);

    const first = await repository.recordIntegrityChecks({
      sessionId: seeded.sessionId,
      checks: [
        integrityCheck({
          evidenceId: seeded.evidenceId,
          status: "anchored",
          sourceId: seeded.sourceId,
          snapshotId: seeded.snapshotId
        })
      ],
      event: {
        correlationId: newId(),
        type: "CITATION_INTEGRITY_CHECKED",
        payload: { checked: 1 }
      }
    });
    const original = first.checks[0]!;
    expect(original.status).toBe("anchored");
    expect(original.isCurrent).toBe(true);

    const corrected = await repository.correctIntegrity({
      sessionId: seeded.sessionId,
      targetId: original.id,
      newId: newId(),
      status: "partial",
      rationale: "The quote is elided and the middle does not resolve.",
      actor: "Reviewer Two (reviewer)",
      event: {
        correlationId: newId(),
        type: "CITATION_CORRECTION_RECORDED",
        payload: { previousStatus: "anchored" }
      }
    });
    expect(corrected.check.status).toBe("partial");
    expect(corrected.check.origin).toBe("human");
    expect(corrected.check.supersedesId).toBe(original.id);

    const history = await repository.listIntegrityHistory(
      seeded.sessionId,
      seeded.evidenceId
    );
    expect(history).toHaveLength(2);
    const superseded = history.find((item) => item.id === original.id)!;
    // Nothing about the earlier conclusion moved except its pointer.
    expect(superseded.status).toBe("anchored");
    expect(superseded.reason).toBe("check says anchored");
    expect(superseded.actor).toBe("Researcher One (researcher)");
    expect(superseded.isCurrent).toBe(false);

    const current = await repository.listCurrentIntegrity(seeded.sessionId);
    expect(current).toHaveLength(1);
    expect(current[0]!.id).toBe(corrected.check.id);
  });

  it("replaces the current assessment of the same pair, keeping the old one", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    const repository = new CitationReviewRepository(database);

    const assess = (status: "support" | "oppose", actor: string) => ({
      id: newId(),
      claimId: seeded.claimId,
      evidenceId: seeded.evidenceId,
      status,
      confidence: 0.5,
      rationale: `${status} because the excerpt says so`,
      matchedExcerpt: "Shipments grew 12%.",
      matchedExcerptLocated: true,
      signals: [] as string[],
      provider: "FakeProvider",
      model: "fake-model",
      promptVersion: "citation-review-v1",
      origin: "model" as const,
      actor
    });

    await repository.recordAssessments({
      sessionId: seeded.sessionId,
      assessments: [assess("support", "Researcher One (researcher)")],
      event: {
        correlationId: newId(),
        type: "SUPPORT_ASSESSMENT_RECORDED",
        payload: { assessed: 1 }
      }
    });
    await repository.recordAssessments({
      sessionId: seeded.sessionId,
      assessments: [assess("oppose", "Researcher One (researcher)")],
      event: {
        correlationId: newId(),
        type: "SUPPORT_ASSESSMENT_RECORDED",
        payload: { assessed: 1 }
      }
    });

    const history = await repository.listAssessmentHistory(
      seeded.sessionId,
      seeded.claimId,
      seeded.evidenceId
    );
    expect(history.map((item) => item.status)).toEqual(["support", "oppose"]);
    expect(history[0]!.isCurrent).toBe(false);
    expect(history[1]!.isCurrent).toBe(true);
    expect(history[1]!.supersedesId).toBe(history[0]!.id);

    const current = await repository.listAssessmentsForClaim(
      seeded.sessionId,
      seeded.claimId
    );
    expect(current).toHaveLength(1);
    expect(current[0]!.status).toBe("oppose");
    // The confidence survives the round trip as a number, not a string.
    expect(typeof current[0]!.confidence).toBe("number");
  });

  it("never changes the evidence row it is describing", async () => {
    const { database } = await freshMigratedDatabase();
    const seeded = await seed(database);
    const repository = new CitationReviewRepository(database);

    const before = (await database.execute(
      sql.raw(
        `select verification_status, locator_status from evidence where id = '${seeded.evidenceId}'`
      )
    )) as unknown as Array<{
      verification_status: string;
      locator_status: string;
    }>;

    const check = await repository.recordIntegrityChecks({
      sessionId: seeded.sessionId,
      checks: [
        integrityCheck({
          evidenceId: seeded.evidenceId,
          status: "missing",
          sourceId: seeded.sourceId,
          snapshotId: seeded.snapshotId
        })
      ],
      event: {
        correlationId: newId(),
        type: "CITATION_INTEGRITY_CHECKED",
        payload: {}
      }
    });
    await repository.recordAssessments({
      sessionId: seeded.sessionId,
      assessments: [
        {
          id: newId(),
          claimId: seeded.claimId,
          evidenceId: seeded.evidenceId,
          status: "oppose",
          rationale: "The excerpt contradicts the claim as stated.",
          matchedExcerptLocated: false,
          promptVersion: "citation-review-v1",
          origin: "model",
          actor: "Researcher One (researcher)"
        }
      ],
      event: {
        correlationId: newId(),
        type: "SUPPORT_ASSESSMENT_RECORDED",
        payload: {}
      }
    });

    const after = (await database.execute(
      sql.raw(
        `select verification_status, locator_status from evidence where id = '${seeded.evidenceId}'`
      )
    )) as unknown as Array<{
      verification_status: string;
      locator_status: string;
    }>;

    expect(check.checks[0]!.status).toBe("missing");
    expect(after[0]).toEqual(before[0]);
    expect(after[0]!.verification_status).toBe("unverified");
  });
});
