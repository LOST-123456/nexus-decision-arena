import {
  createDatabase,
  DecisionSessionRepository,
  EventRepository,
  InspectorRepository
} from "@nexus/db";
import { createApp } from "./app";
import { PostgresIdempotencyStore } from "./api/plugins/idempotency";
import { EventBus } from "./execution/event-bus";

const port = Number(process.env.PORT ?? 4100);
const database = createDatabase(process.env.DATABASE_URL ?? "");
const eventBus = new EventBus();
const app = createApp(
  {
    sessions: new DecisionSessionRepository(database),
    inspector: new InspectorRepository(database),
    events: new EventRepository(database),
    runSession: {
      start: async () => {
        throw new Error(
          "RunSessionService must be wired before demo execution"
        );
      }
    }
  },
  new PostgresIdempotencyStore(database),
  { eventBus }
);

await app.listen({ host: "0.0.0.0", port });
