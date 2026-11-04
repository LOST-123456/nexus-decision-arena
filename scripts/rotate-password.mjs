#!/usr/bin/env node
/**
 * 轮换一个已有账户的口令。
 *
 * 为什么需要这个脚本：`.data/users.json` 存的是 scrypt 加盐哈希，
 * `AUTH_DEFAULT_OWNER_PASSWORD` 只在该账户**首次创建**时读过一次。服务跑起来
 * 之后改环境变量没有任何效果，而界面上也没有改密入口——于是「把演示口令换掉」
 * 这件事以前只能靠手改 JSON 或删库重建。
 *
 * 用法：
 *   node scripts/rotate-password.mjs owner
 *   node scripts/rotate-password.mjs viewer
 *   node scripts/rotate-password.mjs owner --password '自己指定的口令'
 *
 * 写完把明文打印到标准输出，同时落在 `.data/<用户名>-password.txt`（该目录已
 * 被 git 忽略），方便 `pnpm test:e2e` 与手动登录取用。
 */
import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const usersPath = resolve(repoRoot, process.env.AUTH_USERS_PATH || ".data/users.json");

/** 去掉了 0/O/1/l/I，便于口头传达和手抄。 */
const ALPHABET =
  "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const args = process.argv.slice(2);
const username = args[0];
const givenIndex = args.indexOf("--password");
const given = givenIndex >= 0 ? args[givenIndex + 1] : null;

if (!username || username.startsWith("--")) {
  console.error("用法: node scripts/rotate-password.mjs <用户名> [--password <口令>]");
  process.exit(1);
}

let password = given;
if (!password) {
  const bytes = randomBytes(24);
  password = "";
  for (let i = 0; i < 24; i++) password += ALPHABET[bytes[i] % ALPHABET.length];
} else if (password.length < 12) {
  // 与 auth-config 对首个管理员的口令长度要求保持一致。
  console.error("口令至少 12 个字符。");
  process.exit(1);
}

let users;
try {
  users = JSON.parse(readFileSync(usersPath, "utf8"));
} catch (reason) {
  console.error(`读取账户文件失败（${usersPath}）：${reason.message}`);
  console.error("不会创建新文件——写错路径时静默新建一份空的账户文件，等于清空全部账号。");
  process.exit(1);
}

const target = Array.isArray(users)
  ? users.find((user) => user.username?.toLowerCase() === username.toLowerCase())
  : null;
if (!target) {
  console.error(`账户文件里没有 "${username}"。现有账户：${users.map((u) => u.username).join(", ")}`);
  process.exit(1);
}

const salt = randomBytes(16).toString("hex");
target.salt = salt;
target.passwordHash = scryptSync(password, salt, 64).toString("hex");

// 与 AuthService.persist 相同的做法：先写临时文件再重命名，避免半写。
const temporary = `${usersPath}.tmp-${process.pid}`;
writeFileSync(temporary, JSON.stringify(users, null, 2));
writeFileSync(usersPath, readFileSync(temporary));
unlinkSync(temporary);

/**
 * 明文跟着账户文件走：`AUTH_USERS_PATH` 指向别处时（测试用的副本），不能把明文
 * 写到真实部署的那份旁边——否则一次演练就会覆盖线上正在使用的口令记录。
 */
const secretFile = join(dirname(usersPath), `${username.toLowerCase()}-password.txt`);
try {
  writeFileSync(secretFile, password + "\n");
} catch {
  /* 写不进去也不影响账户已经改好 */
}

console.log(`已轮换 ${username} 的口令（${password.length} 位）。`);
console.log(`明文: ${password}`);
console.log(`已写入: ${secretFile}`);
console.log("已登录的会话不会失效——cookie 里是签名后的用户标识，不含口令哈希。");
