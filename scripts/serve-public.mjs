#!/usr/bin/env node
/**
 * 公网入口：一个隧道 + 一个站点，一起活、一起重启。
 *
 * 为什么需要这个文件：
 * 站点本来是"本机 3000"，只能在你这台电脑上打开。要让手机、别的电脑也能开，
 * 最省事的办法是 Cloudflare 快速隧道（本机已装 cloudflared，不需要账号）：
 *   公网 https://xxx.trycloudflare.com  →  本机 http://localhost:3000
 *
 * 但这里有一个必须先解决的坑：core 的 CSRF 策略（P27）只信任显式配置的 Origin，
 * 通过隧道域名发起的登录/写入会被 403 `csrf_origin_rejected` 拒掉。而隧道域名
 * 每次启动都会变，所以人没法手工配。这个脚本的顺序就是答案：
 *
 *   1. 先起隧道，从它的输出里抓出本次的真实域名；
 *   2. 把它连同 loopback 一起写进 WEB_ORIGINS，再起 serve-all；
 *   3. 域名写进 logs\public-url.txt 和根目录的 Nexus-公网地址.url，
 *      桌面那份也一起更新，双击永远指向当前地址。
 *
 * 任一子进程退出就整体重来（隧道掉了、站点崩了都算），除非存在停止标记。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDatabase, probeDatabase } from "./database-ready.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const logs = join(root, "logs");
const stopFlag = join(logs, "stopped.flag");
const urlFile = join(root, "Nexus-公网地址.url");
const localPort = process.env.PORT ?? "3000";

/*
 * cloudflared 的安装位置。允许用环境变量覆盖：换一台机器装到别处时，
 * 改一行配置比翻脚本容易。
 */
const cloudflared =
  process.env.CLOUDFLARED ??
  "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";

/** 桌面上那份 .url 也同步更新，免得上一次留下的旧地址一直点不开。 */
const desktopDirs = [
  process.env.NEXUS_DESKTOP_DIR,
  process.env.USERPROFILE ? join(process.env.USERPROFILE, "Desktop") : null,
  "E:\\桌面"
].filter((value) => typeof value === "string" && value.length > 0);

mkdirSync(logs, { recursive: true });

/*
 * 停止脚本要靠这两个 pid 精确收尾：只杀自己的隧道，不去动别人机器上
 * 可能还在用的其它 cloudflared。
 */
/*
 * 单实例：同一时刻只允许一个启动器。
 *
 * 两个启动器会各建一条隧道，然后各写一次 logs\public-url.txt——后写的那个
 * 域名进了文件，而 core 的 WEB_ORIGINS 用的是先写那个。结果就是"页面能打开、
 * 一提交就 403 Request origin rejected"。这个故障看起来像权限问题，其实是
 * 两个自己人打架，所以必须在开隧道之前拦住。
 */
const pidFile = join(logs, "serve-public.pid");
try {
  const previous = Number(readFileSync(pidFile, "utf8").trim());
  if (Number.isInteger(previous) && previous > 0 && previous !== process.pid) {
    let alive = false;
    try {
      process.kill(previous, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) {
      log(`已经有一个启动器在跑（pid ${previous}），本次不建隧道、不覆盖地址。`);
      // 退避退出：外层循环若把我们再拉起来，也不要立刻再抢一次。
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      process.exit(0);
    }
  }
} catch {
  /* 没有 pid 文件或内容不可读：当作没有实例在跑 */
}

try {
  writeFileSync(pidFile, String(process.pid));
} catch {
  /* 没写成也不影响运行，只是停止时少一条精确路径 */
}

function log(message) {
  process.stdout.write(`[public] ${message}\n`);
}

function writeHealthFile(text) {
  try {
    writeFileSync(join(logs, "public-url.txt"), text);
  } catch {
    /* 写不进日志目录不影响隧道本身 */
  }
}

/**
 * 一个 .url 文件就是"双击打开某个网址"。每次启动都重写，
 * 所以用户桌面上的图标永远是当前这一次的地址。
 */
function writeShortcut(target, url) {
  const body =
    "[InternetShortcut]\r\n" +
    `URL=${url}\r\n` +
    "IconFile=shell32.dll\r\n" +
    "IconIndex=13\r\n";
  try {
    writeFileSync(target, body, "ascii");
  } catch {
    return false;
  }
  return true;
}

function publishUrl(url) {
  writeHealthFile(`${url}\n`);
  const written = [];
  if (writeShortcut(urlFile, url)) written.push(urlFile);
  for (const dir of desktopDirs) {
    if (!existsSync(dir)) continue;
    const target = join(dir, "Nexus 公网.url");
    if (writeShortcut(target, url)) written.push(target);
  }
  log(`公网地址 ${url}`);
  for (const file of written) log(`  已写入 ${file}`);
}

let tunnel = null;
let app = null;
let shuttingDown = false;

function kill(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    /* 已经没了 */
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopDatabaseHeartbeat();
  kill(app);
  kill(tunnel);
  process.exit(code);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

/** 从 cloudflared 的输出里等出本次的隧道域名。 */
function waitForTunnelUrl(child, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`隧道 ${timeoutMs / 1000} 秒内没有给出地址`));
    }, timeoutMs);

    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        cleanup();
        resolve(match[0]);
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`cloudflared 提前退出（code=${code}）`));
    };
    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    }

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

async function startTunnel() {
  const child = spawn(
    cloudflared,
    [
      "tunnel",
      "--url",
      `http://localhost:${localPort}`,
      "--no-autoupdate"
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
  );
  child.on("error", (error) => log(`cloudflared 启动失败: ${error.message}`));
  return child;
}

/**
 * 公网上必须有自己的签名密钥。
 *
 * core 在没有 AUTH_SECRET 时会用代码里内置的 demo 密钥签 cookie——本机开发
 * 无所谓，但这条隧道把站点放到公网上了，内置密钥是公开的，等于谁都能伪造
 * 登录态。第一次运行时生成一个随机值并落在 logs\auth-secret.txt，之后一直
 * 复用它（换了它所有已登录会话会失效，所以不能每次启动都换）。
 */
function ensureAuthSecret() {
  const file = join(logs, "auth-secret.txt");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* 没有就生成 */
  }
  const secret = randomBytes(32).toString("hex");
  try {
    writeFileSync(file, secret);
  } catch {
    /* 写不进去仍然可以用这一次的值，只是下次会变 */
  }
  return secret;
}

const authSecret = ensureAuthSecret();

function startApp(publicUrl) {
  /*
   * 隧道域名必须显式列出：core 一旦发现配置了 Origin，就不再自动信任
   * loopback，所以本机访问也要一并写进去，否则你在这台电脑上反而登不进去。
   */
  const origins = [
    publicUrl,
    `http://localhost:${localPort}`,
    `http://127.0.0.1:${localPort}`
  ].join(",");

  return spawn(process.execPath, [join(root, "scripts/serve-all.mjs")], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, WEB_ORIGINS: origins, AUTH_SECRET: authSecret }
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

/**
 * 自检：发布出去的域名，真的被服务端信任了吗。
 *
 * 判据是一次不带 cookie 的 POST 带 Origin 头：信任则 2xx（这里是无会话的
 * logout，204），不信任则 403 csrf_origin_rejected。这比"日志里打印了地址"
 * 强得多——地址打印成功、白名单却是别人，正是最难查的那种故障。
 */
async function verifyPublishedOriginIsTrusted(publicUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${localPort}/api/auth/logout`,
        {
          method: "POST",
          headers: { origin: publicUrl, "content-type": "application/json" },
          body: "{}"
        }
      );
      return response.status !== 403;
    } catch {
      /* 站点还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * 站点跑起来之后接着看着数据库。
 *
 * `ensureDatabase` 只在每一轮启动时跑一次。可数据库是在站点活着的时候掉线的：
 * Docker Desktop 被关掉、机器休眠回来、容器被重建。那时页面每个请求都 503，
 * 而启动器日志里一个字都没有——只能靠人猜「是不是网站坏了」。
 *
 * 心跳只做两件事：写一行日志（日志里能看到它是几点掉的），以及发现连不上时尝试
 * 把 Docker 拉起来。恢复之后不需要重启站点：core 的连接池会在下一次查询时重新
 * 取连接，页面刷新即可。
 *
 * 60 秒一次，因为 `ensureDatabase` 本身就可能要等几分钟——太密只会把日志刷满。
 */
const HEARTBEAT_MS = 60_000;
let heartbeatTimer = null;
let databaseKnownDown = false;
let ensuringDatabase = false;

function startDatabaseHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(async () => {
    if (existsSync(stopFlag) || ensuringDatabase) return;
    const { checked, reachable } = probeDatabase();
    // 远端库、或这台机器没有 docker：不归本轮管，也不该据此报警。
    if (!checked) return;
    if (reachable) {
      if (databaseKnownDown) {
        log("数据库恢复了。页面刷新一下就能用，不用重新登录。");
        databaseKnownDown = false;
      }
      return;
    }
    if (!databaseKnownDown) {
      databaseKnownDown = true;
      log("数据库连不上了：页面会显示「数据库暂时连不上」。正在尝试把它拉起来…");
    }
    ensuringDatabase = true;
    try {
      await ensureDatabase(log);
    } catch (error) {
      log(`尝试拉起数据库时出错：${error?.message ?? error}`);
    } finally {
      ensuringDatabase = false;
    }
  }, HEARTBEAT_MS);
  // 心跳不该把进程按在事件循环里不退出。
  heartbeatTimer.unref?.();
}

function stopDatabaseHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function main() {
  if (!existsSync(cloudflared)) {
    log(`找不到 cloudflared: ${cloudflared}`);
    log("改环境变量 CLOUDFLARED 指向它，或先安装它。");
    process.exit(1);
  }

  // 启动即视为"要跑"，清掉上一次的停止标记。
  rmSync(stopFlag, { force: true });

  for (;;) {
    if (existsSync(stopFlag)) {
      log("看到停止标记，退出。");
      shutdown(0);
      return;
    }

    // 数据库先就位再开隧道：先开的话，第一个打开页面的人会撞上 500。
    await ensureDatabase(log);

    log("正在建立隧道…");
    tunnel = await startTunnel();

    let publicUrl;
    try {
      publicUrl = await waitForTunnelUrl(tunnel);
    } catch (error) {
      log(`隧道失败：${error.message}`);
      kill(tunnel);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }

    // 先落盘再起站：地址文件存在就意味着"这一轮的域名已经确定"。
    publishUrl(publicUrl);

    try {
      writeFileSync(join(logs, "tunnel.pid"), String(tunnel.pid));
    } catch {
      /* 同上，仅影响停止时的精确清理 */
    }

    app = startApp(publicUrl);

    if (!(await verifyPublishedOriginIsTrusted(publicUrl))) {
      log(
        "自检失败：发布出去的域名不在本轮信任名单里（公网写入会 403）。重启这一轮。"
      );
      kill(app);
      kill(tunnel);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    log("自检通过：发布地址与信任名单一致。");
    startDatabaseHeartbeat();

    const [first] = await Promise.all([waitForExit(app), waitForExit(tunnel)]);
    stopDatabaseHeartbeat();
    kill(app);
    kill(tunnel);

    if (existsSync(stopFlag)) {
      log("看到停止标记，退出。");
      shutdown(0);
      return;
    }
    log(`子进程退出（code=${first.code}），3 秒后整体重启。`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

main().catch((error) => {
  log(`无法启动：${error?.message ?? error}`);
  shutdown(1);
});
