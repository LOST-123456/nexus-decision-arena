import type { ExecutionEvent } from "@nexus/shared";
import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../../app";
import type { EventBus } from "../../execution/event-bus";

export const SSE_HEARTBEAT_MS = 15_000;

function formatEvent(event: ExecutionEvent): string {
  return [
    `id: ${event.sequence}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    ""
  ].join("\n");
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

      const replay = (await dependencies.repository.listAfter(
        sessionId,
        lastSequence
      )) as ExecutionEvent[];

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      reply.raw.flushHeaders();

      let closed = false;
      let highestSequence = lastSequence;
      const send = (event: ExecutionEvent): void => {
        if (closed || event.sequence <= highestSequence) {
          return;
        }
        highestSequence = event.sequence;
        reply.raw.write(formatEvent(event));
      };

      for (const event of replay) {
        send(event);
      }

      const unsubscribe = dependencies.bus.subscribe(sessionId, send);
      const heartbeat = setInterval(() => {
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
        clearInterval(heartbeat);
        unsubscribe();
        request.raw.off("close", cleanup);
        reply.raw.off("close", cleanup);
      };

      request.raw.once("close", cleanup);
      reply.raw.once("close", cleanup);
      reply.raw.once("error", cleanup);
    }
  );
}
