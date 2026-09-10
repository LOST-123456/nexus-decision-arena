import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*",
  "lib/*",
  "services/*",
  "apps/web"
]);
