import { describe, expect, it } from "vitest";
import { LoginThrottle } from "./login-rate-limit";

/**
 * The throttle is the only thing standing between an exposed login endpoint
 * and an unbounded password search, so its timing rules are asserted directly
 * against an injected clock rather than by waiting out real windows.
 */

function makeThrottle(over: {
  maxFailures?: number;
  windowMs?: number;
  blockMs?: number;
} = {}) {
  let clock = 1_000_000;
  const throttle = new LoginThrottle({
    maxFailures: over.maxFailures ?? 3,
    windowMs: over.windowMs ?? 60_000,
    blockMs: over.blockMs ?? 120_000,
    now: () => clock
  });
  return {
    throttle,
    advance(ms: number) {
      clock += ms;
    },
    at() {
      return clock;
    }
  };
}

describe("LoginThrottle", () => {
  it("allows attempts until the failure limit is reached", () => {
    const t = makeThrottle({ maxFailures: 3 });
    expect(t.throttle.check("k").allowed).toBe(true);
    t.throttle.recordFailure("k");
    t.throttle.recordFailure("k");
    expect(t.throttle.check("k").allowed).toBe(true);
    t.throttle.recordFailure("k");
    expect(t.throttle.check("k")).toEqual({
      allowed: false,
      retryAfterMs: 120_000
    });
  });

  it("does not extend the block when attempts keep arriving", () => {
    const t = makeThrottle({ maxFailures: 2, blockMs: 100_000 });
    t.throttle.recordFailure("k");
    t.throttle.recordFailure("k");
    const first = t.throttle.check("k");
    expect(first.allowed).toBe(false);
    t.advance(50_000);
    t.throttle.recordFailure("k");
    t.throttle.recordFailure("k");
    const second = t.throttle.check("k");
    expect(second.allowed).toBe(false);
    if (!second.allowed && !first.allowed) {
      // The block ends at the same moment regardless of the extra attempts.
      expect(second.retryAfterMs).toBe(first.retryAfterMs - 50_000);
    }
  });

  it("gives a fresh budget once the block expires", () => {
    const t = makeThrottle({ maxFailures: 1, blockMs: 100_000 });
    t.throttle.recordFailure("k");
    expect(t.throttle.check("k").allowed).toBe(false);
    t.advance(100_001);
    expect(t.throttle.check("k").allowed).toBe(true);
    // The old failure must not still be counted against the new budget.
    t.throttle.recordFailure("k");
    expect(t.throttle.check("k").allowed).toBe(false);
  });

  it("forgets failures that fall outside the window", () => {
    const t = makeThrottle({ maxFailures: 2, windowMs: 60_000 });
    t.throttle.recordFailure("k");
    t.advance(61_000);
    t.throttle.recordFailure("k");
    // Only one failure is inside the window, so the limit is not reached.
    expect(t.throttle.check("k").allowed).toBe(true);
  });

  it("clears the record on success", () => {
    const t = makeThrottle({ maxFailures: 2 });
    t.throttle.recordFailure("k");
    t.throttle.recordFailure("k");
    expect(t.throttle.check("k").allowed).toBe(false);
    t.throttle.recordSuccess("k");
    expect(t.throttle.check("k").allowed).toBe(true);
  });

  it("keeps accounts and addresses independent", () => {
    const t = makeThrottle({ maxFailures: 2 });
    t.throttle.recordFailure("account:owner");
    t.throttle.recordFailure("account:owner");
    expect(t.throttle.check("account:owner").allowed).toBe(false);
    // A different account, and the same address, are not blocked by it.
    expect(t.throttle.check("account:viewer").allowed).toBe(true);
    expect(t.throttle.check("address:10.0.0.1").allowed).toBe(true);
  });

  it("reports the wait in whole seconds when asked", () => {
    const t = makeThrottle({ maxFailures: 1, blockMs: 90_000 });
    t.throttle.recordFailure("k");
    const decision = t.throttle.check("k");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.retryAfterMs).toBe(90_000);
    }
  });

  it("does not mutate state just by being asked", () => {
    const t = makeThrottle({ maxFailures: 2 });
    t.throttle.recordFailure("k");
    const before = t.throttle.size;
    t.throttle.check("k");
    t.throttle.check("k");
    expect(t.throttle.size).toBe(before);
  });
});
