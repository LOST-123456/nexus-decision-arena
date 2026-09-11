import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase } from "./client";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://nexus:nexus@localhost:5432/nexus"
);
const migrationDirectory = resolve("migrations");
const files = (await readdir(migrationDirectory))
  .filter((file) => file.endsWith(".sql"))
  .sort();

for (const file of files) {
  const statement = await readFile(resolve(migrationDirectory, file), "utf8");
  await database.execute(statement);
  console.log(`applied ${file}`);
}

await database.end();
