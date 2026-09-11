import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore } from "./idempotency";

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

    await expect(store.get("key-1", "hash-2")).rejects.toThrow(
      "Idempotency key reused with a different request"
    );
  });
});
