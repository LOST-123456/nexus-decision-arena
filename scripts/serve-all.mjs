#!/usr/bin/env node
/**
 * Single-port launcher for the publishing sandbox.
 *
 * The sandbox exposes exactly one HTTP port. This app is two processes:
 *   - core API (Fastify)  -> internal 127.0.0.1:4100
 *   - web UI   (Next.js)  -> the public $PORT
 * `apps/web` proxies `/api/:path*` to `API_PROXY_TARGET` (default 127.0.0.1:4100),
 * so the outside world only ever talks to $PORT.
 *
 * Order matters: Next renders on the server and calls the core during SSR, so
 * the core must be answering /health before the web server starts taking
 * requests. If it is not, every server-rendered page returns 500.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

const PUBLIC_PORT = process.env.PORT || "3000";
/*
 * The core port is NOT configurable at runtime. `apps/web/next.config.ts`
 * declares its `/api/:path*` rewrite with `API_PROXY_TARGET`, and Next bakes
 * rewrites into the build output — changing the env when the server starts has
 * no effect. The build default is 127.0.0.1:4100, so the core must listen
 * there. Passing CORE_PORT=4200 produced ECONNREFUSED 127.0.0.1:4100.
 */
const CORE_PORT = "4100";
const CORE_BASE = `http://127.0.0.1:${CORE_PORT}`;

const children = [];
let shuttingDown = false;

function log(message) {
  process.stdout.write(`[serve-all] ${message}\n`);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  process.exit(code);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

function start(command, args, options) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    log(`child exited (code=${code} signal=${signal})`);
    shutdown(code ?? 1);
  });
  return child;
}

async function waitForCore(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${CORE_BASE}/health`);
      if (response.ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main() {
  log(`starting core on internal :${CORE_PORT}`);

  const coreEntry = join(root, "services/core/dist/server.js");
  const coreSource = join(root, "services/core/src/server.ts");
  const tsxCli = join(root, "node_modules/tsx/dist/cli.mjs");

  if (existsSync(coreEntry)) {
    start(process.execPath, [coreEntry], {
      env: { ...process.env, PORT: CORE_PORT }
    });
  } else if (existsSync(tsxCli) && existsSync(coreSource)) {
    start(process.execPath, [tsxCli, coreSource], {
      cwd: join(root, "services/core"),
      env: { ...process.env, PORT: CORE_PORT }
    });
  } else {
    log("cannot find core entry (dist/server.js or tsx + src/server.ts)");
    process.exit(1);
  }

  if (!(await waitForCore())) {
    log("core never answered /health - refusing to start web (SSR would 500)");
    shutdown(1);
    return;
  }
  log("core is healthy");

  log(`starting web on public :${PUBLIC_PORT}`);
  const nextBin = join(root, "apps/web/node_modules/next/dist/bin/next");
  const nextFallback = join(root, "node_modules/next/dist/bin/next");
  const bin = existsSync(nextBin) ? nextBin : nextFallback;
  if (!existsSync(bin)) {
    log("cannot find next binary");
    shutdown(1);
    return;
  }
  start(process.execPath, [bin, "start", "-p", PUBLIC_PORT, "-H", "0.0.0.0"], {
    cwd: join(root, "apps/web"),
    env: { ...process.env, API_PROXY_TARGET: CORE_BASE }
  });
}

main().catch((error) => {
  log(`failed: ${error?.message ?? error}`);
  shutdown(1);
});
