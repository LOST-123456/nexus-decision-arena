import { describe, expect, it, vi } from "vitest";
import { newId } from "@nexus/shared";
import { EventBus } from "./event-bus";

describe("event bus", () => {
  it("delivers only after the append operation resolves", async () => {
    const listener = vi.fn();
    const bus = new EventBus();
    bus.subscribe("00000000-0000-7000-8000-000000000001", listener);

    await bus.publishAfterCommit({
      append: async () => ({
        id: newId(),
        sessionId: "00000000-0000-7000-8000-000000000001",
        sequence: 1,
        correlationId: newId(),
        type: "SESSION_STATE_CHANGED",
        payload: {},
        occurredAt: new Date().toISOString()
      })
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops delivery after unsubscribe", async () => {
    const listener = vi.fn();
    const sessionId = newId();
    const bus = new EventBus();
    const unsubscribe = bus.subscribe(sessionId, listener);

    unsubscribe();
    await bus.publishAfterCommit({
      append: async () => ({
        id: newId(),
        sessionId,
        sequence: 1,
        correlationId: newId(),
        type: "SESSION_STATE_CHANGED",
        payload: {},
        occurredAt: new Date().toISOString()
      })
    });

    expect(listener).not.toHaveBeenCalled();
  });
});
