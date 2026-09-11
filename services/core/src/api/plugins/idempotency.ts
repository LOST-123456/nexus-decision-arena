import { createHash } from "node:crypto";

type StoredResult = {
  status: "completed";
  response: unknown;
};

type StoredEntry = {
  requestHash: string;
  result: Promise<StoredResult>;
};

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key reused with a different request");
    this.name = "IdempotencyConflictError";
  }
}

export class InMemoryIdempotencyStore {
  private readonly values = new Map<string, StoredEntry>();

  async get(key: string, requestHash: string): Promise<StoredResult | null> {
    const value = this.values.get(key);
    if (!value) {
      return null;
    }
    this.assertSameHash(value, requestHash);
    return value.result;
  }

  async execute<T>(
    key: string,
    requestHash: string,
    operation: () => Promise<T>
  ): Promise<StoredResult & { response: T }> {
    const value = this.values.get(key);
    if (value) {
      this.assertSameHash(value, requestHash);
      return (await value.result) as StoredResult & { response: T };
    }

    const result = this.run(key, requestHash, operation);
    this.values.set(key, { requestHash, result });
    return (await result) as StoredResult & { response: T };
  }

  async save(
    key: string,
    requestHash: string,
    response: unknown
  ): Promise<void> {
    const existing = this.values.get(key);
    if (existing) {
      this.assertSameHash(existing, requestHash);
      return;
    }

    this.values.set(key, {
      requestHash,
      result: Promise.resolve({
        status: "completed",
        response
      })
    });
  }

  static hash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  private async run<T>(
    key: string,
    requestHash: string,
    operation: () => Promise<T>
  ): Promise<StoredResult> {
    try {
      return {
        status: "completed",
        response: await operation()
      };
    } catch (error) {
      this.values.delete(key);
      throw error;
    }
  }

  private assertSameHash(value: StoredEntry, requestHash: string): void {
    if (value.requestHash !== requestHash) {
      throw new IdempotencyConflictError();
    }
  }
}
