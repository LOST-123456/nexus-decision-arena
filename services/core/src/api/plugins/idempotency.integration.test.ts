import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  idempotencyKeys,
  type Database
} from "@nexus/db";
import {
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  PostgresIdempotencyStore
} from "./idempotency";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const database: Database = createDatabase(databaseUrl);

beforeEach(async () => {
  await database.execute("TRUNCATE idempotency_keys");
});

afterAll(async () => {
  await database.end();
});

describe("PostgresIdempotencyStore", () => {
  it("deduplicates concurrent same-key operations across store instances", async () => {
    const firstStore = new PostgresIdempotencyStore(database, {
      processingTimeoutMs: 500,
      pollIntervalMs: 5
    });
    const secondStore = new PostgresIdempotencyStore(database, {
      processingTimeoutMs: 500,
      pollIntervalMs: 5
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const operation = vi.fn(async () => {
      signalStarted();
      await operationGate;
      return { id: "session-1" };
    });

    const first = firstStore.execute("shared-key", "hash-1", operation);
    await started;
    const second = secondStore.execute("shared-key", "hash-1", operation);
    releaseOperation();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "completed", response: { id: "session-1" } },
      { status: "completed", response: { id: "session-1" } }
    ]);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("removes a failed reservation so a later request can retry", async () => {
    const store = new PostgresIdempotencyStore(database, {
      processingTimeoutMs: 500,
      pollIntervalMs: 5
    });
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ id: "session-1" });

    await expect(store.execute("retry-key", "hash-1", operation)).rejects.toThrow(
      "temporary failure"
    );
    await expect(
      store.execute("retry-key", "hash-1", operation)
    ).resolves.toEqual({
      status: "completed",
      response: { id: "session-1" }
    });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("times out when another process leaves the operation in progress", async () => {
    const firstStore = new PostgresIdempotencyStore(database, {
      processingTimeoutMs: 500,
      pollIntervalMs: 5
    });
    const waitingStore = new PostgresIdempotencyStore(database, {
      processingTimeoutMs: 30,
      pollIntervalMs: 5
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const operation = vi.fn(async () => {
      signalStarted();
      await operationGate;
      return { id: "session-1" };
    });

    const owner = firstStore.execute("timeout-key", "hash-1", operation);
    await started;

    await expect(
      waitingStore.execute("timeout-key", "hash-1", operation)
    ).rejects.toBeInstanceOf(IdempotencyTimeoutError);

    releaseOperation();
    await owner;
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("reclaims an old processing reservation and executes it", async () => {
    await database.insert(idempotencyKeys).values({
      key: "stale-key",
      requestHash: "hash-1",
      status: "processing",
      response: null,
      leaseToken: "old-lease",
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 60_000).toISOString()
    });
    const store = new PostgresIdempotencyStore(database, {
      processingTimeoutMs: 500,
      pollIntervalMs: 5,
      staleProcessingMs: 10
    });
    const operation = vi.fn().mockResolvedValue({ id: "session-1" });

    await expect(
      store.execute("stale-key", "hash-1", operation)
    ).resolves.toEqual({
      status: "completed",
      response: { id: "session-1" }
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("keeps a hash mismatch as a conflict instead of reclaiming it", async () => {
    await database.insert(idempotencyKeys).values({
      key: "stale-conflict-key",
      requestHash: "hash-1",
      status: "processing",
      response: null,
      leaseToken: "old-lease",
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 60_000).toISOString()
    });
    const store = new PostgresIdempotencyStore(database, {
      processingTimeoutMs: 500,
      pollIntervalMs: 5,
      staleProcessingMs: 10
    });
    const operation = vi.fn().mockResolvedValue({ id: "session-1" });

    await expect(
      store.execute("stale-conflict-key", "hash-2", operation)
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(operation).not.toHaveBeenCalled();
  });

  it("elects one reclaimer for an expired lease", async () => {
    await database.insert(idempotencyKeys).values({
      key: "race-reclaim-key",
      requestHash: "hash-1",
      status: "processing",
      response: null,
      leaseToken: "old-lease",
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 60_000).toISOString()
    });
    const firstStore = new PostgresIdempotencyStore(database, {
      processingTimeoutMs: 500,
      pollIntervalMs: 5,
      staleProcessingMs: 10,
      leaseDurationMs: 500
    });
    const secondStore = new PostgresIdempotencyStore(database, {
      processingTimeoutMs: 500,
      pollIntervalMs: 5,
      staleProcessingMs: 10,
      leaseDurationMs: 500
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const operation = vi.fn(async () => {
      signalStarted();
      await operationGate;
      return { id: "session-1" };
    });

    const first = firstStore.execute("race-reclaim-key", "hash-1", operation);
    const second = secondStore.execute("race-reclaim-key", "hash-1", operation);
    await started;
    releaseOperation();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "completed", response: { id: "session-1" } },
      { status: "completed", response: { id: "session-1" } }
    ]);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("prevents an expired owner from completing after a newer reclaim", async () => {
    const firstStore = new PostgresIdempotencyStore(database, {
      processingTimeoutMs: 500,
      pollIntervalMs: 5,
      staleProcessingMs: 10,
      leaseDurationMs: 10
    });
    const secondStore = new PostgresIdempotencyStore(database, {
      processingTimeoutMs: 500,
      pollIntervalMs: 5,
      staleProcessingMs: 10,
      leaseDurationMs: 500
    });
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = firstStore.execute("old-owner-key", "hash-1", async () => {
      signalFirstStarted();
      await firstGate;
      return { id: "old-owner" };
    });

    await firstStarted;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const reclaimed = await secondStore.execute(
      "old-owner-key",
      "hash-1",
      async () => ({ id: "new-owner" })
    );
    releaseFirst();

    await expect(first).rejects.toBeInstanceOf(IdempotencyLeaseLostError);
    expect(reclaimed).toEqual({
      status: "completed",
      response: { id: "new-owner" }
    });
  });
});
