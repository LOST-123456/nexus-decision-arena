import { createApp } from "./app";

const port = Number(process.env.PORT ?? 4100);
const app = createApp({
  sessions: {} as never,
  inspector: {} as never,
  events: {} as never,
  runSession: {} as never
});

await app.listen({ host: "0.0.0.0", port });
