import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  newId,
  SourceSchema,
  SourceSnapshotSchema,
  type Source
} from "@nexus/shared";
import { runMigrations } from "../migrate";
import {
  assertDisposableDatabaseName,
  createTestAdminDatabase,
  createTestDatabaseForUrl,
  resolveTestDatabaseUrl
} from "../testing/test-database";
import { EvidenceRepository } from "./evidence-repository";
import {
  GrantAlreadyExistsError,
  LibraryDuplicateSourceError,
  SourceLibraryRepository,
  markCopyForked
} from "./source-library-repository";

/**
 * 0018 adds the cross-research library: recorded session ownership
 * (`decision_sessions.owner_user_id`), the share grants that widen visibility
 * (`source_share_grants`), and the lineage of a source copied into another
 * research (`source_copies`).
 *
 * What only a real database can prove here:
 *  1. the up migration lands both tables and the ownership column, and the
 *     documented down script really removes them and clears the ledger, so a
 *     later `db:migrate` re-applies instead of silently skipping;
 *  2. the rules are enforced by PostgreSQL, not only by Zod — an unknown
 *     subject type or scope, an anonymous or reasonless revocation, an unknown
 *     fork state, and a fork with no moment attached are all rejected;
 *  3. one *live* grant per (session, subject, scope): a duplicate is refused
 *     while the same pair becomes grantable again after revocation — the
 *     revoked row is kept, so the history is not rewritten;
 *  4. a copy is atomic and self-contained: the new source, its own snapshot,
 *     the lineage row and the target's audit event land together, a duplicate
 *     in the target refuses the whole write, and a re-capture forks the copy
 *     only when the text really differs;
 *  5. search only ever looks inside the session ids it is handed, and each
 *     filter narrows without inventing rows.
 *
 * Runs only against a dedicated test database: the guard refuses before
 * connecting when TEST_DATABASE_URL is missing or points anywhere unsafe.
 */
const databaseUrl = resolveTestDatabaseUrl().toString();
const admin = createTestAdminDatabase();

/** Every throwaway database this file creates is dropped in `afterAll`. */
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

async function columnExists(
  database: TestDatabase,
  table: string,
  column: string
): Promise<boolean> {
  const rows = (await database.execute(
    sql.raw(
      `select column_name from information_schema.columns
       where table_name = '${table}' and column_name = '${column}'`
    )
  )) as unknown as Array<{ column_name: string }>;
  return rows.length > 0;
}

async function ledger(database: TestDatabase): Promise<string[]> {
  const rows = (await database.execute(
    sql.raw("select filename from schema_migrations order by filename")
  )) as unknown as Array<{ filename: string }>;
  return rows.map((row) => row.filename);
}

/**
 * Rolls back every migration applied after `filename`, newest first.
 *
 * A down script only undoes its own migration, so it must not have to cope
 * with objects a later migration adds. The list comes from the ledger rather
 * than a hard-coded filename, so adding a migration does not silently
 * invalidate this test.
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
  expect(applied).toContain("0018_source_library.sql");
  return { database };
}

/** A session, optionally with a recorded owner. NULL models a legacy session. */
async function seedSession(
  database: TestDatabase,
  ownerUserId: string | null = null
): Promise<string> {
  const projectId = newId();
  const sessionId = newId();
  await database.execute(
    sql.raw(
      `INSERT INTO projects (id, name, input) VALUES ('${projectId}', 'source-library', '{}'::jsonb)`
    )
  );
  await database.execute(
    sql.raw(`
      INSERT INTO decision_sessions (id, project_id, locale, phase, operational_status, next_event_sequence, owner_user_id)
      VALUES ('${sessionId}', '${projectId}', 'zh-CN', 'EVIDENCE', 'ACTIVE', 1, ${
        ownerUserId === null ? "NULL" : `'${ownerUserId}'`
      })
    `)
  );
  return sessionId;
}

type SourceSeed = {
  sessionId: string;
  title: string;
  url: string;
  publisher?: string;
  author?: string;
  publishedAt?: string;
};

async function seedSource(
  repository: EvidenceRepository,
  seed: SourceSeed
): Promise<Source> {
  const now = new Date().toISOString();
  const source = SourceSchema.parse({
    id: newId(),
    sessionId: seed.sessionId,
    title: seed.title,
    kind: "url",
    url: seed.url,
    canonicalUrl: seed.url,
    ...(seed.publisher ? { publisher: seed.publisher } : {}),
    ...(seed.author ? { author: seed.author } : {}),
    ...(seed.publishedAt ? { publishedAt: seed.publishedAt } : {}),
    retrievalStatus: "not_requested",
    retrievalAttempts: 0,
    createdBy: "human",
    createdAt: now,
    updatedAt: now
  });
  await repository.createSource(source);
  return source;
}

async function seedSnapshot(
  repository: EvidenceRepository,
  source: Source,
  contentHash: string,
  content: string,
  sourceLanguage?: string
) {
  const now = new Date().toISOString();
  const snapshot = SourceSnapshotSchema.parse({
    id: newId(),
    sessionId: source.sessionId,
    sourceId: source.id,
    canonicalUrl: source.canonicalUrl ?? source.url ?? "",
    contentHash,
    title: source.title,
    contentType: "text/html; charset=utf-8",
    content,
    contentBytes: Buffer.byteLength(content),
    charCount: content.length,
    retrievedAt: now,
    ...(sourceLanguage ? { sourceLanguage } : {}),
    createdAt: now
  });
  await repository.recordRetrievalSuccess({
    snapshot,
    source: {},
    event: {
      correlationId: source.id,
      type: "SOURCE_RETRIEVED",
      payload: {}
    }
  });
  return snapshot;
}

function nullText(value: string | null): string {
  return value === null ? "NULL" : `'${value}'`;
}

/** One source_share_grants INSERT assembled from overrides. */
async function insertGrant(
  database: TestDatabase,
  sessionId: string,
  overrides: {
    subjectType?: string;
    subjectId?: string;
    scope?: string;
    revokedAt?: string | null;
    revokedBy?: string | null;
    revokeReason?: string | null;
  } = {}
): Promise<string> {
  const id = newId();
  await database.execute(
    sql.raw(`
      INSERT INTO source_share_grants (id, session_id, subject_type, subject_id, scope, granted_by,
                                       revoked_at, revoked_by, revoke_reason)
      VALUES ('${id}', '${sessionId}', '${overrides.subjectType ?? "user"}',
              '${overrides.subjectId ?? "user-2"}', '${overrides.scope ?? "read"}', 'Owner (owner)',
              ${nullText(overrides.revokedAt ?? null)},
              ${nullText(overrides.revokedBy ?? null)},
              ${nullText(overrides.revokeReason ?? null)})
    `)
  );
  return id;
}

/** One source_copies INSERT assembled from overrides. */
async function insertCopy(
  database: TestDatabase,
  input: {
    sessionId: string;
    sourceId: string;
    originSessionId: string;
    originSourceId: string;
  },
  overrides: {
    originSnapshotId?: string | null;
    originSnapshotHash?: string | null;
    forkState?: string;
    forkedAt?: string | null;
  } = {}
): Promise<string> {
  const id = newId();
  await database.execute(
    sql.raw(`
      INSERT INTO source_copies (id, session_id, source_id, origin_session_id, origin_source_id,
                                 origin_snapshot_id, origin_snapshot_hash, copied_by, fork_state, forked_at)
      VALUES ('${id}', '${input.sessionId}', '${input.sourceId}', '${input.originSessionId}',
              '${input.originSourceId}', ${nullText(overrides.originSnapshotId ?? null)},
              ${nullText(overrides.originSnapshotHash ?? null)}, 'Owner (owner)',
              '${overrides.forkState ?? "synced"}', ${nullText(overrides.forkedAt ?? null)})
    `)
  );
  return id;
}

/**
 * The Postgres error behind a rejected statement.
 *
 * A failed `execute` surfaces the driver error itself, whose `code` is the
 * SQLSTATE and whose `constraint_name` names the rule that fired. `23514` is
 * a check violation and `23505` a unique violation; a literal Postgres cannot
 * even parse fails earlier with `22P02` and names no constraint. Telling them
 * apart is what proves the constraint itself is doing the rejecting.
 */
async function rejectedStatement(run: () => Promise<unknown>): Promise<{
  code: string | null;
  constraint: string | null;
}> {
  try {
    await run();
  } catch (error) {
    const pg = error as { code?: string; constraint_name?: string };
    return { code: pg.code ?? null, constraint: pg.constraint_name ?? null };
  }
  throw new Error("expected the statement to be rejected");
}

describe("0018 source library migration", () => {
  it("creates the tables and the ownership column, then rolls back and re-applies", async () => {
    const { database } = await freshMigratedDatabase();

    for (const table of ["source_share_grants", "source_copies"]) {
      expect(await tableExists(database, table)).toBe(true);
    }
    expect(await columnExists(database, "decision_sessions", "owner_user_id")).toBe(
      true
    );

    for (const statement of await statements(
      "rollback/0018_source_library.down.sql"
    )) {
      await database.execute(sql.raw(statement));
    }
    for (const table of ["source_share_grants", "source_copies"]) {
      expect(await tableExists(database, table)).toBe(false);
    }
    expect(await columnExists(database, "decision_sessions", "owner_user_id")).toBe(
      false
    );
    expect(await ledger(database)).not.toContain("0018_source_library.sql");

    const reapplied = (await runMigrations(database, resolve("migrations")))
      .applied;
    expect(reapplied).toContain("0018_source_library.sql");
    expect(await tableExists(database, "source_share_grants")).toBe(true);
    expect(await tableExists(database, "source_copies")).toBe(true);
    expect(await columnExists(database, "decision_sessions", "owner_user_id")).toBe(
      true
    );

    // A down script only undoes its own migration: rolling 0018 back through
    // the ledger (newest first) must leave the older migrations' down scripts
    // working, here proven with 0017's, whose tables 0018 points at.
    await rollbackMigrationsAfter(
      database,
      "0016_agent_runs_operations_center.sql"
    );
    expect(await tableExists(database, "source_copies")).toBe(false);
    for (const statement of await statements(
      "rollback/0017_multilingual_translations.down.sql"
    )) {
      await database.execute(sql.raw(statement));
    }
    expect(await tableExists(database, "translations")).toBe(false);
  });

  it("keeps the grant vocabulary closed and forces an attributed revocation", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database, "user-1");

    const subjectViolation = await rejectedStatement(() =>
      insertGrant(database, sessionId, { subjectType: "team" })
    );
    expect(subjectViolation.code).toBe("23514");
    expect(subjectViolation.constraint).toBe(
      "source_share_grants_subject_type_check"
    );

    const scopeViolation = await rejectedStatement(() =>
      insertGrant(database, sessionId, { scope: "write" })
    );
    expect(scopeViolation.code).toBe("23514");
    expect(scopeViolation.constraint).toBe("source_share_grants_scope_check");

    // "We revoked it" with nobody named is not an audit trail.
    const anonymousRevocation = await rejectedStatement(() =>
      insertGrant(database, sessionId, {
        revokedAt: new Date().toISOString(),
        revokedBy: null,
        revokeReason: "撤销"
      })
    );
    expect(anonymousRevocation.code).toBe("23514");
    expect(anonymousRevocation.constraint).toBe(
      "source_share_grants_revocation_attributed_check"
    );

    const reasonless = await rejectedStatement(() =>
      insertGrant(database, sessionId, {
        revokedAt: new Date().toISOString(),
        revokedBy: "Owner (owner)",
        revokeReason: null
      })
    );
    expect(reasonless.constraint).toBe(
      "source_share_grants_revocation_attributed_check"
    );

    // Control: valid text that is not a closed-set member still reaches the
    // check, which is what shows the rules above are not parser refusals.
    expect(subjectViolation.code).toBe("23514");
    expect(subjectViolation.constraint).not.toBeNull();

    await insertGrant(database, sessionId, {
      scope: "copy",
      revokedAt: new Date().toISOString(),
      revokedBy: "Owner (owner)",
      revokeReason: "研究已结束"
    });
    const rows = (await database.execute(
      sql.raw("select scope, revoked_by, revoke_reason from source_share_grants")
    )) as unknown as Array<{
      scope: string;
      revoked_by: string;
      revoke_reason: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scope).toBe("copy");
    // The revocation is recorded, not applied by deleting the row.
    expect(rows[0]?.revoked_by).toBe("Owner (owner)");
    expect(rows[0]?.revoke_reason).toBe("研究已结束");
  });

  it("allows one live grant per subject and scope, and re-grants after revocation", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database, "user-1");

    const grantId = await insertGrant(database, sessionId, { subjectId: "user-2" });

    const duplicate = await rejectedStatement(() =>
      insertGrant(database, sessionId, { subjectId: "user-2" })
    );
    expect(duplicate.code).toBe("23505");
    expect(duplicate.constraint).toBe("source_share_grants_live_idx");

    // A different scope is a different permission, so it is not a duplicate.
    await insertGrant(database, sessionId, { subjectId: "user-2", scope: "copy" });
    // A role grant is a different subject.
    await insertGrant(database, sessionId, {
      subjectType: "role",
      subjectId: "reviewer"
    });

    // Revoking frees the pair: the same grant can be issued again, and the
    // revoked row stays behind as history.
    await database.execute(
      sql.raw(
        `UPDATE source_share_grants SET revoked_at = now(), revoked_by = 'Owner (owner)',
         revoke_reason = '临时放开' WHERE id = '${grantId}'`
      )
    );
    await insertGrant(database, sessionId, { subjectId: "user-2" });

    const rows = (await database.execute(
      sql.raw(
        "select count(*)::int as total from source_share_grants where revoked_at is null"
      )
    )) as unknown as Array<{ total: number }>;
    expect(rows[0]?.total).toBe(3);
    const all = (await database.execute(
      sql.raw("select count(*)::int as total from source_share_grants")
    )) as unknown as Array<{ total: number }>;
    expect(all[0]?.total).toBe(4);
  });

  it("keeps the copy vocabulary closed and forces a moment when a copy forks", async () => {
    const { database } = await freshMigratedDatabase();
    const repository = new EvidenceRepository(database);
    const originSession = await seedSession(database, "user-1");
    const targetSession = await seedSession(database, "user-1");
    const origin = await seedSource(repository, {
      sessionId: originSession,
      title: "季度回顾",
      url: "https://example.org/q4"
    });
    const target = await seedSource(repository, {
      sessionId: targetSession,
      title: "季度回顾（副本）",
      url: "https://example.org/q4-copy"
    });

    const base = {
      sessionId: targetSession,
      sourceId: target.id,
      originSessionId: originSession,
      originSourceId: origin.id
    };

    const stateViolation = await rejectedStatement(() =>
      insertCopy(database, base, { forkState: "drifted" })
    );
    expect(stateViolation.code).toBe("23514");
    expect(stateViolation.constraint).toBe("source_copies_fork_state_check");

    // "Forked" with no moment is indistinguishable from silent drift.
    const forkedWithoutMoment = await rejectedStatement(() =>
      insertCopy(database, base, { forkState: "forked", forkedAt: null })
    );
    expect(forkedWithoutMoment.code).toBe("23514");
    expect(forkedWithoutMoment.constraint).toBe(
      "source_copies_fork_has_timestamp_check"
    );

    // The mirror image: a synced copy must not carry a fork moment.
    const syncedWithMoment = await rejectedStatement(() =>
      insertCopy(database, base, {
        forkState: "synced",
        forkedAt: new Date().toISOString()
      })
    );
    expect(syncedWithMoment.constraint).toBe(
      "source_copies_fork_has_timestamp_check"
    );

    await insertCopy(database, base, {
      forkState: "forked",
      forkedAt: new Date().toISOString(),
      originSnapshotHash: "a".repeat(64)
    });
    // A second copy of the same origin into the same research is a duplicate.
    const duplicateCopy = await rejectedStatement(() => insertCopy(database, base));
    expect(duplicateCopy.code).toBe("23505");
    expect(duplicateCopy.constraint).toBe("source_copies_session_source_idx");
  });
});

describe("source library repository", () => {
  it("creates a copy atomically with its own snapshot, lineage and audit event", async () => {
    const { database } = await freshMigratedDatabase();
    const repository = new EvidenceRepository(database);
    const library = new SourceLibraryRepository(database);
    const originSession = await seedSession(database, "user-1");
    const targetSession = await seedSession(database, "user-1");
    const origin = await seedSource(repository, {
      sessionId: originSession,
      title: "季度回顾",
      url: "https://example.org/q4",
      publisher: "统计年报",
      author: "统计处"
    });
    const originSnapshot = await seedSnapshot(
      repository,
      origin,
      "a".repeat(64),
      "第四季度出货量同比增长 12%。",
      "zh"
    );

    const now = new Date().toISOString();
    const copiedSource = SourceSchema.parse({
      id: newId(),
      sessionId: targetSession,
      title: origin.title,
      kind: origin.kind,
      url: origin.url,
      canonicalUrl: origin.canonicalUrl,
      retrievalStatus: "fetched",
      retrievalAttempts: 0,
      contentHash: originSnapshot.contentHash,
      contentBytes: originSnapshot.contentBytes,
      retrievedAt: originSnapshot.retrievedAt,
      contentType: originSnapshot.contentType,
      createdBy: "human",
      createdAt: now,
      updatedAt: now
    });
    const copiedSnapshot = SourceSnapshotSchema.parse({
      id: newId(),
      sessionId: targetSession,
      sourceId: copiedSource.id,
      canonicalUrl: originSnapshot.canonicalUrl,
      contentHash: originSnapshot.contentHash,
      title: originSnapshot.title,
      contentType: originSnapshot.contentType,
      content: originSnapshot.content,
      contentBytes: originSnapshot.contentBytes,
      charCount: originSnapshot.charCount,
      retrievedAt: originSnapshot.retrievedAt,
      sourceLanguage: "zh",
      createdAt: now
    });

    const result = await library.createCopiedSource({
      source: copiedSource,
      snapshot: copiedSnapshot,
      copy: {
        id: newId(),
        originSessionId: originSession,
        originSourceId: origin.id,
        originSnapshotId: originSnapshot.id,
        originSnapshotHash: originSnapshot.contentHash,
        copiedBy: "Owner (owner)",
        copiedAt: now
      },
      event: {
        correlationId: copiedSource.id,
        type: "SOURCE_COPIED_TO_RESEARCH",
        payload: {
          sourceId: copiedSource.id,
          originSessionId: originSession,
          originSourceId: origin.id
        }
      }
    });

    expect(result.source.sessionId).toBe(targetSession);
    expect(result.snapshot?.sessionId).toBe(targetSession);
    expect(result.copy.originSnapshotHash).toBe(originSnapshot.contentHash);
    expect(result.copy.forkState).toBe("synced");

    // The copy is self-contained: the target holds its own capture and the
    // origin still holds exactly one, untouched.
    const targetSnapshots = await library.listVersions(copiedSource.id);
    expect(targetSnapshots).toHaveLength(1);
    expect(targetSnapshots[0]?.content).toBe(originSnapshot.content);
    expect(targetSnapshots[0]?.sessionId).toBe(targetSession);
    expect(await library.listVersions(origin.id)).toHaveLength(1);

    // The copy is attributed in the target's own audit trail.
    const events = (await database.execute(
      sql.raw(
        `select type from execution_events where session_id = '${targetSession}'`
      )
    )) as unknown as Array<{ type: string }>;
    expect(events.map((row) => row.type)).toEqual(["SOURCE_COPIED_TO_RESEARCH"]);

    const lineage = await library.listCopiesForSession(targetSession);
    expect([...lineage.keys()]).toEqual([copiedSource.id]);
  });

  it("refuses a duplicate in the target and leaves nothing behind", async () => {
    const { database } = await freshMigratedDatabase();
    const repository = new EvidenceRepository(database);
    const library = new SourceLibraryRepository(database);
    const originSession = await seedSession(database, "user-1");
    const targetSession = await seedSession(database, "user-1");
    const origin = await seedSource(repository, {
      sessionId: originSession,
      title: "季度回顾",
      url: "https://example.org/q4"
    });
    // The target already holds the same canonical url under another title.
    await seedSource(repository, {
      sessionId: targetSession,
      title: "Q4 年报",
      url: "https://example.org/q4"
    });

    const now = new Date().toISOString();
    const attempt = () =>
      library.createCopiedSource({
        source: SourceSchema.parse({
          id: newId(),
          sessionId: targetSession,
          title: "季度回顾",
          kind: "url",
          url: "https://example.org/q4",
          canonicalUrl: "https://example.org/q4",
          retrievalStatus: "fetched",
          retrievalAttempts: 0,
          createdBy: "human",
          createdAt: now,
          updatedAt: now
        }),
        snapshot: null,
        copy: {
          id: newId(),
          originSessionId: originSession,
          originSourceId: origin.id,
          originSnapshotId: null,
          originSnapshotHash: null,
          copiedBy: "Owner (owner)",
          copiedAt: now
        },
        event: {
          correlationId: origin.id,
          type: "SOURCE_COPIED_TO_RESEARCH",
          payload: {}
        }
      });

    await expect(attempt()).rejects.toBeInstanceOf(LibraryDuplicateSourceError);

    const copies = (await database.execute(
      sql.raw("select count(*)::int as total from source_copies")
    )) as unknown as Array<{ total: number }>;
    expect(copies[0]?.total).toBe(0);
    const events = (await database.execute(
      sql.raw(
        `select count(*)::int as total from execution_events where session_id = '${targetSession}'`
      )
    )) as unknown as Array<{ total: number }>;
    expect(events[0]?.total).toBe(0);
    const targetSources = (await database.execute(
      sql.raw(
        `select count(*)::int as total from sources where session_id = '${targetSession}'`
      )
    )) as unknown as Array<{ total: number }>;
    expect(targetSources[0]?.total).toBe(1);

    // A reference copy of a source with no capture is allowed and leaves the
    // origin snapshot columns null: there is no version to point at.
    const other = await seedSource(repository, {
      sessionId: originSession,
      title: "尚未抓取的通告",
      url: "https://example.org/notice"
    });
    const reference = await library.createCopiedSource({
      source: SourceSchema.parse({
        id: newId(),
        sessionId: targetSession,
        title: other.title,
        kind: "url",
        url: other.url,
        canonicalUrl: other.canonicalUrl,
        retrievalStatus: "not_requested",
        retrievalAttempts: 0,
        createdBy: "human",
        createdAt: now,
        updatedAt: now
      }),
      snapshot: null,
      copy: {
        id: newId(),
        originSessionId: originSession,
        originSourceId: other.id,
        originSnapshotId: null,
        originSnapshotHash: null,
        copiedBy: "Owner (owner)",
        copiedAt: now
      },
      event: {
        correlationId: other.id,
        type: "SOURCE_COPIED_TO_RESEARCH",
        payload: {}
      }
    });
    expect(reference.snapshot).toBeNull();
    expect(reference.copy.originSnapshotId).toBeNull();
    expect(reference.copy.originSnapshotHash).toBeNull();
  });

  it("forks a copy only when the target really captures different text", async () => {
    const { database } = await freshMigratedDatabase();
    const repository = new EvidenceRepository(database);
    const library = new SourceLibraryRepository(database);
    const originSession = await seedSession(database, "user-1");
    const targetSession = await seedSession(database, "user-1");
    const origin = await seedSource(repository, {
      sessionId: originSession,
      title: "季度回顾",
      url: "https://example.org/q4"
    });
    const originSnapshot = await seedSnapshot(
      repository,
      origin,
      "a".repeat(64),
      "初版正文"
    );
    const copied = await seedSource(repository, {
      sessionId: targetSession,
      title: "季度回顾",
      url: "https://example.org/q4"
    });
    await insertCopy(
      database,
      {
        sessionId: targetSession,
        sourceId: copied.id,
        originSessionId: originSession,
        originSourceId: origin.id
      },
      { originSnapshotId: originSnapshot.id, originSnapshotHash: originSnapshot.contentHash }
    );

    // Re-capturing the same text is not drift.
    await seedSnapshot(repository, copied, "a".repeat(64), "初版正文");
    let row = await library.getCopyForSource(targetSession, copied.id);
    expect(row?.forkState).toBe("synced");
    expect(row?.forkedAt).toBeNull();

    // Capturing different text forks the copy, with the moment recorded.
    await seedSnapshot(repository, copied, "b".repeat(64), "修订后的正文");
    row = await library.getCopyForSource(targetSession, copied.id);
    expect(row?.forkState).toBe("forked");
    expect(row?.forkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The fork is sticky: a later capture that happens to match again must not
    // un-fork it, because the divergence really happened.
    await seedSnapshot(repository, copied, "a".repeat(64), "初版正文");
    row = await library.getCopyForSource(targetSession, copied.id);
    expect(row?.forkState).toBe("forked");
  });

  it("marks a fork only inside the transaction that caused it", async () => {
    const { database } = await freshMigratedDatabase();
    const repository = new EvidenceRepository(database);
    const library = new SourceLibraryRepository(database);
    const sessionId = await seedSession(database, "user-1");
    const source = await seedSource(repository, {
      sessionId,
      title: "季度回顾",
      url: "https://example.org/q4"
    });
    await insertCopy(
      database,
      {
        sessionId,
        sourceId: source.id,
        originSessionId: sessionId,
        originSourceId: source.id
      },
      { originSnapshotHash: "a".repeat(64) }
    );

    const flipped = await database.transaction((transaction) =>
      markCopyForked(transaction, {
        sessionId,
        sourceId: source.id,
        contentHash: "b".repeat(64),
        forkedAt: new Date().toISOString()
      })
    );
    expect(flipped).toBe(true);
    // Idempotent: a second attempt finds nothing left to flip.
    expect(
      await database.transaction((transaction) =>
        markCopyForked(transaction, {
          sessionId,
          sourceId: source.id,
          contentHash: "c".repeat(64),
          forkedAt: new Date().toISOString()
        })
      )
    ).toBe(false);
    expect((await library.getCopyForSource(sessionId, source.id))?.forkState).toBe(
      "forked"
    );
  });

  it("separates owned from granted researches and carries the grant scope", async () => {
    const { database } = await freshMigratedDatabase();
    const library = new SourceLibraryRepository(database);
    const owned = await seedSession(database, "user-1");
    const readGranted = await seedSession(database, "user-2");
    const copyGranted = await seedSession(database, "user-2");
    const legacy = await seedSession(database, null);
    const revoked = await seedSession(database, "user-3");
    await insertGrant(database, readGranted, { subjectId: "user-1", scope: "read" });
    // A role grant is a second, independent way to be granted access.
    await insertGrant(database, copyGranted, {
      subjectType: "role",
      subjectId: "reviewer",
      scope: "copy"
    });
    await insertGrant(database, revoked, {
      subjectId: "user-1",
      revokedAt: new Date().toISOString(),
      revokedBy: "Owner (owner)",
      revokeReason: "研究已结束"
    });

    const result = await library.listAuthorizedSessions("user-1", "reviewer");
    expect(result.own.map((row) => row.sessionId)).toEqual([owned]);
    // The revoked grant is history, not access: it must not appear at all.
    expect(result.granted.map((row) => row.sessionId).sort()).toEqual(
      [readGranted, copyGranted].sort()
    );

    const readRow = result.granted.find((row) => row.sessionId === readGranted);
    expect(readRow?.grantScope).toBe("read");
    expect(readRow?.grantId).toBeTruthy();
    const copyRow = result.granted.find((row) => row.sessionId === copyGranted);
    expect(copyRow?.grantScope).toBe("copy");

    // A session with no recorded owner belongs to nobody: it is never "owned"
    // by the caller, so legacy material is only reachable once someone with
    // the `owner` role explicitly grants it.
    expect(result.own.some((row) => row.sessionId === legacy)).toBe(false);
    expect(result.granted.some((row) => row.sessionId === legacy)).toBe(false);

    const noGrants = await library.listAuthorizedSessions("user-9", "reviewer");
    expect(noGrants.own).toHaveLength(0);
    expect(noGrants.granted.map((row) => row.sessionId)).toEqual([copyGranted]);
  });

  it("searches only inside the sessions it is given, and filters narrow honestly", async () => {
    const { database } = await freshMigratedDatabase();
    const repository = new EvidenceRepository(database);
    const library = new SourceLibraryRepository(database);
    const visibleSession = await seedSession(database, "user-1");
    const foreignSession = await seedSession(database, "user-2");

    const visibleSource = await seedSource(repository, {
      sessionId: visibleSession,
      title: "出货量年报",
      url: "https://data.stats.gov.cn/shipments",
      publisher: "国家统计局",
      author: "统计处",
      publishedAt: "2024-03-01T00:00:00.000Z"
    });
    await seedSnapshot(repository, visibleSource, "a".repeat(64), "正文", "zh");
    const foreignSource = await seedSource(repository, {
      sessionId: foreignSession,
      title: "出货量年报",
      url: "https://data.stats.gov.cn/shipments",
      publisher: "国家统计局",
      author: "统计处",
      publishedAt: "2024-03-01T00:00:00.000Z"
    });
    await seedSnapshot(repository, foreignSource, "b".repeat(64), "正文", "zh");

    const scoped = await library.searchLibrarySources({
      sessionIds: [visibleSession],
      limit: 50,
      offset: 0
    });
    expect(scoped.total).toBe(1);
    expect(scoped.rows[0]?.source.id).toBe(visibleSource.id);
    expect(scoped.rows[0]?.snapshotCount).toBe(1);
    expect(scoped.rows[0]?.languages).toEqual(["zh"]);

    // No authorized session means no result — never "everything".
    const none = await library.searchLibrarySources({
      sessionIds: [],
      limit: 50,
      offset: 0
    });
    expect(none.total).toBe(0);

    const byQuery = await library.searchLibrarySources({
      sessionIds: [visibleSession],
      query: "出货量",
      limit: 50,
      offset: 0
    });
    expect(byQuery.total).toBe(1);

    const byPublisher = await library.searchLibrarySources({
      sessionIds: [visibleSession],
      publisher: "国家统计",
      limit: 50,
      offset: 0
    });
    expect(byPublisher.total).toBe(1);

    const byAuthor = await library.searchLibrarySources({
      sessionIds: [visibleSession],
      author: "统计",
      limit: 50,
      offset: 0
    });
    expect(byAuthor.total).toBe(1);

    // The domain filter matches the host of the canonical url, including a
    // parent domain, and does not leak into the other session.
    const byDomain = await library.searchLibrarySources({
      sessionIds: [visibleSession],
      domain: "stats.gov.cn",
      limit: 50,
      offset: 0
    });
    expect(byDomain.total).toBe(1);

    const byDate = await library.searchLibrarySources({
      sessionIds: [visibleSession],
      publishedFrom: "2024-01-01T00:00:00.000Z",
      publishedTo: "2024-12-31T00:00:00.000Z",
      limit: 50,
      offset: 0
    });
    expect(byDate.total).toBe(1);

    const byLanguage = await library.searchLibrarySources({
      sessionIds: [visibleSession],
      language: "zh",
      limit: 50,
      offset: 0
    });
    expect(byLanguage.total).toBe(1);

    const byMissingLanguage = await library.searchLibrarySources({
      sessionIds: [visibleSession],
      language: "en",
      limit: 50,
      offset: 0
    });
    expect(byMissingLanguage.total).toBe(0);

    // A filter that names a session outside the authorized set narrows to
    // nothing rather than reaching into it.
    const wrongSession = await library.searchLibrarySources({
      sessionIds: [visibleSession],
      sessionId: foreignSession,
      limit: 50,
      offset: 0
    });
    expect(wrongSession.total).toBe(0);

    const paged = await library.searchLibrarySources({
      sessionIds: [visibleSession, foreignSession],
      limit: 1,
      offset: 0
    });
    expect(paged.rows).toHaveLength(1);
    expect(paged.total).toBe(2);
  });

  it("keeps a revoked grant's row, and refuses a duplicate live grant", async () => {
    const { database } = await freshMigratedDatabase();
    const library = new SourceLibraryRepository(database);
    const sessionId = await seedSession(database, "user-1");

    const grant = await library.createGrant(
      {
        sessionId,
        subjectType: "user",
        subjectId: "user-2",
        scope: "copy"
      },
      "Owner (owner)",
      {
        correlationId: sessionId,
        type: "SOURCE_LIBRARY_GRANTED",
        payload: { subjectId: "user-2" }
      }
    );
    expect(grant.revokedAt).toBeUndefined();

    await expect(
      library.createGrant(
        { sessionId, subjectType: "user", subjectId: "user-2", scope: "copy" },
        "Owner (owner)"
      )
    ).rejects.toBeInstanceOf(GrantAlreadyExistsError);

    const revoked = await library.revokeGrant(
      grant.id,
      "Owner (owner)",
      "临时放开",
      new Date().toISOString(),
      {
        correlationId: grant.id,
        type: "SOURCE_LIBRARY_REVOKED",
        payload: { subjectId: "user-2" }
      }
    );
    expect(revoked?.revokedBy).toBe("Owner (owner)");
    expect(revoked?.revokeReason).toBe("临时放开");

    // A second revocation is not a new decision.
    expect(
      await library.revokeGrant(
        grant.id,
        "Owner (owner)",
        "再次撤销",
        new Date().toISOString()
      )
    ).toBeNull();

    const [row] = await library.listGrants(sessionId);
    expect(row?.revokedAt).toBeTruthy();
    expect(row?.revokeReason).toBe("临时放开");

    const events = (await database.execute(
      sql.raw(
        `select type from execution_events where session_id = '${sessionId}' order by sequence`
      )
    )) as unknown as Array<{ type: string }>;
    expect(events.map((item) => item.type)).toEqual([
      "SOURCE_LIBRARY_GRANTED",
      "SOURCE_LIBRARY_REVOKED"
    ]);
  });

  it("keeps the target's lineage when the origin research is removed", async () => {
    const { database } = await freshMigratedDatabase();
    const repository = new EvidenceRepository(database);
    const library = new SourceLibraryRepository(database);
    const originSession = await seedSession(database, "user-1");
    const targetSession = await seedSession(database, "user-1");
    const origin = await seedSource(repository, {
      sessionId: originSession,
      title: "季度回顾",
      url: "https://example.org/q4"
    });
    const originSnapshot = await seedSnapshot(
      repository,
      origin,
      "a".repeat(64),
      "正文"
    );
    const copied = await seedSource(repository, {
      sessionId: targetSession,
      title: "季度回顾",
      url: "https://example.org/q4"
    });
    await insertCopy(
      database,
      {
        sessionId: targetSession,
        sourceId: copied.id,
        originSessionId: originSession,
        originSourceId: origin.id
      },
      {
        originSnapshotId: originSnapshot.id,
        originSnapshotHash: originSnapshot.contentHash
      }
    );

    // The origin's material is removed. The provenance record must outlive
    // it: deleting a research's rows must not silently delete another
    // research's audit trail. (A whole-session DELETE is blocked by the
    // pre-existing non-cascading `sources.session_id` foreign key, which is
    // unrelated to this migration, so the guarantee is proven at the level
    // the library actually owns: the origin's rows disappearing.)
    await database.execute(
      sql.raw(`DELETE FROM source_snapshots WHERE session_id = '${originSession}'`)
    );
    await database.execute(
      sql.raw(`DELETE FROM sources WHERE session_id = '${originSession}'`)
    );
    expect(await library.getSourceById(origin.id)).toBeNull();

    const surviving = await library.getCopyForSource(targetSession, copied.id);
    expect(surviving?.originSessionId).toBe(originSession);
    expect(surviving?.originSourceId).toBe(origin.id);
    expect(surviving?.originSnapshotHash).toBe("a".repeat(64));
    // The copy itself is untouched and still readable inside its own research.
    expect(await library.listVersions(copied.id)).toHaveLength(0);
    expect((await library.getSourceById(copied.id))?.title).toBe("季度回顾");

    // The other direction does cascade, and should: removing the copy's own
    // source removes the lineage row with it — the material and its record are
    // one thing, and they belong to the research that holds them.
    await database.execute(sql.raw(`DELETE FROM sources WHERE id = '${copied.id}'`));
    expect(await library.getCopyForSource(targetSession, copied.id)).toBeNull();
    const remaining = (await database.execute(
      sql.raw("select count(*)::int as total from source_copies")
    )) as unknown as Array<{ total: number }>;
    expect(remaining[0]?.total).toBe(0);
  });

  it("reads the origin's latest capture for drift, and the copy by id", async () => {
    const { database } = await freshMigratedDatabase();
    const repository = new EvidenceRepository(database);
    const library = new SourceLibraryRepository(database);
    const sessionId = await seedSession(database, "user-1");
    const source = await seedSource(repository, {
      sessionId,
      title: "季度回顾",
      url: "https://example.org/q4"
    });
    expect(await library.getLatestSnapshotForSource(source.id)).toBeNull();

    const first = await seedSnapshot(repository, source, "a".repeat(64), "初版");
    const second = await seedSnapshot(repository, source, "b".repeat(64), "修订版");
    const latest = await library.getLatestSnapshotForSource(source.id);
    expect(latest?.id).toBe(second.id);
    expect(latest?.contentHash).toBe("b".repeat(64));

    expect((await library.getSnapshotById(first.id))?.content).toBe("初版");

    const versions = await library.listVersions(source.id);
    expect(versions).toHaveLength(2);

    // The duplicate probe reports which rule it matched, so the caller can be
    // pointed at the existing row instead of a bare "duplicate".
    const byUrl = await library.findDuplicateInSession(sessionId, {
      canonicalUrl: "https://example.org/q4",
      title: "别的标题"
    });
    expect(byUrl?.reason).toBe("canonical_url");
    const byTitle = await library.findDuplicateInSession(sessionId, {
      canonicalUrl: null,
      title: "季度回顾"
    });
    expect(byTitle?.reason).toBe("title");
    expect(
      await library.findDuplicateInSession(sessionId, {
        canonicalUrl: null,
        title: "全新来源"
      })
    ).toBeNull();

    expect(await library.getSourceById(newId())).toBeNull();
    expect(await library.getCopyForSource(sessionId, source.id)).toBeNull();
    expect(await library.listCopiedOriginSourceIds(sessionId)).toEqual(new Set());
  });
});
