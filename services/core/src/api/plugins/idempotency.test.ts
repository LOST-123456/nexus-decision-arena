import { describe, expect, it, vi } from "vitest";
import {
  IdempotencyConflictError,
  InMemoryIdempotencyStore
} from "./idempotency";

describe("idempotency store", () => {
  it("returns the stored result for the same key and request hash", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.save("key-1", "hash-1", { id: "session-1" });

    await expect(store.get("key-1", "hash-1")).resolves.toEqual({
      status: "completed",
      response: { id: "session-1" }
    });
  });

  it("rejects reusing a key for a different request", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.save("key-1", "hash-1", { id: "session-1" });

    await expect(store.get("key-1", "hash-2")).rejects.toBeInstanceOf(
      IdempotencyConflictError
    );
  });

  it("runs one operation for concurrent same-key requests", async () => {
    const store = new InMemoryIdempotencyStore();
    let resolveOperation!: (value: { id: string }) => void;
    const operation = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveOperation = resolve;
        })
    );

    const first = store.execute("key-1", "hash-1", operation);
    const second = store.execute("key-1", "hash-1", operation);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(operation).toHaveBeenCalledTimes(1);
    resolveOperation({ id: "session-1" });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "completed", response: { id: "session-1" } },
      { status: "completed", response: { id: "session-1" } }
    ]);
  });
});
