import type { SourceFileRecord } from "@nexus/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDependencies } from "../../app";
import {
  FileIngestionError,
  FileIngestionService
} from "../../research/file-ingestion-service";
import { SourceFileNotFoundError } from "@nexus/db";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

/**
 * Upload routes for a single file.
 *
 * The body is raw bytes with the name in a header, rather than multipart: it
 * keeps the server parsing exactly one thing, and the client already knows both.
 * Everything here is authenticated, session-scoped and idempotent on retry, and
 * each response tells the truth about what happened — including when nothing
 * could be read.
 *
 * Note on what is absent: there is no endpoint that marks evidence verified, no
 * endpoint that accepts a client-supplied Source, and no endpoint that takes a
 * `verifiedBy` or `owner`. Those are decided server-side or by a person later.
 */

function getIdempotencyKey(request: FastifyRequest): string | null {
  const key = request.headers["idempotency-key"];
  return typeof key === "string" && key.length > 0 ? key : null;
}

function actorOf(
  request: FastifyRequest,
  dependencies: Pick<AppDependencies, "auth">
) {
  return dependencies.auth?.userFromRequest(request) ?? null;
}

function actorName(
  user: { displayName: string; username: string } | null
): string {
  return user ? `${user.displayName} (${user.username})` : "unattributed";
}

type FileRouteDependencies = Pick<AppDependencies, "auth" | "evidence"> & {
  fileIngestion?: FileIngestionService;
};

function decodeFileName(raw: string): string | null {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // Strip any directory components a client may have sent: the name is a label,
  // never a path, and never something this build resolves.
  const base = decoded.split(/[\\/]/).pop() ?? "";
  const trimmed = base.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 240) : null;
}

function mapServiceError(
  reply: { code: (c: number) => { send: (b: unknown) => unknown } },
  error: unknown
): boolean {
  if (error instanceof FileIngestionError) {
    reply.code(error.httpStatus).send({
      error: error.message,
      code: error.code,
      ...(error.file ? { file: error.file } : {})
    });
    return true;
  }
  if (
    error instanceof SourceFileNotFoundError ||
    (error instanceof Error && error.name === "SourceFileNotFoundError")
  ) {
    reply
      .code(404)
      .send({ error: "File not found", code: "file_not_found" });
    return true;
  }
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof IdempotencyTimeoutError ||
    error instanceof IdempotencyLeaseLostError
  ) {
    reply.code(409).send({ error: error.message });
    return true;
  }
  // A session that does not exist surfaces as a foreign key violation; nobody
  // should see that as a server failure.
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "23503") {
    reply.code(404).send({ error: "Session not found" });
    return true;
  }
  return false;
}

function bodyBytes(request: FastifyRequest): Uint8Array | null {
  const body = request.body;
  if (body instanceof Uint8Array) return body;
  return null;
}

export function registerFileRoutes(
  app: FastifyInstance,
  dependencies: FileRouteDependencies,
  idempotency: IdempotencyStore
): void {
  /* Uploads one file and immediately tries to read it. */
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/files",
    async (request, reply) => {
      const user = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.fileIngestion) {
        return reply
          .code(501)
          .send({ error: "File ingestion is not configured" });
      }
      const nameHeader = request.headers["x-file-name"];
      const fileName =
        typeof nameHeader === "string" ? decodeFileName(nameHeader) : null;
      if (!fileName) {
        return reply.code(400).send({
          error: "X-File-Name header is required and must be a valid file name"
        });
      }
      const bytes = bodyBytes(request);
      if (!bytes) {
        return reply
          .code(400)
          .send({ error: "Request body must be the raw file bytes" });
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }

      const sessionId = request.params.id;
      try {
        const requestHash = hashIdempotencyRequest({
          operation: "file-upload",
          sessionId,
          body: { fileName, byteSize: bytes.length }
        });
        const result = await idempotency.execute(key, requestHash, () =>
          dependencies.fileIngestion!.importFile({
            sessionId,
            fileName,
            declaredMimeType:
              typeof request.headers["content-type"] === "string"
                ? request.headers["content-type"]
                : "application/octet-stream",
            bytes,
            actor: actorName(user)
          })
        );
        // The same bytes twice is not a new import; saying so beats pretending
        // the file arrived for the first time.
        return reply.code(result.response.duplicated ? 200 : 201).send({
          file: result.response.file,
          source: result.response.source,
          duplicated: result.response.duplicated
        });
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /* Every file imported into the session, newest first. */
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/files",
    async (request, reply) => {
      const user = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!dependencies.fileIngestion) {
        return reply
          .code(501)
          .send({ error: "File ingestion is not configured" });
      }
      try {
        return { files: await dependencies.fileIngestion.listFiles(request.params.id) };
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /* One file: what it is, how the read settled, and its source when it has one. */
  app.get<{ Params: { id: string; fileId: string } }>(
    "/api/sessions/:id/files/:fileId",
    async (request, reply) => {
      const user = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!dependencies.fileIngestion) {
        return reply
          .code(501)
          .send({ error: "File ingestion is not configured" });
      }
      try {
        const file: SourceFileRecord = await dependencies.fileIngestion.getFile(
          request.params.id,
          request.params.fileId
        );
        return { file };
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /* The text (and csv table) a person reads and excerpts from. */
  app.get<{ Params: { id: string; fileId: string } }>(
    "/api/sessions/:id/files/:fileId/content",
    async (request, reply) => {
      const user = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!dependencies.fileIngestion) {
        return reply
          .code(501)
          .send({ error: "File ingestion is not configured" });
      }
      try {
        const content = await dependencies.fileIngestion.readFileContent({
          sessionId: request.params.id,
          fileId: request.params.fileId
        });
        return {
          file: content.file,
          source: content.source,
          snapshot: content.snapshot,
          content: content.content,
          contentType: content.contentType,
          ...(content.table ? { table: content.table } : {})
        };
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /* Tries again to read a file whose import did not succeed. */
  app.post<{ Params: { id: string; fileId: string } }>(
    "/api/sessions/:id/files/:fileId/retry",
    async (request, reply) => {
      const user = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.fileIngestion) {
        return reply
          .code(501)
          .send({ error: "File ingestion is not configured" });
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "file-retry",
        sessionId,
        fileId: request.params.fileId
      });
      try {
        const result = await idempotency.execute(key, requestHash, () =>
          dependencies.fileIngestion!.retryParse({
            sessionId,
            fileId: request.params.fileId,
            actor: actorName(user)
          })
        );
        return {
          file: result.response.file,
          source: result.response.source,
          duplicated: result.response.duplicated
        };
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );
}
