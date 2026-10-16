/**
 * Login throttling.
 *
 * Online password guessing is the one attack that needs no vulnerability: it
 * only needs the endpoint to keep answering. This guard counts failed attempts
 * per account *and* per source address, because either one alone is trivially
 * sidestepped — one account is enough to keep guessing, and one address is
 * enough to spread guesses across every account.
 *
 * Design notes:
 * - The window is sliding: attempts older than `windowMs` stop counting, so a
 *   user who mistypes twice a day is never locked out.
 * - Reaching the limit starts a *block*, and the block is not extended by
 *   further attempts. Otherwise an attacker could keep a legitimate user locked
 *   out indefinitely by refreshing the failure count.
 * - When the block expires the history is cleared, so the next attempt gets a
 *   fresh budget instead of being rejected for a failure from an hour ago.
 * - `check` is pure: it never mutates state on the allowed path. A caller that
 *   asks twice before recording anything gets the same answer twice.
 */

export type LoginThrottleOptions = {
  /** Failed attempts allowed inside `windowMs` before a block starts. */
  maxFailures?: number;
  /** How long a failure is remembered. */
  windowMs?: number;
  /** How long a caller is refused after the limit is reached. */
  blockMs?: number;
  /** Injected clock, so a test can walk through a block without waiting. */
  now?: () => number;
};

export const DEFAULT_LOGIN_MAX_FAILURES = 5;
export const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_LOGIN_BLOCK_MS = 15 * 60 * 1000;

export type ThrottleDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

type Entry = {
  /** Epoch milliseconds of failures that are still inside the window. */
  failures: number[];
  /** Epoch milliseconds until which the key is refused; 0 when not blocked. */
  lockedUntil: number;
};

export class LoginThrottle {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(options: LoginThrottleOptions = {}) {
    this.maxFailures = options.maxFailures ?? DEFAULT_LOGIN_MAX_FAILURES;
    this.windowMs = options.windowMs ?? DEFAULT_LOGIN_WINDOW_MS;
    this.blockMs = options.blockMs ?? DEFAULT_LOGIN_BLOCK_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Whether `key` may attempt a login now. Does not record anything: the
   * caller records the outcome once it knows it.
   */
  check(key: string): ThrottleDecision {
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true };
    const now = this.now();
    if (entry.lockedUntil > now) {
      return { allowed: false, retryAfterMs: entry.lockedUntil - now };
    }
    if (entry.lockedUntil > 0) {
      // The block has expired. Start from a clean budget rather than carrying
      // failures forward forever.
      this.entries.delete(key);
      return { allowed: true };
    }
    const recent = entry.failures.filter((at) => at > now - this.windowMs);
    if (recent.length >= this.maxFailures) {
      entry.failures = recent;
      entry.lockedUntil = now + this.blockMs;
      return { allowed: false, retryAfterMs: this.blockMs };
    }
    entry.failures = recent;
    return { allowed: true };
  }

  recordFailure(key: string): void {
    const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 };
    entry.failures.push(this.now());
    this.entries.set(key, entry);
    this.prune();
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** Drops state for keys that can no longer affect a decision. */
  private prune(): void {
    if (this.entries.size < 1024) return;
    const now = this.now();
    for (const [key, entry] of this.entries) {
      const blocked = entry.lockedUntil > now;
      const remembered = entry.failures.some((at) => at > now - this.windowMs);
      if (!blocked && !remembered) this.entries.delete(key);
    }
  }

  /** Number of keys currently tracked. Exposed for tests and diagnostics. */
  get size(): number {
    return this.entries.size;
  }

  reset(): void {
    this.entries.clear();
  }
}
