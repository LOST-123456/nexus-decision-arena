import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { runMigrations } from "../migrate";
import {
  assertDisposableDatabaseName,
  createTestAdminDatabase,
  createTestDatabaseForUrl,
  resolveTestDatabaseUrl
} from "../testing/test-database";
import { ClaimExtractionRepository } from "./claim-extraction-repository";

/**
 * The candidate tables, proved against a real PostgreSQL rather than a stub.
 *
 * Two claims are being made here, and both matter to the separation the whole
 * feature rests on:
 *  1. The migration lands the tables with closed value sets (a database that
 *     accepts a fourth locator state would quietly break the UI's assumptions),
 *     one-row-per-question uniqueness, and a down script that clears the
 *     ledger so the migration can really be re-applied.
 *  2. Ruling on candidates writes only candidates. After accepting and
 *     rejecting, the domain tables hold exactly what they held before — because
 *     promotion is supposed to happen through the ordinary claim and evidence
 *     endpoints, not here.
 *
 * Runs only against a dedicated test database: the guard refuses before
 * connecting when TEST_DATABASE_URL is missing or points anywhere unsafe.
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

async function freshMigratedDatabase(): Promise<{
  database: TestDatabase;
}> {
  const databaseName = `nexus_migration_${newId().replaceAll("-", "")}`;
  await admin.execute(`CREATE DATABASE "${databaseName}"`);
  createdDatabases.push(databaseName);
  const database = createTestDatabaseForUrl(tempDatabaseUrl(databaseName));
  const applied = (await runMigrations(database, resolve("migrations"))).applied;
  expect(applied).toContain("0008_claim_candidate_extraction.sql");
  return { database };
}

async function seedSession(database: TestDatabase): Promise<string> {
  const projectId = newId();
  const sessionId = newId();
  await database.execute(
    sql.raw(
      `INSERT INTO projects (id, name, input) VALUES ('${projectId}', 'migration', '{}'::jsonb)`
    )
  );
  await database.execute(
    sql.raw(`
      INSERT INTO decision_sessions (id, project_id, locale, phase, operational_status, next_event_sequence)
      VALUES ('${sessionId}', '${projectId}', 'zh-CN', 'CREATED', 'ACTIVE', 1)
    `)
  );
  return sessionId;
}

async function seedSource(database: TestDatabase, sessionId: string): Promise<string> {
  const sourceId = newId();
  await database.execute(
    sql.raw(`
      INSERT INTO sources (id, session_id, title, kind, url, canonical_url, created_by)
      VALUES ('${sourceId}', '${sessionId}', 'Report', 'url', 'https://example.test/a', 'https://example.test/a', 'human')
    `)
  );
  return sourceId;
}

async function seedSnapshot(
  database: TestDatabase,
  sessionId: string,
  sourceId: string
): Promise<string> {
  const snapshotId = newId();
  await database.execute(
    sql.raw(`
      INSERT INTO source_snapshots
        (id, session_id, source_id, canonical_url, content_hash, content_type, content, content_bytes, char_count, retrieved_at)
      VALUES ('${snapshotId}', '${sessionId}', '${sourceId}', 'https://example.test/a',
              'hash-1', 'text/plain', 'Shipments grew 12%.', 100, 20, now())
    `)
  );
  return snapshotId;
}

async function seedClaim(database: TestDatabase, sessionId: string): Promise<string> {
  const claimId = newId();
  const now = new Date().toISOString();
  await database.execute(
    sql.raw(`
      INSERT INTO claims (id, session_id, lens, statement, type, stance, importance, confidence,
                          evidence_ids, status, root_claim_id, revision, relations, created_at, updated_at)
      VALUES ('${claimId}', '${sessionId}', 'research', 'Shipments grew.', 'fact', 'support',
              3, 0.5, '[]'::jsonb, 'proposed', '${claimId}', 1, '[]'::jsonb, '${now}', '${now}')
    `)
  );
  return claimId;
}

function runRow(input: {
  sessionId: string;
  sourceId: string;
  snapshotId: string;
  inputHash: string;
}) {
  const now = new Date().toISOString();
  return {
    id: newId(),
    sessionId: input.sessionId,
    sourceId: input.sourceId,
    snapshotId: input.snapshotId,
    status: "running" as const,
    provider: "FakeProvider",
    model: "fake-model",
    inputHash: input.inputHash,
    promptVersion: "claim-extraction-v1",
    segmentationVersion: "paragraph-v1",
    charCount: 20,
    segmentCount: 1,
    candidateClaimCount: 0,
    candidateEvidenceCount: 0,
    anchorMatched: 0,
    anchorMissing: 0,
    attempt: 1,
    correlationId: newId(),
    createdBy: "human",
    startedAt: now,
    createdAt: now,
    updatedAt: now
  };
}

describe("0008 claim candidate extraction migration", () => {
  it("creates the candidate tables and can be rolled back and re-applied", async () => {
    const { database } = await freshMigratedDatabase();

    expect(await tableExists(database, "claim_extraction_runs")).toBe(true);
    expect(await tableExists(database, "claim_candidates")).toBe(true);
    expect(await tableExists(database, "evidence_candidates")).toBe(true);

    // Roll back. Any migration newer than 0008 would have to go first, but 0008
    // is the head here, so the inverse has everything it needs.
    for (const statement of await statements(
      "rollback/0008_claim_candidate_extraction.down.sql"
    )) {
      await database.execute(sql.raw(statement));
    }
    expect(await tableExists(database, "claim_extraction_runs")).toBe(false);
    expect(await tableExists(database, "claim_candidates")).toBe(false);
    expect(await tableExists(database, "evidence_candidates")).toBe(false);

    // The ledger row went too, otherwise the next migrate would skip it.
    expect(await ledger(database)).not.toContain("0008_claim_candidate_extraction.sql");

    const reApplied = await runMigrations(database, resolve("migrations"));
    expect(reApplied.applied).toContain("0008_claim_candidate_extraction.sql");
    expect(await tableExists(database, "claim_candidates")).toBe(true);
  });

  it("keeps the candidate value sets closed in the database, not only in Zod", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId);
    const snapshotId = await seedSnapshot(database, sessionId, sourceId);

    await expect(
      database.execute(
        sql.raw(`
          INSERT INTO claim_extraction_runs
            (id, session_id, source_id, snapshot_id, status, provider, model, input_hash,
             prompt_version, segmentation_version, correlation_id, created_by, started_at)
          VALUES ('${newId()}', '${sessionId}', '${sourceId}', '${snapshotId}',
                  'pretty-good', 'Fake', 'fake', 'hash', 'v1', 'v1', '${newId()}', 'human', now())
        `)
      )
    ).rejects.toThrow();

    await expect(
      database.execute(
        sql.raw(`
          INSERT INTO evidence_candidates
            (id, session_id, run_id, source_id, snapshot_id, segment_index, claim_candidate_id,
             excerpt, title, direction, locator_kind, locator_status, rationale, uncertainty)
          VALUES ('${newId()}', '${sessionId}', '${newId()}', '${sourceId}', '${snapshotId}',
                  0, '${newId()}', 'quote', 'title', 'supports', 'quote', 'sort-of', 'because', '[]'::jsonb)
        `)
      )
    ).rejects.toThrow();
  });
});

describe("ClaimExtractionRepository", () => {
  it("stores one answer per question and reuses it on a repeated request", async () => {
    const { database } = await freshMigratedDatabase();
    const repository = new ClaimExtractionRepository(database);
    const sessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId);
    const snapshotId = await seedSnapshot(database, sessionId, sourceId);

    const run = runRow({ sessionId, sourceId, snapshotId, inputHash: "hash-a" });
    await repository.createRun({
      run,
      event: {
        correlationId: run.correlationId,
        type: "CLAIM_EXTRACTION_STARTED",
        payload: { extractionRunId: run.id }
      }
    });

    const found = await repository.findReusableRun({
      sessionId,
      sourceId,
      snapshotId,
      inputHash: "hash-a"
    });
    expect(found?.id).toBe(run.id);
    expect(
      await repository.findReusableRun({
        sessionId,
        sourceId,
        snapshotId,
        inputHash: "hash-b"
      })
    ).toBeNull();

    // The same question cannot be stored twice.
    await expect(
      repository.createRun({
        run: { ...run, id: newId() },
        event: {
          correlationId: run.correlationId,
          type: "CLAIM_EXTRACTION_STARTED",
          payload: {}
        }
      })
    ).rejects.toThrow();
  });

  it("writes candidates and locates them only because the server decided so", async () => {
    const { database } = await freshMigratedDatabase();
    const repository = new ClaimExtractionRepository(database);
    const sessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId);
    const snapshotId = await seedSnapshot(database, sessionId, sourceId);
    const run = runRow({ sessionId, sourceId, snapshotId, inputHash: "hash-c" });
    await repository.createRun({
      run,
      event: {
        correlationId: run.correlationId,
        type: "CLAIM_EXTRACTION_STARTED",
        payload: {}
      }
    });

    const claimId = newId();
    const stored = await repository.replaceCandidates({
      runId: run.id,
      sessionId,
      sourceId,
      snapshotId,
      claims: [
        {
          id: claimId,
          segmentIndex: 0,
          statement: "Shipments grew 12%.",
          type: "fact",
          qualifiers: ["year over year"],
          uncertainty: [],
          rationale: "Stated plainly.",
          suggestedImportance: 3,
          status: "proposed"
        }
      ],
      evidence: [
        {
          id: newId(),
          claimCandidateId: claimId,
          segmentIndex: 0,
          excerpt: "Shipments grew 12%.",
          title: "Growth",
          direction: "supports",
          locatorKind: "quote",
          locatorStatus: "anchored",
          locator: "第 1 段 · 第 1 句",
          anchorText: "Shipments grew 12%.",
          sourceContentHash: "hash-1",
          suggestedReliability: 0.5,
          rationale: "Same sentence.",
          uncertainty: [],
          status: "proposed"
        },
        {
          id: newId(),
          claimCandidateId: claimId,
          segmentIndex: 0,
          excerpt: "Nothing like this appears in the page.",
          title: "Invented",
          direction: "supports",
          locatorKind: "quote",
          locatorStatus: "missing",
          locator: "无法在原文中定位",
          anchorText: "Nothing like this appears in the page.",
          sourceContentHash: "hash-1",
          suggestedReliability: 0.2,
          rationale: "Asserted without support.",
          uncertainty: [],
          status: "proposed"
        }
      ],
      event: {
        correlationId: run.correlationId,
        type: "CLAIM_EXTRACTION_COMPLETED",
        payload: {}
      }
    });

    expect(stored.claims).toHaveLength(1);
    expect(stored.evidence).toHaveLength(2);
    const runAfter = await repository.getRun(sessionId, run.id);
    expect(runAfter?.status).toBe("succeeded");
    expect(runAfter?.anchorMatched).toBe(1);
    expect(runAfter?.anchorMissing).toBe(1);

    // Re-running replaces rather than accumulating.
    await repository.replaceCandidates({
      runId: run.id,
      sessionId,
      sourceId,
      snapshotId,
      claims: [
        {
          id: newId(),
          segmentIndex: 0,
          statement: "Still one claim.",
          type: "fact",
          qualifiers: [],
          uncertainty: [],
          rationale: "Reason.",
          suggestedImportance: 3,
          status: "proposed"
        }
      ],
      evidence: [],
      event: {
        correlationId: run.correlationId,
        type: "CLAIM_EXTRACTION_COMPLETED",
        payload: {}
      }
    });
    const second = await repository.listCandidatesByRun(sessionId, run.id);
    expect(second.claims).toHaveLength(1);
    expect(second.evidence).toHaveLength(0);
  });

  it("records a failure with the code the interface promises", async () => {
    const { database } = await freshMigratedDatabase();
    const repository = new ClaimExtractionRepository(database);
    const sessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId);
    const snapshotId = await seedSnapshot(database, sessionId, sourceId);
    const run = runRow({ sessionId, sourceId, snapshotId, inputHash: "hash-d" });
    await repository.createRun({
      run,
      event: {
        correlationId: run.correlationId,
        type: "CLAIM_EXTRACTION_STARTED",
        payload: {}
      }
    });

    await repository.failRun({
      sessionId,
      runId: run.id,
      failureCode: "timeout",
      failureMessage: "模型响应超时",
      event: {
        correlationId: run.correlationId,
        type: "CLAIM_EXTRACTION_FAILED",
        payload: { failureCode: "timeout" }
      }
    });

    const stored = await repository.getRun(sessionId, run.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.failureCode).toBe("timeout");

    await repository.markAttemptStarted({ sessionId, runId: run.id, attempt: 2 });
    const retried = await repository.getRun(sessionId, run.id);
    expect(retried?.status).toBe("running");
    expect(retried?.attempt).toBe(2);
    // A stale reason must not survive into an attempt that has not failed yet.
    expect(retried?.failureCode).toBeUndefined();
    expect(retried?.failureMessage).toBeUndefined();
  });

  it("ruling on candidates writes candidates and nothing into the domain", async () => {
    const { database } = await freshMigratedDatabase();
    const repository = new ClaimExtractionRepository(database);
    const sessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId);
    const snapshotId = await seedSnapshot(database, sessionId, sourceId);
    const run = runRow({ sessionId, sourceId, snapshotId, inputHash: "hash-e" });
    await repository.createRun({
      run,
      event: {
        correlationId: run.correlationId,
        type: "CLAIM_EXTRACTION_STARTED",
        payload: {}
      }
    });

    const claimId = newId();
    const stored = await repository.replaceCandidates({
      runId: run.id,
      sessionId,
      sourceId,
      snapshotId,
      claims: [
        {
          id: claimId,
          segmentIndex: 0,
          statement: "A.",
          type: "fact",
          qualifiers: [],
          uncertainty: [],
          rationale: "R.",
          suggestedImportance: 3,
          status: "proposed"
        },
        {
          id: newId(),
          segmentIndex: 0,
          statement: "B.",
          type: "fact",
          qualifiers: [],
          uncertainty: [],
          rationale: "R.",
          suggestedImportance: 3,
          status: "proposed"
        }
      ],
      evidence: [],
      event: {
        correlationId: run.correlationId,
        type: "CLAIM_EXTRACTION_COMPLETED",
        payload: {}
      }
    });

    // An accepted candidate may only point at a claim that really exists: the
    // foreign key says so, so the link can never dangle.
    const existingClaimId = await seedClaim(database, sessionId);

    const claimsBefore = await countRows(database, "claims");
    const evidenceBefore = await countRows(database, "evidence");

    const decided = await repository.recordDecisions({
      sessionId,
      runId: run.id,
      decisions: [
        {
          candidateId: stored.claims[0]!.id,
          kind: "claim",
          status: "accepted",
          createdClaimId: existingClaimId
        },
        {
          candidateId: stored.claims[1]!.id,
          kind: "claim",
          status: "rejected"
        }
      ],
      decidedBy: "Researcher One (researcher)",
      event: {
        correlationId: run.correlationId,
        type: "CLAIM_CANDIDATES_DECIDED",
        payload: {}
      }
    });

    expect(decided.claims.find((item) => item.id === stored.claims[0]!.id)?.status).toBe(
      "accepted"
    );
    expect(decided.claims.find((item) => item.id === stored.claims[1]!.id)?.status).toBe(
      "rejected"
    );

    // The point of the whole separation: the ruling recorded itself, and no
    // claim or excerpt was created, accepted or otherwise.
    expect(await countRows(database, "claims")).toBe(claimsBefore);
    expect(await countRows(database, "evidence")).toBe(evidenceBefore);
  });

  it("refuses to rule on a candidate outside its own session", async () => {
    const { database } = await freshMigratedDatabase();
    const repository = new ClaimExtractionRepository(database);
    const sessionId = await seedSession(database);
    const otherSessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId);
    const snapshotId = await seedSnapshot(database, sessionId, sourceId);
    const run = runRow({ sessionId, sourceId, snapshotId, inputHash: "hash-f" });
    await repository.createRun({
      run,
      event: {
        correlationId: run.correlationId,
        type: "CLAIM_EXTRACTION_STARTED",
        payload: {}
      }
    });

    const foreignClaimId = newId();
    await repository.replaceCandidates({
      runId: run.id,
      sessionId,
      sourceId,
      snapshotId,
      claims: [
        {
          id: foreignClaimId,
          segmentIndex: 0,
          statement: "Owned by this session.",
          type: "fact",
          qualifiers: [],
          uncertainty: [],
          rationale: "R.",
          suggestedImportance: 3,
          status: "proposed"
        }
      ],
      evidence: [],
      event: {
        correlationId: run.correlationId,
        type: "CLAIM_EXTRACTION_COMPLETED",
        payload: {}
      }
    });

    await expect(
      repository.recordDecisions({
        sessionId: otherSessionId,
        runId: run.id,
        decisions: [
          {
            candidateId: foreignClaimId,
            kind: "claim",
            status: "rejected"
          }
        ],
        decidedBy: "Intruder",
        event: {
          correlationId: run.correlationId,
          type: "CLAIM_CANDIDATES_DECIDED",
          payload: {}
        }
      })
    ).rejects.toThrow(/Candidate not found/);

    const untouched = await repository.listCandidatesByRun(sessionId, run.id);
    expect(untouched.claims[0]!.status).toBe("proposed");
  });
});
