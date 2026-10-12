import {
  type EvidenceRepository,
  SourceTitleConflictError,
  type SourceFileRepository,
  SourceFileNotFoundError
} from "@nexus/db";
import {
  type FileIngestionFailureCode,
  type Source,
  type SourceFileParseStats,
  type SourceFileRecord,
  type SourceSnapshot,
  SOURCE_FILE_CONTENT_TYPES
} from "@nexus/shared";
import { deriveUuidV7 } from "../api/plugins/deterministic-id";
import {
  DEFAULT_MAX_FILE_BYTES,
  DocumentParseError,
  FILE_PARSER_VERSION,
  detectSourceFileKind,
  inspectCsv,
  parseDocument,
  sha256Of,
  type CsvStructure,
  type ParsedDocument
} from "./file-parsers";
import {
  FileStorageError,
  fileStorageKey,
  type SourceFileStorage
} from "./file-storage";

/*
 * The file importer: bytes in, one registered source plus one stored capture
 * out - or an honest note about why neither happened.
 *
 * The invariants this file defends, all of them shaped by the same rule (nothing
 * here judges truth):
 *
 *   - Importing creates a Source and a Snapshot. It never creates Evidence, and
 *     never touches verification status. What a sentence means for a claim stays
 *     a human decision made later through the existing evidence API.
 *   - Content identity beats file names. Identical bytes already imported into a
 *     session resolve to the existing row; the same name with different bytes is
 *     a different file and is never folded into the first.
 *   - A file we cannot read is reported, not excused: `needs_ocr` for a scanned
 *     PDF, `failed` with a reason for anything else, and neither claims success.
 *   - Nothing leaves the session it arrived in. Every lookup is session-scoped,
 *     including retries.
 *   - The client is trusted with nothing: ownership, publisher, verification and
 *     the target Source are all decided here.
 */

export type IngestedFile = {
  file: SourceFileRecord;
  source: Source | null;
  snapshot: SourceSnapshot | null;
  /** True when identical bytes had already been imported into this session. */
  duplicated: boolean;
};

export type SourceFileContent = {
  file: SourceFileRecord;
  source: Source | null;
  snapshot: SourceSnapshot | null;
  /** The stored capture text. Empty when there is nothing to read. */
  content: string;
  contentType: string;
  /** Present for csv, so the reader can render the table rather than prose. */
  table?: CsvStructure;
};

export class FileIngestionError extends Error {
  constructor(
    message: string,
    readonly code: FileIngestionFailureCode,
    readonly httpStatus: number,
    /** Set when a failed import still left a row behind, as most at-least do. */
    readonly file: SourceFileRecord | null = null
  ) {
    super(message);
    this.name = "FileIngestionError";
  }
}

const HTTP_STATUS_BY_CODE: Readonly<Record<FileIngestionFailureCode, number>> = {
  file_not_found: 404,
  unsupported_type: 415,
  empty_file: 400,
  file_too_large: 413,
  parse_failed: 422,
  storage_unavailable: 503
};

type FileRepository = Pick<
  SourceFileRepository,
  | "insertSourceFile"
  | "getSourceFile"
  | "findSourceFileByHash"
  | "listSourceFiles"
  | "getStorageKey"
  | "settleParse"
>;

type IngestionEvidence = Pick<
  EvidenceRepository,
  | "createSource"
  | "getSource"
  | "listSources"
  | "recordRetrievalSuccess"
  | "getCurrentSnapshot"
>;

export class FileIngestionService {
  constructor(
    private readonly dependencies: {
      files: FileRepository;
      /** Source/snapshot writes happen here, never anywhere else. */
      evidence: IngestionEvidence;
      storage: SourceFileStorage;
      /** Per-file ceiling for this deployment. Bounded by default, never open. */
      maxBytes?: number | undefined;
      timeoutMs?: number | undefined;
      now?: () => Date;
    }
  ) {}

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private get maxBytes(): number {
    return this.dependencies.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /* ---------------------------------------------------------------- *
   * Import
   * ---------------------------------------------------------------- */

  /**
   * Imports one file.
   *
   * Order matters and is deliberate: size and type are checked before anything
   * is written (a refused file leaves no trace), bytes are stored only once we
   * know there is a document there, and the Source exists before the row that
   * points at it. A failure after storage cleans the bytes back up, so nothing
   * accumulates in the dark.
   */
  async importFile(input: {
    sessionId: string;
    fileName: string;
    declaredMimeType: string;
    bytes: Uint8Array;
    actor: string;
  }): Promise<IngestedFile> {
    const bytes = input.bytes;
    if (bytes.length === 0) {
      throw new FileIngestionError(
        "文件为空：没有任何内容可以读取。",
        "empty_file",
        HTTP_STATUS_BY_CODE.empty_file,
        null
      );
    }
    if (bytes.length > this.maxBytes) {
      const limitMb = (this.maxBytes / (1024 * 1024)).toFixed(1);
      const sizeMb = (bytes.length / (1024 * 1024)).toFixed(1);
      throw new FileIngestionError(
        `文件超过大小上限：单个文件最多 ${limitMb} MB，当前文件 ${sizeMb} MB。`,
        "file_too_large",
        HTTP_STATUS_BY_CODE.file_too_large,
        null
      );
    }

    const sha256 = sha256Of(bytes);
    const alreadyImported = await this.dependencies.files.findSourceFileByHash(
      input.sessionId,
      sha256
    );
    if (alreadyImported) {
      // Same bytes, same session: the earlier row answers. This is why content
      // decides duplication - a renamed copy of the same PDF is still the same
      // document, and a different PDF called the same name is not this one.
      const source = alreadyImported.sourceId
        ? await this.dependencies.evidence.getSource(
            input.sessionId,
            alreadyImported.sourceId
          )
        : null;
      const snapshot = source
        ? await this.dependencies.evidence.getCurrentSnapshot(
            input.sessionId,
            source.id
          )
        : null;
      return {
        file: alreadyImported,
        source,
        snapshot,
        duplicated: true
      };
    }

    const detectedKind = detectSourceFileKind({
      bytes,
      fileName: input.fileName
    });
    if (!detectedKind) {
      throw new FileIngestionError(
        "不支持的文件类型：内容不是 PDF、Word 文档、纯文本、Markdown 或 CSV。",
        "unsupported_type",
        HTTP_STATUS_BY_CODE.unsupported_type,
        null
      );
    }

    // Derived from content, so a retry of the same upload cannot create a second
    // row for the same document.
    const fileId = deriveUuidV7("source-file", input.sessionId, sha256);
    const storageKey = fileStorageKey(input.sessionId, fileId);
    await this.put(input.sessionId, storageKey, bytes);

    let parsed: ParsedDocument;
    try {
      parsed = await parseDocument({
        bytes,
        kind: detectedKind,
        limits: { timeoutMs: this.dependencies.timeoutMs }
      });
    } catch (cause) {
      const failure = cause instanceof DocumentParseError ? cause : null;
      const message =
        failure?.message ?? "文件解析失败：无法提取其中的文本内容。";
      const code: FileIngestionFailureCode = failure?.code ?? "parse_failed";
      const file = await this.dependencies.files.insertSourceFile({
        file: {
          id: fileId,
          sessionId: input.sessionId,
          fileName: this.fileName(input.fileName),
          declaredMimeType: input.declaredMimeType,
          detectedKind,
          byteSize: bytes.length,
          sha256,
          parseStatus: "failed",
          parseError: message,
          parseStats: null,
          storageKey,
          parserVersion: FILE_PARSER_VERSION
        }
      });
      throw new FileIngestionError(
        message,
        code,
        HTTP_STATUS_BY_CODE[code],
        file
      );
    }

    if (parsed.outcome === "needs_ocr") {
      // The file is real and the pages are countable; there is simply no text
      // layer. Recording that beats recording a "parsed" document whose content
      // is empty, which would invite citing something that is not there.
      const file = await this.dependencies.files.insertSourceFile({
        file: {
          id: fileId,
          sessionId: input.sessionId,
          fileName: this.fileName(input.fileName),
          declaredMimeType: input.declaredMimeType,
          detectedKind,
          byteSize: bytes.length,
          sha256,
          parseStatus: "needs_ocr",
          parseStats: parsed.stats,
          storageKey,
          parserVersion: FILE_PARSER_VERSION
        }
      });
      return { file, source: null, snapshot: null, duplicated: false };
    }

    return await this.recordParsed({
      input: { ...input, file: null, storageKey, fileId, sha256 },
      parsed
    });
  }

  /* ---------------------------------------------------------------- *
   * Reads
   * ---------------------------------------------------------------- */

  async listFiles(sessionId: string): Promise<SourceFileRecord[]> {
    return await this.dependencies.files.listSourceFiles(sessionId);
  }

  async getFile(sessionId: string, fileId: string): Promise<SourceFileRecord> {
    try {
      return await this.dependencies.files.getSourceFile(sessionId, fileId);
    } catch (cause) {
      if (cause instanceof SourceFileNotFoundError) {
        throw new FileIngestionError(
          "未找到该文件：它可能不属于当前会话，或已被移除。",
          "file_not_found",
          HTTP_STATUS_BY_CODE.file_not_found,
          null
        );
      }
      throw cause;
    }
  }

  /**
   * What the reader shows for one file.
   *
   * An empty `content` only ever accompanies a recorded outcome (`needs_ocr` or
   * `failed`) that explains it, so the reader can say why rather than showing a
   * blank page that looks like a loading failure.
   */
  async readFileContent(input: {
    sessionId: string;
    fileId: string;
  }): Promise<SourceFileContent> {
    const file = await this.getFile(input.sessionId, input.fileId);
    if (!file.sourceId) {
      return {
        file,
        source: null,
        snapshot: null,
        content: "",
        contentType: SOURCE_FILE_CONTENT_TYPES[file.detectedKind]
      };
    }
    const source = await this.dependencies.evidence.getSource(
      input.sessionId,
      file.sourceId
    );
    const snapshot = await this.dependencies.evidence.getCurrentSnapshot(
      input.sessionId,
      file.sourceId
    );
    const content = snapshot?.content ?? "";
    const table = await this.tableFor(file.detectedKind, content);
    return {
      file,
      source,
      snapshot,
      content,
      contentType: snapshot?.contentType ?? SOURCE_FILE_CONTENT_TYPES[file.detectedKind],
      ...(table ? { table } : {})
    };
  }

  private async tableFor(
    kind: SourceFileRecord["detectedKind"],
    content: string
  ): Promise<CsvStructure | null> {
    if (kind !== "csv" || content.trim().length === 0) return null;
    try {
      return inspectCsv(content);
    } catch {
      // A csv we could once read but no longer recognise: the text is still
      // there to read, so the table is simply omitted rather than faked.
      return null;
    }
  }

  /* ---------------------------------------------------------------- *
   * Retry
   * ---------------------------------------------------------------- */

  /**
   * Re-reads the stored bytes of a file whose import did not succeed.
   *
   * Nothing is asked of the client beyond "please try again": the bytes come
   * from storage, so a retry cannot smuggle in different content, and nothing is
   * invented for sources that already exist.
   */
  async retryParse(input: {
    sessionId: string;
    fileId: string;
    actor: string;
  }): Promise<IngestedFile> {
    const file = await this.getFile(input.sessionId, input.fileId);
    const storageKey = await this.dependencies.files.getStorageKey(
      input.sessionId,
      input.fileId
    );
    let bytes: Uint8Array;
    try {
      bytes = await this.dependencies.storage.read(storageKey);
    } catch (cause) {
      throw new FileIngestionError(
        cause instanceof FileStorageError
          ? `无法读取已保存的文件：${cause.message}`
          : "无法读取已保存的文件：文件存储不可用。",
        "storage_unavailable",
        HTTP_STATUS_BY_CODE.storage_unavailable,
        file
      );
    }

    const detectedKind =
      detectSourceFileKind({ bytes, fileName: file.fileName }) ??
      file.detectedKind;

    try {
      const parsed = await parseDocument({
        bytes,
        kind: detectedKind,
        limits: { timeoutMs: this.dependencies.timeoutMs }
      });
      if (parsed.outcome === "needs_ocr") {
        const updated = await this.dependencies.files.settleParse({
          sessionId: input.sessionId,
          fileId: input.fileId,
          parseStatus: "needs_ocr",
          parseError: null,
          parseStats: parsed.stats
        });
        return { file: updated, source: null, snapshot: null, duplicated: false };
      }
      return await this.recordParsed({
        input: {
          sessionId: input.sessionId,
          fileName: file.fileName,
          declaredMimeType: file.declaredMimeType,
          actor: input.actor,
          bytes,
          file,
          storageKey,
          fileId: input.fileId,
          sha256: file.sha256
        },
        parsed
      });
    } catch (cause) {
      const failure = cause instanceof DocumentParseError ? cause : null;
      const message =
        failure?.message ?? "重新解析失败：无法提取其中的文本内容。";
      const code: FileIngestionFailureCode = failure?.code ?? "parse_failed";
      const updated = await this.dependencies.files.settleParse({
        sessionId: input.sessionId,
        fileId: input.fileId,
        parseStatus: "failed",
        parseError: message,
        parseStats: null
      });
      throw new FileIngestionError(
        message,
        code,
        HTTP_STATUS_BY_CODE[code],
        updated
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * Shared internals
   * ---------------------------------------------------------------- */

  /** A failed import must not leave bytes behind that nothing refers to. */
  private async put(
    sessionId: string,
    storageKey: string,
    bytes: Uint8Array
  ): Promise<void> {
    void sessionId;
    try {
      await this.dependencies.storage.put(storageKey, bytes);
    } catch (cause) {
      throw new FileIngestionError(
        cause instanceof FileStorageError
          ? `无法保存上传的文件：${cause.message}`
          : "无法保存上传的文件：文件存储不可用。",
        "storage_unavailable",
        HTTP_STATUS_BY_CODE.storage_unavailable,
        null
      );
    }
  }

  /**
   * Turns extracted text into a Source plus a Snapshot, then records the file
   * row that points at them.
   *
   * This is the only place this service writes anything a citation can later
   * refer to, and it does so through the evidence repository alone: the Source
   * becomes citable by exactly the same rules as any imported web page, and the
   * capture lands in the same snapshot table with the same content hash. No new
   * storage, no new verification path, no new way to become evidence.
   */
  private async recordParsed(input: {
    input: {
      sessionId: string;
      fileName: string;
      declaredMimeType: string;
      actor: string;
      bytes: Uint8Array;
      /** Set for retries, which update a row rather than creating one. */
      file: SourceFileRecord | null;
      storageKey: string;
      fileId: string;
      sha256: string;
    };
    parsed: Extract<ParsedDocument, { outcome: "parsed" }>;
  }): Promise<IngestedFile> {
    const {
      sessionId,
      fileName,
      declaredMimeType,
      actor,
      bytes,
      file,
      storageKey,
      fileId,
      sha256
    } = input.input;
    const { parsed } = input;
    const now = this.now().toISOString();
    const contentBytes = new TextEncoder().encode(parsed.content).length;
    const contentHash = sha256Of(new TextEncoder().encode(parsed.content));
    // A synthetic locator: content-addressed, so the same file version is always
    // the same Source and drift is detectable the same way a URL change is.
    const canonicalUrl = `file:///sha256/${sha256}`;

    let sourceId = file?.sourceId ?? null;
    let source: Source | null = null;
    let snapshot: SourceSnapshot | null = null;

    try {
      if (sourceId === null) {
        const registered = await this.registerSource({
          sessionId,
          fileName,
          sha256,
          canonicalUrl,
          contentHash,
          kind: parsed.kind,
          actor,
          now
        });
        sourceId = registered.id;
        source = registered;
      } else {
        source = await this.dependencies.evidence.getSource(sessionId, sourceId);
      }

      const recorded = await this.dependencies.evidence.recordRetrievalSuccess({
        snapshot: {
          id: deriveUuidV7("source-file-snapshot", sessionId, contentHash),
          sessionId,
          sourceId,
          canonicalUrl,
          contentHash,
          title: source?.title ?? fileName,
          contentType: SOURCE_FILE_CONTENT_TYPES[parsed.kind],
          content: parsed.content,
          contentBytes,
          charCount: parsed.content.length,
          retrievedAt: now,
          createdAt: now
        },
        source: {},
        event: {
          correlationId: sourceId,
          type: "SOURCE_RETRIEVED",
          payload: {
            sourceId,
            canonicalUrl,
            contentType: SOURCE_FILE_CONTENT_TYPES[parsed.kind],
            contentHash,
            charCount: parsed.content.length,
            // Same event type as a web import, marked so the trail can tell how
            // this source arrived without inventing a new event vocabulary.
            origin: "file-import",
            fileId,
            fileName,
            parserVersion: FILE_PARSER_VERSION,
            retrievedBy: actor
          }
        }
      });
      source = recorded.source;
      snapshot = recorded.snapshot;

      const stats: SourceFileParseStats = parsed.stats;
      const fileRecord = file
        ? await this.dependencies.files.settleParse({
            sessionId,
            fileId,
            parseStatus: "parsed",
            parseError: null,
            parseStats: stats,
            sourceId
          })
        : await this.dependencies.files.insertSourceFile({
            file: {
              id: fileId,
              sessionId,
              sourceId,
              fileName: this.fileName(fileName),
              declaredMimeType,
              detectedKind: parsed.kind,
              byteSize: bytes.length,
              sha256,
              parseStatus: "parsed",
              parseStats: stats,
              storageKey,
              parserVersion: FILE_PARSER_VERSION
            }
          });

      return { file: fileRecord, source, snapshot, duplicated: false };
    } catch (cause) {
      if (!file) {
        await this.dependencies.storage.remove(storageKey).catch(() => undefined);
      }
      throw cause;
    }
  }

  /** Creates the citable Source for a file whose text we could extract. */
  private async registerSource(input: {
    sessionId: string;
    fileName: string;
    sha256: string;
    canonicalUrl: string;
    contentHash: string;
    kind: SourceFileRecord["detectedKind"];
    actor: string;
    now: string;
  }): Promise<Source> {
    const title = await this.uniqueTitle(input.sessionId, input.fileName);
    const draft: Source = {
      id: deriveUuidV7("source-file-source", input.sessionId, input.sha256),
      sessionId: input.sessionId,
      title,
      kind: "document",
      // No publisher, author or date is invented: they are unknown until a
      // person supplies them, and a blank field is the honest answer.
      canonicalUrl: input.canonicalUrl,
      contentType: SOURCE_FILE_CONTENT_TYPES[input.kind],
      contentHash: input.contentHash,
      retrievalStatus: "pending",
      retrievalAttempts: 0,
      createdBy: "human",
      createdAt: input.now,
      updatedAt: input.now
    };
    const event = {
      correlationId: draft.id,
      type: "SOURCE_REGISTERED" as const,
      payload: {
        sourceId: draft.id,
        kind: "document" as const,
        origin: "file-import",
        fileName: input.fileName,
        registeredBy: input.actor
      }
    };

    try {
      const created = await this.dependencies.evidence.createSource(draft, event);
      return created.source;
    } catch (cause) {
      if (!(cause instanceof SourceTitleConflictError)) throw cause;
      // Lost a race for the title; fall back to a distinguishable name rather
      // than failing an import whose bytes are perfectly readable.
      const fallback = await this.dependencies.evidence.createSource(
        {
          ...draft,
          title: `${title} (${input.sha256.slice(0, 8)})`.slice(0, 240)
        },
        event
      );
      return fallback.source;
    }
  }

  /**
   * Keeps the file's own name on the record and only disambiguates Source
   * titles, which must be unique per session.
   *
   * Two files called `report.pdf` with different bytes stay two files; this only
   * makes their Sources addressable. The original name is preserved on the file
   * row, so nothing is quietly rewritten.
   */
  private async uniqueTitle(
    sessionId: string,
    fileName: string
  ): Promise<string> {
    const taken = new Set(
      (await this.dependencies.evidence.listSources(sessionId)).map(
        (source) => source.title
      )
    );
    const trimmed = fileName.trim().slice(0, 240) || "未命名文件";
    if (!taken.has(trimmed)) return trimmed;
    const dot = trimmed.lastIndexOf(".");
    const stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
    const extension = dot > 0 ? trimmed.slice(dot) : "";
    for (let attempt = 2; attempt <= 999; attempt += 1) {
      const candidate = `${stem} (${attempt})${extension}`.slice(0, 240);
      if (!taken.has(candidate)) return candidate;
    }
    return `${stem} (${Date.now()})${extension}`.slice(0, 240);
  }

  private fileName(name: string): string {
    return name.trim().slice(0, 240) || "未命名文件";
  }
}
