import type { ExecutionEvent } from "@nexus/shared";

type Listener = (event: ExecutionEvent) => void;

export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(sessionId: string, listener: Listener): () => void {
    const sessionListeners =
      this.listeners.get(sessionId) ?? new Set<Listener>();
    sessionListeners.add(listener);
    this.listeners.set(sessionId, sessionListeners);

    return () => {
      sessionListeners.delete(listener);
      if (sessionListeners.size === 0) {
        this.listeners.delete(sessionId);
      }
    };
  }

  async publishAfterCommit(input: {
    append(): Promise<ExecutionEvent>;
  }): Promise<ExecutionEvent> {
    const event = await input.append();
    for (const listener of this.listeners.get(event.sessionId) ?? []) {
      listener(event);
    }
    return event;
  }
}
