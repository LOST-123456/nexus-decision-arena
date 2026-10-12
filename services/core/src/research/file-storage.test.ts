import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DiskFileStorage,
  FileStorageError,
  InMemoryFileStorage,
  fileStorageKey
} from "./file-storage";

/**
 * Storage tests, aimed squarely at the security properties:
 *  - a key we did not mint is refused before anything touches the filesystem;
 *  - nothing can escape the storage root, even with a key built by hand;
 *  - what goes in comes back byte for byte, and removal is safe to repeat.
 *
 * The session id doubles as the first key segment, so these two together are
 * also the boundary that keeps one session from reaching another session's
 * bytes: there is no key that names another session's directory.
 */

const SESSION_ID = "8b1e9c34-6f52-4c1a-9a2b-0f6d5c4e3a21";
const FILE_ID = "1f9d0a77-2c8b-4f6e-8d1a-3e7c9b5a4d22";
const FILE_ID_B = "c3a1f0e2-77aa-4b1d-9e2f-8c5b6a7d9e10";

const scratch = await mkdtemp(path.join(tmpdir(), "nexus-file-storage-"));
const disk = new DiskFileStorage(scratch);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("fileStorageKey", () => {
  it("mints a two-level key from two uuids", () => {
    expect(fileStorageKey(SESSION_ID, FILE_ID)).toBe(`${SESSION_ID}/${FILE_ID}`);
  });

  it("refuses anything that is not a uuid pair", () => {
    expect(() => fileStorageKey("../../etc", FILE_ID)).toThrow(FileStorageError);
    expect(() => fileStorageKey(SESSION_ID, "passwd")).toThrow(FileStorageError);
    expect(() => fileStorageKey(SESSION_ID, `${FILE_ID}/../../passwd`)).toThrow(
      FileStorageError
    );
  });
});

describe("DiskFileStorage", () => {
  it("round-trips bytes unchanged", async () => {
    const key = fileStorageKey(SESSION_ID, FILE_ID);
    const bytes = new TextEncoder().encode("原文 bilingual \u00b7 \u0026 punctuation");
    await disk.put(key, bytes);
    expect(await disk.read(key)).toEqual(bytes);
  });

  it("keeps each file addressable separately", async () => {
    await disk.put(
      fileStorageKey(SESSION_ID, FILE_ID_B),
      new TextEncoder().encode("second file")
    );
    expect(new TextDecoder().decode(await disk.read(fileStorageKey(SESSION_ID, FILE_ID)))).toContain(
      "原文"
    );
    expect(
      new TextDecoder().decode(await disk.read(fileStorageKey(SESSION_ID, FILE_ID_B)))
    ).toBe("second file");
  });

  it("refuses a key that would resolve outside the root", async () => {
    // Even with a well-formed pair, the stored key is never a client string: the
    // check exists for the case where somebody builds one by hand.
    await expect(disk.read(`../../../Windows/win.ini`)).rejects.toBeInstanceOf(
      FileStorageError
    );
    await expect(
      disk.put(`${SESSION_ID}/${FILE_ID}/../../escape`, new Uint8Array([1]))
    ).rejects.toBeInstanceOf(FileStorageError);
  });

  it("treats removal of an absent file as a no-op", async () => {
    await expect(
      disk.remove(fileStorageKey(SESSION_ID, "00000000-0000-4000-8000-000000000000"))
    ).resolves.toBeUndefined();
  });

  it("fails to read what was removed", async () => {
    const key = fileStorageKey(SESSION_ID, FILE_ID_B);
    await disk.remove(key);
    await expect(disk.read(key)).rejects.toBeInstanceOf(FileStorageError);
  });
});

describe("InMemoryFileStorage", () => {
  it("has the same contract, without touching disk", async () => {
    const storage = new InMemoryFileStorage();
    const key = fileStorageKey(SESSION_ID, FILE_ID);
    await storage.put(key, new Uint8Array([7, 8, 9]));
    expect(await storage.read(key)).toEqual(new Uint8Array([7, 8, 9]));
    await storage.remove(key);
    await expect(storage.read(key)).rejects.toBeInstanceOf(FileStorageError);
  });
});
