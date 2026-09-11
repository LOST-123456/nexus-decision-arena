import { createHash } from "node:crypto";

type StoredResult = {
  status: "completed";
  response: unknown;
};

export class InMemoryIdempotencyStore {
  private readonly values = new Map<
    string,
    { requestHash: string; result: StoredResult }
  >();

  async get(key: string, requestHash: string): Promise<StoredResult | null> {
    const value = this.values.get(key);
    if (!value) {
      return null;
    }
    if (value.requestHash !== requestHash) {
      throw new Error("Idempotency key reused with a different request");
    }
    return value.result;
  }

  async save(
    key: string,
    requestHash: string,
    response: unknown
  ): Promise<void> {
    this.values.set(key, {
      requestHash,
      result: { status: "completed", response }
    });
  }

  static hash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }
}
