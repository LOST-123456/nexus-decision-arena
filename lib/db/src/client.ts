import { type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDatabase(url: string) {
  const client = postgres(url, {
    max: 10,
    onnotice: () => undefined
  });
  const database = drizzle(client, { schema });
  const execute = database.execute.bind(database);

  return Object.assign(database, {
    end: () => client.end(),
    execute: (query: string | SQL) =>
      typeof query === "string" ? client.unsafe(query) : execute(query)
  });
}

export type Database = ReturnType<typeof createDatabase>;