import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  projects,
  SourceFileRepository,
  type Database
} from "@nexus/db";
import { newId, type SourceFileRecord } from "@nexus/shared";
import { createApp } from "../../app";
import { InMemoryIdempotencyStore } from "../plugins/idempotency";
import { FileIngestionService } from "../../research/file-ingestion-service";
import { InMemoryFileStorage } from "../../research/file-storage";

/**
 * DB-backed tests for local research file import.
 *
 * What only a real database can prove — everything below is about the boundary
 * between "a file was uploaded" and "this now exists as something citable":
 *
 *  - a successful import writes a Source and a Snapshot through the *existing*
 *    evidence repository, and never anything verified;
 *  - identical bytes resolve to the earlier row instead of a second import,
 *    while the same file name with different bytes stays two files;
 *  - an unreadable file is visible as `needs_ocr` / `failed` rather than absent;
 *  - nothing crosses sessions, and every write requires a reviewer;
 *  - the stored text can be read back exactly, including csv as a table.
 */
const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const evidenceRepository = new EvidenceRepository(database);
const events = new EventRepository(database);
const fileRepository = new SourceFileRepository(database);

const PROJECT_ID = newId();
const SESSION_ID = newId();
const SESSION_B_ID = newId();

let role: "owner" | "reviewer" | "viewer" = "reviewer";

function fakeAuth(enabled = true) {
  return {
    userFromRequest: () =>
      enabled
        ? {
            id: "user-1",
            username: "researcher",
            displayName: "Researcher One",
            role
          }
        : null
  };
}

function ingestion(maxBytes?: number) {
  return new FileIngestionService({
    files: fileRepository,
    evidence: evidenceRepository,
    storage: new InMemoryFileStorage(),
    ...(maxBytes ? { maxBytes } : {})
  });
}

function testApp(enabled = true, fileIngestion = ingestion()) {
  return createApp(
    {
      auth: fakeAuth(enabled) as never,
      sessions,
      inspector: {} as never,
      events,
      runSession: { start: async () => undefined },
      evidence: evidenceRepository,
      arena: {} as never,
      fileIngestion
    },
    new InMemoryIdempotencyStore()
  );
}

/**
 * One application for a whole scenario.
 *
 * This matters for more than tidiness: the idempotency store and the file
 * storage live inside the app instance. A replay can only be observed if the
 * second upload hits the same store, and a retry can only re-read bytes that
 * were written to the same storage. Calls that deliberately change one of those
 * (unauthenticated, smaller ceiling) build their own instance on purpose.
 */
let sharedApp: ReturnType<typeof testApp> | null = null;
function defaultApp(): ReturnType<typeof testApp> {
  sharedApp ??= testApp();
  return sharedApp;
}

const encode = (value: string) => new TextEncoder().encode(value);

async function upload(options: {
  sessionId?: string;
  fileName: string;
  bytes: Uint8Array;
  contentType?: string;
  idempotencyKey?: string;
  app?: ReturnType<typeof testApp>;
}) {
  const target = options.app ?? defaultApp();
  return await target.inject({
    method: "POST",
    url: `/api/sessions/${options.sessionId ?? SESSION_ID}/files`,
    headers: {
      // The browser client always sends the bytes as an explicit octet-stream;
      // nothing here infers the type from it (that is done from the signature).
      "content-type": options.contentType ?? "application/octet-stream",
      "x-file-name": encodeURIComponent(options.fileName),
      ...(options.idempotencyKey === null
        ? {}
        : { "idempotency-key": options.idempotencyKey ?? newId() })
    },
    payload: Buffer.from(options.bytes)
  });
}

const TXT_BYTES = encode("Costs rose by 12%.\n\nHeadcount stayed flat.\n");

beforeEach(async () => {
  role = "reviewer";
  await database.execute("TRUNCATE projects CASCADE");
  await database.insert(projects).values({
    id: PROJECT_ID,
    name: "File import integration",
    input: {}
  });
  await sessions.create({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    locale: "zh-CN",
    phase: "EVIDENCE",
    operationalStatus: "ACTIVE",
    currentConclusion: null,
    // The research belongs to the signed-in reviewer: access is decided from
    // the recorded owner, never from the request.
    ownerUserId: "user-1"
  });
  await sessions.create({
    id: SESSION_B_ID,
    projectId: PROJECT_ID,
    locale: "zh-CN",
    phase: "EVIDENCE",
    operationalStatus: "ACTIVE",
    currentConclusion: null,
    // Same owner on purpose: these tests prove that a file read never crosses
    // the session it belongs to, which is a different layer from who may open
    // the research at all.
    ownerUserId: "user-1"
  });
});

afterAll(async () => {
  await database.execute("TRUNCATE projects CASCADE");
});

describe("POST /api/sessions/:id/files", () => {
  it("imports a text file into a Source and a stored capture", async () => {
    const response = await upload({ fileName: "notes.txt", bytes: TXT_BYTES });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.duplicated).toBe(false);
    expect(body.file.parseStatus).toBe("parsed");
    expect(body.file.detectedKind).toBe("txt");
    expect(body.source.kind).toBe("document");
    // Nothing about the file is proof of anything: no evidence exists, and the
    // verification axis is untouched because it belongs to a different step.
    expect(body.source.retrievalStatus).toBe("fetched");
  });

  it("stores the extracted text so it can be read back", async () => {
    await upload({ fileName: "notes.txt", bytes: TXT_BYTES });
    const list = await defaultApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/files`
    });
    const fileId = list.json().files[0].id as string;
    const content = await defaultApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/files/${fileId}/content`
    });
    expect(content.statusCode).toBe(200);
    expect(content.json().content).toBe(
      "Costs rose by 12%.\n\nHeadcount stayed flat."
    );
    expect(content.json().source.kind).toBe("document");
  });

  it("keeps a csv as a table rather than prose", async () => {
    const response = await upload({
      fileName: "data.csv",
      bytes: encode("region,amount\nEast,1200\nWest,980\n")
    });
    expect(response.statusCode).toBe(201);
    const fileId = response.json().file.id as string;
    const content = await defaultApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/files/${fileId}/content`
    });
    const table = content.json().table;
    expect(table.columns).toEqual(["region", "amount"]);
    expect(table.columnTypes).toEqual(["text", "integer"]);
    expect(table.rowCount).toBe(2);
  });

  it("treats identical bytes in the same session as one file", async () => {
    const first = await upload({ fileName: "notes.txt", bytes: TXT_BYTES });
    const second = await upload({ fileName: "renamed.txt", bytes: TXT_BYTES });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicated).toBe(true);
    expect(second.json().file.id).toBe(first.json().file.id);
  });

  it("keeps same-named files with different bytes as two files", async () => {
    const first = await upload({ fileName: "report.txt", bytes: TXT_BYTES });
    const second = await upload({
      fileName: "report.txt",
      bytes: encode("Entirely different content.\n")
    });
    expect(first.json().file.id).not.toBe(second.json().file.id);
    // Both are readable; only their Source titles had to be distinguished.
    const list = await defaultApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/files`
    });
    expect(list.json().files).toHaveLength(2);
    const titles = new Set(
      list.json().files.map((file: SourceFileRecord) => file.fileName)
    );
    expect(titles.size).toBe(1);
  });

  it("refuses an unsupported type without recording anything", async () => {
    const response = await upload({
      fileName: "image.png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02])
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().code).toBe("unsupported_type");
    const list = await defaultApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/files`
    });
    expect(list.json().files).toEqual([]);
  });

  it("refuses an empty file", async () => {
    const response = await upload({
      fileName: "empty.txt",
      bytes: new Uint8Array([])
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("empty_file");
  });

  it("refuses a file over the configured ceiling", async () => {
    const small = ingestion(8);
    const response = await upload({
      fileName: "notes.txt",
      bytes: TXT_BYTES,
      app: testApp(true, small)
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().code).toBe("file_too_large");
  });

  it("requires authentication and a reviewer role", async () => {
    const anonymous = await upload({ fileName: "notes.txt", bytes: TXT_BYTES, app: testApp(false) });
    expect(anonymous.statusCode).toBe(401);

    role = "viewer";
    const viewer = await upload({ fileName: "notes.txt", bytes: TXT_BYTES });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json().error).toContain("Reviewer");
  });

  it("lets a viewer read files", async () => {
    await upload({ fileName: "notes.txt", bytes: TXT_BYTES });
    role = "viewer";
    const list = await defaultApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/files`
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().files).toHaveLength(1);
  });

  it("requires an idempotency key", async () => {
    const response = await defaultApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/files`,
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent("notes.txt")
      },
      payload: Buffer.from(TXT_BYTES)
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Idempotency-Key");
  });

  it("replays the same upload instead of importing twice", async () => {
    const key = newId();
    const first = await upload({
      fileName: "notes.txt",
      bytes: TXT_BYTES,
      idempotencyKey: key
    });
    const second = await upload({
      fileName: "notes.txt",
      bytes: TXT_BYTES,
      idempotencyKey: key
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const list = await defaultApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/files`
    });
    expect(list.json().files).toHaveLength(1);
  });

  it("records a file it cannot read instead of hiding it", async () => {
    // Looks like a PDF by signature, yet has no readable structure at all.
    const response = await upload({
      fileName: "broken.pdf",
      bytes: encode("%PDF-1.4 not really a document")
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("parse_failed");
    expect(response.json().file.parseStatus).toBe("failed");
    expect(response.json().file.parseError).toBeTruthy();
    // The row exists, so the failure stays visible in the file list.
    const list = await defaultApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/files`
    });
    expect(list.json().files).toHaveLength(1);
    expect(list.json().files[0].sourceId).toBeUndefined();
  });
});

describe("file reads across sessions", () => {
  it("does not expose another session's files", async () => {
    const uploaded = await upload({ fileName: "notes.txt", bytes: TXT_BYTES });
    const fileId = uploaded.json().file.id as string;
    const other = await defaultApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_B_ID}/files/${fileId}`
    });
    expect(other.statusCode).toBe(404);
    expect(other.json().code).toBe("file_not_found");
  });

  it("lists only the session's own files", async () => {
    await upload({ fileName: "notes.txt", bytes: TXT_BYTES });
    await upload({ fileName: "other.txt", bytes: encode("Session B file.\n"), sessionId: SESSION_B_ID });
    const mine = await defaultApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/files`
    });
    expect(mine.json().files).toHaveLength(1);
    expect(mine.json().files[0].fileName).toBe("notes.txt");
  });
});

describe("POST /api/sessions/:id/files/:fileId/retry", () => {
  it("accepts a retry for a recorded failure and reports the outcome again", async () => {
    const failed = await upload({
      fileName: "broken.pdf",
      bytes: encode("%PDF-1.4 not really a document")
    });
    const fileId = failed.json().file.id as string;
    const response = await defaultApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/files/${fileId}/retry`,
      headers: { "idempotency-key": newId() }
    });
    // Still unreadable, because nothing about the bytes changed: the retry must
    // say so rather than succeed.
    expect(response.statusCode).toBe(422);
    const stored = await defaultApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/files/${fileId}`
    });
    expect(stored.json().file.parseStatus).toBe("failed");
  });

  it("needs the same permissions as an upload", async () => {
    const uploaded = await upload({ fileName: "notes.txt", bytes: TXT_BYTES });
    const fileId = uploaded.json().file.id as string;
    role = "viewer";
    const response = await defaultApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/files/${fileId}/retry`,
      headers: { "idempotency-key": newId() }
    });
    expect(response.statusCode).toBe(403);
  });
});
