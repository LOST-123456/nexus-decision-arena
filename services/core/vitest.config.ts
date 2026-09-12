import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 30_000,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgres://nexus:nexus@localhost:5432/nexus"
    }
  }
});