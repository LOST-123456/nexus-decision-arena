import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type Database } from "@nexus/db";
import {
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
});
