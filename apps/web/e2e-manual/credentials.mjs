import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 手动探针脚本的口令来源。
 *
 * 这些脚本是排查用的，不在测试套件里跑，但它们在仓库里——写死口令等于
 * 把口令连同脚本一起交出去，而且部署方一换口令，这些脚本就全部静默失效。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function resolved(envName, fileName) {
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const value = readFileSync(join(repoRoot, ".data", fileName), "utf8").trim();
    if (value !== "") return value;
  } catch {
    /* 落到下面统一报错 */
  }
  throw new Error(
    `缺少 ${envName}：请设置该环境变量，或把口令写进 .data/${fileName}。`
  );
}

export const OWNER_PASSWORD = resolved("E2E_OWNER_PASSWORD", "owner-password.txt");
export const VIEWER_PASSWORD = resolved("E2E_VIEWER_PASSWORD", "viewer-password.txt");
export const OWNER = { username: "owner", password: OWNER_PASSWORD };
export const VIEWER = { username: "viewer", password: VIEWER_PASSWORD };
