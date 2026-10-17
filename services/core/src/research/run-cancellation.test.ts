import { describe, expect, it, vi } from "vitest";
import { RunCancellationRegistry } from "./run-cancellation";

/**
 * The registry is an accelerator, not a ledger. These tests pin both halves of
 * that claim: it really does abort the run it owns, and it answers "no" for
 * everything it does not own — which is the answer a second instance must be
 * able to give.
 */
describe("RunCancellationRegistry", () => {
  it("hands out one signal per run and keeps it addressable", () => {
    const registry = new RunCancellationRegistry();
    const signal = registry.begin("run-1");

    expect(signal.aborted).toBe(false);
    expect(registry.signal("run-1")).toBe(signal);
    expect(registry.activeCount).toBe(1);
  });

  it("aborts exactly the run it was asked about", () => {
    const registry = new RunCancellationRegistry();
    const first = registry.begin("run-1");
    const second = registry.begin("run-2");

    expect(registry.cancel("run-1")).toBe(true);
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
  });

  it("answers false for a run it never registered", () => {
    const registry = new RunCancellationRegistry();
    // The cross-instance case: another process is running this one.
    expect(registry.cancel("run-elsewhere")).toBe(false);
    expect(registry.signal("run-elsewhere")).toBeUndefined();
  });

  it("does not report the same stop twice", () => {
    const registry = new RunCancellationRegistry();
    registry.begin("run-1");

    expect(registry.cancel("run-1")).toBe(true);
    // A second cancel changes nothing; claiming it delivered a signal would
    // make two requests look like two stops.
    expect(registry.cancel("run-1")).toBe(false);
  });

  it("forgets a run once it is released", () => {
    const registry = new RunCancellationRegistry();
    registry.begin("run-1");
    registry.end("run-1");

    expect(registry.activeCount).toBe(0);
    expect(registry.signal("run-1")).toBeUndefined();
    expect(registry.cancel("run-1")).toBe(false);
  });

  it("notifies a listener that was already waiting when the abort lands", () => {
    const registry = new RunCancellationRegistry();
    const signal = registry.begin("run-1");
    const listener = vi.fn();
    signal.addEventListener("abort", listener);

    registry.cancel("run-1");

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps runs independent when one ends and another is cancelled", () => {
    const registry = new RunCancellationRegistry();
    registry.begin("run-1");
    const second = registry.begin("run-2");

    registry.end("run-1");
    expect(registry.cancel("run-2")).toBe(true);
    expect(second.aborted).toBe(true);
    expect(registry.activeCount).toBe(1);
  });
});
