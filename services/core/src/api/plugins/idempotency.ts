import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { idempotencyKeys, type Database } from "@nexus/db";

export type StoredResult = {
  status: "completed";
  response: unknown;
};

export interface IdempotencyStore {
  get(key: string, requestHash: string): Promise<StoredResult | null>;
  execute<T>(
    key: string,
    requestHash: string,
    operation: () => Promise<T>
  ): Promise<StoredResult & { response: T }>;
  save(key: string, requestHash: string, response: unknown): Promise<void>;
}

type StoredEntry = {
  requestHash: string;
  result: Promise<StoredResult>;
};

type IdempotencyRow = typeof idempotencyKeys.$inferSelect;
type Lease = {
  token: string;
  expiresAt: string;
};

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key reused with a different request");
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for the concurrent idempotent operation");
    this.name = "IdempotencyTimeoutError";
  }
}

export class IdempotencyLeaseLostError extends Error {
  constructor() {
    super("Idempotency lease was lost before the operation completed");
    this.name = "IdempotencyLeaseLostError";
  }
}

export function hashIdempotencyRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertSameHash(requestHash: string, expected: string): void {
  if (requestHash !== expected) {
    throw new IdempotencyConflictError();
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly values = new Map<string, StoredEntry>();

  async get(key: string, requestHash: string): Promise<StoredResult | null> {
    const value = this.values.get(key);
    if (!value) {
      return null;
    }
    assertSameHash(value.requestHash, requestHash);
    return value.result;
  }

  async execute<T>(
    key: string,
    requestHash: string,
    operation: () => Promise<T>
  ): Promise<StoredResult & { response: T }> {
    const value = this.values.get(key);
    if (value) {
      assertSameHash(value.requestHash, requestHash);
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
      assertSameHash(existing.requestHash, requestHash);
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
    return hashIdempotencyRequest(value);
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
}

export type PostgresIdempotencyStoreOptions = {
  processingTimeoutMs?: number;
  pollIntervalMs?: number;
  staleProcessingMs?: number;
  leaseDurationMs?: number;
};

export const IDEMPOTENCY_LEASE_DURATION_MS = 5 * 60_000;
export const IDEMPOTENCY_STALE_PROCESSING_MS =
  IDEMPOTENCY_LEASE_DURATION_MS;
const DEFAULT_PROCESSING_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

export class PostgresIdempotencyStore implements IdempotencyStore {
  private readonly processingTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;

  constructor(
    private readonly database: Database,
    options: PostgresIdempotencyStoreOptions = {}
  ) {
    this.processingTimeoutMs =
      options.processingTimeoutMs ?? DEFAULT_PROCESSING_TIMEOUT_MS;
    this.pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.leaseDurationMs =
      options.leaseDurationMs ??
      options.staleProcessingMs ??
      IDEMPOTENCY_LEASE_DURATION_MS;
  }

  async get(key: string, requestHash: string): Promise<StoredResult | null> {
    const row = await this.read(key);
    if (!row) {
      return null;
    }
    assertSameHash(row.requestHash, requestHash);
    if (row.status !== "completed") {
      return null;
    }
    return { status: "completed", response: row.response };
  }

  async execute<T>(
    key: string,
    requestHash: string,
    operation: () => Promise<T>
  ): Promise<StoredResult & { response: T }> {
    const initialLease = await this.reserve(key, requestHash);
    if (initialLease) {
      return this.run(key, requestHash, initialLease, operation);
    }

    const deadline = Date.now() + this.processingTimeoutMs;
    while (true) {
      const row = await this.read(key);

      if (!row) {
        const lease = await this.reserve(key, requestHash);
        if (lease) {
          return this.run(key, requestHash, lease, operation);
        }
      } else {
        assertSameHash(row.requestHash, requestHash);

        if (row.status === "completed") {
          return {
            status: "completed",
            response: row.response as T
          };
        }

        if (row.status === "failed") {
          await this.database
            .delete(idempotencyKeys)
            .where(
              and(
                eq(idempotencyKeys.key, key),
                eq(idempotencyKeys.requestHash, requestHash),
                eq(idempotencyKeys.status, "failed")
              )
            );
          continue;
        }

        const reclaimedLease = await this.reclaimStale(key, requestHash);
        if (reclaimedLease) {
          return this.run(key, requestHash, reclaimedLease, operation);
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new IdempotencyTimeoutError();
      }
      await delay(Math.min(this.pollIntervalMs, remaining));
    }
  }

  async save(
    key: string,
    requestHash: string,
    response: unknown
  ): Promise<void> {
    const row = await this.read(key);
    if (row) {
      assertSameHash(row.requestHash, requestHash);
      if (row.status === "completed") {
        return;
      }
    }

    await this.database
      .insert(idempotencyKeys)
      .values({
        key,
        requestHash,
        status: "completed",
        response
      })
      .onConflictDoNothing();

    const saved = await this.read(key);
    if (!saved) {
      throw new Error("Idempotency result was not saved");
    }
    assertSameHash(saved.requestHash, requestHash);
  }

  private createLease(): Lease {
    return {
      token: randomUUID(),
      expiresAt: new Date(Date.now() + this.leaseDurationMs).toISOString()
    };
  }

  private async reclaimStale(
    key: string,
    requestHash: string
  ): Promise<string | null> {
    const now = new Date();
    const nowIso = now.toISOString();
    const lease = this.createLease();
    const reclaimed = await this.database
      .update(idempotencyKeys)
      .set({
        status: "processing",
        response: null,
        leaseToken: lease.token,
        leaseExpiresAt: lease.expiresAt,
        updatedAt: nowIso
      })
      .where(
        and(
          eq(idempotencyKeys.key, key),
          eq(idempotencyKeys.requestHash, requestHash),
          eq(idempotencyKeys.status, "processing"),
          or(
            isNull(idempotencyKeys.leaseExpiresAt),
            lt(idempotencyKeys.leaseExpiresAt, nowIso)
          )
        )
      )
      .returning({ leaseToken: idempotencyKeys.leaseToken });

    return reclaimed[0]?.leaseToken ?? null;
  }

  private async reserve(
    key: string,
    requestHash: string
  ): Promise<string | null> {
    const lease = this.createLease();
    const inserted = await this.database
      .insert(idempotencyKeys)
      .values({
        key,
        requestHash,
        status: "processing",
        leaseToken: lease.token,
        leaseExpiresAt: lease.expiresAt
      })
      .onConflictDoNothing()
      .returning({ leaseToken: idempotencyKeys.leaseToken });

    return inserted[0]?.leaseToken ?? null;
  }

  private async run<T>(
    key: string,
    requestHash: string,
    leaseToken: string,
    operation: () => Promise<T>
  ): Promise<StoredResult & { response: T }> {
    let response: T;
    try {
      response = await operation();
    } catch (error) {
      await this.releaseLease(key, requestHash, leaseToken);
      throw error;
    }

    const completed = await this.database
      .update(idempotencyKeys)
      .set({
        status: "completed",
        response: response ?? null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date().toISOString()
      })
      .where(
        and(
          eq(idempotencyKeys.key, key),
          eq(idempotencyKeys.requestHash, requestHash),
          eq(idempotencyKeys.status, "processing"),
          eq(idempotencyKeys.leaseToken, leaseToken)
        )
      )
      .returning({ key: idempotencyKeys.key });

    if (completed.length === 0) {
      throw new IdempotencyLeaseLostError();
    }

    return { status: "completed", response };
  }

  private async releaseLease(
    key: string,
    requestHash: string,
    leaseToken: string
  ): Promise<void> {
    await this.database
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.key, key),
          eq(idempotencyKeys.requestHash, requestHash),
          eq(idempotencyKeys.status, "processing"),
          eq(idempotencyKeys.leaseToken, leaseToken)
        )
      );
  }

  private async read(key: string): Promise<IdempotencyRow | null> {
    const [row] = await this.database
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))
      .limit(1);

    return row ?? null;
  }
}
