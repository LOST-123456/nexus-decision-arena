import type { ExecutionEvent } from "@nexus/shared";
import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../../app";
import type { EventBus } from "../../execution/event-bus";

export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_RECOVERY_BASE_DELAY_MS = 25;
export const SSE_RECOVERY_MAX_DELAY_MS = 1_000;

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
  },
  allowedOrigins: ReadonlySet<string> = new Set()
): void {
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/events",
    async (request, reply) => {
      const events = await dependencies.repository.listAfter(
        request.params.id,
        0
      );
      return reply.send(events);
    }
  );

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
      let expectedSequence = lastSequence + 1;
      let recovering = false;
      let recoveryAttempts = 0;
      let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let unsubscribe = (): void => undefined;
      const pending = new Map<number, ExecutionEvent>();

      const writeEvent = (event: ExecutionEvent): void => {
        reply.raw.write(formatEvent(event));
      };

      const flushContiguous = (): void => {
        while (!closed) {
          const event = pending.get(expectedSequence);
          if (!event) {
            break;
          }
          pending.delete(expectedSequence);
          writeEvent(event);
          expectedSequence += 1;
        }

        if (pending.size === 0) {
          recoveryAttempts = 0;
        }
      };

      const recover = async (): Promise<void> => {
        if (recovering || closed) {
          return;
        }
        recovering = true;

        try {
          const events = (await dependencies.repository.listAfter(
            sessionId,
            expectedSequence - 1
          )) as ExecutionEvent[];
          if (closed) {
            return;
          }
          for (const event of events) {
            if (event.sequence >= expectedSequence) {
              pending.set(event.sequence, event);
            }
          }
          flushContiguous();
        } catch {
          // The bounded timer below retries without a tight database loop.
        } finally {
          recovering = false;
          if (!closed && pending.size > 0) {
            scheduleRecovery();
          }
        }
      };

      const scheduleRecovery = (): void => {
        if (closed || recovering || recoveryTimer) {
          return;
        }

        const delay = Math.min(
          SSE_RECOVERY_BASE_DELAY_MS * 2 ** recoveryAttempts,
          SSE_RECOVERY_MAX_DELAY_MS
        );
        recoveryAttempts += 1;
        recoveryTimer = setTimeout(() => {
          recoveryTimer = undefined;
          void recover();
        }, delay);
        recoveryTimer.unref?.();
      };

      const enqueue = (event: ExecutionEvent): void => {
        if (closed || event.sequence < expectedSequence) {
          return;
        }

        pending.set(event.sequence, event);
        flushContiguous();

        if (pending.size > 0) {
          scheduleRecovery();
        }
      };

      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        if (recoveryTimer) {
          clearTimeout(recoveryTimer);
        }
        unsubscribe();
        pending.clear();
        request.raw.off("close", cleanup);
        reply.raw.off("close", cleanup);
        reply.raw.off("error", cleanup);
      };

      unsubscribe = dependencies.bus.subscribe(sessionId, enqueue);
      request.raw.once("close", cleanup);
      reply.raw.once("close", cleanup);
      reply.raw.once("error", cleanup);

      reply.hijack();
      const origin = request.headers.origin;
      reply.raw.writeHead(200, {
        ...(origin && allowedOrigins.has(origin)
          ? {
              "access-control-allow-origin": origin,
              vary: "Origin"
            }
          : {}),
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      reply.raw.flushHeaders();

      heartbeat = setInterval(() => {
        if (!closed) {
          reply.raw.write(": heartbeat\n\n");
        }
      }, SSE_HEARTBEAT_MS);
      heartbeat.unref?.();

      let replay: ExecutionEvent[];
      try {
        replay = (await dependencies.repository.listAfter(
          sessionId,
          lastSequence
        )) as ExecutionEvent[];
      } catch {
        cleanup();
        reply.raw.destroy();
        return;
      }

      if (closed) {
        return;
      }

      for (const event of sortBySequence(replay)) {
        enqueue(event);
      }
    }
  );
}
