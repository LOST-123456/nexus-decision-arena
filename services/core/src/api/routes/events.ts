import type { ExecutionEvent } from "@nexus/shared";
import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../../app";
import type { EventBus } from "../../execution/event-bus";

export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_REORDER_WINDOW = 16;

function formatEvent(event: ExecutionEvent): string {
  return [
    `id: ${event.sequence}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    ""
  ].join("\n");
}

function sortBySequence(events: Iterable<ExecutionEvent>): ExecutionEvent[] {
  return [...events].sort((left, right) => left.sequence - right.sequence);
}

export function registerEventRoutes(
  app: FastifyInstance,
  dependencies: {
    bus: EventBus;
    repository: Pick<AppDependencies["events"], "listAfter">;
  }
): void {
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/events/stream",
    async (request, reply) => {
      const sessionId = request.params.id;
      const queryAfter =
        typeof request.query === "object" &&
        request.query !== null &&
        "after" in request.query &&
        typeof request.query.after === "string"
          ? Number(request.query.after)
          : null;
      const lastSequence =
        queryAfter ??
        (typeof request.headers["last-event-id"] === "string"
          ? Number(request.headers["last-event-id"])
          : 0);

      let closed = false;
      let replaying = true;
      let nextSequence = lastSequence + 1;
      let recovering = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const buffered: ExecutionEvent[] = [];
      const pending = new Map<number, ExecutionEvent>();

      const writeEvent = (event: ExecutionEvent): void => {
        reply.raw.write(formatEvent(event));
      };

      const flushPending = (): void => {
        while (!closed) {
          const event = pending.get(nextSequence);
          if (!event) {
            return;
          }
          pending.delete(nextSequence);
          writeEvent(event);
          nextSequence += 1;
        }
      };

      const recover = (): void => {
        if (recovering || closed) {
          return;
        }
        recovering = true;

        void dependencies.repository
          .listAfter(sessionId, nextSequence - 1)
          .then((events) => {
            if (closed) {
              return;
            }
            for (const event of events as ExecutionEvent[]) {
              if (event.sequence >= nextSequence) {
                pending.set(event.sequence, event);
              }
            }
            flushPending();
          })
          .catch(() => undefined)
          .finally(() => {
            recovering = false;
            if (!closed && pending.size > SSE_REORDER_WINDOW) {
              recover();
            }
          });
      };

      const enqueue = (event: ExecutionEvent): void => {
        if (closed || event.sequence < nextSequence) {
          return;
        }

        pending.set(event.sequence, event);
        flushPending();

        if (pending.size > SSE_REORDER_WINDOW) {
          recover();
        }
      };

      const unsubscribe = dependencies.bus.subscribe(sessionId, (event) => {
        if (closed) {
          return;
        }
        if (replaying) {
          buffered.push(event);
          return;
        }
        enqueue(event);
      });

      let replay: ExecutionEvent[];
      try {
        replay = (await dependencies.repository.listAfter(
          sessionId,
          lastSequence
        )) as ExecutionEvent[];
      } catch (error) {
        unsubscribe();
        throw error;
      }

      if (closed) {
        unsubscribe();
        return;
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      reply.raw.flushHeaders();

      const initialEvents = new Map<number, ExecutionEvent>();
      for (const event of sortBySequence([...replay, ...buffered])) {
        if (event.sequence >= nextSequence) {
          initialEvents.set(event.sequence, event);
        }
      }
      for (const event of initialEvents.values()) {
        writeEvent(event);
        nextSequence = event.sequence + 1;
      }
      replaying = false;

      heartbeat = setInterval(() => {
        if (!closed) {
          reply.raw.write(": heartbeat\n\n");
        }
      }, SSE_HEARTBEAT_MS);
      heartbeat.unref?.();

      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        unsubscribe();
        pending.clear();
        buffered.length = 0;
        request.raw.off("close", cleanup);
        reply.raw.off("close", cleanup);
      };

      request.raw.once("close", cleanup);
      reply.raw.once("close", cleanup);
      reply.raw.once("error", cleanup);
    }
  );
}
