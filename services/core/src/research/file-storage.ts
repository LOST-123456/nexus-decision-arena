import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/*
 * Where uploaded bytes live.
 *
 * The database deliberately stores no binary content: a `source_files` row holds
 * a key, and this module holds the bytes. Three rules follow from that split:
 *
 *   - **Keys are opaque and generated.** Nothing a client sends becomes part of a
 *     path. Every key is `<session uuid>/<file uuid>` and is re-validated here,
 *     including after joining, so no amount of clever input can walk out of the
 *     storage root.
 *   - **There is no public surface.** Files are read only through the session's
 *     own endpoints, which are authenticated and session-scoped. Nothing here is
 *     served statically, and nothing is resolved from a request-supplied path.
 *   - **Nothing here interprets content.** Stored bytes are returned unchanged
 *     and re-parsed, never executed, never opened "as a document" by anything
 *     that would honour macros, scripts or embedded external references.
 */

export interface SourceFileStorage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array>;
  /** Best-effort removal, used to clean up after a failed import. */
  remove(key: string): Promise<void>;
}

export class FileStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileStorageError";
  }
}

const KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertKey(key: string): void {
  // Validated before use rather than after resolution: a key we did not mint is
  // not something we should even try to open.
  if (!KEY_PATTERN.test(key)) {
    throw new FileStorageError("Refusing to use an unrecognized storage key");
  }
}

/** The only way a key comes into existence. */
export function fileStorageKey(sessionId: string, fileId: string): string {
  const key = `${sessionId}/${fileId}`;
  assertKey(key);
  return key;
}

/** Files under `<root>/<sessionId>/<fileId>`, root resolved once at startup. */
export class DiskFileStorage implements SourceFileStorage {
  constructor(private readonly root: string) {}

  private target(key: string): string {
    assertKey(key);
    const base = path.resolve(this.root);
    const resolved = path.resolve(base, key);
    // Belt and braces: even with an allow-listed key, the join is re-checked, so
    // escaping the root is impossible rather than merely unexpected.
    if (!resolved.startsWith(base + path.sep)) {
      throw new FileStorageError("Resolved path escapes the storage root");
    }
    return resolved;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.target(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  async read(key: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.target(key)));
    } catch (cause) {
      throw new FileStorageError(
        `Stored file could not be read: ${cause instanceof Error ? cause.message : "unknown error"}`
      );
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await rm(this.target(key), { force: true });
    } catch {
      // A leftover file is not worth failing an import over; nothing is lost
      // beyond disk space, and wiping must never become a hard dependency.
    }
  }
}

/** Used by tests: same contract, no filesystem. */
export class InMemoryFileStorage implements SourceFileStorage {
  private readonly entries = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    assertKey(key);
    this.entries.set(key, bytes);
  }

  async read(key: string): Promise<Uint8Array> {
    const found = this.entries.get(key);
    if (!found) throw new FileStorageError("Stored file could not be read: not found");
    return found;
  }

  async remove(key: string): Promise<void> {
    this.entries.delete(key);
  }
}
