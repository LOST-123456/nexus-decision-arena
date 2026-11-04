/**
 * 数据库就位检查（独立成模块，便于单独跑）。
 *
 * 背景：站点的数据在 Docker 容器里，而 Docker Desktop 不在这台机器的任何
 * 自启链上。Docker 没跑的时候，站点看起来一切正常，但每个请求都 500
 * （ECONNREFUSED），用户看到的是"网站坏了"。这不是代码 bug，重启 web 进程
 * 也修不好。
 *
 * 这段逻辑原来写在 ensure-database.cmd 里，由启动器 `call` 出来。用 .cmd
 * 承载它的代价是：只要有一处写错（路径含 &、docker 是 shim、errorlevel 被
 * 上一条命令污染），启动器就会停在"自检"之后，日志里只剩一行输出——看上去
 * 像启动器什么都没做就退出了。挪到 Node 之后每一步都有日志，"等/跳过/超时"
 * 三种结局都写得下来，而且任何失败都只是让站点先 500，不会拦住启动。
 *
 * 检查三件事，按顺序：
 *   1. Docker daemon 在跑吗？（没跑就拉起 Docker Desktop，最多等 180 秒）
 *   2. 容器在跑吗？（docker start，已经在跑时这条无害）
 *   3. Postgres 接受连接了吗？（崩溃恢复能到几分钟）
 *
 * 第 3 步要等：非正常关机后 Postgres 会先接受 TCP、再回 57P03
 * "the database system is starting up"，直到回放完 WAL。在这里等，比让前
 * 几次页面加载失败便宜。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const container = process.env.NEXUS_DB_CONTAINER ?? "nexus-latest-postgres";
const dockerDesktop =
  process.env.DOCKER_DESKTOP ??
  "C:\\Users\\Lenovo\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe";

/** CLI 不一定在 PATH 上；允许用环境变量指，再退到两个常见安装位置。 */
const dockerCandidates = [
  process.env.DOCKER,
  "docker",
  "C:\\Users\\Lenovo\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe",
  "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"
].filter((value) => typeof value === "string" && value.length > 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `undefined` 表示还没查过；`null` 表示查过但没有可用的 docker。 */
let cachedDocker;

/** 跑一条命令拿结果。超时算失败，绝不抛出去打断调用方。 */
function tryCommand(command, args, timeoutMs = 20_000) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/**
 * 与部署脚本（`start-site.cmd` / `serve-public.cmd`）里的值保持一致：5433 是
 * 容器发布到宿主的端口，`nexus_demo` 是它承载的库。
 *
 * 启动器和 core 是两个进程，而 `.env` 不一定存在——core 有兜底串，启动器如果
 * 只看 `process.env.DATABASE_URL`，就会认为「没有配置，不归我管」，于是心跳
 * 永远返回 `checked: false`，等于没装。
 *
 * 只有 host 参与「是不是本机库」的判断；端口在这里不参与任何决定（探测是在
 * 容器内跑 `pg_isready`，与宿主端口无关）。
 */
const DEFAULT_DATABASE_URL =
  "postgres://nexus:nexus@localhost:5433/nexus_demo";

/**
 * 只有本机数据库才需要自检。
 *
 * 指向远端库时（改 DATABASE_URL 就够）在人家的机器上找 Docker 是纯噪音，
 * 所以按 host 判断。NEXUS_SKIP_DB_CHECK=1 是手动开关。
 */
export function databaseIsLocal(
  databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
) {
  if (process.env.NEXUS_SKIP_DB_CHECK === "1") return false;
  if (!databaseUrl) return false;
  try {
    const host = new URL(databaseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function findDockerCli() {
  // 心跳会反复调用这里；没有缓存的话每 60 秒要跑三次 `--version`。
  if (cachedDocker !== undefined) return cachedDocker;
  for (const candidate of dockerCandidates) {
    if (tryCommand(candidate, ["--version"], 10_000).ok) {
      cachedDocker = candidate;
      return candidate;
    }
  }
  cachedDocker = null;
  return null;
}

/**
 * 一次轻量探测：数据库此刻接不接受连接。
 *
 * 只回答「是/否」，不修任何东西——修复是 `ensureDatabase` 的事，那要等几分钟，
 * 不能挂在一次心跳里。
 *
 * 为什么需要它：站点跑起来之后数据库仍可能掉线（Docker Desktop 被关掉、机器
 * 休眠回来、容器被重新创建）。以前只有「重启整轮」才会再检查一次，于是页面
 * 会连续几十分钟报 503，而启动器日志里一个字都没有。
 *
 * `checked: false` 表示这台机器不归我们管（远端库，或找不到 docker），调用方
 * 不应据此判断数据库的健康状况。
 */
export function probeDatabase() {
  if (!databaseIsLocal()) return { checked: false, reachable: true };
  const docker = findDockerCli();
  if (!docker) return { checked: false, reachable: true };
  const result = tryCommand(
    docker,
    ["exec", container, "pg_isready", "-U", "nexus", "-d", "nexus_demo"],
    8_000
  );
  return { checked: true, reachable: result.ok };
}

/** 等一件事发生，直到超时。返回是否等到。 */
async function waitUntil(step, seconds, intervalMs) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (step()) return true;
    await sleep(intervalMs);
  }
  return false;
}

/**
 * 确保数据库可用。永远不抛错：最坏的结果是站点先跑起来、接口暂时 500。
 *
 * @param {(message: string) => void} log
 * @returns {Promise<"ready" | "skipped" | "recovering">}
 */
export async function ensureDatabase(log = () => {}) {
  if (!databaseIsLocal()) {
    log("数据库不在这台机器上（或已关闭自检），跳过 Docker 检查。");
    return "skipped";
  }

  const docker = findDockerCli();
  if (!docker) {
    log("找不到 docker 命令，跳过数据库自检；如果页面报 500，先手动起 Docker。");
    return "skipped";
  }

  if (!tryCommand(docker, ["info"], 20_000).ok) {
    log("Docker daemon 没在跑，正在启动 Docker Desktop…");
    if (!existsSync(dockerDesktop)) {
      log(`找不到 ${dockerDesktop}，请手动启动 Docker Desktop。`);
      return "skipped";
    }
    try {
      spawn(dockerDesktop, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch (error) {
      log(`启动 Docker Desktop 失败：${error.message}`);
      return "skipped";
    }
    if (!(await waitUntil(() => tryCommand(docker, ["info"], 20_000).ok, 180, 5_000))) {
      log("Docker daemon 180 秒内没起来，先继续启动站点（接口会报 500）。");
      return "recovering";
    }
    log("Docker daemon 已就绪。");
  }

  // 已经在跑时这条只是无害的确认。
  tryCommand(docker, ["start", container], 60_000);

  const ready = await waitUntil(
    () =>
      tryCommand(
        docker,
        ["exec", container, "pg_isready", "-U", "nexus", "-d", "nexus_demo"],
        15_000
      ).ok,
    300,
    3_000
  );
  if (ready) {
    log(`数据库已就绪（${container}）。`);
    return "ready";
  }
  log("等了 300 秒数据库还在恢复，先继续启动；这段时间页面会报 500。");
  return "recovering";
}
