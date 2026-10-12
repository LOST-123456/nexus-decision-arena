import { and, desc, eq } from "drizzle-orm";
import {
  type SourceFileParseStats,
  type SourceFileParseStatus,
  type SourceFileRecord,
  SourceFileRecordSchema
} from "@nexus/shared";
import type { Database } from "../client";
import { sourceFiles } from "../schema";
import { iso } from "./domain-mapper";

export class SourceFileNotFoundError extends Error {
  constructor(fileId: string) {
    super(`Source file not found: ${fileId}`);
    this.name = "SourceFileNotFoundError";
  }
}

/**
 * A file row about to be written.
 *
 * Timestamps are supplied by the server, and `storageKey` deliberately does not
 * appear on the domain record: where the bytes live is not something anyone
 * outside the storage layer should ever see.
 */
export type NewSourceFile = Omit<
  SourceFileRecord,
  "createdAt" | "updatedAt"
> & {
  storageKey: string;
};

function mapSourceFile(row: typeof sourceFiles.$inferSelect): SourceFileRecord {
  // All nullable columns normalize through the zod preprocess rules, and every
  // timestamptz goes through `iso()` because Postgres hands back text (or a Date).
  return SourceFileRecordSchema.parse({
    ...row,
    sourceId: row.sourceId ?? null,
    parseError: row.parseError ?? null,
    parseStats: row.parseStats ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  });
}

/**
 * The only writer of file-import rows.
 *
 * What it refuses to do is the point: it records *files and parse outcomes*. It
 * never creates evidence, never sets a verification status, and never decides
 * whether anything in a document supports a claim. Its closest reach into the
 * domain is a foreign key to a `sources` row that the evidence repository
 * created, so an imported document becomes citable through exactly the same
 * path as any other source.
 */
export class SourceFileRepository {
  constructor(private readonly database: Database) {}

  /**
   * Records a file whose parse already settled.
   *
   * There is deliberately no "in progress" row: parsing happens against the
   * uploaded bytes before anything is written, so a row is only ever a finished
   * outcome. Something half-read cannot be mistaken for a success later.
   */
  async insertSourceFile(input: {
    file: NewSourceFile;
  }): Promise<SourceFileRecord> {
    const now = new Date().toISOString();
    const [row] = await this.database
      .insert(sourceFiles)
      .values({
        id: input.file.id,
        sessionId: input.file.sessionId,
        sourceId: input.file.sourceId ?? null,
        fileName: input.file.fileName,
        declaredMimeType: input.file.declaredMimeType,
        detectedKind: input.file.detectedKind,
        byteSize: input.file.byteSize,
        sha256: input.file.sha256,
        parseStatus: input.file.parseStatus,
        parseError: input.file.parseError ?? null,
        parseStats: input.file.parseStats ?? null,
        storageKey: input.file.storageKey,
        parserVersion: input.file.parserVersion,
        createdAt: now,
        updatedAt: now
      })
      .returning();
    return mapSourceFile(row!);
  }

  /** Read scoped to the session: another session's file simply does not exist. */
  async getSourceFile(
    sessionId: string,
    fileId: string
  ): Promise<SourceFileRecord> {
    const [row] = await this.database
      .select()
      .from(sourceFiles)
      .where(
        and(eq(sourceFiles.sessionId, sessionId), eq(sourceFiles.id, fileId))
      )
      .limit(1);
    if (!row) throw new SourceFileNotFoundError(fileId);
    return mapSourceFile(row);
  }

  /**
   * Whether identical bytes already exist in this session.
   *
   * Content decides duplication, never the file name: the same document
   * re-uploaded under a new name is the same content, and a different document
   * re-uploaded under the same name is a different file.
   */
  async findSourceFileByHash(
    sessionId: string,
    sha256: string
  ): Promise<SourceFileRecord | null> {
    const [row] = await this.database
      .select()
      .from(sourceFiles)
      .where(
        and(eq(sourceFiles.sessionId, sessionId), eq(sourceFiles.sha256, sha256))
      )
      .limit(1);
    return row ? mapSourceFile(row) : null;
  }

  async listSourceFiles(sessionId: string): Promise<SourceFileRecord[]> {
    const rows = await this.database
      .select()
      .from(sourceFiles)
      .where(eq(sourceFiles.sessionId, sessionId))
      .orderBy(desc(sourceFiles.createdAt));
    return rows.map(mapSourceFile);
  }

  /** The opaque key into managed storage. Server-side eyes only. */
  async getStorageKey(sessionId: string, fileId: string): Promise<string> {
    const [row] = await this.database
      .select({ storageKey: sourceFiles.storageKey })
      .from(sourceFiles)
      .where(
        and(eq(sourceFiles.sessionId, sessionId), eq(sourceFiles.id, fileId))
      )
      .limit(1);
    if (!row) throw new SourceFileNotFoundError(fileId);
    return row.storageKey;
  }

  /**
   * Writes how a read settled, including after a retry.
   *
   * `sourceId` may arrive together with a `parsed` status: the row then points
   * at the Source the extracted text was stored under, which is what lets the
   * reader route from a file to the text a person can actually excerpt.
   */
  async settleParse(input: {
    sessionId: string;
    fileId: string;
    parseStatus: SourceFileParseStatus;
    parseError: string | null;
    parseStats: SourceFileParseStats | null;
    sourceId?: string | undefined;
  }): Promise<SourceFileRecord> {
    const now = new Date().toISOString();
    const [row] = await this.database
      .update(sourceFiles)
      .set({
        parseStatus: input.parseStatus,
        parseError: input.parseError,
        parseStats: input.parseStats,
        sourceId: input.sourceId ?? null,
        updatedAt: now
      })
      .where(
        and(
          eq(sourceFiles.sessionId, input.sessionId),
          eq(sourceFiles.id, input.fileId)
        )
      )
      .returning();
    if (!row) throw new SourceFileNotFoundError(input.fileId);
    return mapSourceFile(row);
  }
}
