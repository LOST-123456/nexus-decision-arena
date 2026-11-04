import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The one place the E2E suite learns the owner password.
 *
 * It used to be a literal in every spec — and in the login page, which printed
 * it on screen. A password that lives in the repository cannot be changed
 * without editing nineteen files, and one printed on the page is not a
 * password at all.
 *
 * Resolution order:
 *   1. `E2E_OWNER_PASSWORD`, for CI and for a one-off run;
 *   2. `<repo>/.data/owner-password.txt`, which the deployment writes and
 *      git ignores — this is the local case, and keeps `pnpm test:e2e`
 *      working after a clone of an already-provisioned machine.
 *
 * Missing both is a failed run with a sentence explaining what to set, not a
 * mystery 401 halfway through the suite.
 */

// apps/web/e2e/support -> apps/web/e2e -> apps/web -> apps -> 仓库根
const repoRoot = join(__dirname, "..", "..", "..", "..");

function readLocalPassword(fileName: string): string | null {
  try {
    const value = readFileSync(join(repoRoot, ".data", fileName), "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

function resolve(
  envName: string,
  fileName: string,
  role: string
): string {
  const value =
    process.env[envName]?.trim() || readLocalPassword(fileName);
  if (value) return value;
  throw new Error(
    `E2E 需要 ${role} 口令：请设置 ${envName}，或把口令写进 .data/${fileName}（该目录已被 git 忽略）。`
  );
}

/** The password the seeded `owner` account actually answers to. */
export const OWNER_PASSWORD = resolve(
  "E2E_OWNER_PASSWORD",
  "owner-password.txt",
  "owner"
);

/** The owner login, in the shape `page.getByLabel` flows already take. */
export const OWNER = { username: "owner", password: OWNER_PASSWORD };

/** The read-only account, used by the permission-boundary specs. */
export const VIEWER_PASSWORD = resolve(
  "E2E_VIEWER_PASSWORD",
  "viewer-password.txt",
  "viewer"
);

export const VIEWER = { username: "viewer", password: VIEWER_PASSWORD };

