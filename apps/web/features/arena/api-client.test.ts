import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionEventTypeSchema,
  newId,
  type ExecutionEvent
} from "@nexus/shared";
import { subscribeToEvents } from "./api-client";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, EventListener>();
  closed = false;

  constructor(readonly url: string | URL) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

afterEach(() => {
  FakeEventSource.instances = [];
});

describe("SSE client", () => {
  it("subscribes to named execution events instead of default messages", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const sessionId = newId();
    const onEvent = vi.fn();
    const unsubscribe = subscribeToEvents(sessionId, 12, onEvent);
    const source = FakeEventSource.instances[0]!;
    const event: ExecutionEvent = {
      id: newId(),
      sessionId,
      sequence: 13,
      correlationId: newId(),
      type: "CONFLICT_DETECTED",
      payload: { id: newId() },
      occurredAt: new Date().toISOString()
    };

    expect(String(source.url)).toContain("after=12");
    for (const type of ExecutionEventTypeSchema.options) {
      expect(source.listeners.has(type)).toBe(true);
    }

    source.emit("CONFLICT_DETECTED", event);
    expect(onEvent).toHaveBeenCalledWith(event);

    unsubscribe();
    expect(source.closed).toBe(true);
    vi.unstubAllGlobals();
  });
});
